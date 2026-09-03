/**
 * POST /api/stripe/webhook
 *
 * The one route where a mistake is a financial incident.
 *
 * UNAUTHENTICATED BY DESIGN — the HMAC signature over the raw bytes IS the authentication.
 * There is no user session here, so every write goes through `createAdminClient()` (service_role)
 * and therefore BYPASSES RLS. That is intentional and safe only because the request is proven to
 * come from Stripe. Two consequences the next person must keep true:
 *   - this route must never be reachable with a user JWT, and must never trust anything in the
 *     request other than the verified event payload (no query params, no headers, no body ids
 *     that were not signed);
 *   - `middleware.ts` must not try to refresh a session for this path — there is no cookie to
 *     refresh, and rewriting the request would corrupt the raw body the signature covers.
 *
 * ---------------------------------------------------------------------------
 * Local development
 * ---------------------------------------------------------------------------
 *   stripe listen --forward-to localhost:3000/api/stripe/webhook
 *   stripe trigger payment_intent.succeeded
 *
 * Copy the printed `whsec_…` into STRIPE_WEBHOOK_SECRET. `stripe listen` also forwards Connect
 * events, so in dev a single secret covers both endpoints.
 *
 * Production — register TWO endpoints in the dashboard:
 *
 *   1. Account endpoint  → STRIPE_WEBHOOK_SECRET
 *        payment_intent.succeeded
 *        payment_intent.payment_failed
 *        payment_intent.canceled
 *        charge.refunded
 *        charge.dispute.created
 *        checkout.session.completed
 *        application_fee.created
 *
 *   2. Connect endpoint  → STRIPE_CONNECT_WEBHOOK_SECRET
 *        account.updated
 *        payout.paid
 *        payout.failed
 *        (optional: payout.created, payout.updated)
 *
 * `account.updated` and `payout.*` are Connect events and arrive signed with the CONNECT
 * secret, which is why both secrets are tried below.
 *
 * ---------------------------------------------------------------------------
 * Status-code contract
 * ---------------------------------------------------------------------------
 * Stripe retries with exponential backoff for up to 3 days and guarantees AT-LEAST-ONCE
 * delivery — exactly-once PROCESSING is our job, and it is done with the `stripe_events` table.
 *   200 → verified and either processed or deliberately ignored (unknown type, event for
 *         another environment, duplicate). Never make Stripe retry something we chose to skip.
 *   400 → signature verification failed. No detail in the body: an attacker probing the
 *         endpoint learns nothing about why.
 *   500 → a genuinely retryable failure (the database was unreachable, a write failed). Only
 *         then do we want Stripe to come back.
 */

import { NextResponse, type NextRequest } from "next/server"
import type Stripe from "stripe"

import {
  isUniqueViolation,
  mapPayoutStatus,
  mapRefundStatus,
  mapStripeStatus,
} from "@/lib/payments"
import { stripe } from "@/lib/stripe"
import { createAdminClient } from "@/lib/supabase/admin"
import type { Database, Enums, Json, Tables, TablesUpdate } from "@onpitch/shared/database"
import type { SupabaseClient } from "@supabase/supabase-js"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type AdminClient = SupabaseClient<Database>

/** What a handler did, for the `stripe_events` ledger. */
interface Outcome {
  handled: boolean
  note?: string
}

const processed = (note?: string): Outcome => ({ handled: true, note })
const ignored = (note: string): Outcome => ({ handled: false, note })

/** Booking columns every handler works from. */
const BOOKING_COLUMNS =
  "id, pitch_id, booked_by, team_id, status, payment_status, total_minor, refunded_amount_minor, currency, stripe_payment_intent_id, stripe_charge_id, connected_account_id"

/** Derived from the generated Row type, so it cannot drift from `BOOKING_COLUMNS`. */
type BookingRow = Pick<
  Tables<"bookings">,
  | "id"
  | "pitch_id"
  | "booked_by"
  | "team_id"
  | "status"
  | "payment_status"
  | "total_minor"
  | "refunded_amount_minor"
  | "currency"
  | "stripe_payment_intent_id"
  | "stripe_charge_id"
  | "connected_account_id"
>

/* ========================================================================== */
/*  Entry point                                                               */
/* ========================================================================== */

export async function POST(request: NextRequest) {
  // RAW BODY, ALWAYS. The signature is an HMAC over the exact bytes Stripe sent. `req.json()`
  // would parse and re-serialise them — key order, whitespace and number formatting all change —
  // and `constructEvent` would then never verify. Read the text and hand those bytes to Stripe.
  const rawBody = await request.text()
  const signature = request.headers.get("stripe-signature")

  if (!signature) {
    return new NextResponse("Bad request", { status: 400 })
  }

  const verified = verifyEvent(rawBody, signature)
  if (!verified) {
    // Deliberately opaque: no reason, no echo of the payload.
    return new NextResponse("Bad request", { status: 400 })
  }
  const { event } = verified

  const admin = createAdminClient()

  /* ------------------------------------------------------------ idempotency */
  const claim = await claimEvent(admin, event, rawBody)
  if (claim === "duplicate") {
    // Already processed successfully. Return 200 immediately — replaying a payment_intent
    // handler is how a booking gets double-confirmed or a refund double-counted.
    return NextResponse.json({ received: true, duplicate: true })
  }
  if (claim === "unavailable") {
    // We could not even record the event; processing it now would risk doing the work twice.
    // 500 so Stripe redelivers once the database is back.
    return NextResponse.json({ error: "ledger_unavailable" }, { status: 500 })
  }

  /* --------------------------------------------------------------- dispatch */
  try {
    const outcome = await handleEvent(admin, event)
    await markProcessed(admin, event.id, outcome.note)
    return NextResponse.json({ received: true, handled: outcome.handled })
  } catch (error) {
    const message = errorMessage(error)
    console.error("[stripe-webhook] processing failed", event.id, event.type, message)
    await markFailed(admin, event.id, message)
    // `processed_at` stays NULL, so Stripe's next delivery re-runs the handler instead of
    // short-circuiting on the duplicate check. See `claimEvent`.
    return NextResponse.json({ error: "processing_failed" }, { status: 500 })
  }
}

/* ========================================================================== */
/*  Signature verification — two endpoints, two secrets                       */
/* ========================================================================== */

function verifyEvent(
  rawBody: string,
  signature: string,
): { event: Stripe.Event; endpoint: "account" | "connect" } | null {
  const candidates: Array<{ endpoint: "account" | "connect"; secret: string | undefined }> = [
    { endpoint: "account", secret: process.env.STRIPE_WEBHOOK_SECRET },
    { endpoint: "connect", secret: process.env.STRIPE_CONNECT_WEBHOOK_SECRET },
  ]

  for (const candidate of candidates) {
    if (!candidate.secret) continue
    try {
      const event = stripe.webhooks.constructEvent(rawBody, signature, candidate.secret)
      return { event, endpoint: candidate.endpoint }
    } catch {
      // Wrong secret for this endpoint, or a forgery. Try the other secret before giving up:
      // `account.updated` and `payout.*` are signed with the Connect endpoint's secret.
    }
  }
  return null
}

/* ========================================================================== */
/*  Exactly-once ledger                                                       */
/* ========================================================================== */

type ClaimResult = "claimed" | "duplicate" | "unavailable"

/**
 * Insert the event id FIRST. The primary key on `stripe_events.id` is the exactly-once guard:
 *
 *   - insert succeeds        → we own this delivery, process it.
 *   - insert conflicts (23505) and the row has `processed_at`  → already done, return 200.
 *   - insert conflicts and `processed_at IS NULL`              → a previous attempt failed
 *     midway; count the attempt and process it again. Short-circuiting on the mere existence of
 *     the row would silently drop every event whose first attempt errored.
 */
async function claimEvent(
  admin: AdminClient,
  event: Stripe.Event,
  rawBody: string,
): Promise<ClaimResult> {
  const payload = safeParseJson(rawBody)

  const { error } = await admin.from("stripe_events").insert({
    id: event.id,
    type: event.type,
    api_version: event.api_version ?? null,
    payload,
  })

  if (!error) return "claimed"

  if (!isUniqueViolation(error)) {
    console.error("[stripe-webhook] could not record event", event.id, error.message)
    return "unavailable"
  }

  const { data: existing, error: readError } = await admin
    .from("stripe_events")
    .select("id, processed_at, attempts")
    .eq("id", event.id)
    .maybeSingle()

  if (readError) {
    console.error("[stripe-webhook] could not read event ledger", event.id, readError.message)
    return "unavailable"
  }
  if (!existing) return "claimed"
  if (existing.processed_at) return "duplicate"

  await admin
    .from("stripe_events")
    .update({ attempts: existing.attempts + 1, received_at: new Date().toISOString() })
    .eq("id", event.id)

  return "claimed"
}

/**
 * Stamp the delivery as done. `processing_error` doubles as a note column here: on a processed
 * row it explains WHY an event was deliberately skipped (unknown type, foreign booking), and the
 * runbook only ever treats rows with `processed_at IS NULL` as failures.
 */
async function markProcessed(admin: AdminClient, eventId: string, note?: string): Promise<void> {
  const { error } = await admin
    .from("stripe_events")
    .update({ processed_at: new Date().toISOString(), processing_error: note ?? null })
    .eq("id", eventId)
  if (error) console.error("[stripe-webhook] could not mark processed", eventId, error.message)
}

async function markFailed(admin: AdminClient, eventId: string, message: string): Promise<void> {
  const { error } = await admin
    .from("stripe_events")
    .update({ processing_error: message.slice(0, 2_000) })
    .eq("id", eventId)
  if (error) console.error("[stripe-webhook] could not record failure", eventId, error.message)
}

/* ========================================================================== */
/*  Dispatch                                                                  */
/* ========================================================================== */

async function handleEvent(admin: AdminClient, event: Stripe.Event): Promise<Outcome> {
  switch (event.type) {
    case "payment_intent.succeeded":
      return onPaymentIntentSucceeded(admin, event.data.object as Stripe.PaymentIntent)
    case "payment_intent.payment_failed":
      return onPaymentIntentFailed(admin, event.data.object as Stripe.PaymentIntent)
    case "payment_intent.canceled":
      return onPaymentIntentCanceled(admin, event.data.object as Stripe.PaymentIntent)
    case "charge.refunded":
      return onChargeRefunded(admin, event.data.object as Stripe.Charge)
    case "charge.dispute.created":
      return onDisputeCreated(admin, event.data.object as Stripe.Dispute)
    case "checkout.session.completed":
      return onCheckoutSessionCompleted(admin, event.data.object as Stripe.Checkout.Session)
    case "account.updated":
      return onAccountUpdated(admin, event.data.object as Stripe.Account)
    case "payout.paid":
    case "payout.failed":
    case "payout.created":
    case "payout.updated":
      return onPayout(admin, event.data.object as Stripe.Payout, event.account ?? null)
    case "application_fee.created":
      return onApplicationFeeCreated(admin, event.data.object as Stripe.ApplicationFee)
    default:
      // Everything else is acknowledged and dropped. The ledger row keeps the payload, so an
      // event type we later decide to care about can be replayed from the dashboard.
      console.info("[stripe-webhook] unhandled event type", event.type, event.id)
      return ignored(`unhandled event type: ${event.type}`)
  }
}

/* -------------------------------------------------------------------------- */
/*  payment_intent.succeeded                                                   */
/* -------------------------------------------------------------------------- */

async function onPaymentIntentSucceeded(
  admin: AdminClient,
  intent: Stripe.PaymentIntent,
): Promise<Outcome> {
  const booking = await findBooking(admin, {
    bookingId: intent.metadata?.booking_id,
    paymentIntentId: intent.id,
  })
  if (!booking) return ignored(`no booking for payment intent ${intent.id}`)

  const chargeId = idOf(intent.latest_charge)
  const destination = idOf(intent.transfer_data?.destination ?? null)

  // The slot was already released (payment_failed arrived first, or the customer cancelled) but
  // the money landed anyway. NEVER silently re-confirm: the slot may belong to someone else now.
  // Record the truth about the payment, flag it loudly, and let a human refund it.
  if (booking.status === "cancelled" || booking.status === "refunded") {
    await admin
      .from("bookings")
      .update({
        payment_status: mapStripeStatus(intent.status),
        stripe_charge_id: chargeId ?? booking.stripe_charge_id,
        connected_account_id: destination ?? booking.connected_account_id,
      })
      .eq("id", booking.id)

    await admin.from("audit_log").insert({
      actor_id: null,
      action: "stripe.payment_succeeded_on_released_booking",
      entity_type: "booking",
      entity_id: booking.id,
      metadata: {
        payment_intent_id: intent.id,
        charge_id: chargeId,
        amount_minor: intent.amount_received ?? intent.amount,
        booking_status: booking.status,
      },
    })

    await notify(admin, [
      {
        user_id: booking.booked_by,
        type: "booking.payment_needs_review",
        title: "İptal edilmiş rezervasyona ödeme geldi",
        body: "Ödemen, rezervasyon serbest bırakıldıktan sonra ulaştı. Destek ekibi iade edecek.",
        data: { booking_id: booking.id, payment_intent_id: intent.id },
      },
    ])

    return ignored("payment succeeded on a released booking; flagged for manual refund")
  }

  const { data: confirmed, error } = await admin
    .from("bookings")
    .update({
      status: "confirmed",
      payment_status: mapStripeStatus(intent.status),
      stripe_charge_id: chargeId ?? booking.stripe_charge_id,
      stripe_payment_intent_id: intent.id,
      connected_account_id: destination ?? booking.connected_account_id,
    })
    .eq("id", booking.id)
    .in("status", ["pending", "awaiting_payment", "confirmed"])
    .select("id, status")
    .maybeSingle()

  if (error) throw new Error(`booking confirm failed: ${error.message}`)
  if (!confirmed) return ignored(`booking ${booking.id} was not in a confirmable state`)

  const venue = await loadVenueForPitch(admin, booking.pitch_id)
  const rows: NotificationRow[] = [
    {
      user_id: booking.booked_by,
      type: "booking.confirmed",
      title: "Rezervasyonun onaylandı",
      body: `Payment received. Your pitch at ${venue?.name ?? "the venue"} is reserved.`,
      data: { booking_id: booking.id, payment_intent_id: intent.id },
    },
  ]
  if (venue && venue.owner_id !== booking.booked_by) {
    rows.push({
      user_id: venue.owner_id,
      type: "booking.confirmed",
      title: "Yeni ödenmiş rezervasyon",
      body: `A pitch at ${venue.name} has been booked and paid for.`,
      data: { booking_id: booking.id, payment_intent_id: intent.id },
    })
  }
  await notify(admin, rows)

  return processed()
}

/* -------------------------------------------------------------------------- */
/*  payment_intent.payment_failed / .canceled                                  */
/* -------------------------------------------------------------------------- */

async function onPaymentIntentFailed(
  admin: AdminClient,
  intent: Stripe.PaymentIntent,
): Promise<Outcome> {
  const booking = await findBooking(admin, {
    bookingId: intent.metadata?.booking_id,
    paymentIntentId: intent.id,
  })
  if (!booking) return ignored(`no booking for payment intent ${intent.id}`)

  const declineMessage = intent.last_payment_error?.message ?? "The payment was declined."

  // Release the slot. A reservation nobody can pay for must not sit on the calendar, so the
  // booking is cancelled rather than left pending — the customer starts a fresh checkout, which
  // is also what re-prices and re-checks availability. To close the door on the released intent
  // succeeding later, the intent itself is cancelled below; if that race is lost,
  // `payment_intent.succeeded` above detects the released booking and flags it.
  //
  // TRADE-OFF: a declined card therefore costs the customer a new checkout instead of a retry on
  // the same Payment Element. The softer alternative is to leave the booking in
  // `awaiting_payment` with `payment_status = 'failed'` and let a scheduled sweeper expire stale
  // reservations — do that only once such a sweeper exists, or slots will be held by dead
  // reservations.
  const { data: released, error } = await admin
    .from("bookings")
    .update({
      status: "cancelled",
      payment_status: "failed",
      cancelled_at: new Date().toISOString(),
      cancellation_reason: `Payment failed: ${declineMessage}`.slice(0, 500),
    })
    .eq("id", booking.id)
    .in("status", ["pending", "awaiting_payment"])
    .select("id")
    .maybeSingle()

  if (error) throw new Error(`booking release failed: ${error.message}`)
  if (!released) return ignored(`booking ${booking.id} was no longer awaiting payment`)

  try {
    await stripe.paymentIntents.cancel(intent.id, { cancellation_reason: "abandoned" })
  } catch {
    // Not cancelable (already canceled, or already succeeded in the meantime). Either way the
    // succeeded handler covers the dangerous case.
  }

  await notify(admin, [
    {
      user_id: booking.booked_by,
      type: "booking.payment_failed",
      title: "Ödeme başarısız",
      body: `${declineMessage} The slot has been released — please try booking again.`,
      data: { booking_id: booking.id, payment_intent_id: intent.id },
    },
  ])

  return processed()
}

async function onPaymentIntentCanceled(
  admin: AdminClient,
  intent: Stripe.PaymentIntent,
): Promise<Outcome> {
  const booking = await findBooking(admin, {
    bookingId: intent.metadata?.booking_id,
    paymentIntentId: intent.id,
  })
  if (!booking) return ignored(`no booking for payment intent ${intent.id}`)

  const { data: released, error } = await admin
    .from("bookings")
    .update({
      status: "cancelled",
      payment_status: "failed",
      cancelled_at: new Date().toISOString(),
      cancellation_reason: "The payment was cancelled before it completed.",
    })
    .eq("id", booking.id)
    .in("status", ["pending", "awaiting_payment"])
    .select("id")
    .maybeSingle()

  if (error) throw new Error(`booking release failed: ${error.message}`)
  return released ? processed() : ignored(`booking ${booking.id} was already settled`)
}

/* -------------------------------------------------------------------------- */
/*  charge.refunded                                                            */
/* -------------------------------------------------------------------------- */

async function onChargeRefunded(admin: AdminClient, charge: Stripe.Charge): Promise<Outcome> {
  const booking = await findBooking(admin, {
    bookingId: charge.metadata?.booking_id,
    paymentIntentId: idOf(charge.payment_intent),
    chargeId: charge.id,
  })
  if (!booking) return ignored(`no booking for charge ${charge.id}`)

  const refundedMinor = Math.max(charge.amount_refunded ?? 0, booking.refunded_amount_minor)
  const paymentStatus = mapRefundStatus(refundedMinor, charge.amount ?? booking.total_minor)
  const fullyRefunded = paymentStatus === "refunded"

  const update: TablesUpdate<"bookings"> = {
    payment_status: paymentStatus,
    refunded_amount_minor: Math.min(refundedMinor, booking.total_minor),
    stripe_charge_id: charge.id,
  }
  // A fully refunded booking is terminal; `refunded` also sits outside the double-booking
  // exclusion predicate, so the slot is free again. A partial refund leaves the status alone —
  // it is usually already `cancelled`, set by the cancel route.
  if (fullyRefunded) update.status = "refunded"

  const { error } = await admin.from("bookings").update(update).eq("id", booking.id)

  if (error) throw new Error(`refund update failed: ${error.message}`)

  const venue = await loadVenueForPitch(admin, booking.pitch_id)
  const rows: NotificationRow[] = [
    {
      user_id: booking.booked_by,
      type: "booking.refunded",
      title: fullyRefunded ? "Refund issued" : "Partial refund issued",
      body: `Rezervasyonun at ${venue?.name ?? "the venue"} has been refunded.`,
      data: {
        booking_id: booking.id,
        refunded_amount_minor: refundedMinor,
        currency: booking.currency,
      },
    },
  ]
  if (venue && venue.owner_id !== booking.booked_by) {
    rows.push({
      user_id: venue.owner_id,
      type: "booking.refunded",
      title: "Bir rezervasyon iade edildi",
      body: `A booking at ${venue.name} has been refunded.`,
      data: {
        booking_id: booking.id,
        refunded_amount_minor: refundedMinor,
        currency: booking.currency,
      },
    })
  }
  await notify(admin, rows)

  return processed()
}

/* -------------------------------------------------------------------------- */
/*  charge.dispute.created                                                     */
/* -------------------------------------------------------------------------- */

async function onDisputeCreated(admin: AdminClient, dispute: Stripe.Dispute): Promise<Outcome> {
  const booking = await findBooking(admin, {
    paymentIntentId: idOf(dispute.payment_intent),
    chargeId: idOf(dispute.charge),
  })
  if (!booking) return ignored(`no booking for dispute ${dispute.id}`)

  // A chargeback is recorded, announced and answered by a human — it deliberately does NOT move
  // `bookings.status`.
  //
  // `disputed` sits OUTSIDE the `bookings_no_double_booking` exclusion predicate
  // (supabase/migrations/0001_schema.sql) and outside `OCCUPYING_BOOKING_STATUSES`
  // (lib/venue/metrics.ts), so writing it would put a paid, still-upcoming slot straight back on
  // sale the moment the chargeback opens — the venue would sell the pitch twice while the dispute
  // is still being answered. On a booking that had already been cancelled or refunded it would
  // additionally overwrite a terminal state, so a retried cancel would answer 409 instead of the
  // idempotent 200 and the row would stop counting as a cancellation.
  //
  // Moving the status here is only safe once `disputed` is added to the exclusion predicate AND
  // to the constants that mirror it byte for byte (web `OCCUPYING_BOOKING_STATUSES` and mobile
  // `SLOT_HOLDING_STATUSES`), all in the same change. Until then the audit row below plus the
  // owner notification are the record; the money side is already carried by `payment_status`.

  await admin.from("audit_log").insert({
    actor_id: null,
    action: "stripe.dispute_created",
    entity_type: "booking",
    entity_id: booking.id,
    metadata: {
      dispute_id: dispute.id,
      reason: dispute.reason,
      amount_minor: dispute.amount,
      currency: dispute.currency,
      // Evidence is due to Stripe by this date; missing it forfeits the dispute.
      evidence_due_by: dispute.evidence_details?.due_by ?? null,
    },
  })

  const venue = await loadVenueForPitch(admin, booking.pitch_id)
  if (venue) {
    await notify(admin, [
      {
        user_id: venue.owner_id,
        type: "booking.disputed",
        title: "Bir ödemeye itiraz ediliyor",
        body: `A booking at ${venue.name} is under dispute. The platform is handling the response.`,
        data: { booking_id: booking.id, dispute_id: dispute.id },
      },
    ])
  }

  return processed()
}

/* -------------------------------------------------------------------------- */
/*  checkout.session.completed                                                 */
/* -------------------------------------------------------------------------- */

async function onCheckoutSessionCompleted(
  admin: AdminClient,
  session: Stripe.Checkout.Session,
): Promise<Outcome> {
  // The Payment Element flow does not create Checkout Oturumlar, but hosted Checkout may be used
  // for one-off or admin-created bookings, so the linkage is handled here too.
  const booking = await findBooking(admin, {
    bookingId: session.metadata?.booking_id,
    paymentIntentId: idOf(session.payment_intent),
  })
  if (!booking) return ignored(`no booking for checkout session ${session.id}`)

  const paid = session.payment_status === "paid" || session.payment_status === "no_payment_required"

  const update: TablesUpdate<"bookings"> = {
    stripe_checkout_session_id: session.id,
    stripe_payment_intent_id: idOf(session.payment_intent) ?? booking.stripe_payment_intent_id,
    payment_status: paid ? "succeeded" : "requires_payment",
  }
  if (paid) update.status = "confirmed"

  const { error } = await admin
    .from("bookings")
    .update(update)
    .eq("id", booking.id)
    .in("status", ["pending", "awaiting_payment", "confirmed"])

  if (error) throw new Error(`checkout session update failed: ${error.message}`)
  return processed()
}

/* -------------------------------------------------------------------------- */
/*  account.updated (Connect endpoint)                                         */
/* -------------------------------------------------------------------------- */

async function onAccountUpdated(admin: AdminClient, account: Stripe.Account): Promise<Outcome> {
  const chargesEnabled = account.charges_enabled === true
  const payoutsEnabled = account.payouts_enabled === true
  const detailsSubmitted = account.details_submitted === true
  // A venue is only publishable when it can both take money and be paid out. If Stripe pulls
  // either capability (new requirements, verification lapse), the venue is unpublished — a pitch
  // that cannot be paid for must not appear as bookable.
  const shouldBeActive = chargesEnabled && payoutsEnabled

  const { data: venues, error: readError } = await admin
    .from("venues")
    .select("id, name, owner_id, charges_enabled, payouts_enabled, is_active, onboarding_completed_at")
    .eq("stripe_account_id", account.id)

  if (readError) throw new Error(`venue lookup failed: ${readError.message}`)
  if (!venues || venues.length === 0) {
    return ignored(`no venue linked to connected account ${account.id}`)
  }

  const nowIso = new Date().toISOString()
  for (const venue of venues) {
    const { error } = await admin
      .from("venues")
      .update({
        charges_enabled: chargesEnabled,
        payouts_enabled: payoutsEnabled,
        is_active: shouldBeActive,
        onboarding_completed_at:
          venue.onboarding_completed_at ?? (detailsSubmitted && shouldBeActive ? nowIso : null),
      })
      .eq("id", venue.id)

    if (error) throw new Error(`venue update failed: ${error.message}`)

    if (shouldBeActive && !venue.is_active) {
      await notify(admin, [
        {
          user_id: venue.owner_id,
          type: "venue.activated",
          title: "İşletmen yayında",
          body: `${venue.name} can now take bookings and receive payouts.`,
          data: { venue_id: venue.id },
        },
      ])
    } else if (!shouldBeActive && venue.is_active) {
      await notify(admin, [
        {
          user_id: venue.owner_id,
          type: "venue.deactivated",
          title: "Hakediş hesabında işlem gerekiyor",
          body: `${venue.name} has been unpublished because Stripe needs more information.`,
          data: {
            venue_id: venue.id,
            disabled_reason: account.requirements?.disabled_reason ?? null,
            currently_due: (account.requirements?.currently_due ?? []) as Json,
          },
        },
      ])
    }
  }

  return processed()
}

/* -------------------------------------------------------------------------- */
/*  payout.* (Connect endpoint)                                                */
/* -------------------------------------------------------------------------- */

async function onPayout(
  admin: AdminClient,
  payout: Stripe.Payout,
  connectedAccountId: string | null,
): Promise<Outcome> {
  // On a Connect event the account the payout belongs to is on the ENVELOPE, not the object.
  if (!connectedAccountId) return ignored(`payout ${payout.id} arrived without a connected account`)

  // A payout belongs to an ACCOUNT, not to a venue, and one connected account can back several
  // venues (connect/onboard: "one connected account per owner"), so `venue_payouts.venue_id`
  // cannot be right for all of them — `stripe_payout_id` is globally unique, so there is exactly
  // one row per payout. Until that key changes, pick the OLDEST venue deterministically rather
  // than whatever Postgres happened to return first, and say so in the log when it is ambiguous.
  const { data: venues, error: venueError } = await admin
    .from("venues")
    .select("id, name, owner_id")
    .eq("stripe_account_id", connectedAccountId)
    .order("created_at", { ascending: true })
    .limit(2)

  if (venueError) throw new Error(`venue lookup failed: ${venueError.message}`)
  const venue = venues?.[0]
  if (!venue) return ignored(`no venue linked to connected account ${connectedAccountId}`)
  if (venues.length > 1) {
    console.warn(
      "[stripe-webhook] connected account backs several venues; payout attributed to the oldest",
      { connected_account_id: connectedAccountId, payout_id: payout.id, venue_id: venue.id },
    )
  }

  const incomingStatus = mapPayoutStatus(payout.status)

  // Stripe redelivers for up to three days and does not order deliveries, so a `payout.created`
  // whose first attempt failed can be re-processed AFTER `payout.paid` has landed. Without this
  // read the upsert below would regress a settled row to `pending` and nothing would correct it.
  const { data: existing, error: existingError } = await admin
    .from("venue_payouts")
    .select("status")
    .eq("stripe_payout_id", payout.id)
    .maybeSingle()

  if (existingError) throw new Error(`payout lookup failed: ${existingError.message}`)

  const status =
    existing && payoutStatusRank(existing.status) > payoutStatusRank(incomingStatus)
      ? existing.status
      : incomingStatus

  // `stripe_payout_id` is unique, so the upsert is the idempotency guard for this table: the
  // created → in_transit → paid sequence collapses onto one row.
  const { error } = await admin.from("venue_payouts").upsert(
    {
      venue_id: venue.id,
      stripe_payout_id: payout.id,
      connected_account_id: connectedAccountId,
      amount_minor: payout.amount,
      currency: payout.currency,
      status,
      arrival_date: unixToDateString(payout.arrival_date),
    },
    { onConflict: "stripe_payout_id" },
  )

  if (error) throw new Error(`payout upsert failed: ${error.message}`)

  if (status === "failed" && existing?.status !== "failed") {
    await notify(admin, [
      {
        user_id: venue.owner_id,
        type: "payout.failed",
        title: "Bir hakediş başarısız oldu",
        body: `A payout to ${venue.name} could not be completed. Check your bank details in the Stripe dashboard.`,
        data: {
          venue_id: venue.id,
          payout_id: payout.id,
          failure_message: payout.failure_message ?? null,
        },
      },
    ])
  }

  return processed()
}

/* -------------------------------------------------------------------------- */
/*  application_fee.created                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Payouts settle forwards only. `pending` → `in_transit` → `paid`/`failed`; a redelivered or
 * out-of-order event must never walk a row back down this ladder. `paid` and `failed` share a
 * rank because a settled payout CAN later be returned by the bank.
 */
function payoutStatusRank(status: Enums<"payout_status">): number {
  switch (status) {
    case "pending":
      return 0
    case "in_transit":
      return 1
    case "paid":
    case "failed":
      return 2
    default:
      return 0
  }
}

async function onApplicationFeeCreated(
  admin: AdminClient,
  fee: Stripe.ApplicationFee,
): Promise<Outcome> {
  const chargeId = idOf(fee.charge)
  if (!chargeId) return ignored(`application fee ${fee.id} has no charge`)

  // Fee objects carry none of OUR metadata, and `bookings.stripe_charge_id` is written by a
  // DIFFERENT event (`payment_intent.succeeded`). For a destination charge both events are
  // emitted at the same moment and Stripe guarantees no ordering, so matching on that column
  // alone dropped the fee id whenever this event arrived first — and `ignored()` then marks the
  // delivery processed, so it never came back. Retrieve the charge and resolve the booking the
  // way every other handler does. A Stripe failure throws so the event is retried.
  const charge = await stripe.charges.retrieve(chargeId)

  const booking = await findBooking(admin, {
    bookingId: charge.metadata?.booking_id,
    paymentIntentId: idOf(charge.payment_intent),
    chargeId,
  })
  // Still a miss: a genuinely foreign charge (one Stripe account serving several environments).
  // Acknowledge and drop, exactly as `findBooking` documents.
  if (!booking) return ignored(`no booking for charge ${chargeId}`)

  // The fee id is the reconciliation handle between a booking and the platform's revenue; it is
  // only knowable once the charge exists, which is why it is stamped here and not at checkout.
  // `stripe_charge_id` is stamped too — this handler may well be the first to learn it.
  const { error } = await admin
    .from("bookings")
    .update({ application_fee_id: fee.id, stripe_charge_id: chargeId })
    .eq("id", booking.id)

  if (error) throw new Error(`application fee update failed: ${error.message}`)
  return processed()
}

/* ========================================================================== */
/*  Shared helpers                                                            */
/* ========================================================================== */

interface BookingLookup {
  bookingId?: string | null
  paymentIntentId?: string | null
  chargeId?: string | null
}

/**
 * Resolve the booking an event belongs to. The metadata id set at checkout is tried first
 * because it survives every Stripe object hop; the payment-intent and charge ids are fallbacks
 * for events (and for objects created outside our checkout) that carry no metadata.
 *
 * A miss is NOT an error: the same Stripe account may serve several environments, so an event
 * for an unknown booking is acknowledged and ignored rather than retried for three days.
 */
async function findBooking(admin: AdminClient, lookup: BookingLookup): Promise<BookingRow | null> {
  if (lookup.bookingId && isUuid(lookup.bookingId)) {
    const { data } = await admin
      .from("bookings")
      .select(BOOKING_COLUMNS)
      .eq("id", lookup.bookingId)
      .maybeSingle()
    if (data) return data as BookingRow
  }

  if (lookup.paymentIntentId) {
    const { data } = await admin
      .from("bookings")
      .select(BOOKING_COLUMNS)
      .eq("stripe_payment_intent_id", lookup.paymentIntentId)
      .maybeSingle()
    if (data) return data as BookingRow
  }

  if (lookup.chargeId) {
    const { data } = await admin
      .from("bookings")
      .select(BOOKING_COLUMNS)
      .eq("stripe_charge_id", lookup.chargeId)
      .maybeSingle()
    if (data) return data as BookingRow
  }

  return null
}

async function loadVenueForPitch(
  admin: AdminClient,
  pitchId: string,
): Promise<{ id: string; name: string; owner_id: string } | null> {
  const { data: pitch } = await admin
    .from("pitches")
    .select("venue_id")
    .eq("id", pitchId)
    .maybeSingle()
  if (!pitch) return null

  const { data: venue } = await admin
    .from("venues")
    .select("id, name, owner_id")
    .eq("id", pitch.venue_id)
    .maybeSingle()
  return venue ?? null
}

interface NotificationRow {
  user_id: string
  type: string
  title: string
  body: string
  data: Record<string, Json>
}

/** Notifications are a side effect: a failure here must never fail the webhook. */
async function notify(admin: AdminClient, rows: NotificationRow[]): Promise<void> {
  if (rows.length === 0) return
  const { error } = await admin.from("notifications").insert(rows)
  if (error) console.error("[stripe-webhook] notification insert failed", error.message)
}

/** Stripe expandable fields arrive as either an id or the whole object. */
function idOf(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null
  return typeof value === "string" ? value : value.id
}

function unixToDateString(seconds: number | null | undefined): string | null {
  if (!seconds && seconds !== 0) return null
  const date = new Date(seconds * 1000)
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10)
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Metadata is attacker-influenced only through our own checkout, but it is still free text. */
function isUuid(value: string): boolean {
  return UUID_RE.test(value)
}

function safeParseJson(raw: string): Json {
  try {
    return JSON.parse(raw) as Json
  } catch {
    return { unparseable: true } as Json
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === "string" ? error : "Unknown webhook processing error"
}
