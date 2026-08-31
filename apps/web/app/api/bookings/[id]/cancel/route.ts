/**
 * POST /api/bookings/[id]/cancel
 *
 * Policy-aware cancellation. Outside the cancellation window the money comes back in full and
 * the platform gives up its application fee; inside the window only part of the total is
 * refunded and the platform keeps its fee. `refund_application_fee` and `reverse_transfer` are
 * decided here, on the server, from `lib/payments.ts` — a caller can supply a reason and
 * nothing else.
 *
 * IDEMPOTENT on three levels:
 *   1. A booking that is already cancelled/refunded returns its current state with a 200.
 *   2. `stripe.refunds.create` is keyed on the booking id, so a retried request can only ever
 *      produce one refund, even if two cancels race each other.
 *   3. The status update is conditional on the booking still being live, so a webhook that got
 *      there first is not clobbered.
 */

import type { NextRequest } from "next/server"
import type Stripe from "stripe"

import { fail, ok } from "@/lib/api-response"
import {
  mapRefundStatus,
  parseTstzRange,
  refundIdempotencyKey,
  resolveCancellationPolicy,
  type CancellationPolicy,
} from "@/lib/payments"
import { getSessionUser } from "@/lib/rbac"
import { describeStripeError, stripe } from "@/lib/stripe"
import { createAdminClient } from "@/lib/supabase/admin"
import { enforceRateLimit } from "@/lib/rate-limit"
import type { Database, Enums, Json } from "@halisaha/shared/database"
import type { SupabaseClient } from "@supabase/supabase-js"
import { API_ERROR_CODES, asMinor, cancelBookingSchema, type CancellationResult } from "@halisaha/shared/domain"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type AdminClient = SupabaseClient<Database>

/** Statuses a cancellation may still act on. Everything else is terminal. */
const CANCELLABLE: readonly Enums<"booking_status">[] = ["pending", "awaiting_payment", "confirmed"]
/** Statuses that mean the work is already done — answer idempotently instead of erroring. */
const ALREADY_DONE: readonly Enums<"booking_status">[] = ["cancelled", "refunded"]

export async function POST(request: NextRequest, context: { params: { id: string } }) {
  const bookingId = context.params.id

  const session = await getSessionUser()
  if (!session) {
    return fail(API_ERROR_CODES.UNAUTHENTICATED, "Rezervasyon iptal etmek için giriş yap.", 401)
  }

  // Budgets are counted in Postgres, not in this process — see lib/rate-limit.ts.
  const limited = await enforceRateLimit("booking_cancel")
  if (limited) return limited

  let payload: unknown = {}
  const raw = await request.text()
  if (raw.trim().length > 0) {
    try {
      payload = JSON.parse(raw)
    } catch {
      return fail(API_ERROR_CODES.VALIDATION_FAILED, "İstek gövdesi geçerli JSON olmalı.", 400)
    }
  }
  const parsed = cancelBookingSchema.safeParse(payload)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
      .join("; ")
    return fail(API_ERROR_CODES.VALIDATION_FAILED, `Invalid cancellation request. ${detail}`, 422)
  }

  // service_role: this route writes payment_status, refunded_amount_minor and Stripe ids, all
  // of which are unreachable from a user session by design (see the UPDATE grant in 0002_rls).
  // Authorisation is therefore re-implemented here rather than delegated to RLS.
  const admin = createAdminClient()

  const { data: booking, error: bookingError } = await admin
    .from("bookings")
    .select(
      "id, pitch_id, booked_by, team_id, status, payment_status, total_minor, refunded_amount_minor, currency, time_range, stripe_payment_intent_id, stripe_charge_id, connected_account_id, cancelled_at",
    )
    .eq("id", bookingId)
    .maybeSingle()

  if (bookingError) {
    return fail(API_ERROR_CODES.INTERNAL, "Bu rezervasyon yüklenemedi.", 500)
  }
  if (!booking) {
    return fail(API_ERROR_CODES.NOT_FOUND, "Böyle bir rezervasyon yok.", 404)
  }

  const venue = await loadVenueForPitch(admin, booking.pitch_id)
  const isBooker = booking.booked_by === session.user.id
  const isVenueOwner = venue?.owner_id === session.user.id
  const isAdmin = session.profile.role === "admin"
  if (!isBooker && !isVenueOwner && !isAdmin) {
    return fail(API_ERROR_CODES.FORBIDDEN, "Bu rezervasyonu iptal etme yetkin yok.", 403)
  }

  /* --------------------------------------------------------- idempotency #1 */
  if (ALREADY_DONE.includes(booking.status)) {
    return ok(toResult(booking))
  }
  if (!CANCELLABLE.includes(booking.status)) {
    return fail(
      API_ERROR_CODES.FORBIDDEN,
      `A booking in state "${booking.status}" can no longer be cancelled here.`,
      409,
    )
  }

  /* ------------------------------------------------------------ the policy */
  let kickoffAt: Date
  try {
    kickoffAt = parseTstzRange(booking.time_range).startsAt
  } catch {
    return fail(API_ERROR_CODES.INTERNAL, "Bu rezervasyonun saat aralığı okunamıyor.", 500)
  }

  const policy = resolveCancellationPolicy({
    kickoffAt,
    totalMinor: booking.total_minor,
    alreadyRefundedMinor: booking.refunded_amount_minor,
  })

  const reason =
    parsed.data.reason ??
    (policy.reasonCode === "outside_window"
      ? "Cancelled by the customer outside the cancellation window."
      : "Cancelled by the customer inside the cancellation window.")

  /* ------------------------------------------------------------ the money */
  let refundedThisCall = 0
  let paymentStatus: Enums<"payment_status"> = booking.payment_status

  // Refundability, not one exact string: a booking that was already PARTIALLY refunded (a
  // dashboard refund lands as `partially_refunded` via charge.refunded, which deliberately
  // leaves `status` alone) still has money left to give back, and gating on "succeeded" alone
  // silently cancelled it with no refund at all.
  const isRefundablePaymentStatus =
    booking.payment_status === "succeeded" || booking.payment_status === "partially_refunded"

  if (isRefundablePaymentStatus && booking.stripe_payment_intent_id) {
    if (policy.refundMinor > 0) {
      try {
        const refund = await createRefund(
          booking.stripe_payment_intent_id,
          bookingId,
          policy,
          reason,
          booking.refunded_amount_minor,
        )
        refundedThisCall = refund.amount ?? 0
      } catch (error) {
        // Log the detail (request id included) and return the stable code — a raw Stripe
        // message is not guaranteed to be safe to show a customer.
        console.error("[cancel] refunds.create failed", bookingId, describeStripeError(error))
        return fail(
          API_ERROR_CODES.STRIPE_ERROR,
          "İade tamamlanamadı. Hiçbir şey değişmedi — lütfen tekrar dene.",
          502,
        )
      }
    }
    paymentStatus = mapRefundStatus(
      booking.refunded_amount_minor + refundedThisCall,
      booking.total_minor,
    )
  } else if (booking.stripe_payment_intent_id) {
    // Nothing was captured. Cancel the intent so an in-flight authorisation cannot land on a
    // booking that no longer holds the slot.
    try {
      await stripe.paymentIntents.cancel(booking.stripe_payment_intent_id, {
        cancellation_reason: "abandoned",
      })
    } catch {
      // Already canceled, already succeeded, or not cancelable in its current state. The
      // webhook reconciles either way; a failure here must not block the cancellation.
    }
    // Only an uncaptured payment is demoted to `failed`; a payment_status that already records
    // a refund (set by the charge.refunded webhook) must not be overwritten here.
    if (booking.payment_status === "requires_payment" || booking.payment_status === "processing") {
      paymentStatus = "failed"
    }
  }

  const refundedTotal = booking.refunded_amount_minor + refundedThisCall

  /* ------------------------------------------------------------ the record */
  // `cancelled` sits outside the exclusion constraint's status predicate, so committing this
  // frees the slot for someone else immediately. Conditional on the booking still being live so
  // a webhook that arrived first is never overwritten.
  const { data: updated, error: updateError } = await admin
    .from("bookings")
    .update({
      status: "cancelled",
      payment_status: paymentStatus,
      cancelled_at: new Date().toISOString(),
      cancellation_reason: reason,
      refunded_amount_minor: refundedTotal,
    })
    .eq("id", bookingId)
    .in("status", [...CANCELLABLE])
    .select(
      "id, status, payment_status, refunded_amount_minor, currency, total_minor, booked_by, pitch_id",
    )
    .maybeSingle()

  if (updateError) {
    // The refund may already have gone through — never retry the money, surface the state.
    console.error("[cancel] booking update failed after refund", bookingId, updateError.message)
    return fail(
      API_ERROR_CODES.INTERNAL,
      "İade talebi iletildi ama rezervasyon güncellenemedi. Destek ekibine bildirildi.",
      500,
    )
  }

  if (!updated) {
    // Someone (a webhook, a parallel cancel) moved the booking first. Report what is true now.
    const { data: current } = await admin
      .from("bookings")
      .select("id, status, payment_status, refunded_amount_minor, currency, total_minor")
      .eq("id", bookingId)
      .maybeSingle()
    return ok(
      toResult(
        current ?? {
          id: booking.id,
          status: "cancelled",
          payment_status: paymentStatus,
          refunded_amount_minor: refundedTotal,
          currency: booking.currency,
          total_minor: booking.total_minor,
        },
      ),
    )
  }

  await Promise.all([
    notifyCancellation(admin, {
      bookingId,
      bookerId: updated.booked_by,
      venueOwnerId: venue?.owner_id ?? null,
      venueName: venue?.name ?? "the venue",
      refundedMinor: refundedTotal,
      currency: updated.currency,
      policy,
    }),
    admin.from("audit_log").insert({
      actor_id: session.user.id,
      action: "booking.cancelled",
      entity_type: "booking",
      entity_id: bookingId,
      metadata: {
        reason,
        policy: policy.reasonCode,
        window_hours: policy.windowHours,
        hours_until_kickoff: Number(policy.hoursUntilKickoff.toFixed(2)),
        refund_minor: refundedThisCall,
        refunded_total_minor: refundedTotal,
        refund_application_fee: policy.refundApplicationFee,
        reverse_transfer: policy.reverseTransfer,
      },
    }),
  ])

  return ok(toResult(updated))
}

/* ========================================================================== */
/*  Helpers                                                                   */
/* ========================================================================== */

interface RefundableBooking {
  id: string
  status: Enums<"booking_status">
  payment_status: Enums<"payment_status">
  refunded_amount_minor: number
  currency: string
  total_minor: number
}

function toResult(booking: RefundableBooking): CancellationResult {
  return {
    bookingId: booking.id,
    status: booking.status,
    paymentStatus: booking.payment_status,
    refundedAmountMinor: asMinor(booking.refunded_amount_minor),
    currency: booking.currency,
    fullRefund: booking.refunded_amount_minor >= booking.total_minor && booking.total_minor > 0,
  }
}

/**
 * Create the refund against the PaymentIntent.
 *
 * On a destination charge the refund is taken from the PLATFORM's balance, so both switches
 * matter:
 *   - `reverse_transfer: true` pulls the venue's proportional share back off the connected
 *     account, so the venue does not keep money for a slot it no longer has to provide.
 *   - `refund_application_fee` gives the platform's cut back too. True only outside the
 *     cancellation window; a late cancellation keeps the fee (see `resolveCancellationPolicy`).
 *
 * The idempotency key is derived from the booking id AND the amount already refunded, so two
 * concurrent cancels resolve to ONE refund (Stripe replays the first response instead of moving
 * money twice) while a later, genuinely different refund on the same booking is still allowed.
 */
async function createRefund(
  paymentIntentId: string,
  bookingId: string,
  policy: CancellationPolicy,
  reason: string,
  alreadyRefundedMinor: number,
): Promise<Stripe.Refund> {
  return stripe.refunds.create(
    {
      payment_intent: paymentIntentId,
      amount: policy.refundMinor,
      refund_application_fee: policy.refundApplicationFee,
      reverse_transfer: policy.reverseTransfer,
      metadata: {
        booking_id: bookingId,
        policy: policy.reasonCode,
        window_hours: String(policy.windowHours),
        reason: reason.slice(0, 200),
      },
    },
    { idempotencyKey: refundIdempotencyKey(bookingId, alreadyRefundedMinor) },
  )
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

interface CancellationNotice {
  bookingId: string
  bookerId: string
  venueOwnerId: string | null
  venueName: string
  refundedMinor: number
  currency: string
  policy: CancellationPolicy
}

async function notifyCancellation(admin: AdminClient, notice: CancellationNotice): Promise<void> {
  const data: Record<string, Json> = {
    booking_id: notice.bookingId,
    refunded_amount_minor: notice.refundedMinor,
    currency: notice.currency,
    policy: notice.policy.reasonCode,
  }

  const rows = [
    {
      user_id: notice.bookerId,
      type: "booking.cancelled",
      title: "Rezervasyon iptal edildi",
      body:
        notice.refundedMinor > 0
          ? `${notice.venueName} rezervasyonun iptal edildi, iadesi yolda.`
          : `${notice.venueName} rezervasyonun iptal edildi. İptal politikasına göre iade yapılmıyor.`,
      data,
    },
  ]
  if (notice.venueOwnerId && notice.venueOwnerId !== notice.bookerId) {
    rows.push({
      user_id: notice.venueOwnerId,
      type: "booking.cancelled",
      title: "Bir rezervasyon iptal edildi",
      body: `A booking at ${notice.venueName} was cancelled and the slot is available again.`,
      data,
    })
  }

  const { error } = await admin.from("notifications").insert(rows)
  if (error) console.error("[cancel] notification insert failed", error.message)
}
