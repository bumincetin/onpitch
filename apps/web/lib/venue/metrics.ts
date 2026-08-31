/**
 * lib/venue/metrics.ts
 *
 * The venue owner dashboard's arithmetic, in one place, so the overview page, the
 * `/api/venues/[id]/metrics` route and any future export all report identical numbers.
 *
 * ---------------------------------------------------------------------------
 * WHY OCCUPANCY IS THE HARD ONE
 * ---------------------------------------------------------------------------
 * "Booked hours / 24h" reports the wrong thing: a pitch that closes at 23:00 can never reach
 * 100%, and an owner who blacks out a week for resurfacing would watch occupancy collapse
 * through no fault of their own. So the denominator here is BOOKABLE minutes, not calendar minutes:
 *
 *     bookable = Σ over (active pitch × local day) of
 *                  [opening_time, closing_time) ∩ requested window
 *                  minus any pitch_availability_blocks overlapping that interval
 *
 *     booked   = Σ of booking.time_range ∩ that same open interval,
 *                for statuses that actually hold the slot
 *
 * Both numerator and denominator are clipped to the same open interval, so occupancy is
 * mathematically incapable of exceeding 1 even when a booking straddles closing time.
 *
 * Opening hours are WALL CLOCK in `venues.timezone` while the ranges are absolute instants, so
 * every day boundary is resolved through the zone (see `zonedWallClockToUtc`). Over a DST
 * transition the local 08:00–23:00 window is genuinely 14 or 16 hours long, and this computes
 * that rather than assuming 15.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT PostgREST AGGREGATE FUNCTIONS
 * ---------------------------------------------------------------------------
 * The obvious "SQL-side" shape would be `select=sum(total_minor),count()`. PostgREST only
 * exposes aggregates when `db-aggregates-enabled` is on, and there is no RPC in the schema
 * contract that returns venue metrics, and this module may not add a migration. So instead of
 * gambling the whole dashboard on a server flag, every metric set is ONE bounded, projected,
 * index-backed query (`.overlaps()` rides `idx_bookings_pitch_range`, a GiST index) and the fold
 * happens in a single pass here. Every metric set therefore costs a fixed number of round trips
 * regardless of how many pitches, days or bookings exist — never a per-pitch or per-day loop.
 *
 * ---------------------------------------------------------------------------
 * RLS IS THE BOUNDARY
 * ---------------------------------------------------------------------------
 * Every read below goes through the caller's cookie-bound client. `bookings_select_stakeholders`
 * and `venue_payouts_select_owner` are what stop one owner reading another's revenue. The
 * `.eq('venue_id', …)` / `.in('pitch_id', …)` filters in this file are QUERY OPTIMISATIONS that
 * let Postgres use an index — they are not, and must never be mistaken for, the access check.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

import type { Database, Enums, Tables } from "@halisaha/shared/database"
import {
  DEFAULT_CURRENCY,
  asMinor,
  type MinorUnits,
  type NextPayout,
  type VenueDashboardMetrics,
} from "@halisaha/shared/domain"

/* ========================================================================== */
/*  Constants                                                                 */
/* ========================================================================== */

/**
 * Booking statuses that HOLD a slot. Deliberately identical to the predicate on the
 * `bookings_no_double_booking` exclusion constraint in 0001_schema.sql — if the database
 * considers a status to occupy the pitch, occupancy must count it, or the dashboard would
 * disagree with the thing that actually rejects a second booking.
 */
export const OCCUPYING_BOOKING_STATUSES: readonly Enums<"booking_status">[] = [
  "pending",
  "awaiting_payment",
  "confirmed",
  "completed",
]

/**
 * Statuses whose money we recognise. `refunded` and `partially_refunded` stay in: the charge did
 * happen, and the refund is subtracted separately so gross and refunds are both visible instead
 * of silently netting to zero.
 *
 * `cancelled` is in for the same reason. A cancellation inside the window is not free: with the
 * default `LATE_CANCELLATION_REFUND_BPS` in lib/payments.ts the customer gets half back and the
 * venue KEEPS the rest, and a cancellation after kickoff refunds nothing at all. Those rows keep
 * `status = 'cancelled'` forever -- the charge.refunded webhook only promotes a FULLY refunded
 * charge to `refunded` -- so dropping them here would silently erase money that is really
 * sitting in the venue's Stripe balance. `isCharged()` still excludes the cancellations that
 * were never paid for, and `grossMinor - refundedMinor` nets each one down to exactly what the
 * venue retained.
 */
const REVENUE_BOOKING_STATUSES: readonly Enums<"booking_status">[] = [
  "confirmed",
  "completed",
  "cancelled",
  "refunded",
  "disputed",
]

/** Statuses that count against the cancellation rate. */
const CANCELLED_BOOKING_STATUSES: readonly Enums<"booking_status">[] = ["cancelled", "refunded"]

/** Payouts Stripe has not settled yet, in the order we would show them to an owner. */
const OPEN_PAYOUT_STATUSES: readonly Enums<"payout_status">[] = ["in_transit", "pending"]

const MINUTE_MS = 60_000
const DAY_MS = 86_400_000

/** Hard ceiling on how many local days a single metrics window may span. */
export const MAX_METRICS_DAYS = 400

/* ========================================================================== */
/*  Timezone helpers                                                          */
/* ========================================================================== */
/*
 * These are pure, dependency-free and safe to import from a client component — the venue
 * calendar renders the same local day boundaries this module measures, and two different
 * definitions of "Tuesday" between the grid and the occupancy number would be a bug nobody
 * could reproduce.
 */

export interface ZonedParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  /** 0 = Sunday … 6 = Saturday, in the target zone. */
  weekday: number
}

const WEEKDAY_INDEX: Readonly<Record<string, number>> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
}

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("tr-TR", {
    timeZone,
    hour12: false,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
}

/** Decompose an absolute instant into local calendar fields in `timeZone`. */
export function zonedParts(instant: Date, timeZone: string): ZonedParts {
  let formatter: Intl.DateTimeFormat
  try {
    formatter = partsFormatter(timeZone)
  } catch {
    // An unknown IANA zone must not take the dashboard down; UTC is a defensible fallback.
    formatter = partsFormatter("UTC")
  }

  const bag: Record<string, string> = {}
  for (const part of formatter.formatToParts(instant)) {
    if (part.type !== "literal") bag[part.type] = part.value
  }

  // Some engines render midnight as "24" under hour12:false; normalise it back to 0.
  const hour = Number(bag.hour ?? "0") % 24

  return {
    year: Number(bag.year ?? "1970"),
    month: Number(bag.month ?? "1"),
    day: Number(bag.day ?? "1"),
    hour,
    minute: Number(bag.minute ?? "0"),
    second: Number(bag.second ?? "0"),
    weekday: WEEKDAY_INDEX[bag.weekday ?? "Thu"] ?? 4,
  }
}

/** Minutes east of UTC that `timeZone` is observing at `instant`. */
export function zoneOffsetMinutes(instant: Date, timeZone: string): number {
  const parts = zonedParts(instant, timeZone)
  const asIfUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  )
  return Math.round((asIfUtc - instant.getTime()) / MINUTE_MS)
}

/**
 * The absolute instant at which a given LOCAL wall clock occurs in `timeZone`.
 *
 * Two passes, because the offset we need depends on the answer we are computing: pass one uses
 * the offset at the naive UTC guess, pass two re-reads the offset at the corrected instant. That
 * settles every real-world DST transition. In the one-hour gap a spring-forward deletes there is
 * no such wall clock at all, and the result lands on the instant the clock jumped to — the same
 * choice Postgres makes for `timestamp at time zone`.
 */
export function zonedWallClockToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0, 0)
  let instant = naive - zoneOffsetMinutes(new Date(naive), timeZone) * MINUTE_MS
  instant = naive - zoneOffsetMinutes(new Date(instant), timeZone) * MINUTE_MS
  return new Date(instant)
}

/** `"08:00"` / `"08:00:00"` / `"24:00:00"` → minutes past local midnight. */
export function timeToMinutes(value: string | null | undefined): number {
  if (!value) return 0
  const [rawHour = "0", rawMinute = "0"] = value.split(":")
  const hour = Number(rawHour)
  const minute = Number(rawMinute)
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return 0
  return Math.max(0, Math.min(24 * 60, hour * 60 + minute))
}

/** `YYYY-MM-DD` for an instant, as seen in `timeZone`. */
export function zonedDateKey(instant: Date, timeZone: string): string {
  const { year, month, day } = zonedParts(instant, timeZone)
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
}

/** Split a `YYYY-MM-DD` key back into numbers. */
export function parseDateKey(key: string): { year: number; month: number; day: number } {
  const [year = "1970", month = "01", day = "01"] = key.split("-")
  return { year: Number(year), month: Number(month), day: Number(day) }
}

/** Advance a `YYYY-MM-DD` key by `days`, staying on the civil calendar (no DST drift). */
export function addDaysToDateKey(key: string, days: number): string {
  const { year, month, day } = parseDateKey(key)
  const shifted = new Date(Date.UTC(year, month - 1, day + days))
  return zonedDateKey(shifted, "UTC")
}

/**
 * Every local calendar day (`YYYY-MM-DD`) touched by `[from, to)` in `timeZone`.
 * Capped at {@link MAX_METRICS_DAYS} so a nonsense query cannot allocate unbounded memory.
 */
export function localDaysBetween(from: Date, to: Date, timeZone: string): string[] {
  const days: string[] = []
  if (!(to.getTime() > from.getTime())) return days

  let key = zonedDateKey(from, timeZone)
  const lastKey = zonedDateKey(new Date(to.getTime() - 1), timeZone)

  for (let guard = 0; guard <= MAX_METRICS_DAYS; guard += 1) {
    days.push(key)
    if (key === lastKey) break
    key = addDaysToDateKey(key, 1)
  }
  return days
}

/* ========================================================================== */
/*  Interval arithmetic                                                       */
/* ========================================================================== */

export interface Interval {
  /** Epoch ms, inclusive. */
  start: number
  /** Epoch ms, exclusive. */
  end: number
}

/** Overlap of two half-open intervals in minutes. Zero when they do not meet. */
export function overlapMinutes(a: Interval, b: Interval): number {
  const start = Math.max(a.start, b.start)
  const end = Math.min(a.end, b.end)
  return end > start ? (end - start) / MINUTE_MS : 0
}

/**
 * Parse a Postgres `tstzrange` literal into an {@link Interval}.
 *
 * PostgREST hands back the raw literal — `["2026-09-01 18:00:00+00","2026-09-01 19:00:00+00")` —
 * whose space separator and truncated `+00` offset `Date` rejects on some runtimes, so both are
 * normalised. Returns `null` rather than throwing: one malformed row must not take a whole
 * dashboard down.
 */
export function parseRange(literal: string | null | undefined): Interval | null {
  if (!literal) return null
  const inner = literal.trim().replace(/^[[(]/, "").replace(/[\])]$/, "")

  let inQuotes = false
  let splitAt = -1
  for (let i = 0; i < inner.length; i += 1) {
    const char = inner[i]
    if (char === '"') inQuotes = !inQuotes
    else if (char === "," && !inQuotes) {
      splitAt = i
      break
    }
  }
  if (splitAt < 0) return null

  const start = Date.parse(normaliseTimestampLiteral(inner.slice(0, splitAt)))
  const end = Date.parse(normaliseTimestampLiteral(inner.slice(splitAt + 1)))
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null
  return { start, end }
}

function normaliseTimestampLiteral(raw: string): string {
  const unquoted = raw.trim().replace(/^"/, "").replace(/"$/, "")
  const withT = unquoted.replace(" ", "T")
  // `+00` → `+00:00`, `+0300` → `+03:00`, anchored to the time component so a bare date's
  // trailing `-01` is never mistaken for an offset.
  return withT.replace(
    /T([\d:.]+)([+-]\d{2})(\d{2})?$/,
    (_all, time: string, hh: string, mm?: string) => `T${time}${hh}:${mm ?? "00"}`,
  )
}

/** Render a half-open `tstzrange` literal for a PostgREST `.overlaps()` filter. */
export function toRangeLiteral(from: Date | string, to: Date | string): string {
  const start = from instanceof Date ? from : new Date(from)
  const end = to instanceof Date ? to : new Date(to)
  return `["${start.toISOString()}","${end.toISOString()}")`
}

/* ========================================================================== */
/*  Public shapes                                                             */
/* ========================================================================== */

/** The projection this module needs off `pitches`; nothing more is fetched. */
export type MetricsPitch = Pick<
  Tables<"pitches">,
  "id" | "name" | "is_active" | "opening_time" | "closing_time" | "slot_minutes" | "currency"
>

/** The projection this module needs off `bookings`. */
export type MetricsBooking = Pick<
  Tables<"bookings">,
  | "id"
  | "pitch_id"
  | "time_range"
  | "status"
  | "payment_status"
  | "subtotal_minor"
  | "platform_fee_minor"
  | "total_minor"
  | "refunded_amount_minor"
  | "currency"
  | "created_at"
>

/** The projection this module needs off `pitch_availability_blocks`. */
export type MetricsBlock = Pick<Tables<"pitch_availability_blocks">, "id" | "pitch_id" | "block_range">

/** One local day of the occupancy series that feeds the chart. */
export interface OccupancyPoint {
  /** `YYYY-MM-DD` in the venue timezone. */
  date: string
  bookedMinutes: number
  bookableMinutes: number
  /** `bookedMinutes / bookableMinutes`, clamped to [0,1]. Zero when nothing was bookable. */
  occupancyRate: number
  revenueMinor: MinorUnits
  bookingCount: number
}

/** The three headline figures we compare period-over-period. */
export interface VenuePeriodTotals {
  occupancyRate: number
  bookedMinutes: number
  bookableMinutes: number
  grossMinor: MinorUnits
  refundedMinor: MinorUnits
  revenueMinor: MinorUnits
  platformFeeMinor: MinorUnits
  netMinor: MinorUnits
  bookingCount: number
  cancelledCount: number
  cancellationRate: number
  averageBookingValueMinor: MinorUnits
}

/**
 * Week-over-week (strictly: window-over-equal-preceding-window) movement.
 *
 * Rates move in POINTS (an occupancy of 0.40 → 0.52 is `+0.12`, not `+30%`) because a percentage
 * change of a percentage reads as a point change to most people. Counts and money
 * move in RATIOS, and are `null` — not `0`, not `Infinity` — when the previous window was empty,
 * so the UI can say "no comparison" instead of inventing a 100% rise from nothing.
 */
export interface VenueMetricsDeltas {
  occupancyRatePoints: number | null
  cancellationRatePoints: number | null
  revenueRatio: number | null
  bookingCountRatio: number | null
  averageBookingValueRatio: number | null
}

export interface VenueMetricsResult {
  /** The shared-contract shape, ready to return from the API route. */
  metrics: VenueDashboardMetrics
  current: VenuePeriodTotals
  previous: VenuePeriodTotals
  deltas: VenueMetricsDeltas
  /** One point per local day of the current window, in chronological order. */
  series: OccupancyPoint[]
  range: { from: string; to: string }
  previousRange: { from: string; to: string }
  timezone: string
  currency: string
  pitchCount: number
  activePitchCount: number
}

export interface ComputeVenueMetricsInput {
  supabase: SupabaseClient<Database>
  /** The venue whose metrics to compute. RLS still decides what the caller may read. */
  venue: Pick<Tables<"venues">, "id" | "timezone">
  /** Inclusive lower bound of the window. Defaults to 7 days before `to`. */
  from?: string | Date
  /** Exclusive upper bound. Defaults to now. */
  to?: string | Date
  /** Injectable clock; tests pass a fixed instant. */
  now?: Date
}

/* ========================================================================== */
/*  Window resolution                                                         */
/* ========================================================================== */

export interface ResolvedWindow {
  from: Date
  to: Date
  previousFrom: Date
  previousTo: Date
  days: number
}

/**
 * Normalise a caller-supplied window and derive the comparison window.
 *
 * The comparison period is always exactly as long as, and immediately before, the requested one.
 * `venueMetricsQuerySchema` already accepts a bare `YYYY-MM-DD`; a date-only bound is read as
 * UTC midnight, matching how Postgres would coerce it.
 */
export function resolveWindow(
  from: string | Date | undefined,
  to: string | Date | undefined,
  now: Date = new Date(),
): ResolvedWindow {
  const end = toDateOr(to, now)
  const defaultStart = new Date(end.getTime() - 7 * DAY_MS)
  let start = toDateOr(from, defaultStart)

  if (start.getTime() >= end.getTime()) {
    start = new Date(end.getTime() - DAY_MS)
  }

  const spanMs = Math.min(end.getTime() - start.getTime(), MAX_METRICS_DAYS * DAY_MS)
  const clampedStart = new Date(end.getTime() - spanMs)

  return {
    from: clampedStart,
    to: end,
    previousFrom: new Date(clampedStart.getTime() - spanMs),
    previousTo: clampedStart,
    days: Math.max(1, Math.round(spanMs / DAY_MS)),
  }
}

function toDateOr(value: string | Date | undefined, fallback: Date): Date {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : fallback
  if (typeof value === "string" && value.trim() !== "") {
    // A bare calendar date has no time component; anchor it at UTC midnight.
    const normalised = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value
    const parsed = new Date(normalised)
    if (Number.isFinite(parsed.getTime())) return parsed
  }
  return fallback
}

/* ========================================================================== */
/*  The computation                                                           */
/* ========================================================================== */

/**
 * Compute every dashboard figure for one venue over one window, plus the equal preceding window.
 *
 * Round trips: 5, flat.
 *   1. `pitches`      — the venue's pitches and their opening hours
 *   2. `bookings`     — one `.overlaps()` covering BOTH windows at once (GiST-indexed)
 *   3. `pitch_availability_blocks` — same trick
 *   4. `bookings`     — head-only count of what is still to come (2 looks backwards, so it
 *                       cannot answer this); runs concurrently with 2 and 3
 *   5. `venue_payouts` — the open payout queue, for `nextPayout`
 *
 * A venue with no pitches short-circuits after query 1 with a well-formed zeroed result, which
 * is what a freshly onboarded owner should see rather than an error.
 */
export async function computeVenueMetrics(
  input: ComputeVenueMetricsInput,
): Promise<VenueMetricsResult> {
  const { supabase, venue } = input
  const now = input.now ?? new Date()
  const timezone = venue.timezone || "Europe/Istanbul"
  const window = resolveWindow(input.from, input.to, now)

  /* --- 1. Pitches -------------------------------------------------------- */
  // RLS (`pitches_select_visible`) is the access boundary. `.eq('venue_id', …)` is an index hint.
  const { data: pitchRows, error: pitchError } = await supabase
    .from("pitches")
    .select("id, name, is_active, opening_time, closing_time, slot_minutes, currency")
    .eq("venue_id", venue.id)
    .order("name", { ascending: true })

  if (pitchError) throw pitchError

  const pitches: MetricsPitch[] = pitchRows ?? []
  const activeSahalar = pitches.filter((pitch) => pitch.is_active)
  const currency = (pitches[0]?.currency || DEFAULT_CURRENCY).toLowerCase()

  const nextPayout = await loadNextPayout(supabase, venue.id, currency)

  if (activeSahalar.length === 0) {
    return emptyResult({ window, timezone, currency, nextPayout, pitches })
  }

  const pitchIds = activeSahalar.map((pitch) => pitch.id)

  /* --- 2 & 3. Bookings and blocks over BOTH windows in one query each ----- */
  const spanLiteral = toRangeLiteral(window.previousFrom, window.to)

  // "Upcoming" is the one forward-looking figure on the dashboard, so it cannot be folded out of
  // the window read above: that read stops at `window.to`, which defaults to `now`, and nothing
  // starting after `now` can overlap a range that ends at `now`. It gets its own head-only count.
  // `>> [now,now]` is "starts strictly after now"; the +1y overlap keeps it on
  // idx_bookings_pitch_range instead of scanning the whole future.
  const nowPivot = `["${now.toISOString()}","${now.toISOString()}"]`
  const upcomingLiteral = toRangeLiteral(now, new Date(now.getTime() + 365 * DAY_MS))

  const [bookingsResponse, blocksResponse, upcomingResponse] = await Promise.all([
    supabase
      .from("bookings")
      .select(
        "id, pitch_id, time_range, status, payment_status, subtotal_minor, platform_fee_minor, " +
          "total_minor, refunded_amount_minor, currency, created_at",
      )
      // RLS (`bookings_select_stakeholders`) is what authorises this read; the pitch filter is a
      // query optimisation that lets Postgres use idx_bookings_pitch_range.
      .in("pitch_id", pitchIds)
      .overlaps("time_range", spanLiteral),
    supabase
      .from("pitch_availability_blocks")
      .select("id, pitch_id, block_range")
      .in("pitch_id", pitchIds)
      .overlaps("block_range", spanLiteral),
    supabase
      .from("bookings")
      .select("id", { count: "exact", head: true })
      .in("pitch_id", pitchIds)
      .eq("status", "confirmed")
      .overlaps("time_range", upcomingLiteral)
      .filter("time_range", "sr", nowPivot),
  ])

  if (bookingsResponse.error) throw bookingsResponse.error
  if (blocksResponse.error) throw blocksResponse.error
  if (upcomingResponse.error) throw upcomingResponse.error

  // `as unknown as`: the booking select is a concatenated string rather than a literal, so
  // postgrest-js cannot parse it into a result type. The projection in the query is what makes
  // this assertion true — change one and change the other.
  const bookings: MetricsBooking[] = (bookingsResponse.data ?? []) as unknown as MetricsBooking[]
  const blocks: MetricsBlock[] = blocksResponse.data ?? []

  /* --- 4. Fold each window ------------------------------------------------ */
  const current = foldWindow({
    from: window.from,
    to: window.to,
    timezone,
    pitches: activeSahalar,
    bookings,
    blocks,
    withSeries: true,
  })
  const previous = foldWindow({
    from: window.previousFrom,
    to: window.previousTo,
    timezone,
    pitches: activeSahalar,
    bookings,
    blocks,
    withSeries: false,
  })

  const upcomingBookings = upcomingResponse.count ?? 0

  const metrics: VenueDashboardMetrics = {
    occupancyRate: current.totals.occupancyRate,
    revenueMinor: current.totals.revenueMinor,
    upcomingBookings,
    nextPayout,
    currency,
    platformFeeMinor: current.totals.platformFeeMinor,
    netMinor: current.totals.netMinor,
    bookingCount: current.totals.bookingCount,
    averageBookingValueMinor: current.totals.averageBookingValueMinor,
    cancellationRate: current.totals.cancellationRate,
    rangeFrom: window.from.toISOString(),
    rangeTo: window.to.toISOString(),
  }

  return {
    metrics,
    current: current.totals,
    previous: previous.totals,
    deltas: deriveDeltas(current.totals, previous.totals),
    series: current.series,
    range: { from: window.from.toISOString(), to: window.to.toISOString() },
    previousRange: {
      from: window.previousFrom.toISOString(),
      to: window.previousTo.toISOString(),
    },
    timezone,
    currency,
    pitchCount: pitches.length,
    activePitchCount: activeSahalar.length,
  }
}

/* -------------------------------------------------------------------------- */
/*  Folding one window                                                        */
/* -------------------------------------------------------------------------- */

interface FoldInput {
  from: Date
  to: Date
  timezone: string
  pitches: MetricsPitch[]
  bookings: MetricsBooking[]
  blocks: MetricsBlock[]
  withSeries: boolean
}

interface FoldOutput {
  totals: VenuePeriodTotals
  series: OccupancyPoint[]
}

/**
 * One pass over (pitch × local day) building the bookable denominator, and one pass over the
 * bookings building the numerator and the money. Both are clipped to the SAME open interval,
 * which is what guarantees `occupancyRate <= 1`.
 */
function foldWindow(input: FoldInput): FoldOutput {
  const { from, to, timezone, pitches, bookings, blocks, withSeries } = input
  const windowInterval: Interval = { start: from.getTime(), end: to.getTime() }
  const days = localDaysBetween(from, to, timezone)

  // pitchId -> ordered list of that pitch's open intervals, one per local day.
  const openIntervalsByPitch = new Map<string, Map<string, Interval>>()
  const blocksByPitch = groupBy(blocks, (block) => block.pitch_id)

  const perDay = new Map<string, OccupancyPoint>()
  for (const day of days) {
    perDay.set(day, {
      date: day,
      bookedMinutes: 0,
      bookableMinutes: 0,
      occupancyRate: 0,
      revenueMinor: asMinor(0),
      bookingCount: 0,
    })
  }

  let bookableMinutes = 0

  for (const pitch of pitches) {
    const openMinute = timeToMinutes(pitch.opening_time)
    const rawCloseMinute = timeToMinutes(pitch.closing_time)
    // A closing time at or before the opening time is an OVERNIGHT session, not an empty one:
    // 0001_schema.sql says closing_time "may sort before opening_time for venues open past
    // midnight". Project it onto a continuous [open, close + 24h) axis -- the same projection
    // `assertWithinOpeningHours` in lib/payments.ts uses when it prices such a slot -- so the
    // post-midnight tail lands in the bookable denominator instead of the pitch counting as
    // never bookable and pinning occupancy at 0. `zonedWallClockToUtc` takes the resulting
    // hour >= 24 and rolls it into the next local day.
    const closeMinute = rawCloseMinute <= openMinute ? rawCloseMinute + 24 * 60 : rawCloseMinute
    const dayMap = new Map<string, Interval>()
    openIntervalsByPitch.set(pitch.id, dayMap)

    const pitchBlocks = blocksByPitch.get(pitch.id) ?? []
    const blockIntervals = pitchBlocks
      .map((block) => parseRange(block.block_range))
      .filter((interval): interval is Interval => interval !== null)

    for (const day of days) {
      const { year, month, day: dayOfMonth } = parseDateKey(day)
      const opensAt = zonedWallClockToUtc(
        year,
        month,
        dayOfMonth,
        Math.floor(openMinute / 60),
        openMinute % 60,
        timezone,
      )
      const closesAt = zonedWallClockToUtc(
        year,
        month,
        dayOfMonth,
        Math.floor(closeMinute / 60),
        closeMinute % 60,
        timezone,
      )

      const open: Interval = { start: opensAt.getTime(), end: closesAt.getTime() }
      const clippedStart = Math.max(open.start, windowInterval.start)
      const clippedEnd = Math.min(open.end, windowInterval.end)
      if (clippedEnd <= clippedStart) continue

      const bookable: Interval = { start: clippedStart, end: clippedEnd }
      dayMap.set(day, bookable)

      // Blackout windows come OUT of the denominator: an owner who closes for resurfacing has
      // not "failed to sell" those hours, so they must not drag occupancy down.
      let minutes = (bookable.end - bookable.start) / MINUTE_MS
      for (const blocked of blockIntervals) {
        minutes -= overlapMinutes(bookable, blocked)
      }
      minutes = Math.max(0, minutes)

      bookableMinutes += minutes
      const point = perDay.get(day)
      if (point) point.bookableMinutes += minutes
    }
  }

  let bookedMinutes = 0
  let grossMinor = 0
  let refundedMinor = 0
  let platformFeeMinor = 0
  let bookingCount = 0
  let cancelledCount = 0
  let revenueBookingCount = 0

  for (const booking of bookings) {
    const interval = parseRange(booking.time_range)
    if (!interval) continue
    if (overlapMinutes(interval, windowInterval) <= 0) continue

    bookingCount += 1
    if (CANCELLED_BOOKING_STATUSES.includes(booking.status)) cancelledCount += 1

    const dayMap = openIntervalsByPitch.get(booking.pitch_id)
    const occupies = OCCUPYING_BOOKING_STATUSES.includes(booking.status)

    if (occupies && dayMap) {
      // A booking can straddle local midnight, so intersect it with every open interval it
      // touches rather than only the day it starts on.
      for (const [day, open] of dayMap) {
        const minutes = overlapMinutes(interval, open)
        if (minutes <= 0) continue
        bookedMinutes += minutes
        const point = perDay.get(day)
        if (point) point.bookedMinutes += minutes
      }
    }

    if (REVENUE_BOOKING_STATUSES.includes(booking.status) && isCharged(booking.payment_status)) {
      grossMinor += booking.total_minor
      refundedMinor += booking.refunded_amount_minor
      platformFeeMinor += retainedPlatformFeeMinor(booking)
      revenueBookingCount += 1

      const dayKey = zonedDateKey(new Date(interval.start), timezone)
      const point = perDay.get(dayKey)
      if (point) {
        point.revenueMinor = asMinor(
          point.revenueMinor + booking.total_minor - booking.refunded_amount_minor,
        )
        point.bookingCount += 1
      }
    }
  }

  for (const point of perDay.values()) {
    point.occupancyRate =
      point.bookableMinutes > 0 ? clamp01(point.bookedMinutes / point.bookableMinutes) : 0
  }

  const revenueMinor = Math.max(0, grossMinor - refundedMinor)
  // Destination charges: `total_minor` is what the customer paid and `platform_fee_minor` is the
  // Stripe application_fee_amount, so the venue's share is what is left after the refund and
  // after whatever part of that fee the platform actually kept. `platformFeeMinor` above is
  // already the RETAINED fee (see `retainedPlatformFeeMinor`), not the fee originally charged,
  // which is why a fully refunded booking nets to zero here rather than to minus its fee.
  const netMinor = Math.max(0, revenueMinor - platformFeeMinor)

  const totals: VenuePeriodTotals = {
    occupancyRate: bookableMinutes > 0 ? clamp01(bookedMinutes / bookableMinutes) : 0,
    bookedMinutes,
    bookableMinutes,
    grossMinor: asMinor(grossMinor),
    refundedMinor: asMinor(refundedMinor),
    revenueMinor: asMinor(revenueMinor),
    platformFeeMinor: asMinor(platformFeeMinor),
    netMinor: asMinor(netMinor),
    bookingCount,
    cancelledCount,
    cancellationRate: bookingCount > 0 ? clamp01(cancelledCount / bookingCount) : 0,
    averageBookingValueMinor: asMinor(
      revenueBookingCount > 0 ? Math.round(grossMinor / revenueBookingCount) : 0,
    ),
  }

  const series = withSeries
    ? days.map((day) => perDay.get(day)).filter((point): point is OccupancyPoint => Boolean(point))
    : []

  return { totals, series }
}

/**
 * The application fee the platform actually KEPT on a booking.
 *
 * `bookings` records the fee that was charged (`platform_fee_minor`) but nothing about that fee
 * coming back, so this reconstructs it from the one policy that issues refunds.
 * `resolveCancellationPolicy` in lib/payments.ts sets `refundApplicationFee: true` only on the
 * outside-window branch, and that branch refunds the WHOLE remaining total; every partial refund
 * -- a late cancellation, or a goodwill refund issued from the Stripe dashboard -- leaves the
 * fee with the platform. A charge that came back in full is exactly what
 * `payment_status = 'refunded'` records (`mapRefundStatus` in lib/payments.ts), so that is the
 * signal used here.
 *
 * Subtracting the whole fee from a booking whose fee Stripe already handed back would understate
 * venue net. The durable fix is a `refunded_fee_minor` column written at refund time, which this
 * module may not add.
 */
function retainedPlatformFeeMinor(booking: MetricsBooking): number {
  return booking.payment_status === "refunded" ? 0 : booking.platform_fee_minor
}

/** A booking whose money actually moved. `processing` is excluded: it may still fail. */
function isCharged(paymentStatus: Enums<"payment_status">): boolean {
  return (
    paymentStatus === "succeeded" ||
    paymentStatus === "refunded" ||
    paymentStatus === "partially_refunded"
  )
}

/* -------------------------------------------------------------------------- */
/*  Deltas                                                                    */
/* -------------------------------------------------------------------------- */

function deriveDeltas(current: VenuePeriodTotals, previous: VenuePeriodTotals): VenueMetricsDeltas {
  return {
    occupancyRatePoints:
      previous.bookableMinutes > 0 ? current.occupancyRate - previous.occupancyRate : null,
    cancellationRatePoints:
      previous.bookingCount > 0 ? current.cancellationRate - previous.cancellationRate : null,
    revenueRatio: ratio(current.revenueMinor, previous.revenueMinor),
    bookingCountRatio: ratio(current.bookingCount, previous.bookingCount),
    averageBookingValueRatio: ratio(
      current.averageBookingValueMinor,
      previous.averageBookingValueMinor,
    ),
  }
}

/** Relative change, or `null` when there is no baseline to divide by. */
function ratio(current: number, previous: number): number | null {
  if (previous <= 0) return null
  return (current - previous) / previous
}

/* -------------------------------------------------------------------------- */
/*  Payouts                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The next payout Stripe has scheduled. `venue_payouts` is a service_role-written mirror of the
 * `payout.*` webhooks, so this is a plain read: `in_transit` beats `pending`, then the earliest
 * arrival date wins.
 */
export async function loadNextPayout(
  supabase: SupabaseClient<Database>,
  venueId: string,
  fallbackCurrency: string = DEFAULT_CURRENCY,
): Promise<NextPayout | null> {
  // RLS (`venue_payouts_select_owner`) is the boundary; `.eq('venue_id', …)` uses
  // idx_venue_payouts_venue_id.
  const { data, error } = await supabase
    .from("venue_payouts")
    .select("stripe_payout_id, amount_minor, currency, status, arrival_date, created_at")
    .eq("venue_id", venueId)
    .in("status", OPEN_PAYOUT_STATUSES as unknown as Enums<"payout_status">[])
    .order("arrival_date", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: true })
    .limit(1)

  if (error) {
    // A payout read failing must not take the whole dashboard down — the number is informational.
    console.error("[venue/metrics] payout lookup failed", { code: error.code })
    return null
  }

  const row = data?.[0]
  if (!row) return null

  return {
    payoutId: row.stripe_payout_id,
    amountMinor: asMinor(row.amount_minor),
    currency: (row.currency || fallbackCurrency).toLowerCase(),
    status: row.status,
    arrivalDate: row.arrival_date,
  }
}

/* -------------------------------------------------------------------------- */
/*  Zeroed result                                                             */
/* -------------------------------------------------------------------------- */

function emptyTotals(): VenuePeriodTotals {
  const zero = asMinor(0)
  return {
    occupancyRate: 0,
    bookedMinutes: 0,
    bookableMinutes: 0,
    grossMinor: zero,
    refundedMinor: zero,
    revenueMinor: zero,
    platformFeeMinor: zero,
    netMinor: zero,
    bookingCount: 0,
    cancelledCount: 0,
    cancellationRate: 0,
    averageBookingValueMinor: zero,
  }
}

function emptyResult(args: {
  window: ResolvedWindow
  timezone: string
  currency: string
  nextPayout: NextPayout | null
  pitches: MetricsPitch[]
}): VenueMetricsResult {
  const { window, timezone, currency, nextPayout, pitches } = args
  const totals = emptyTotals()

  return {
    metrics: {
      occupancyRate: 0,
      revenueMinor: totals.revenueMinor,
      upcomingBookings: 0,
      nextPayout,
      currency,
      platformFeeMinor: totals.platformFeeMinor,
      netMinor: totals.netMinor,
      bookingCount: 0,
      averageBookingValueMinor: totals.averageBookingValueMinor,
      cancellationRate: 0,
      rangeFrom: window.from.toISOString(),
      rangeTo: window.to.toISOString(),
    },
    current: totals,
    previous: emptyTotals(),
    deltas: {
      occupancyRatePoints: null,
      cancellationRatePoints: null,
      revenueRatio: null,
      bookingCountRatio: null,
      averageBookingValueRatio: null,
    },
    series: localDaysBetween(window.from, window.to, timezone).map((date) => ({
      date,
      bookedMinutes: 0,
      bookableMinutes: 0,
      occupancyRate: 0,
      revenueMinor: asMinor(0),
      bookingCount: 0,
    })),
    range: { from: window.from.toISOString(), to: window.to.toISOString() },
    previousRange: {
      from: window.previousFrom.toISOString(),
      to: window.previousTo.toISOString(),
    },
    timezone,
    currency,
    pitchCount: pitches.length,
    activePitchCount: 0,
  }
}

/* -------------------------------------------------------------------------- */
/*  Small utilities                                                           */
/* -------------------------------------------------------------------------- */

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const item of items) {
    const bucket = map.get(key(item))
    if (bucket) bucket.push(item)
    else map.set(key(item), [item])
  }
  return map
}

/** Percent string for a rate in [0,1], e.g. `0.4231` → `"42%"`. */
export function formatRate(rate: number, fractionDigits = 0): string {
  return `${(clamp01(rate) * 100).toFixed(fractionDigits)}%`
}

/** Signed percent string for a delta ratio, e.g. `0.184` → `"+18.4%"`. */
export function formatSignedRatio(value: number | null, fractionDigits = 1): string | null {
  if (value === null || !Number.isFinite(value)) return null
  const sign = value > 0 ? "+" : ""
  return `${sign}${(value * 100).toFixed(fractionDigits)}%`
}

/** Signed points string for a rate delta, e.g. `0.12` → `"+12 pts"`. */
export function formatSignedPoints(value: number | null, fractionDigits = 0): string | null {
  if (value === null || !Number.isFinite(value)) return null
  const sign = value > 0 ? "+" : ""
  return `${sign}${(value * 100).toFixed(fractionDigits)} pts`
}

/* ========================================================================== */
/*  Venue resolution                                                          */
/* ========================================================================== */
/*
 * Shared by every page under `app/(dashboard)/venue/**` so they all agree on which venue "my
 * dashboard" means.
 *
 * A NOTE ON THE `owner_id` FILTER, because the house rule is "RLS is the boundary, an explicit
 * owner filter is only a query optimisation" and this is the one place where that is not the
 * whole story. `venues` carries a deliberately PUBLIC select policy
 * (`venues_select_active_anon` / `venues_select_active_or_own`): anyone, signed in or not, may
 * read an ACTIVE venue, because browsing facilities is the front door of the product. So on this
 * table the RLS predicate is "active OR mine", and an unfiltered read would hand a venue owner
 * every competitor's venue — not a security failure, but the wrong QUESTION. The `owner_id`
 * predicate is therefore semantic here: it is what turns "venues I may read" into "venues I own".
 *
 * Everywhere else in this module (bookings, blocks, payouts) the filters really are just index
 * hints, and deleting them would change performance, not visibility.
 */

/** The venue fields the dashboard chrome needs. */
export type OwnerVenue = Pick<
  Tables<"venues">,
  | "id"
  | "owner_id"
  | "name"
  | "slug"
  | "city"
  | "timezone"
  | "is_active"
  | "stripe_account_id"
  | "charges_enabled"
  | "payouts_enabled"
  | "onboarding_completed_at"
  | "created_at"
>

const OWNER_VENUE_COLUMNS =
  "id, owner_id, name, slug, city, timezone, is_active, stripe_account_id, charges_enabled, " +
  "payouts_enabled, onboarding_completed_at, created_at"

/** Every venue this user owns, oldest first (so "my first venue" is a stable default). */
export async function listOwnedVenues(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<OwnerVenue[]> {
  const { data, error } = await supabase
    .from("venues")
    .select(OWNER_VENUE_COLUMNS)
    .eq("owner_id", userId)
    .order("created_at", { ascending: true })

  if (error) throw error
  // `as unknown as`: OWNER_VENUE_COLUMNS is a shared const rather than a string literal.
  return (data ?? []) as unknown as OwnerVenue[]
}

/**
 * Pick the venue a dashboard page should render.
 *
 * `requestedId` comes from `?venue=…`. An owner may only select from what they own; an ADMIN may
 * additionally name any venue by id, which is what makes support work possible without handing
 * anyone a service-role key. Returns `null` when a fresh owner has no venue yet — the caller
 * renders the "create your venue" path rather than an error.
 */
export async function resolveDashboardVenue(
  supabase: SupabaseClient<Database>,
  userId: string,
  options: { requestedId?: string; isAdmin?: boolean } = {},
): Promise<{ venue: OwnerVenue | null; venues: OwnerVenue[] }> {
  const venues = await listOwnedVenues(supabase, userId)
  const requestedId = options.requestedId

  if (requestedId) {
    const owned = venues.find((venue) => venue.id === requestedId)
    if (owned) return { venue: owned, venues }

    if (options.isAdmin) {
      // RLS still applies; an admin's `private.is_admin()` disjunct is what lets this through.
      const { data, error } = await supabase
        .from("venues")
        .select(OWNER_VENUE_COLUMNS)
        .eq("id", requestedId)
        .maybeSingle()
      if (error) throw error
      if (data) {
        const venue = data as unknown as OwnerVenue
        return { venue, venues: [venue, ...venues] }
      }
    }
  }

  return { venue: venues[0] ?? null, venues }
}

/** `YYYY-MM-DD` of the Monday of the local week containing `instant`. */
export function startOfLocalWeek(instant: Date, timeZone: string): string {
  const key = zonedDateKey(instant, timeZone)
  const { year, month, day } = parseDateKey(key)
  // getUTCDay(): 0 = Sunday. Shift so Monday leads the week.
  const offset = (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7
  return addDaysToDateKey(key, -offset)
}
