/**
 * lib/booking/slots.ts
 *
 * Everything the booking screens need to turn a pitch's availability into something tappable.
 * Nothing here decides what a booking costs; the server does that.
 *
 * ---------------------------------------------------------------------------
 * WHERE A GRID COMES FROM
 * ---------------------------------------------------------------------------
 * `GET /api/pitches/[id]/slots` is the source. It runs the free/busy read with the service-role
 * client because `bookings_select_stakeholders` deliberately hides other people's bookings, and
 * it prices every slot through the same `slotPriceMinor()` that `POST /api/bookings/checkout`
 * uses — so the grid and the card charge cannot disagree.
 *
 * {@link buildFallbackGrid} exists for the window during development where that route is not
 * deployed yet. It builds the same shape from the user's OWN Supabase client, and it is NOT
 * equivalent: RLS shows the caller only their own bookings, their team's, and the ones on a
 * pitch they own. Everyone else's reservations are invisible, so a slot another customer has
 * already paid for renders as free. That is why {@link PitchSlots.degraded} is on the return
 * value and why the picker puts a warning above a degraded grid instead of drawing it silently.
 * The exclusion constraint at checkout is still the thing that decides who gets the slot; a
 * degraded grid makes losing that race much more likely.
 *
 * ---------------------------------------------------------------------------
 * PRICE
 * ---------------------------------------------------------------------------
 * The client never computes a price it then sends. `slotPriceMinor()` below mirrors the server
 * only so a fallback grid can label its own slots; {@link selectionSubtotalMinor} adds up prices
 * the SERVER put on the slots, and the number it returns is an estimate shown next to the words
 * "confirmed at checkout". What the customer is charged comes back in `CheckoutResult.quote`,
 * recomputed on the server from `pitches.hourly_rate_minor`.
 *
 * The parsers for the two booking payloads that carry money — {@link parseCheckoutResult} and
 * {@link parseCancellationResult} — live here too, next to the grid they follow on from, so the
 * picker and the booking screen cannot end up with two different ideas of what a quote is.
 *
 * ---------------------------------------------------------------------------
 * TIME
 * ---------------------------------------------------------------------------
 * `pitches.opening_time` and `closing_time` are wall clock in the VENUE's zone; bookings and
 * blackouts are absolute instants. Every boundary here is resolved through
 * {@link zonedWallClockToUtc}, which is the same two-pass technique `lib/venue/metrics.ts` uses
 * on the web. Slot ENDS are then absolute (`start + slotMinutes`), matching `quoteBooking()` —
 * reading the end off the wall clock would produce a "60-minute" slot that is 0 or 120 real
 * minutes long on the two days a year a DST zone shifts, and checkout would refuse a slot this
 * grid had just advertised.
 */

import { z } from 'zod'

import { Constants, type Enums } from '@onpitch/shared/database'
import {
  asMinor,
  DEFAULT_CURRENCY,
  type AvailabilityDay,
  type AvailabilityGrid,
  type CancellationResult,
  type CheckoutResult,
  type MinorUnits,
  type SlotUnavailableReason,
  type TimeSlot,
} from '@onpitch/shared/domain'

const MINUTE_MS = 60_000
const DAY_MINUTES = 24 * 60

/** How many local days one request may ask the slots route for. The route's own cap is 7. */
export const MAX_GRID_DAYS = 7

/**
 * Ceiling on slots emitted for a single day, so a corrupt `opening_time` cannot make the picker
 * allocate without limit. 96 is a 24-hour pitch on the finest (15-minute) grid the schema allows.
 */
const MAX_SLOTS_PER_DAY = 96

/**
 * Longest booking the picker will assemble out of consecutive slots.
 *
 * Eight slots is four hours at the common 30-minute granularity. The server imposes no such
 * limit — this is a guard against a fat-fingered drag turning into an eight-hour charge.
 */
export const MAX_SLOTS_PER_BOOKING = 8

/** Statuses whose booking holds the slot. Mirrors `OCCUPYING_BOOKING_STATUSES` on the web. */
export const SLOT_HOLDING_STATUSES: readonly Enums<'booking_status'>[] = [
  'pending',
  'awaiting_payment',
  'confirmed',
  'completed',
]

/* ========================================================================== */
/*  Time zone arithmetic                                                      */
/* ========================================================================== */

export interface ZonedParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
}

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

/** An instant, read as a wall clock in `timeZone`. An unknown zone degrades to UTC. */
export function zonedParts(instant: Date, timeZone: string): ZonedParts {
  let formatter: Intl.DateTimeFormat
  try {
    formatter = partsFormatter(timeZone)
  } catch {
    formatter = partsFormatter('UTC')
  }

  const bag: Record<string, string> = {}
  for (const part of formatter.formatToParts(instant)) {
    if (part.type !== 'literal') bag[part.type] = part.value
  }

  // Some engines render midnight as "24" under hour12:false; normalise it back to 0.
  const hour = Number(bag.hour ?? '0') % 24

  return {
    year: Number(bag.year ?? '1970'),
    month: Number(bag.month ?? '1'),
    day: Number(bag.day ?? '1'),
    hour: Number.isFinite(hour) ? hour : 0,
    minute: Number(bag.minute ?? '0'),
  }
}

/** Minutes east of UTC that `timeZone` observes at `instant`. */
function zoneOffsetMinutes(instant: Date, timeZone: string): number {
  const parts = zonedParts(instant, timeZone)
  const asIfUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0)
  return Math.round((asIfUtc - instant.getTime()) / MINUTE_MS)
}

/**
 * The absolute instant at which a local wall clock occurs in `timeZone`.
 *
 * Two passes, because the offset needed depends on the answer being computed: the first pass
 * uses the offset in force at the naive instant, the second corrects it with the offset in force
 * at the candidate. That converges everywhere outside the one-hour DST gap, where either answer
 * names the same real instant.
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

/** `YYYY-MM-DD` for an instant, as seen in `timeZone`. */
export function zonedDateKey(instant: Date, timeZone: string): string {
  const { year, month, day } = zonedParts(instant, timeZone)
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** Split a `YYYY-MM-DD` key back into numbers. Malformed input lands on the epoch, never NaN. */
export function parseDateKey(key: string): { year: number; month: number; day: number } {
  const [year = '1970', month = '01', day = '01'] = key.split('-')
  const parsed = { year: Number(year), month: Number(month), day: Number(day) }
  if (!Number.isFinite(parsed.year) || !Number.isFinite(parsed.month) || !Number.isFinite(parsed.day)) {
    return { year: 1970, month: 1, day: 1 }
  }
  return parsed
}

/** True when a key is well formed AND names a real civil date — 2026-02-31 is neither. */
export function isDateKey(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const { year, month, day } = parseDateKey(value)
  if (month < 1 || month > 12 || day < 1 || day > 31) return false
  const probe = new Date(Date.UTC(year, month - 1, day))
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  )
}

/** Advance a `YYYY-MM-DD` key by `days`, on the civil calendar, so DST cannot drift it. */
export function addDaysToDateKey(key: string, days: number): string {
  const { year, month, day } = parseDateKey(key)
  return zonedDateKey(new Date(Date.UTC(year, month - 1, day + days)), 'UTC')
}

/** Today's local calendar day at the venue. */
export function todayKey(timeZone: string, now: Date = new Date()): string {
  return zonedDateKey(now, timeZone)
}

/** `count` consecutive local days starting at `startKey`, capped at {@link MAX_GRID_DAYS}. */
export function dateKeysFrom(startKey: string, count: number): string[] {
  const total = Math.min(Math.max(Math.trunc(count), 1), MAX_GRID_DAYS)
  const keys: string[] = []
  for (let offset = 0; offset < total; offset += 1) keys.push(addDaysToDateKey(startKey, offset))
  return keys
}

/** `"08:00"` / `"08:00:00"` / `"24:00:00"` → minutes past local midnight. */
export function timeToMinutes(value: string | null | undefined): number {
  if (!value) return 0
  const [rawHour = '0', rawMinute = '0'] = value.split(':')
  const hour = Number(rawHour)
  const minute = Number(rawMinute)
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return 0
  return Math.max(0, Math.min(DAY_MINUTES, hour * 60 + minute))
}

/* ========================================================================== */
/*  Intervals                                                                 */
/* ========================================================================== */

export interface Interval {
  /** Epoch ms, inclusive. */
  start: number
  /** Epoch ms, exclusive. */
  end: number
}

/** Half-open overlap. Touching endpoints do not overlap — the rule `tstzrange` itself uses. */
function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end
}

/**
 * Parse a Postgres `tstzrange` literal into an {@link Interval}.
 *
 * PostgREST hands back the raw literal — `["2026-09-01 18:00:00+00","2026-09-01 19:00:00+00")` —
 * whose space separator and truncated `+00` offset Hermes' `Date.parse` rejects, so both are
 * normalised. Returns null rather than throwing: one unreadable row must not empty a list.
 */
export function parseRange(literal: string | null | undefined): Interval | null {
  if (!literal) return null
  const inner = literal.trim().replace(/^[[(]/, '').replace(/[\])]$/, '')

  let inQuotes = false
  let splitAt = -1
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index]
    if (char === '"') inQuotes = !inQuotes
    else if (char === ',' && !inQuotes) {
      splitAt = index
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
  const unquoted = raw.trim().replace(/^"/, '').replace(/"$/, '')
  const withT = unquoted.replace(' ', 'T')
  // `+00` → `+00:00`, `+0300` → `+03:00`, anchored to the time component so a bare date's
  // trailing `-01` is never mistaken for an offset.
  return withT.replace(
    /T([\d:.]+)([+-]\d{2})(\d{2})?$/,
    (_all, time: string, hours: string, minutes?: string) => `T${time}${hours}:${minutes ?? '00'}`,
  )
}

/** A half-open `tstzrange` literal, for a PostgREST overlap filter. */
export function toRangeLiteral(from: Date | string, to: Date | string): string {
  const start = from instanceof Date ? from : new Date(from)
  const end = to instanceof Date ? to : new Date(to)
  return `["${start.toISOString()}","${end.toISOString()}")`
}

/* ========================================================================== */
/*  Price of one slot                                                         */
/* ========================================================================== */

/**
 * What one slot costs, in minor units.
 *
 * Mirrors `slotPriceMinor()` in `apps/web/lib/payments.ts` exactly, including the `+ 30`
 * half-up bias. It is used ONLY to label a {@link buildFallbackGrid} grid, which the
 * server did not price. Returns 0 for a misconfigured pitch, which turns the whole grid closed
 * rather than throwing inside a render.
 */
export function slotPriceMinor(hourlyRateMinor: number, slotMinutes: number): MinorUnits {
  if (!Number.isInteger(hourlyRateMinor) || hourlyRateMinor <= 0) return asMinor(0)
  if (!Number.isInteger(slotMinutes) || slotMinutes <= 0) return asMinor(0)
  return asMinor(Math.floor((hourlyRateMinor * slotMinutes + 30) / 60))
}

/* ========================================================================== */
/*  The /api/pitches/[id]/slots payload                                       */
/* ========================================================================== */

/*
 * `apiFetch<T>` verifies the ApiResponse envelope but not the payload inside it, and this
 * payload carries money and the instants a reservation is made from, so it is parsed rather than
 * asserted: a server that regresses produces one readable error here rather than a grid of
 * `NaN` prices and an `Invalid Date` in a checkout body.
 */

const slotReasonSchema = z.enum(['booked', 'blocked', 'closed', 'past', 'venue_not_payable'])

const isoInstant = z.string().refine((value) => Number.isFinite(Date.parse(value)), {
  message: 'expected an ISO-8601 instant',
})

const minorAmount = z.number().int().min(0)

const timeSlotSchema = z.object({
  startsAt: isoInstant,
  endsAt: isoInstant,
  available: z.boolean(),
  priceMinor: minorAmount,
  reason: slotReasonSchema.optional(),
})

const availabilityDaySchema = z.object({
  date: z.string().refine(isDateKey, 'expected a calendar date as YYYY-MM-DD'),
  slots: z.array(timeSlotSchema).max(MAX_SLOTS_PER_DAY),
})

const availabilityGridSchema = z.object({
  pitchId: z.string().min(1),
  venueId: z.string().min(1),
  timezone: z.string().min(1),
  slotMinutes: z.number().int().positive(),
  currency: z.string().min(3).max(3),
  hourlyRateMinor: minorAmount,
  days: z.array(availabilityDaySchema).max(MAX_GRID_DAYS),
})

const pitchSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  // Taken from `Constants` rather than retyped, so a migration that adds a format cannot leave
  // this schema rejecting a pitch the server is happy to sell.
  format: z.enum(Constants.public.Enums.match_format),
  surface: z.enum(Constants.public.Enums.pitch_surface),
  isIndoor: z.boolean(),
  capacity: z.number().int().nullable(),
  openingTime: z.string(),
  closingTime: z.string(),
})

const venueSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  slug: z.string(),
  city: z.string().nullable(),
  timezone: z.string().min(1),
  isPayable: z.boolean(),
})

const pitchSlotsSchema = z.object({
  pitch: pitchSummarySchema,
  venue: venueSummarySchema,
  grid: availabilityGridSchema,
  generatedAt: isoInstant,
})

export type SlotsPitchSummary = z.infer<typeof pitchSummarySchema>
export type SlotsVenueSummary = z.infer<typeof venueSummarySchema>

/** The parsed slots payload, plus the honesty flag the picker renders a warning from. */
export interface PitchSlots {
  pitch: SlotsPitchSummary
  venue: SlotsVenueSummary
  grid: AvailabilityGrid
  /** When the free/busy snapshot was taken. Slots go stale in seconds, so the UI says when. */
  generatedAt: string
  /**
   * True when the grid came from {@link buildFallbackGrid} rather than the server, i.e. it was
   * assembled from a view of `bookings` that RLS narrows to the caller's own rows.
   */
  degraded: boolean
}

/**
 * Parse a `GET /api/pitches/[id]/slots` payload.
 *
 * @throws {TypeError} with a readable path when the payload is not the documented shape.
 */
export function parsePitchSlots(payload: unknown): PitchSlots {
  const parsed = pitchSlotsSchema.safeParse(payload)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    const where = first ? `${first.path.join('.') || 'payload'}: ${first.message}` : 'unknown field'
    throw new TypeError(`The availability response was not in the expected shape (${where}).`)
  }

  const { pitch, venue, grid, generatedAt } = parsed.data

  return {
    pitch,
    venue,
    generatedAt,
    degraded: false,
    grid: {
      pitchId: grid.pitchId,
      venueId: grid.venueId,
      timezone: grid.timezone,
      slotMinutes: grid.slotMinutes,
      currency: grid.currency.toLowerCase(),
      hourlyRateMinor: asMinor(grid.hourlyRateMinor),
      days: grid.days.map((day) => ({
        date: day.date,
        slots: day.slots.map(toTimeSlot),
      })),
    },
  }
}

function toTimeSlot(raw: z.infer<typeof timeSlotSchema>): TimeSlot {
  const slot: TimeSlot = {
    startsAt: raw.startsAt,
    endsAt: raw.endsAt,
    available: raw.available,
    priceMinor: asMinor(raw.priceMinor),
  }
  if (raw.reason) slot.reason = raw.reason
  return slot
}

/* ========================================================================== */
/*  Checkout and cancellation payloads                                        */
/* ========================================================================== */

const bookingQuoteSchema = z.object({
  pitchId: z.string().min(1),
  startsAt: isoInstant,
  endsAt: isoInstant,
  durationMinutes: z.number().int().positive(),
  hourlyRateMinor: minorAmount,
  subtotalMinor: minorAmount,
  platformFeeMinor: minorAmount,
  totalMinor: minorAmount,
  currency: z.string().min(3).max(3),
})

const checkoutResultSchema = z.object({
  bookingId: z.string().min(1),
  clientSecret: z.string().min(1),
  publishableKey: z.string().min(1),
  quote: bookingQuoteSchema,
})

const cancellationResultSchema = z.object({
  bookingId: z.string().min(1),
  status: z.enum(Constants.public.Enums.booking_status),
  paymentStatus: z.enum(Constants.public.Enums.payment_status),
  refundedAmountMinor: minorAmount,
  currency: z.string().min(3).max(3),
  fullRefund: z.boolean(),
})

/**
 * Parse `POST /api/bookings/checkout`.
 *
 * This is the payload the Payment Sheet is mounted from and the amounts the customer is shown
 * before they authorise a charge, so it is verified rather than asserted. A `clientSecret` of
 * `undefined` reaching `initPaymentSheet` produces a native error with no useful message; a
 * `totalMinor` of `undefined` renders as `NaN` next to a Pay button.
 *
 * @throws {TypeError} naming the first field that did not match.
 */
export function parseCheckoutResult(payload: unknown): CheckoutResult {
  const parsed = checkoutResultSchema.safeParse(payload)
  if (!parsed.success) {
    throw new TypeError(`The checkout response was not in the expected shape (${firstIssue(parsed.error)}).`)
  }
  const { bookingId, clientSecret, publishableKey, quote } = parsed.data

  return {
    bookingId,
    clientSecret,
    publishableKey,
    quote: {
      pitchId: quote.pitchId,
      startsAt: quote.startsAt,
      endsAt: quote.endsAt,
      durationMinutes: quote.durationMinutes,
      hourlyRateMinor: asMinor(quote.hourlyRateMinor),
      subtotalMinor: asMinor(quote.subtotalMinor),
      platformFeeMinor: asMinor(quote.platformFeeMinor),
      totalMinor: asMinor(quote.totalMinor),
      currency: quote.currency.toLowerCase(),
    },
  }
}

/** Parse `POST /api/bookings/[id]/cancel`. The refunded amount is shown to the customer. */
export function parseCancellationResult(payload: unknown): CancellationResult {
  const parsed = cancellationResultSchema.safeParse(payload)
  if (!parsed.success) {
    throw new TypeError(
      `The cancellation response was not in the expected shape (${firstIssue(parsed.error)}).`,
    )
  }
  const data = parsed.data
  return {
    bookingId: data.bookingId,
    status: data.status,
    paymentStatus: data.paymentStatus,
    refundedAmountMinor: asMinor(data.refundedAmountMinor),
    currency: data.currency.toLowerCase(),
    fullRefund: data.fullRefund,
  }
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0]
  return issue ? `${issue.path.join('.') || 'payload'}: ${issue.message}` : 'unknown field'
}

/* ========================================================================== */
/*  The fallback grid                                                         */
/* ========================================================================== */

/** The pitch fields a grid depends on, already out of snake_case. */
export interface FallbackPitch {
  id: string
  venueId: string
  /** `HH:MM[:SS]` wall clock in the venue timezone. */
  openingTime: string
  closingTime: string
  slotMinutes: number
  hourlyRateMinor: number
  currency: string
  isActive: boolean
}

export interface FallbackGridInput {
  pitch: FallbackPitch
  /** IANA zone from `venues.timezone`. */
  timezone: string
  /** Local calendar days to render. */
  dates: readonly string[]
  /** Bookings the CALLER can see. Under RLS that is not all of them — see the file header. */
  bookings: readonly Interval[]
  blocks: readonly Interval[]
  /** Published AND able to take a charge. False turns the grid unbookable with a reason. */
  venuePayable: boolean
  now?: Date
}

/** Opening minutes on a continuous axis; a schedule wrapping past midnight becomes `close + 1440`. */
function openingMinutes(pitch: FallbackPitch): { open: number; close: number } | null {
  const open = timeToMinutes(pitch.openingTime)
  const rawClose = timeToMinutes(pitch.closingTime)
  const close = rawClose <= open ? rawClose + DAY_MINUTES : rawClose
  return close > open ? { open, close } : null
}

/**
 * The instants one local day's slots can occupy, or null when the pitch sells nothing that day.
 * Exported so a caller can size the overlap query it runs against `bookings`.
 */
export function dayWindow(
  pitch: FallbackPitch,
  dateKey: string,
  timeZone: string,
): Interval | null {
  const hours = openingMinutes(pitch)
  if (!hours) return null
  const { year, month, day } = parseDateKey(dateKey)
  // Date.UTC normalises minute overflow, so a close of 1560 (26:00) rolls into the next civil
  // day on its own — which is exactly what a schedule wrapping past midnight means.
  const start = zonedWallClockToUtc(year, month, day, 0, hours.open, timeZone)
  const end = zonedWallClockToUtc(year, month, day, 0, hours.close, timeZone)
  return end.getTime() > start.getTime() ? { start: start.getTime(), end: end.getTime() } : null
}

/**
 * One interval covering every day in `dates`, padded by a slot at each end.
 *
 * The padding covers DST: slot ends are absolute while the window's bounds are wall clock, so on
 * a DST day the last slot can finish after the window does. Widening the query can
 * only pull in intervals that overlap no slot; narrowing it would show a booked slot as free.
 */
export function coveringWindow(
  pitch: FallbackPitch,
  dates: readonly string[],
  timeZone: string,
): Interval | null {
  let start = Number.POSITIVE_INFINITY
  let end = Number.NEGATIVE_INFINITY
  for (const key of dates) {
    const dayInterval = dayWindow(pitch, key, timeZone)
    if (!dayInterval) continue
    if (dayInterval.start < start) start = dayInterval.start
    if (dayInterval.end > end) end = dayInterval.end
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null

  const pad = Math.max(pitch.slotMinutes, 60) * MINUTE_MS
  return { start: start - pad, end: end + pad }
}

function resolveReason(
  slot: Interval,
  bookings: readonly Interval[],
  blocks: readonly Interval[],
  nowMs: number,
): SlotUnavailableReason | null {
  // "That time has gone" is more useful than "someone else has it" for a slot that is both.
  if (slot.start <= nowMs) return 'past'
  for (const booking of bookings) if (overlaps(slot, booking)) return 'booked'
  for (const block of blocks) if (overlaps(slot, block)) return 'blocked'
  return null
}

/**
 * Build a grid on the device, for the case where the slots route is not deployed.
 *
 * Produces the same {@link AvailabilityGrid} shape as the server so the picker has one code
 * path, but the caller MUST mark the result degraded: the `bookings` handed in came through
 * RLS, which hides other customers' reservations.
 */
export function buildFallbackGrid(input: FallbackGridInput): AvailabilityGrid {
  const { pitch, timezone } = input
  const nowMs = (input.now ?? new Date()).getTime()
  const perSlot = slotPriceMinor(pitch.hourlyRateMinor, pitch.slotMinutes)

  const blanketReason: SlotUnavailableReason | null = !pitch.isActive
    ? 'closed'
    : !input.venuePayable
      ? 'venue_not_payable'
      : perSlot <= 0
        ? 'closed'
        : null

  const hours = openingMinutes(pitch)
  const days: AvailabilityDay[] = []

  for (const dateKey of input.dates.slice(0, MAX_GRID_DAYS)) {
    const slots: TimeSlot[] = []

    if (hours) {
      const { year, month, day } = parseDateKey(dateKey)
      const seen = new Set<number>()

      for (
        let minute = hours.open, guard = 0;
        minute + pitch.slotMinutes <= hours.close && guard < MAX_SLOTS_PER_DAY;
        minute += pitch.slotMinutes, guard += 1
      ) {
        const startMs = zonedWallClockToUtc(year, month, day, 0, minute, timezone).getTime()
        // A spring-forward gap maps two wall clocks onto one instant. Emitting both would put
        // two identical rows on the picker, only one of which can be booked.
        if (seen.has(startMs)) continue
        seen.add(startMs)

        const interval: Interval = { start: startMs, end: startMs + pitch.slotMinutes * MINUTE_MS }
        const reason = blanketReason ?? resolveReason(interval, input.bookings, input.blocks, nowMs)

        const slot: TimeSlot = {
          startsAt: new Date(interval.start).toISOString(),
          endsAt: new Date(interval.end).toISOString(),
          available: reason === null,
          priceMinor: perSlot,
        }
        if (reason !== null) slot.reason = reason
        slots.push(slot)
      }
    }

    days.push({ date: dateKey, slots })
  }

  return {
    pitchId: pitch.id,
    venueId: pitch.venueId,
    timezone,
    slotMinutes: pitch.slotMinutes,
    currency: (pitch.currency || DEFAULT_CURRENCY).toLowerCase(),
    hourlyRateMinor: asMinor(Math.max(0, Math.trunc(pitch.hourlyRateMinor))),
    days,
  }
}

/* ========================================================================== */
/*  Reading a grid                                                            */
/* ========================================================================== */

/** Why a slot cannot be sold, in words a customer can act on. */
export const SLOT_REASON_LABEL: Readonly<Record<SlotUnavailableReason, string>> = {
  booked: 'Taken',
  blocked: 'Closed by the venue',
  closed: 'Not sold',
  past: 'Gone',
  venue_not_payable: 'Not taking payments',
}

/** The day with this key, or null when the grid does not cover it. */
export function dayByKey(grid: AvailabilityGrid, dateKey: string): AvailabilityDay | null {
  for (const day of grid.days) if (day.date === dateKey) return day
  return null
}

/** How many slots on a day a customer could take right now. */
export function countAvailable(day: AvailabilityDay | null): number {
  if (!day) return 0
  let total = 0
  for (const slot of day.slots) if (slot.available) total += 1
  return total
}

/** How many slots across the whole grid are free. */
export function countAvailableInGrid(grid: AvailabilityGrid): number {
  let total = 0
  for (const day of grid.days) total += countAvailable(day)
  return total
}

/** The first free slot on a day, for a "next free at 19:00" hint. */
export function firstAvailable(day: AvailabilityDay | null): TimeSlot | null {
  if (!day) return null
  for (const slot of day.slots) if (slot.available) return slot
  return null
}

/* ========================================================================== */
/*  Selection                                                                 */
/* ========================================================================== */

/**
 * A selection is an ordered run of CONSECUTIVE slots on one day.
 *
 * Consecutive is checked by exact string equality of one slot's `endsAt` against the next
 * slot's `startsAt`, which both come out of the same generator. That is stricter than comparing
 * parsed instants, and deliberately so: on a spring-forward day the grid skips a slot, and the
 * two slots either side of the gap must not join into a booking whose `time_range` covers a
 * window the venue is not selling.
 */
export type SlotSelection = readonly TimeSlot[]

function adjacentBefore(slot: TimeSlot, first: TimeSlot): boolean {
  return slot.endsAt === first.startsAt
}

function adjacentAfter(slot: TimeSlot, last: TimeSlot): boolean {
  return slot.startsAt === last.endsAt
}

/**
 * Apply a tap to the current selection.
 *
 * - Tapping a free slot with nothing selected starts a selection.
 * - Tapping the slot immediately before or after the run extends it, up to
 *   {@link MAX_SLOTS_PER_BOOKING}.
 * - Tapping either END of the run shortens it; tapping the only selected slot clears it.
 * - Anything else — a slot inside the run, a slot across a gap, a slot on another day —
 *   restarts the selection at the tapped slot.
 *
 * An unavailable slot never enters a selection.
 */
export function toggleSlot(selection: SlotSelection, slot: TimeSlot): SlotSelection {
  if (!slot.available) return selection
  if (selection.length === 0) return [slot]

  const first = selection[0]
  const last = selection[selection.length - 1]
  if (!first || !last) return [slot]

  if (selection.length === 1 && first.startsAt === slot.startsAt) return []
  if (first.startsAt === slot.startsAt) return selection.slice(1)
  if (last.startsAt === slot.startsAt) return selection.slice(0, -1)

  if (selection.length >= MAX_SLOTS_PER_BOOKING) return [slot]
  if (adjacentBefore(slot, first)) return [slot, ...selection]
  if (adjacentAfter(slot, last)) return [...selection, slot]

  return [slot]
}

/** True when this slot is part of the run. */
export function isSelected(selection: SlotSelection, slot: TimeSlot): boolean {
  for (const entry of selection) if (entry.startsAt === slot.startsAt) return true
  return false
}

export interface SelectionWindow {
  /** ISO instant, inclusive lower bound. What goes in the checkout body. */
  startsAt: string
  /** ISO instant, exclusive upper bound. */
  endsAt: string
  durationMinutes: number
  slotCount: number
}

/** The `[start, end)` window a selection asks for, or null when nothing is selected. */
export function selectionWindow(selection: SlotSelection): SelectionWindow | null {
  const first = selection[0]
  const last = selection[selection.length - 1]
  if (!first || !last) return null

  const startMs = Date.parse(first.startsAt)
  const endMs = Date.parse(last.endsAt)
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null

  return {
    startsAt: first.startsAt,
    endsAt: last.endsAt,
    durationMinutes: Math.round((endMs - startMs) / MINUTE_MS),
    slotCount: selection.length,
  }
}

/**
 * What the selected slots add up to, using the prices the SERVER put on them.
 *
 * An estimate for the button. It is never sent anywhere: the checkout body carries a pitch and a
 * window, and `quoteBooking()` recomputes the charge from `pitches.hourly_rate_minor`, so render
 * it next to words that say the total is confirmed at checkout.
 */
export function selectionSubtotalMinor(selection: SlotSelection): MinorUnits {
  let total = 0
  for (const slot of selection) total += Math.max(0, Math.trunc(slot.priceMinor))
  return asMinor(total)
}

/* ========================================================================== */
/*  Reservation lifetime                                                      */
/* ========================================================================== */

/**
 * How long an unpaid reservation holds its slot, in minutes.
 *
 * The server owns this number — `BOOKING_RESERVATION_TTL_MINUTES`, defaulted to 30 and clamped
 * to [10, 1440] in both `lib/booking/availability.ts` and the expire-reservations route — and
 * the app cannot read a server env var. So the countdown below is ADVISORY: it uses the same
 * default, and every screen that shows it treats the expiry as "this hold is probably gone, ask
 * the server" rather than as a fact. The booking row is what actually settles it, because the
 * sweeper flips `status` to `cancelled` when the hold lapses.
 */
export const RESERVATION_TTL_MINUTES = 30

/** When a reservation created at `createdAt` stops holding its slot. Null if unparseable. */
export function reservationExpiresAt(createdAt: string | null | undefined): Date | null {
  if (!createdAt) return null
  const created = Date.parse(createdAt)
  if (!Number.isFinite(created)) return null
  return new Date(created + RESERVATION_TTL_MINUTES * MINUTE_MS)
}

/**
 * `mm:ss` remaining until `deadline`, or null once it has passed.
 *
 * Returned as a string rather than a number so the caller cannot accidentally render a negative
 * countdown; "expired" is a different UI state, not `-00:14`.
 */
export function countdownLabel(deadline: Date | null, now: Date = new Date()): string | null {
  if (!deadline) return null
  const remaining = deadline.getTime() - now.getTime()
  if (remaining <= 0) return null

  const totalSeconds = Math.floor(remaining / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

/* ========================================================================== */
/*  Distance                                                                  */
/* ========================================================================== */

export interface Coordinates {
  latitude: number
  longitude: number
}

const EARTH_RADIUS_KM = 6371

/**
 * Great-circle distance in kilometres.
 *
 * Haversine rather than the equirectangular approximation: the cheap version is fine inside one
 * city and visibly wrong across a country, and the sort has to stay sane for a user who searches
 * a city they are not in.
 */
export function distanceKm(from: Coordinates, to: Coordinates): number {
  const toRadians = (degrees: number): number => (degrees * Math.PI) / 180
  const deltaLat = toRadians(to.latitude - from.latitude)
  const deltaLon = toRadians(to.longitude - from.longitude)
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(toRadians(from.latitude)) *
      Math.cos(toRadians(to.latitude)) *
      Math.sin(deltaLon / 2) ** 2
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)))
}

/** `1.2 km` / `14 km`. Below a kilometre it rounds to one decimal; above it, to whole numbers. */
export function formatDistanceKm(km: number): string {
  if (!Number.isFinite(km) || km < 0) return '—'
  return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`
}

/** The mean of a set of coordinates, or null when the set is empty. */
export function centroidOf(points: readonly Coordinates[]): Coordinates | null {
  if (points.length === 0) return null
  let latitude = 0
  let longitude = 0
  for (const point of points) {
    latitude += point.latitude
    longitude += point.longitude
  }
  return { latitude: latitude / points.length, longitude: longitude / points.length }
}
