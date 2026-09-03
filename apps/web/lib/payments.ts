/**
 * lib/payments.ts
 *
 * The money layer: pricing, the Stripe destination-charge parameter builder, the Stripe →
 * `payment_status` mapping, the cancellation/refund policy, and the small Postgres/range
 * helpers the booking routes need.
 *
 * ---------------------------------------------------------------------------
 * FEE MODEL — read this before touching any arithmetic
 * ---------------------------------------------------------------------------
 * The platform fee is taken **out of the venue's cut**, never added on top of the price the
 * player sees:
 *
 *     subtotalMinor    = slots x slotPrice                       (from pitches.hourly_rate_minor)
 *     platformFeeMinor = calculatePlatformFee(subtotalMinor)     // Stripe application_fee_amount
 *     totalMinor       = subtotalMinor                           // what the CARD is charged
 *     venue receives     totalMinor - platformFeeMinor           // settled by transfer_data
 *
 * So a listed 600.00 TRY pitch costs the player exactly 600.00 TRY; at a 10% fee the venue
 * nets 540.00 TRY and the platform keeps 60.00 TRY. The alternative (fee-on-top, total =
 * subtotal + fee) is a valid destination-charge shape too and the schema permits it — the only
 * DB-level invariant is `platform_fee_minor <= total_minor` — but a marketplace that quotes a
 * price and then charges more at the last step loses conversion, so we do not do it. If this
 * ever flips, `quoteBooking()` is the single place to change.
 *
 * Every amount here is an INTEGER count of minor units (kurus). There is no floating-point
 * money math anywhere in this file: division happens once, inside `slotPriceMinor()`, and is
 * immediately rounded to an integer before it can compound.
 */

import type Stripe from "stripe"

import { calculatePlatformFee, PLATFORM_FEE_BPS } from "@/lib/stripe"
import type { Enums, Tables } from "@onpitch/shared/database"
import { asMinor, DEFAULT_CURRENCY, type BookingQuote, type MinorUnits } from "@onpitch/shared/domain"

/* ========================================================================== */
/*  Tunables                                                                  */
/* ========================================================================== */

/**
 * How long before kickoff a cancellation still earns a full refund. Inside the window the
 * booking is a no-show risk the venue cannot re-sell, so only part of the money comes back.
 */
export const CANCELLATION_WINDOW_HOURS = readNonNegativeNumberEnv(
  "BOOKING_CANCELLATION_WINDOW_HOURS",
  24,
)

/**
 * Basis points of `total_minor` refunded for a LATE cancellation (inside the window).
 * `5000` = 50%. Set to `0` for "no refund after the window", `10000` for "always full".
 */
export const LATE_CANCELLATION_REFUND_BPS = clampBps(
  readNonNegativeNumberEnv("BOOKING_LATE_CANCELLATION_REFUND_BPS", 5_000),
)

/**
 * Defensive floor so a misconfigured pitch cannot produce a PaymentIntent Stripe will reject —
 * every currency has a minimum charge amount. 1.00 TRY.
 */
export const MINIMUM_CHARGE_MINOR = 100

/** Clock-skew grace: a slot that started up to this long ago is still bookable. */
const PAST_SLOT_GRACE_MINUTES = 2

function readNonNegativeNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function clampBps(value: number): number {
  return Math.min(Math.max(Math.round(value), 0), 10_000)
}

/* ========================================================================== */
/*  Errors                                                                    */
/* ========================================================================== */

/** Codes `quoteBooking()` can refuse with. They map 1:1 onto `API_ERROR_CODES`. */
export type QuoteErrorCode = "PRICE_UNAVAILABLE" | "VALIDATION_FAILED"

/**
 * Thrown by `quoteBooking()`. Carries a machine-readable code so the route handler answers with
 * the right envelope instead of pattern-matching on a message.
 */
export class QuoteError extends Error {
  readonly code: QuoteErrorCode

  constructor(code: QuoteErrorCode, message: string) {
    super(message)
    this.name = "QuoteError"
    this.code = code
  }
}

/* ========================================================================== */
/*  Pricing                                                                   */
/* ========================================================================== */

/** The only pitch columns pricing depends on. Keeps callers free to select narrowly. */
export type PitchPricing = Pick<
  Tables<"pitches">,
  | "id"
  | "hourly_rate_minor"
  | "currency"
  | "slot_minutes"
  | "opening_time"
  | "closing_time"
  | "is_active"
>

export interface QuoteBookingInput {
  pitch: PitchPricing
  /** ISO-8601 instant or Date — inclusive lower bound of the half-open range. */
  startsAt: string | Date
  /** ISO-8601 instant or Date — exclusive upper bound. */
  endsAt: string | Date
  /** IANA zone from `venues.timezone`. Opening hours are wall clock in this zone. */
  timezone?: string
  /** Injectable clock; tests pass a fixed instant. */
  now?: Date
}

/**
 * Price of ONE slot, scaled from the pitch's hourly rate. Exported so an availability grid can
 * render exactly the number checkout will charge — two different roundings for the same slot is
 * how a marketplace ends up with a "the price changed at the last step" bug report.
 *
 * Rounds half up on the minor unit; a 60-minute grid on any hourly rate is exact.
 */
export function slotPriceMinor(hourlyRateMinor: number, slotMinutes: number): MinorUnits {
  if (!Number.isInteger(hourlyRateMinor) || hourlyRateMinor <= 0) {
    throw new QuoteError("PRICE_UNAVAILABLE", "This pitch has no valid hourly rate configured.")
  }
  if (!Number.isInteger(slotMinutes) || slotMinutes <= 0) {
    throw new QuoteError("PRICE_UNAVAILABLE", "This pitch has no valid slot length configured.")
  }
  // Integer arithmetic end to end: multiply first, then a single floor-with-bias rounding.
  return asMinor(Math.floor((hourlyRateMinor * slotMinutes + 30) / 60))
}

/**
 * Recompute a booking's price from the DATABASE row. The client sends a pitch and a window and
 * never an amount — this function is the only source of truth for what a booking costs, and
 * `POST /api/bookings/checkout` calls it on every attempt, including retries.
 *
 * Throws `QuoteError` when the window is unbookable: pitch inactive, outside opening hours, in
 * the past, or not a whole number of slots.
 */
export function quoteBooking(input: QuoteBookingInput): BookingQuote {
  const { pitch } = input
  const start = toDate(input.startsAt, "startsAt")
  const end = toDate(input.endsAt, "endsAt")
  const now = input.now ?? new Date()
  const timezone = input.timezone ?? "UTC"

  if (!pitch.is_active) {
    throw new QuoteError("PRICE_UNAVAILABLE", "This pitch is not currently bookable.")
  }

  const durationMinutes = (end.getTime() - start.getTime()) / 60_000
  if (!(durationMinutes > 0)) {
    throw new QuoteError("VALIDATION_FAILED", "The booking must end after it starts.")
  }
  if (!Number.isInteger(durationMinutes)) {
    throw new QuoteError("VALIDATION_FAILED", "A booking must be a whole number of minutes.")
  }

  const slotMinutes = pitch.slot_minutes
  if (durationMinutes % slotMinutes !== 0) {
    throw new QuoteError(
      "VALIDATION_FAILED",
      `This pitch is sold in ${slotMinutes}-minute slots; ${durationMinutes} minutes does not divide evenly.`,
    )
  }

  if (start.getTime() < now.getTime() - PAST_SLOT_GRACE_MINUTES * 60_000) {
    throw new QuoteError("PRICE_UNAVAILABLE", "That slot has already started.")
  }

  assertWithinOpeningHours(pitch, start, durationMinutes, timezone)

  // A whole number of slots is not enough: the start has to sit ON the grid too. 18:37 → 19:37 is
  // exactly one 60-minute slot, but its `time_range` overlaps both the 18:00 and the 19:00 slot,
  // so `bookings_no_double_booking` would take two slots off the calendar for the price of one.
  // Measured on the SAME projected axis the opening-hours check uses, not the raw 0..1439 wall
  // clock: on a schedule that wraps past midnight the grid keeps counting slots past 24:00, so a
  // 01:00 slot is minute 1500, not minute 60. Reading it raw rejects every post-midnight slot
  // whenever `slot_minutes` does not divide 1440.
  const openMinutes = timeToMinutes(pitch.opening_time)
  const startMinutes = projectedStartMinutes(pitch, start, timezone)
  const gridOffset = (((startMinutes - openMinutes) % slotMinutes) + slotMinutes) % slotMinutes
  if (gridOffset !== 0) {
    throw new QuoteError(
      "VALIDATION_FAILED",
      `This pitch is sold in ${slotMinutes}-minute slots starting at ${pitch.opening_time}.`,
    )
  }

  const slots = durationMinutes / slotMinutes
  const perSlot = slotPriceMinor(pitch.hourly_rate_minor, slotMinutes)
  const subtotalMinor = asMinor(perSlot * slots)

  // The fee is the Stripe `application_fee_amount` and comes OUT of the venue's cut, so the
  // customer's total IS the subtotal. Clamp defensively: the schema enforces
  // `platform_fee_minor <= total_minor`, and a fee larger than the charge is never sane.
  const platformFeeMinor = asMinor(
    Math.min(Math.max(Math.round(calculatePlatformFee(subtotalMinor)), 0), subtotalMinor),
  )
  const totalMinor = subtotalMinor

  if (totalMinor < MINIMUM_CHARGE_MINOR) {
    throw new QuoteError(
      "PRICE_UNAVAILABLE",
      "The computed price is below the minimum amount this currency can be charged.",
    )
  }

  return {
    pitchId: pitch.id,
    startsAt: start.toISOString(),
    endsAt: end.toISOString(),
    durationMinutes,
    hourlyRateMinor: asMinor(pitch.hourly_rate_minor),
    subtotalMinor,
    platformFeeMinor,
    totalMinor,
    currency: (pitch.currency || DEFAULT_CURRENCY).toLowerCase(),
  }
}

/** What the venue actually receives once Stripe splits the charge. */
export function venueNetMinor(quote: BookingQuote): MinorUnits {
  return asMinor(quote.totalMinor - quote.platformFeeMinor)
}

/* -------------------------------------------------------------------------- */
/*  Opening hours (wall clock in the venue timezone)                           */
/* -------------------------------------------------------------------------- */

/** `"08:00:00"` / `"08:00"` / `"24:00:00"` → minutes past local midnight. */
function timeToMinutes(value: string): number {
  const [h = "0", m = "0"] = value.split(":")
  const hours = Number(h)
  const minutes = Number(m)
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
    throw new QuoteError("PRICE_UNAVAILABLE", "This pitch has invalid opening hours configured.")
  }
  return hours * 60 + minutes
}

/**
 * Minutes past local midnight for an absolute instant, rendered in `timeZone`. Uses
 * `Intl.DateTimeFormat` so no timezone database has to ship with the app. An unknown zone
 * degrades to UTC rather than throwing — a price check must never 500 on a typo'd
 * `venues.timezone`.
 */
function wallClockMinutes(instant: Date, timeZone: string): number {
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat("tr-TR", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(instant)
  } catch {
    return instant.getUTCHours() * 60 + instant.getUTCMinutes()
  }
  const read = (type: "hour" | "minute") => Number(parts.find((p) => p.type === type)?.value ?? "0")
  // Some ICU versions still render midnight as "24" under hour12: false.
  return (read("hour") % 24) * 60 + read("minute")
}

/**
 * Minutes past local midnight for `start`, projected onto the continuous `[open, close + 24h)`
 * axis a wrapping schedule (`closing_time <= opening_time`, e.g. 22:00 → 04:00) lives on. A
 * 01:00 start under a 22:00 → 04:00 schedule is minute 1500, not minute 60.
 *
 * This is the SINGLE definition of that projection, and it is exactly the axis `openingMinutes()`
 * in `lib/booking/availability.ts` builds its grid on. Both the opening-hours bound and the
 * slot-grid alignment check in `quoteBooking()` go through it, so the two can no longer disagree
 * about where a post-midnight slot sits.
 */
export function projectedStartMinutes(
  pitch: Pick<PitchPricing, "opening_time" | "closing_time">,
  start: Date,
  timeZone: string,
): number {
  const open = timeToMinutes(pitch.opening_time)
  const close = timeToMinutes(pitch.closing_time)
  const wraps = close <= open
  const wallClock = wallClockMinutes(start, timeZone)
  return wraps && wallClock < close ? wallClock + 24 * 60 : wallClock
}

/**
 * The window must sit inside a single opening session. Schedules that wrap past midnight
 * (`closing_time <= opening_time`, e.g. 20:00 → 02:00) are supported by projecting the start
 * onto a continuous [open, close + 24h) axis.
 *
 * Elapsed minutes are used for the end bound rather than a second wall-clock reading: exact for
 * fixed-offset zones (Europe/Istanbul has had no DST since 2016), and off by the shift only for
 * a booking that straddles a DST boundary in a zone that still observes one.
 */
function assertWithinOpeningHours(
  pitch: PitchPricing,
  start: Date,
  durationMinutes: number,
  timeZone: string,
): void {
  const open = timeToMinutes(pitch.opening_time)
  const close = timeToMinutes(pitch.closing_time)
  const wraps = close <= open

  const startOffset = projectedStartMinutes(pitch, start, timeZone)
  const closeOffset = wraps ? close + 24 * 60 : close

  if (startOffset < open || startOffset + durationMinutes > closeOffset) {
    throw new QuoteError(
      "PRICE_UNAVAILABLE",
      `That window falls outside the pitch opening hours (${pitch.opening_time} - ${pitch.closing_time}).`,
    )
  }
}

function toDate(value: string | Date, label: string): Date {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) {
    throw new QuoteError("VALIDATION_FAILED", `${label} is not a valid instant.`)
  }
  return date
}

/* ========================================================================== */
/*  Stripe parameter builder                                                  */
/* ========================================================================== */

export interface PaymentIntentBuildInput {
  bookingId: string
  quote: BookingQuote
  /** `acct_…` of the venue's Connect Express account. */
  connectedAccountId: string
  venueId: string
  userId: string
  teamId?: string | null
  /** Sent to Stripe for the receipt; omitted when the profile has no email. */
  receiptEmail?: string | null
  /** Appended to the platform statement descriptor, e.g. a short venue name. */
  statementDescriptorSuffix?: string | null
}

export interface PaymentIntentBuildResult {
  params: Stripe.PaymentIntentCreateParams
  options: Stripe.RequestOptions
}

/**
 * Build the DESTINATION-CHARGE PaymentIntent for a booking.
 *
 * Why a destination charge rather than the alternatives:
 *
 *  - **Destination charge** (this one): the charge is created on the PLATFORM account with
 *    `transfer_data.destination`, so the platform is merchant of record. One charge, one
 *    statement descriptor the player recognises, one refund path, and disputes land on the
 *    platform where the support team actually is. `application_fee_amount` splits the money at
 *    capture — atomically, inside the same charge, with no second API call that can fail after
 *    the funds already moved.
 *  - **Direct charge** (created on the venue's account via the `stripeAccount` header):
 *    rejected. The venue would own disputes, refunds and chargeback fees, the descriptor would
 *    differ per venue, and a negative balance on a small pitch owner's account becomes the
 *    platform's support problem anyway. It also fragments reporting across N connected accounts.
 *  - **Separate charges and transfers**: rejected. Charging first and transferring second leaves
 *    a window where the customer has paid but the venue's share has not moved; every failure in
 *    that window needs a reconciliation job to unstick. `transfer_group` is still set below, so
 *    a manual top-up transfer can be attached later without losing the linkage.
 *
 * `on_behalf_of` makes the connected account the settlement merchant for pricing and regulatory
 * purposes (the charge settles in the venue's country, its name appears on the statement) while
 * liability stays with the platform.
 *
 * The idempotency key is derived from the booking id, so a double-clicked checkout, a retried
 * fetch, or a replayed request can only ever produce ONE PaymentIntent for that booking.
 */
export function buildPaymentIntentParams(input: PaymentIntentBuildInput): PaymentIntentBuildResult {
  const { quote, bookingId, connectedAccountId } = input

  const params: Stripe.PaymentIntentCreateParams = {
    amount: quote.totalMinor,
    currency: quote.currency,
    application_fee_amount: quote.platformFeeMinor,
    transfer_data: { destination: connectedAccountId },
    on_behalf_of: connectedAccountId,
    transfer_group: transferGroupFor(bookingId),
    // Let the Payment Element decide what to offer (cards, wallets, local methods) instead of
    // hard-coding payment_method_types — Stripe then honours the dashboard configuration.
    automatic_payment_methods: { enabled: true },
    description: `OnPitch pitch booking ${bookingId}`,
    metadata: {
      booking_id: bookingId,
      pitch_id: quote.pitchId,
      venue_id: input.venueId,
      user_id: input.userId,
      team_id: input.teamId ?? "",
      starts_at: quote.startsAt,
      ends_at: quote.endsAt,
      subtotal_minor: String(quote.subtotalMinor),
      platform_fee_minor: String(quote.platformFeeMinor),
      platform_fee_bps: String(PLATFORM_FEE_BPS),
    },
  }

  if (input.receiptEmail) params.receipt_email = input.receiptEmail
  const suffix = sanitiseDescriptorSuffix(input.statementDescriptorSuffix)
  if (suffix) params.statement_descriptor_suffix = suffix

  return { params, options: { idempotencyKey: paymentIntentIdempotencyKey(bookingId) } }
}

/** One PaymentIntent per booking. */
export function paymentIntentIdempotencyKey(bookingId: string): string {
  return `booking_pi_${bookingId}`
}

/**
 * One refund per booking per refund state.
 *
 * The booking id alone is what makes two CONCURRENT cancels resolve to a single refund, but it
 * would also make a legitimate SECOND refund (a booking already `partially_refunded` from the
 * Stripe dashboard, now cancelled outright) replay the first response instead of moving new
 * money. `alreadyRefundedMinor` discriminates the attempts without weakening the race guard:
 * two cancels that see the same state still produce the same key.
 */
export function refundIdempotencyKey(bookingId: string, alreadyRefundedMinor = 0): string {
  return alreadyRefundedMinor > 0
    ? `booking_refund_${bookingId}_${alreadyRefundedMinor}`
    : `booking_refund_${bookingId}`
}

/** Stable transfer group so charge, transfer and any later top-up share one identifier. */
export function transferGroupFor(bookingId: string): string {
  return `booking_${bookingId}`
}

/**
 * Stripe rejects `<`, `>`, `\`, `"` and `'` in a descriptor suffix and caps its length, and the
 * combined descriptor has its own limit — keep it short and alphanumeric.
 */
function sanitiseDescriptorSuffix(raw: string | null | undefined): string | null {
  if (!raw) return null
  const cleaned = raw
    .replace(/[^A-Za-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 22)
  return cleaned.length >= 3 ? cleaned : null
}

/* ========================================================================== */
/*  Stripe status → database enum                                             */
/* ========================================================================== */

/**
 * Map a Stripe PaymentIntent status onto `public.payment_status`.
 *
 * The enum is deliberately coarser than Stripe's state machine: everything the customer still
 * has to act on (`requires_payment_method`, `requires_confirmation`, `requires_action`) is one
 * state to us, and `requires_capture` is money that is authorised but not settled, which reads
 * as "processing" from the booking's point of view. A canceled intent is terminal and can never
 * be paid, so it is recorded as `failed`.
 */
export function mapStripeStatus(
  status: Stripe.PaymentIntent.Status | string | null | undefined,
): Enums<"payment_status"> {
  switch (status) {
    case "succeeded":
      return "succeeded"
    case "processing":
    case "requires_capture":
      return "processing"
    case "canceled":
      return "failed"
    case "requires_payment_method":
    case "requires_confirmation":
    case "requires_action":
      return "requires_payment"
    default:
      return "requires_payment"
  }
}

/**
 * Refund state of a charge: everything back → `refunded`, some back → `partially_refunded`,
 * nothing back → `succeeded` (the payment still stands).
 */
export function mapRefundStatus(
  amountRefundedMinor: number,
  amountChargedMinor: number,
): Enums<"payment_status"> {
  if (amountRefundedMinor <= 0) return "succeeded"
  return amountRefundedMinor >= amountChargedMinor ? "refunded" : "partially_refunded"
}

/** Map a Stripe payout status onto `public.payout_status`. */
export function mapPayoutStatus(
  status: string | null | undefined,
): Enums<"payout_status"> {
  switch (status) {
    case "paid":
      return "paid"
    case "in_transit":
      return "in_transit"
    case "failed":
    case "canceled":
      return "failed"
    case "pending":
      return "pending"
    default:
      return "pending"
  }
}

/* ========================================================================== */
/*  Cancellation / refund policy                                              */
/* ========================================================================== */

export interface CancellationPolicy {
  /** True when the whole outstanding `total_minor` comes back. */
  fullRefund: boolean
  /** Amount to refund, in minor units. May be 0 under a 0-bps late policy. */
  refundMinor: MinorUnits
  /**
   * Whether the platform hands its `application_fee_amount` back as well. True only for a
   * cancellation made in good time — the platform did the matching work either way, so a late
   * cancellation keeps the fee.
   */
  refundApplicationFee: boolean
  /**
   * Whether Stripe claws the (proportional) transfer back off the venue's connected account.
   * Always true: the venue is not being asked to hold the pitch, so it should not keep money for
   * a slot the platform is handing back.
   */
  reverseTransfer: boolean
  /** Hours between "now" and kickoff, kept for the audit trail. */
  hoursUntilKickoff: number
  windowHours: number
  reasonCode: "outside_window" | "inside_window" | "already_started"
}

export interface CancellationPolicyInput {
  /** Lower bound of `bookings.time_range`. */
  kickoffAt: Date
  /** `bookings.total_minor`. */
  totalMinor: number
  /** Already-refunded amount, so a second cancel cannot refund the same money twice. */
  alreadyRefundedMinor?: number
  now?: Date
}

/**
 * Decide what a cancellation is worth. The CALLER never supplies `refund_application_fee` or
 * `reverse_transfer` — those are policy, and policy lives on the server.
 */
export function resolveCancellationPolicy(input: CancellationPolicyInput): CancellationPolicy {
  const now = input.now ?? new Date()
  const total = Math.max(0, Math.trunc(input.totalMinor))
  const alreadyRefunded = Math.max(0, Math.trunc(input.alreadyRefundedMinor ?? 0))
  const refundable = Math.max(0, total - alreadyRefunded)
  const hoursUntilKickoff = (input.kickoffAt.getTime() - now.getTime()) / 3_600_000

  if (hoursUntilKickoff >= CANCELLATION_WINDOW_HOURS) {
    return {
      fullRefund: refundable === total,
      refundMinor: asMinor(refundable),
      refundApplicationFee: true,
      reverseTransfer: true,
      hoursUntilKickoff,
      windowHours: CANCELLATION_WINDOW_HOURS,
      reasonCode: "outside_window",
    }
  }

  // Inside the window (or after kickoff): a partial refund of the ORIGINAL total, capped by
  // whatever is still refundable. Floored, so rounding can never refund more than was charged.
  const partial = Math.min(refundable, Math.floor((total * LATE_CANCELLATION_REFUND_BPS) / 10_000))

  return {
    fullRefund: false,
    refundMinor: asMinor(Math.max(0, partial)),
    refundApplicationFee: false,
    reverseTransfer: true,
    hoursUntilKickoff,
    windowHours: CANCELLATION_WINDOW_HOURS,
    reasonCode: hoursUntilKickoff <= 0 ? "already_started" : "inside_window",
  }
}

/* ========================================================================== */
/*  Postgres range + error helpers                                            */
/* ========================================================================== */

/**
 * Render a half-open `tstzrange` literal, `["…","…")`. The bounds are quoted so a timestamp
 * rendering can never be mistaken for the range separator.
 */
export function toTstzRange(startsAt: string | Date, endsAt: string | Date): string {
  const start = startsAt instanceof Date ? startsAt.toISOString() : new Date(startsAt).toISOString()
  const end = endsAt instanceof Date ? endsAt.toISOString() : new Date(endsAt).toISOString()
  return `["${start}","${end}")`
}

/**
 * Parse what Postgres gives back for a `tstzrange`, e.g.
 * `["2026-09-01 18:00:00+00","2026-09-01 19:00:00+00")`. PostgREST returns the raw literal, and
 * those timestamps use a space separator and a truncated (`+00`) offset that `Date` does not
 * accept on every runtime, so both are normalised here.
 */
export function parseTstzRange(literal: string): { startsAt: Date; endsAt: Date } {
  const inner = literal.trim().replace(/^[[(]/, "").replace(/[\])]$/, "")
  const [rawStart, rawEnd] = splitRangeBounds(inner)
  const startsAt = new Date(normaliseTimestamp(rawStart))
  const endsAt = new Date(normaliseTimestamp(rawEnd))
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) {
    throw new TypeError(`Unparseable tstzrange literal: ${literal}`)
  }
  return { startsAt, endsAt }
}

/** Split on the comma separating the bounds, ignoring commas inside the quoted timestamps. */
function splitRangeBounds(inner: string): [string, string] {
  let inQuotes = false
  for (let i = 0; i < inner.length; i += 1) {
    const char = inner[i]
    if (char === '"') inQuotes = !inQuotes
    else if (char === "," && !inQuotes) return [inner.slice(0, i), inner.slice(i + 1)]
  }
  return [inner, ""]
}

function normaliseTimestamp(raw: string): string {
  const unquoted = raw.trim().replace(/^"/, "").replace(/"$/, "")
  const withT = unquoted.replace(" ", "T")
  // `+00` → `+00:00`, `+0300` → `+03:00`. Anchored to the time component, so a bare date's
  // trailing `-01` can never be mistaken for an offset.
  return withT.replace(
    /T([\d:.]+)([+-]\d{2})(\d{2})?$/,
    (_all, time: string, hh: string, mm?: string) => `T${time}${hh}:${mm ?? "00"}`,
  )
}

/** SQLSTATE surfaced by PostgREST for an EXCLUDE constraint violation. */
export const SQLSTATE_EXCLUSION_VIOLATION = "23P01"
/** SQLSTATE for a unique violation — how a duplicate `stripe_events` id shows up. */
export const SQLSTATE_UNIQUE_VIOLATION = "23505"

interface CodedError {
  code?: string | null
  message?: string | null
}

/**
 * True when a PostgREST error is the anti-double-booking exclusion constraint firing. This is
 * the ONLY reliable way to detect a lost race for a slot: a `select … where overlaps` check
 * before the insert is a TOCTOU bug, whereas the constraint IS the serialisation point.
 */
export function isExclusionViolation(error: unknown, constraintName?: string): boolean {
  const coded = error as CodedError | null
  if (!coded || coded.code !== SQLSTATE_EXCLUSION_VIOLATION) return false
  if (!constraintName) return true
  return typeof coded.message === "string" && coded.message.includes(constraintName)
}

/** True when a PostgREST error is a unique-constraint violation. */
export function isUniqueViolation(error: unknown): boolean {
  const coded = error as CodedError | null
  return Boolean(coded && coded.code === SQLSTATE_UNIQUE_VIOLATION)
}
