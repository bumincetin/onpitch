/**
 * lib/booking/availability.ts
 *
 * Slot generation for the public booking funnel: what a pitch is selling on a given day, at what
 * price, and which of those slots a customer can actually take.
 *
 * ---------------------------------------------------------------------------
 * THE TIMEZONE RULE
 * ---------------------------------------------------------------------------
 * `pitches.opening_time` / `closing_time` are `time` columns — wall clock in the PARENT VENUE's
 * zone (`venues.timezone`). Bookings and blackout windows are `tstzrange`, i.e. absolute
 * instants. A grid built by taking midnight in the SERVER's zone and adding `n * slotMinutes`
 * is wrong for every deployment whose server is not in the venue's zone, and wrong twice a year
 * even when it is. So every slot boundary here is resolved through `zonedWallClockToUtc()` from
 * `lib/venue/metrics.ts` — the same function the owner calendar and the occupancy numbers use.
 * One definition of "Tuesday 19:00 at this venue", shared by the three surfaces that render it.
 *
 * Slot ENDS are then computed as `start + slotMinutes` in ABSOLUTE time rather than as a second
 * wall-clock reading. That is deliberate and it matches `quoteBooking()` in `lib/payments.ts`,
 * which measures duration as `(end - start) / 60000` and rejects anything that is not a whole
 * number of slots. Reading the end off the wall clock would, on the one day a DST zone shifts,
 * produce a "60-minute" slot that is 0 or 120 real minutes long — and checkout would answer 422
 * for a slot this grid had just advertised as bookable.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MODULE IS NOT
 * ---------------------------------------------------------------------------
 * It performs no I/O and holds no Supabase client. The caller loads the pitch, the occupying
 * bookings and the blackout windows — with the service-role client, because
 * `bookings_select_stakeholders` deliberately hides other people's bookings and a free/busy grid
 * must never be built by relaxing that policy (see the note at the end of `0002_rls.sql`) — and
 * hands intervals in. Only anonymised `{ start, end }` pairs cross this boundary, so nothing a
 * caller renders can leak who holds a slot.
 *
 * A grid is a forecast. The only thing that actually reserves a slot is the
 * INSERT in `POST /api/bookings/checkout` colliding (or not) with the `bookings_no_double_booking`
 * exclusion constraint. Two people can be looking at the same free slot right now; exactly one of
 * them will get it, and this module's job is to make that outcome rare, not to pretend it cannot
 * happen.
 */

import { MINIMUM_CHARGE_MINOR, slotPriceMinor } from "@/lib/payments"
import {
  OCCUPYING_BOOKING_STATUSES,
  parseDateKey,
  timeToMinutes,
  zonedDateKey,
  zonedParts,
  zonedWallClockToUtc,
  type Interval,
} from "@/lib/venue/metrics"
import type { Enums, Tables } from "@halisaha/shared/database"
import {
  asMinor,
  DEFAULT_CURRENCY,
  type AvailabilityDay,
  type AvailabilityGrid,
  type MinorUnits,
  type SlotUnavailableReason,
  type TimeSlot,
} from "@halisaha/shared/domain"

/* ========================================================================== */
/*  Bounds                                                                    */
/* ========================================================================== */

/** How many local days one grid may span. A picker shows a week; the cap is generous. */
export const MAX_GRID_DAYS = 14

/**
 * Ceiling on slots emitted for a single day. 96 is a 24-hour pitch on a 15-minute grid — the
 * finest schedule the `createPitchSchema` bounds allow. It exists so a corrupt `opening_time`
 * cannot make a route allocate without limit.
 */
const MAX_SLOTS_PER_DAY = 96

const MINUTE_MS = 60_000
const DAY_MINUTES = 24 * 60

/** Statuses whose booking holds the slot. Re-exported so callers query with the same list. */
export const SLOT_HOLDING_STATUSES: readonly Enums<"booking_status">[] = OCCUPYING_BOOKING_STATUSES

/* ========================================================================== */
/*  Inputs                                                                    */
/* ========================================================================== */

/** The pitch columns a grid depends on, already normalised out of snake_case. */
export interface AvailabilityPitch {
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

/** The `pitches` columns {@link availabilityPitch} needs. Callers can select narrowly. */
export type AvailabilityPitchRow = Pick<
  Tables<"pitches">,
  | "id"
  | "venue_id"
  | "opening_time"
  | "closing_time"
  | "slot_minutes"
  | "hourly_rate_minor"
  | "currency"
  | "is_active"
>

/** Adapt a database row. The only place snake_case turns into the shape this module speaks. */
export function availabilityPitch(row: AvailabilityPitchRow): AvailabilityPitch {
  return {
    id: row.id,
    venueId: row.venue_id,
    openingTime: row.opening_time,
    closingTime: row.closing_time,
    slotMinutes: row.slot_minutes,
    hourlyRateMinor: row.hourly_rate_minor,
    currency: (row.currency || DEFAULT_CURRENCY).toLowerCase(),
    isActive: row.is_active,
  }
}

export interface BuildGridInput {
  pitch: AvailabilityPitch
  /** IANA zone from `venues.timezone`. An unknown zone degrades to UTC rather than throwing. */
  timezone: string
  /** Local calendar days to render, `YYYY-MM-DD`, in venue-local terms. */
  dates: readonly string[]
  /** Occupying bookings, anonymised to bare intervals. */
  bookings: readonly Interval[]
  /** Owner blackout windows, anonymised — the `reason` text can name a private hirer. */
  blocks: readonly Interval[]
  /**
   * Whether the venue can take money at all: published AND its Connect account accepts charges.
   * False turns the whole grid unbookable with an honest reason instead of sending the customer
   * into a checkout that answers `VENUE_NOT_PAYABLE`.
   */
  venuePayable: boolean
  /** Injectable clock. */
  now?: Date
}

/* ========================================================================== */
/*  Day windows                                                               */
/* ========================================================================== */

/**
 * Opening minutes for a pitch, projected onto a continuous axis.
 *
 * A schedule that wraps past midnight (`closing_time <= opening_time`, e.g. 20:00 → 02:00) is
 * expressed as `[open, close + 1440)`, which is exactly how `assertWithinOpeningHours()` in
 * `lib/payments.ts` reads it. The two must agree or the grid would advertise slots checkout
 * refuses.
 */
function openingMinutes(pitch: AvailabilityPitch): { open: number; close: number } | null {
  const open = timeToMinutes(pitch.openingTime)
  const rawClose = timeToMinutes(pitch.closingTime)
  const close = rawClose <= open ? rawClose + DAY_MINUTES : rawClose
  if (!(close > open)) return null
  return { open, close }
}

/** True when a `YYYY-MM-DD` key is well formed and names a real civil date. */
export function isDateKey(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const { year, month, day } = parseDateKey(value)
  if (month < 1 || month > 12 || day < 1 || day > 31) return false
  const probe = new Date(Date.UTC(year, month - 1, day))
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day
}

/** Today's local calendar day at the venue. */
export function todayKey(timezone: string, now: Date = new Date()): string {
  return zonedDateKey(now, timezone)
}

/** `count` consecutive local days starting at `startKey`, capped at {@link MAX_GRID_DAYS}. */
export function dateKeysFrom(startKey: string, count: number): string[] {
  const { year, month, day } = parseDateKey(startKey)
  const total = Math.min(Math.max(Math.trunc(count), 1), MAX_GRID_DAYS)
  const keys: string[] = []
  for (let offset = 0; offset < total; offset += 1) {
    // Civil-calendar arithmetic in UTC: no DST, so day n + 1 is always the next date on the wall.
    keys.push(zonedDateKey(new Date(Date.UTC(year, month - 1, day + offset)), "UTC"))
  }
  return keys
}

/** The `[start, end)` instants one local day's slots can occupy, or null when nothing is sold. */
export function dayWindow(
  pitch: AvailabilityPitch,
  dateKey: string,
  timezone: string,
): Interval | null {
  const hours = openingMinutes(pitch)
  if (!hours) return null
  const { year, month, day } = parseDateKey(dateKey)
  // Date.UTC normalises minute overflow, so `close = 1560` (26:00) rolls into the next civil day
  // on its own — which is precisely what a schedule wrapping past midnight means.
  const start = zonedWallClockToUtc(year, month, day, 0, hours.open, timezone)
  const end = zonedWallClockToUtc(year, month, day, 0, hours.close, timezone)
  if (!(end.getTime() > start.getTime())) return null
  return { start: start.getTime(), end: end.getTime() }
}

/**
 * One interval covering every day in `dates`, for a single overlap query against `bookings` and
 * `pitch_availability_blocks`. Returns null when the pitch sells nothing.
 *
 * Padded by one slot at each end. Slot ends are absolute (`start + slotMinutes`) while the day
 * window's bounds are wall-clock, so on a DST transition day the last slot can finish up to an
 * hour after the window does. Widening the query can only add intervals that overlap no slot and
 * are therefore ignored; narrowing it would silently show a booked slot as free.
 */
export function coveringWindow(
  pitch: AvailabilityPitch,
  dates: readonly string[],
  timezone: string,
): Interval | null {
  let start = Number.POSITIVE_INFINITY
  let end = Number.NEGATIVE_INFINITY
  for (const key of dates) {
    const window = dayWindow(pitch, key, timezone)
    if (!window) continue
    if (window.start < start) start = window.start
    if (window.end > end) end = window.end
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null

  const pad = Math.max(pitch.slotMinutes, 60) * MINUTE_MS
  return { start: start - pad, end: end + pad }
}

/* ========================================================================== */
/*  The grid                                                                  */
/* ========================================================================== */

/** Half-open overlap test. Touching endpoints do not overlap — the same rule `tstzrange` uses. */
function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && b.start < a.end
}

/**
 * Why this slot cannot be sold, in the order a customer would want to hear it.
 *
 * `past` outranks `booked`: "that time has gone" is more useful than "someone else has it" for a
 * slot that is both. `blocked` is reported without the owner's `reason` text, which can name a
 * private hirer and is never sent to a browsing customer.
 */
function resolveReason(
  slot: Interval,
  input: Pick<BuildGridInput, "bookings" | "blocks">,
  nowMs: number,
): SlotUnavailableReason | null {
  if (slot.start <= nowMs) return "past"
  for (const booking of input.bookings) {
    if (overlaps(slot, booking)) return "booked"
  }
  for (const block of input.blocks) {
    if (overlaps(slot, block)) return "blocked"
  }
  return null
}

/**
 * Build the bookable grid for one pitch across `dates`.
 *
 * Every day is generated, even a fully-taken one: an empty column tells a customer nothing,
 * while a column of disabled slots with reasons tells them to try Tuesday.
 */
export function buildAvailabilityGrid(input: BuildGridInput): AvailabilityGrid {
  const { pitch, timezone } = input
  const nowMs = (input.now ?? new Date()).getTime()

  // A malformed rate or slot length is a configuration fault, not a customer-facing crash: the
  // grid renders closed rather than throwing out of a page render.
  let perSlot: MinorUnits
  try {
    perSlot = slotPriceMinor(pitch.hourlyRateMinor, pitch.slotMinutes)
  } catch {
    perSlot = asMinor(0)
  }

  // A slot priced below `MINIMUM_CHARGE_MINOR` is not sellable: `quoteBooking()` refuses any
  // total under that floor, so advertising it would send the customer into a checkout that
  // answers 422. The floor is above zero, so this also covers the `perSlot = 0` fallback above.
  const blanketReason: SlotUnavailableReason | null = !pitch.isActive
    ? "closed"
    : !input.venuePayable
      ? "venue_not_payable"
      : perSlot < MINIMUM_CHARGE_MINOR
        ? "closed"
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
        const start = zonedWallClockToUtc(year, month, day, 0, minute, timezone)
        const startMs = start.getTime()
        // A spring-forward gap maps two distinct wall clocks onto the same instant. Emitting both
        // would put two identical rows on the picker, one of which cannot be booked separately.
        if (seen.has(startMs)) continue
        seen.add(startMs)

        const interval: Interval = { start: startMs, end: startMs + pitch.slotMinutes * MINUTE_MS }
        const reason = blanketReason ?? resolveReason(interval, input, nowMs)

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
    currency: pitch.currency,
    hourlyRateMinor: asMinor(pitch.hourlyRateMinor),
    days,
  }
}

/* ========================================================================== */
/*  Reading a grid                                                            */
/* ========================================================================== */

/** How many slots across the whole grid a customer could take right now. */
export function countAvailable(grid: AvailabilityGrid): number {
  let total = 0
  for (const day of grid.days) {
    for (const slot of day.slots) {
      if (slot.available) total += 1
    }
  }
  return total
}

/** The earliest bookable slot in the grid, or null when there is none. */
export function firstAvailable(grid: AvailabilityGrid): TimeSlot | null {
  for (const day of grid.days) {
    for (const slot of day.slots) {
      if (slot.available) return slot
    }
  }
  return null
}

/** `HH:MM` (24h) → minutes past local midnight, or null when it is not a time of day. */
export function parseTimeOfDay(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value)
  if (!match) return null
  const hours = match[1]
  const minutes = match[2]
  if (hours === undefined || minutes === undefined) return null
  return Number(hours) * 60 + Number(minutes)
}

/**
 * Keep only the slots whose START falls inside a local time window, e.g. "evenings, 18:00-22:00".
 *
 * The comparison is made on the venue's wall clock, because that is what the customer typed and
 * what the pitch's own opening hours are expressed in. A window that wraps past midnight
 * (`from > to`, e.g. 22:00 → 02:00) is read as two arcs of the same clock face.
 */
export function withinLocalWindow(
  slot: TimeSlot,
  timezone: string,
  fromMinutes: number,
  toMinutes: number,
): boolean {
  const parts = zonedParts(new Date(slot.startsAt), timezone)
  const local = parts.hour * 60 + parts.minute
  return fromMinutes <= toMinutes
    ? local >= fromMinutes && local < toMinutes
    : local >= fromMinutes || local < toMinutes
}

/** Narrow a grid to the slots that start inside a local window. Days are kept, even if empty. */
export function restrictToWindow(
  grid: AvailabilityGrid,
  fromMinutes: number,
  toMinutes: number,
): AvailabilityGrid {
  return {
    ...grid,
    days: grid.days.map((day) => ({
      date: day.date,
      slots: day.slots.filter((slot) => withinLocalWindow(slot, grid.timezone, fromMinutes, toMinutes)),
    })),
  }
}

/* ========================================================================== */
/*  Reservation lifetime                                                      */
/* ========================================================================== */

/**
 * How long an unpaid reservation holds its slot.
 *
 * Mirrors `resolveTtlMinutes()` in `app/api/internal/bookings/expire-reservations/route.ts`,
 * including its clamp, so the countdown a customer watches and the sweeper that actually
 * releases the slot cannot disagree. Read lazily rather than at module scope: this file is
 * imported by route handlers that Next evaluates during `next build`, where the variable is
 * frequently absent.
 */
export function reservationTtlMinutes(): number {
  const raw = process.env.BOOKING_RESERVATION_TTL_MINUTES
  if (!raw) return 30
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return 30
  return Math.min(Math.max(parsed, 10), 24 * 60)
}

/** When an unpaid reservation created at `createdAt` stops holding its slot. */
export function reservationExpiresAt(createdAt: string): Date | null {
  const created = Date.parse(createdAt)
  if (!Number.isFinite(created)) return null
  return new Date(created + reservationTtlMinutes() * MINUTE_MS)
}
