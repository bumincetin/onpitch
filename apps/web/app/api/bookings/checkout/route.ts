/**
 * POST /api/bookings/checkout
 *
 * The split payment. This is the single most order-sensitive route in the product, so the
 * sequence is spelled out rather than implied:
 *
 *   1. Authenticate and check the role.
 *   2. Gate minors on parental consent (GDPR Art. 8) before anything financial happens.
 *   3. Parse the body with zod. The client sends a pitch and a window — NEVER an amount.
 *   4. Recompute the price server-side from `pitches.hourly_rate_minor`.
 *   5. Verify the venue is published and its connected account can actually accept charges.
 *   6. INSERT the booking first, so the `tstzrange` EXCLUDE constraint reserves the slot
 *      atomically. SQLSTATE 23P01 means we lost the race → 409 SLOT_TAKEN. With the slot held,
 *      check the venue's blackout windows — no database constraint cross-checks those two tables.
 *   7. Create the destination-charge PaymentIntent, idempotency-keyed on the booking id.
 *   8. If Stripe fails, release the booking so a dead reservation cannot hold a slot hostage.
 *
 * Returns `{ bookingId, clientSecret, publishableKey, quote }`.
 */

import type { NextRequest } from "next/server"
import type Stripe from "stripe"

import { fail, ok } from "@/lib/api-response"
import {
  buildPaymentIntentParams,
  isExclusionViolation,
  mapStripeStatus,
  parseTstzRange,
  QuoteError,
  quoteBooking,
  toTstzRange,
} from "@/lib/payments"
import { getSessionUser, type AppRole } from "@/lib/rbac"
import { describeStripeError, stripe } from "@/lib/stripe"
import { createAdminClient } from "@/lib/supabase/admin"
import { enforceRateLimit } from "@/lib/rate-limit"
import type { Database, Json, Tables } from "@onpitch/shared/database"
import type { SupabaseClient } from "@supabase/supabase-js"
import {
  API_ERROR_CODES,
  asMinor,
  bookingCheckoutSchema,
  type BookingQuote,
  type CheckoutResult,
} from "@onpitch/shared/domain"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Anyone with an account may book a pitch; only the consent gate below narrows it further. */
const CHECKOUT_ROLES: readonly AppRole[] = ["player", "venue_owner", "admin"]

/** The exclusion constraint from 0001_schema.sql that serialises competing bookings. */
const DOUBLE_BOOKING_CONSTRAINT = "bookings_no_double_booking"

type AdminClient = SupabaseClient<Database>

export async function POST(request: NextRequest) {
  /* ---------------------------------------------------------------- 1. auth */
  const session = await getSessionUser()
  if (!session) {
    return fail(API_ERROR_CODES.UNAUTHENTICATED, "Saha ayırtmak için giriş yap.", 401)
  }

  // Budgets are counted in Postgres, not in this process — see lib/rate-limit.ts. Checked after
  // authentication so an anonymous flood spends nobody's budget but its own 401s.
  const limited = await enforceRateLimit("checkout")
  if (limited) return limited

  // `requireRole()` is the shared guard, but it redirects — right for a Server Component and
  // wrong for a JSON API, where a 302 to /login would be parsed as a failed fetch. We apply the
  // same predicate here and answer with the envelope every other route returns.
  if (!CHECKOUT_ROLES.includes(session.profile.role)) {
    return fail(API_ERROR_CODES.FORBIDDEN, "Bu hesap rezervasyon oluşturamaz.", 403)
  }

  /* ------------------------------------------------------------- 2. consent */
  // Mirrors `public.assert_consented()`: under-16s cannot transact until a guardian has
  // approved the account. The age is recomputed from date_of_birth rather than read off
  // `profiles.is_minor`, which is a write-time snapshot of a generated column.
  const consent = evaluateConsent(session.profile)
  if (!consent.allowed) {
    return fail(consent.code, consent.message, 403)
  }

  /* ---------------------------------------------------------------- 3. body */
  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return fail(API_ERROR_CODES.VALIDATION_FAILED, "İstek gövdesi geçerli JSON olmalı.", 400)
  }

  const parsed = bookingCheckoutSchema.safeParse(payload)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
      .join("; ")
    return fail(API_ERROR_CODES.VALIDATION_FAILED, `Invalid checkout request. ${detail}`, 422)
  }
  const body = parsed.data

  const publishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
  if (!publishableKey) {
    // Fail before reserving a slot: without this key the browser cannot mount the Payment
    // Element, so the reservation could never be paid for.
    return fail(API_ERROR_CODES.INTERNAL, "Bu kurulumda ödeme yapılandırılmamış.", 500)
  }

  /* ------------------------------------------------- 4/5. price + payability */
  // The service-role client is used for the whole route. Reads are pinned to explicit ids, and
  // the booking INSERT has to write `status = 'awaiting_payment'` plus `connected_account_id`,
  // which the `bookings_insert_self` RLS policy deliberately forbids an end-user session from
  // doing. Authorisation is therefore enforced explicitly below (ownership of the team, venue
  // payability) instead of being delegated to RLS.
  const admin = createAdminClient()

  const { data: pitch, error: pitchError } = await admin
    .from("pitches")
    .select(
      "id, venue_id, name, hourly_rate_minor, currency, slot_minutes, opening_time, closing_time, is_active",
    )
    .eq("id", body.pitchId)
    .maybeSingle()

  if (pitchError) {
    return fail(API_ERROR_CODES.INTERNAL, "Saha yüklenemedi.", 500)
  }
  if (!pitch) {
    return fail(API_ERROR_CODES.NOT_FOUND, "Böyle bir saha yok.", 404)
  }

  const { data: venue, error: venueError } = await admin
    .from("venues")
    .select("id, name, owner_id, timezone, is_active, charges_enabled, stripe_account_id")
    .eq("id", pitch.venue_id)
    .maybeSingle()

  if (venueError) {
    return fail(API_ERROR_CODES.INTERNAL, "Tesis yüklenemedi.", 500)
  }
  if (!venue) {
    return fail(API_ERROR_CODES.NOT_FOUND, "Bu sahanın bağlı olduğu tesis yok.", 404)
  }

  if (!venue.is_active) {
    return fail(
      API_ERROR_CODES.VENUE_NOT_PAYABLE,
      "Bu tesis henüz rezervasyon almıyor.",
      409,
    )
  }
  // A destination charge without a payable destination is money the platform cannot split. The
  // venue's Stripe onboarding has to be finished BEFORE a slot is reserved, never after.
  if (!venue.stripe_account_id || !venue.charges_enabled) {
    return fail(
      API_ERROR_CODES.VENUE_NOT_PAYABLE,
      "Bu tesis ödeme kurulumunu tamamlamadı, bu yüzden henüz ödeme alamıyor.",
      409,
    )
  }
  const connectedAccountId = venue.stripe_account_id

  let quote: BookingQuote
  try {
    quote = quoteBooking({
      pitch,
      startsAt: body.startsAt,
      endsAt: body.endsAt,
      timezone: venue.timezone,
    })
  } catch (error) {
    if (error instanceof QuoteError) {
      return fail(
        error.code === "VALIDATION_FAILED"
          ? API_ERROR_CODES.VALIDATION_FAILED
          : API_ERROR_CODES.PRICE_UNAVAILABLE,
        error.message,
        422,
      )
    }
    throw error
  }

  /* ---------------------------------------------------- team authorisation */
  if (body.teamId) {
    const authorised = await isTeamMemberOrOwner(admin, body.teamId, session.user.id)
    if (!authorised) {
      return fail(API_ERROR_CODES.FORBIDDEN, "Bu takımın üyesi değilsin.", 403)
    }
  }

  /* ------------------------------------------------------- 6. reserve first */
  // THE DOUBLE-BOOKING DEFENCE. `bookings_no_double_booking` is a GiST EXCLUDE constraint over
  // (pitch_id =, time_range &&) restricted to live statuses, so two concurrent requests for the
  // same slot cannot both commit — Postgres serialises them and the loser gets SQLSTATE 23P01.
  // Checking availability with a SELECT before inserting would be a textbook TOCTOU race; the
  // constraint is the only correct guard, and it must fire BEFORE any money is moved.
  const timeRange = toTstzRange(quote.startsAt, quote.endsAt)

  const { data: booking, error: insertError } = await admin
    .from("bookings")
    .insert({
      pitch_id: pitch.id,
      booked_by: session.user.id,
      team_id: body.teamId ?? null,
      time_range: timeRange,
      status: "awaiting_payment",
      payment_status: "requires_payment",
      subtotal_minor: quote.subtotalMinor,
      platform_fee_minor: quote.platformFeeMinor,
      total_minor: quote.totalMinor,
      currency: quote.currency,
      connected_account_id: connectedAccountId,
      notes: body.notes ?? null,
    })
    .select("id")
    .single()

  if (insertError || !booking) {
    if (isExclusionViolation(insertError, DOUBLE_BOOKING_CONSTRAINT)) {
      // Before declaring the slot lost, check whether the row in the way is the CALLER's own
      // in-flight reservation — a double-clicked checkout must resume, not 409.
      const resumed = await resumeOwnCheckout(admin, {
        pitchId: pitch.id,
        userId: session.user.id,
        timeRange,
        quote,
        publishableKey,
      })
      if (resumed) return ok(resumed)

      return fail(
        API_ERROR_CODES.SLOT_TAKEN,
        "O saati az önce başkası aldı. Başka bir saat seç.",
        409,
      )
    }
    return fail(API_ERROR_CODES.INTERNAL, "Bu saat ayrılamadı.", 500)
  }

  /* ------------------------------------------------- 6b. venue blackouts */
  // `bookings_no_double_booking` only serialises bookings against bookings, and
  // `pitch_blocks_no_overlap` only blocks against blocks — NOTHING in Postgres cross-checks a
  // booking against `pitch_availability_blocks`, so a maintenance or private-hire window would
  // otherwise be payable. This runs AFTER the insert on purpose: the reservation already holds
  // the slot, so this SELECT is not the TOCTOU race that a pre-insert availability check is.
  const { data: blockingWindows, error: blockError } = await admin
    .from("pitch_availability_blocks")
    .select("id")
    .eq("pitch_id", pitch.id)
    .filter("block_range", "ov", timeRange)
    .limit(1)

  if (blockError) {
    await releaseBooking(admin, booking.id, "Could not verify venue availability.")
    return fail(API_ERROR_CODES.INTERNAL, "Saatin boş olduğu doğrulanamadı.", 500)
  }
  if (blockingWindows && blockingWindows.length > 0) {
    await releaseBooking(admin, booking.id, "That window is blocked by the venue.")
    return fail(
      API_ERROR_CODES.SLOT_TAKEN,
      "İşletme o saati kapattı. Başka bir saat seç.",
      409,
    )
  }

  /* -------------------------------------------------- 7. the PaymentIntent */
  const { params, options } = buildPaymentIntentParams({
    bookingId: booking.id,
    quote,
    connectedAccountId,
    venueId: venue.id,
    userId: session.user.id,
    teamId: body.teamId ?? null,
    receiptEmail: session.profile.email,
    statementDescriptorSuffix: venue.name,
  })

  let intent: Stripe.PaymentIntent
  try {
    intent = await stripe.paymentIntents.create(params, options)
  } catch (error) {
    // 8. Stripe said no. Release the reservation immediately, or the slot stays hostage to a
    // booking that can never be paid for.
    console.error("[checkout] paymentIntents.create failed", describeStripeError(error))
    await releaseBooking(admin, booking.id, "Payment could not be started.")
    // The raw Stripe message never reaches the client — the stable code is the contract.
    return fail(
      API_ERROR_CODES.STRIPE_ERROR,
      "Ödeme başlatılamadı. Birazdan tekrar dene.",
      502,
    )
  }

  if (!intent.client_secret) {
    await releaseBooking(admin, booking.id, "Stripe returned no client secret.")
    await cancelIntentQuietly(intent.id)
    return fail(API_ERROR_CODES.STRIPE_ERROR, "Stripe ödenebilir bir ödeme niyeti döndürmedi.", 502)
  }

  const { error: attachError } = await admin
    .from("bookings")
    .update({
      stripe_payment_intent_id: intent.id,
      payment_status: mapStripeStatus(intent.status),
    })
    .eq("id", booking.id)

  if (attachError) {
    // The booking and the intent could not be linked. Cancel the intent rather than leave a
    // payable charge whose webhook would arrive with no booking to confirm.
    await cancelIntentQuietly(intent.id)
    await releaseBooking(admin, booking.id, "Could not link the payment to the booking.")
    return fail(API_ERROR_CODES.INTERNAL, "Ödeme başlatılamadı. Lütfen tekrar dene.", 500)
  }

  await recordAudit(admin, session.user.id, booking.id, {
    pitch_id: pitch.id,
    venue_id: venue.id,
    payment_intent_id: intent.id,
    total_minor: quote.totalMinor,
    platform_fee_minor: quote.platformFeeMinor,
    currency: quote.currency,
  })

  const result: CheckoutResult = {
    bookingId: booking.id,
    clientSecret: intent.client_secret,
    publishableKey,
    quote,
  }
  return ok(result)
}

/* ========================================================================== */
/*  Helpers                                                                   */
/* ========================================================================== */

interface ConsentVerdict {
  allowed: boolean
  code: string
  message: string
}

const CONSENT_OK: ConsentVerdict = { allowed: true, code: "", message: "" }

/** Whole years between a `YYYY-MM-DD` birthday and now, in UTC. */
function ageYears(dateOfBirth: string): number | null {
  const dob = new Date(`${dateOfBirth}T00:00:00Z`)
  if (Number.isNaN(dob.getTime())) return null
  const now = new Date()
  let years = now.getUTCFullYear() - dob.getUTCFullYear()
  const beforeBirthday =
    now.getUTCMonth() < dob.getUTCMonth() ||
    (now.getUTCMonth() === dob.getUTCMonth() && now.getUTCDate() < dob.getUTCDate())
  if (beforeBirthday) years -= 1
  return years
}

function evaluateConsent(profile: Tables<"profiles">): ConsentVerdict {
  if (profile.deleted_at) {
    return {
      allowed: false,
      code: API_ERROR_CODES.FORBIDDEN,
      message: "Bu hesap kapalı ve işlem yapamaz.",
    }
  }
  if (!profile.date_of_birth) return CONSENT_OK

  const age = ageYears(profile.date_of_birth)
  if (age === null || age >= 16) return CONSENT_OK

  if (profile.parental_consent_status !== "granted") {
    return {
      allowed: false,
      code: API_ERROR_CODES.CONSENT_REQUIRED,
      message:
        "Bu hesabın saha tutabilmesi için önce bir velinin onaylaması gerekiyor. " +
        `Mevcut onay durumu: ${profile.parental_consent_status}.`,
    }
  }
  return CONSENT_OK
}

/**
 * RLS would normally answer this (`private.is_team_member`), but this route runs as
 * service_role, so the same predicate is enforced in application code: an active membership, or
 * ownership of the team.
 */
async function isTeamMemberOrOwner(
  admin: AdminClient,
  teamId: string,
  userId: string,
): Promise<boolean> {
  const { data: membership } = await admin
    .from("team_members")
    .select("team_id")
    .eq("team_id", teamId)
    .eq("player_id", userId)
    .is("left_at", null)
    .maybeSingle()
  if (membership) return true

  const { data: owned } = await admin
    .from("teams")
    .select("id")
    .eq("id", teamId)
    .eq("owner_id", userId)
    .maybeSingle()
  return Boolean(owned)
}

/**
 * Turn a reservation loose. Deliberately a status change and not a DELETE: bookings are
 * financial records and the row is worth keeping for forensics, while `cancelled` sits outside
 * the exclusion constraint's status predicate, so the slot is released the moment this commits.
 */
async function releaseBooking(admin: AdminClient, bookingId: string, reason: string): Promise<void> {
  const { error } = await admin
    .from("bookings")
    .update({
      status: "cancelled",
      payment_status: "failed",
      cancelled_at: new Date().toISOString(),
      cancellation_reason: reason,
    })
    .eq("id", bookingId)
    .eq("status", "awaiting_payment")

  if (error) {
    // Nothing left to do inside the request; the slot stays reserved until an operator or the
    // stale-reservation sweeper clears it. Make sure it is visible in the logs.
    console.error("[checkout] failed to release booking", bookingId, error.message)
  }
}

async function cancelIntentQuietly(paymentIntentId: string): Promise<void> {
  try {
    await stripe.paymentIntents.cancel(paymentIntentId)
  } catch {
    // Already canceled, already succeeded, or unreachable — the webhook reconciles either way.
  }
}

interface ResumeInput {
  pitchId: string
  userId: string
  timeRange: string
  quote: BookingQuote
  publishableKey: string
}

/**
 * A double-clicked checkout loses the race against ITSELF: the first request already reserved
 * the slot, so the second hits 23P01. Returning "slot taken" there would be a lie. If the row in
 * the way belongs to the same user and already has a PaymentIntent that is still payable, hand
 * back the same client secret — the idempotency key guarantees it is the same intent.
 */
async function resumeOwnCheckout(
  admin: AdminClient,
  input: ResumeInput,
): Promise<CheckoutResult | null> {
  const { data: existing } = await admin
    .from("bookings")
    .select(
      "id, status, stripe_payment_intent_id, subtotal_minor, platform_fee_minor, total_minor, currency, time_range",
    )
    .eq("pitch_id", input.pitchId)
    .eq("booked_by", input.userId)
    .in("status", ["pending", "awaiting_payment"])
    .filter("time_range", "ov", input.timeRange)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!existing?.stripe_payment_intent_id) return null

  // The overlap filter finds the row that BLOCKED the insert, which is not necessarily the row
  // the caller asked for: their own 19:00 hold also blocks a 19:30 request. Only an IDENTICAL
  // window is the double-click this function exists for — a partial overlap must fall through to
  // the 409, or the customer is handed (and charged for) a reservation they never picked.
  if (!sameWindow(existing.time_range, input.timeRange)) return null

  try {
    const intent = await stripe.paymentIntents.retrieve(existing.stripe_payment_intent_id)
    if (!intent.client_secret) return null
    if (intent.status === "canceled" || intent.status === "succeeded") return null

    // Echo the amounts that are actually attached to the intent, not the freshly computed
    // ones — a rate change between the two clicks must not make the UI disagree with Stripe.
    return {
      bookingId: existing.id,
      clientSecret: intent.client_secret,
      publishableKey: input.publishableKey,
      quote: {
        ...input.quote,
        subtotalMinor: asMinor(existing.subtotal_minor),
        platformFeeMinor: asMinor(existing.platform_fee_minor),
        totalMinor: asMinor(existing.total_minor),
        currency: existing.currency,
      },
    }
  } catch {
    return null
  }
}

/**
 * True when two `tstzrange` literals describe the same half-open window. Compared as parsed
 * instants rather than as strings: Postgres renders a range back with its own timestamp format
 * (space separator, truncated `+00` offset), which never matches the literal we sent.
 */
function sameWindow(stored: string, requested: string): boolean {
  try {
    const a = parseTstzRange(stored)
    const b = parseTstzRange(requested)
    return a.startsAt.getTime() === b.startsAt.getTime() && a.endsAt.getTime() === b.endsAt.getTime()
  } catch {
    return false
  }
}

async function recordAudit(
  admin: AdminClient,
  actorId: string,
  bookingId: string,
  metadata: Record<string, Json>,
): Promise<void> {
  const { error } = await admin.from("audit_log").insert({
    actor_id: actorId,
    action: "booking.checkout_started",
    entity_type: "booking",
    entity_id: bookingId,
    metadata,
  })
  if (error) console.error("[checkout] audit_log insert failed", error.message)
}
