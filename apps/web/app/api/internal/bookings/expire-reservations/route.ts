/**
 * app/api/internal/bookings/expire-reservations/route.ts
 *
 *   POST /api/internal/bookings/expire-reservations
 *
 * The stale-reservation sweeper the rest of the booking code already assumes exists — see
 * `releaseBooking()` in app/api/bookings/checkout/route.ts and the TRADE-OFF note in
 * `onPaymentIntentFailed()` in app/api/stripe/webhook/route.ts.
 *
 * ── Why a route and not a pg_cron job ───────────────────────────────────────
 * `POST /api/bookings/checkout` inserts the booking as `awaiting_payment`, which IS inside the
 * `bookings_no_double_booking` exclusion predicate, so the row holds the slot from the moment it
 * commits. If the customer then closes the tab, Stripe emits NO event — no `payment_failed`, no
 * `canceled` — so no webhook ever fires and the slot is held forever.
 *
 * Marking the row `cancelled` is only half the job: the PaymentIntent stays payable, and a card
 * completed later would land `payment_intent.succeeded` on a released booking, which the webhook
 * (correctly) routes to the manual-refund path. pg_cron cannot call Stripe, so the sweep lives
 * here: the intent is cancelled FIRST, and the reservation is only released once the intent can
 * no longer take money.
 *
 * ── Not publicly callable ───────────────────────────────────────────────────
 * Guarded by `INTERNAL_API_TOKEN` (Bearer, or `X-Internal-Token`) compared with
 * `timingSafeEqual`, exactly like /api/internal/anomaly/check. There is no user session: the
 * sweep writes `status`, `payment_status` and `cancelled_at`, none of which an end-user session
 * may write (see the UPDATE grant in 0002_rls), so it runs as service_role.
 *
 * ── Scheduling ──────────────────────────────────────────────────────────────
 * Invoke on a short interval (every 5 minutes is ample) from whatever scheduler fronts the
 * deployment. Each call sweeps at most `MAX_BATCH` reservations, oldest first, so a backlog
 * drains over successive runs instead of holding one request open.
 */

import { Buffer } from "node:buffer"
import { timingSafeEqual } from "node:crypto"

import { ApiRouteError, handleRoute, ok } from "@/lib/api-response"
import { describeStripeError, stripe } from "@/lib/stripe"
import { createAdminClient } from "@/lib/supabase/admin"
import type { Database, Json } from "@halisaha/shared/database"
import type { SupabaseClient } from "@supabase/supabase-js"
import { API_ERROR_CODES } from "@halisaha/shared/domain"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type AdminClient = SupabaseClient<Database>

/**
 * How long an unpaid reservation may hold a slot. Comfortably longer than a card payment takes
 * (3-D Secure included) and far shorter than a slot is worth losing.
 */
const DEFAULT_TTL_MINUTES = 30

/** Bound the work per invocation so one call cannot run past the platform's request timeout. */
const MAX_BATCH = 200

const RELEASE_REASON = "The reservation expired before it was paid for."

interface SweepReport {
  /** Reservations older than the TTL that this run looked at. */
  examined: number
  /** Slots actually freed. */
  released: number
  /** Left alone because the payment turned out to have succeeded. */
  paid: number
  /** Left alone because Stripe could not confirm the intent is dead; retried next run. */
  deferred: number
  ttlMinutes: number
  cutoff: string
}

export async function POST(request: Request): Promise<Response> {
  return handleRoute<SweepReport>(async () => {
    requireInternalToken(request)

    const ttlMinutes = resolveTtlMinutes()
    const cutoff = new Date(Date.now() - ttlMinutes * 60_000).toISOString()
    const admin = createAdminClient()

    const { data: stale, error } = await admin
      .from("bookings")
      .select("id, booked_by, stripe_payment_intent_id, created_at")
      .eq("status", "awaiting_payment")
      .lt("created_at", cutoff)
      .order("created_at", { ascending: true })
      .limit(MAX_BATCH)

    if (error) {
      throw new ApiRouteError(
        API_ERROR_CODES.INTERNAL,
        "Zaman aşımına uğramış rezervasyonlar okunamadı.",
        500,
      )
    }

    const report: SweepReport = {
      examined: stale?.length ?? 0,
      released: 0,
      paid: 0,
      deferred: 0,
      ttlMinutes,
      cutoff,
    }
    if (!stale || stale.length === 0) return ok<SweepReport>(report)

    const auditRows: Array<Record<string, Json>> = []

    for (const booking of stale) {
      // Kill the intent BEFORE freeing the slot. Releasing first would open a window in which
      // the customer pays for a slot that has already been handed to someone else.
      if (booking.stripe_payment_intent_id) {
        const outcome = await settleIntent(booking.stripe_payment_intent_id)
        if (outcome === "succeeded") {
          // The card went through in the meantime; `payment_intent.succeeded` will confirm the
          // booking. Never release a paid reservation.
          report.paid += 1
          continue
        }
        if (outcome === "undecided") {
          report.deferred += 1
          continue
        }
      }

      // Conditional on the row still being `awaiting_payment`, so a webhook that got there first
      // is never clobbered. `cancelled` sits outside the exclusion predicate, so the commit frees
      // the slot immediately.
      const { data: released, error: releaseError } = await admin
        .from("bookings")
        .update({
          status: "cancelled",
          payment_status: "failed",
          cancelled_at: new Date().toISOString(),
          cancellation_reason: RELEASE_REASON,
        })
        .eq("id", booking.id)
        .eq("status", "awaiting_payment")
        .select("id")
        .maybeSingle()

      if (releaseError) {
        console.error(
          "[api/internal/expire-reservations] release failed",
          booking.id,
          releaseError.message,
        )
        report.deferred += 1
        continue
      }
      if (!released) continue

      report.released += 1
      auditRows.push({
        booking_id: booking.id,
        payment_intent_id: booking.stripe_payment_intent_id,
        reserved_at: booking.created_at,
        ttl_minutes: ttlMinutes,
      })
    }

    await recordAudit(admin, auditRows)
    return ok<SweepReport>(report)
  })
}

/* ========================================================================== */
/*  The Stripe half                                                           */
/* ========================================================================== */

type IntentOutcome = "dead" | "succeeded" | "undecided"

/**
 * Put the PaymentIntent beyond use, and report honestly when that could not be established.
 *
 *   `dead`      — cancelled, or already cancelled. No money can arrive on it.
 *   `succeeded` — it was paid. The booking must NOT be released.
 *   `undecided` — Stripe was unreachable, or the intent is mid-flight (`processing`,
 *                 `requires_capture`) and money may still land. Leave the slot reserved and let
 *                 the next run decide; a slot held for another five minutes is a far smaller
 *                 problem than a charge against a released booking.
 */
async function settleIntent(paymentIntentId: string): Promise<IntentOutcome> {
  try {
    const intent = await stripe.paymentIntents.cancel(paymentIntentId, {
      cancellation_reason: "abandoned",
    })
    return intent.status === "succeeded" ? "succeeded" : "dead"
  } catch (cancelError) {
    // `cancel` throws for an intent that is not cancelable — which covers both the safe case
    // (already canceled) and the dangerous one (already succeeded). Read the truth back.
    try {
      const intent = await stripe.paymentIntents.retrieve(paymentIntentId)
      if (intent.status === "succeeded") return "succeeded"
      if (intent.status === "canceled") return "dead"
      return "undecided"
    } catch (retrieveError) {
      console.error(
        "[api/internal/expire-reservations] could not settle payment intent",
        paymentIntentId,
        describeStripeError(cancelError),
        describeStripeError(retrieveError),
      )
      return "undecided"
    }
  }
}

/* ========================================================================== */
/*  Authentication                                                            */
/* ========================================================================== */

/**
 * Constant-time comparison against `INTERNAL_API_TOKEN`, mirroring
 * /api/internal/anomaly/check. `timingSafeEqual` throws on unequal lengths — which would itself
 * leak the secret's length — so lengths are compared first and a mismatch answers the same
 * generic 401. A missing env var is a 503: "not configured" and "not allowed" are different
 * facts, and conflating them makes the misconfiguration undebuggable.
 */
function requireInternalToken(request: Request): void {
  const expected = process.env.INTERNAL_API_TOKEN
  if (!expected) {
    console.error(
      "[api/internal/expire-reservations] INTERNAL_API_TOKEN is not set; refusing all callers",
    )
    throw new ApiRouteError(API_ERROR_CODES.INTERNAL, "Bu uç nokta yapılandırılmamış.", 503)
  }

  const header = request.headers.get("authorization")
  const bearer = header?.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : null
  const presented = bearer ?? request.headers.get("x-internal-token")

  if (!presented || !constantTimeEquals(presented, expected)) {
    throw new ApiRouteError(API_ERROR_CODES.FORBIDDEN, "Yetkin yok.", 401)
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8")
  const right = Buffer.from(b, "utf8")
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/* ========================================================================== */
/*  Helpers                                                                   */
/* ========================================================================== */

/** `BOOKING_RESERVATION_TTL_MINUTES`, clamped to something sane. */
function resolveTtlMinutes(): number {
  const raw = process.env.BOOKING_RESERVATION_TTL_MINUTES
  if (!raw) return DEFAULT_TTL_MINUTES
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return DEFAULT_TTL_MINUTES
  // Never below 10 minutes: a 3-D Secure challenge on a slow phone can take several.
  return Math.min(Math.max(parsed, 10), 24 * 60)
}

/** The audit trail is a side effect: a failure here must not fail a sweep that already ran. */
async function recordAudit(admin: AdminClient, rows: Array<Record<string, Json>>): Promise<void> {
  if (rows.length === 0) return
  const { error } = await admin.from("audit_log").insert(
    rows.map((metadata) => ({
      actor_id: null,
      action: "booking.reservation_expired",
      entity_type: "booking",
      entity_id: typeof metadata.booking_id === "string" ? metadata.booking_id : null,
      metadata,
    })),
  )
  if (error) {
    console.error("[api/internal/expire-reservations] audit_log insert failed", error.message)
  }
}
