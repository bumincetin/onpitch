/**
 * lib/format.ts
 *
 * Display formatting. Money comes straight from @onpitch/shared so web and mobile round the same
 * way; dates are added here because the shared package stays platform-neutral and this is where
 * the app's own conventions live.
 *
 * Every date helper takes an ISO-8601 instant (what every timestamptz column serialises to) and
 * renders it in the device's locale and time zone unless a zone is passed. Venue-local rendering
 * matters for a booking grid — pass `AvailabilityGrid.timezone` there — but for "when is my
 * match", the phone's own clock is the right frame.
 *
 * Intl is available in Hermes, but every call is still wrapped: a build with a trimmed ICU set
 * throws on an unsupported option rather than degrading, so each helper falls back to a slice of
 * the ISO string instead of taking the screen down with it.
 */

export {
  asMinor,
  DEFAULT_CURRENCY,
  formatMinor,
  fromMinor,
  minorUnitExponent,
  toMinor,
} from '@onpitch/shared/domain'
export type { MinorUnits } from '@onpitch/shared/domain'

/** An ISO instant, a millisecond epoch, or a Date. Anything unparseable formats as a dash. */
export type DateLike = string | number | Date | null | undefined

/** What every helper renders when the input is absent or unparseable. */
export const EMPTY_DATE_LABEL = '—'

function toDate(value: DateLike): Date | null {
  if (value === null || value === undefined) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

/**
 * Kickoff, the way it reads on a fixture card: `Sat 6 Sep, 20:00`.
 *
 * The year is appended only when the date falls outside the next eleven months, so the common
 * case stays short and a fixture in January 2027 is never mistaken for one next week.
 *
 * @param timeZone IANA zone. Omit for the device zone; pass `venues.timezone` for a booking grid.
 */
export function formatKickoff(value: DateLike, timeZone?: string): string {
  const date = toDate(value)
  if (!date) return EMPTY_DATE_LABEL

  const now = new Date()
  const monthsAway = (date.getTime() - now.getTime()) / (30 * 24 * 60 * 60 * 1000)
  const includeYear = monthsAway > 11 || monthsAway < -1

  try {
    return new Intl.DateTimeFormat(undefined, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: includeYear ? 'numeric' : undefined,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone,
    }).format(date)
  } catch {
    return `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)}`
  }
}

/**
 * Time only: `20:00`. For a slot grid, where the day is already the column header.
 */
export function formatTime(value: DateLike, timeZone?: string): string {
  const date = toDate(value)
  if (!date) return EMPTY_DATE_LABEL

  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone,
    }).format(date)
  } catch {
    return date.toISOString().slice(11, 16)
  }
}

/** A booking window: `20:00 – 21:30`. Both ends in the same zone. */
export function formatTimeRange(start: DateLike, end: DateLike, timeZone?: string): string {
  const from = formatTime(start, timeZone)
  const to = formatTime(end, timeZone)
  if (from === EMPTY_DATE_LABEL || to === EMPTY_DATE_LABEL) return EMPTY_DATE_LABEL
  return `${from} – ${to}`
}

/** A day header: `Today`, `Tomorrow`, or `Sat 6 Sep`. */
export function formatDayLabel(value: DateLike, timeZone?: string, now: Date = new Date()): string {
  const date = toDate(value)
  if (!date) return EMPTY_DATE_LABEL

  const days = calendarDaysBetween(now, date, timeZone)
  if (days === 0) return 'Today'
  if (days === 1) return 'Tomorrow'
  if (days === -1) return 'Yesterday'

  try {
    return new Intl.DateTimeFormat(undefined, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      timeZone,
    }).format(date)
  } catch {
    return date.toISOString().slice(0, 10)
  }
}

/**
 * Distance from now, in words: `in 3 hours`, `2 days ago`, `just now`.
 *
 * Used on notification rows and "reported 12 minutes ago" lines, where the exact instant matters
 * less than the freshness. Pair it with `formatKickoff` when the reader needs both.
 */
export function formatRelative(value: DateLike, now: Date = new Date()): string {
  const date = toDate(value)
  if (!date) return EMPTY_DATE_LABEL

  const deltaSeconds = Math.round((date.getTime() - now.getTime()) / 1000)
  const absolute = Math.abs(deltaSeconds)

  if (absolute < 45) return 'just now'

  const units: ReadonlyArray<{ unit: Intl.RelativeTimeFormatUnit; seconds: number }> = [
    { unit: 'year', seconds: 31_536_000 },
    { unit: 'month', seconds: 2_592_000 },
    { unit: 'week', seconds: 604_800 },
    { unit: 'day', seconds: 86_400 },
    { unit: 'hour', seconds: 3_600 },
    { unit: 'minute', seconds: 60 },
    // Without this row a gap of 45 to 59 seconds matches nothing and drops through to the tail
    // below. The minute row still wins for anything from 60 seconds up.
    { unit: 'second', seconds: 1 },
  ]

  // `noUncheckedIndexedAccess` is on, so this iterates rather than indexing, and the fallback
  // below covers the case where nothing matched instead of asserting on `units[units.length - 1]`.
  for (const step of units) {
    if (absolute < step.seconds) continue
    const amount = Math.round(deltaSeconds / step.seconds)
    try {
      return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(amount, step.unit)
    } catch {
      const plural = Math.abs(amount) === 1 ? step.unit : `${step.unit}s`
      return amount < 0 ? `${Math.abs(amount)} ${plural} ago` : `in ${amount} ${plural}`
    }
  }

  // Unreachable now that the table bottoms out at one second, and kept only so the loop has
  // somewhere to fall out to. Pluralised all the same, so raising the smallest unit again cannot
  // quietly reintroduce "1 minutes ago".
  const minutes = Math.round(deltaSeconds / 60)
  const plural = Math.abs(minutes) === 1 ? 'minute' : 'minutes'
  return minutes < 0 ? `${Math.abs(minutes)} ${plural} ago` : `in ${minutes} ${plural}`
}

/** A match length: `90 min`, `1h 30m`, `2h`. */
export function formatDuration(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) {
    return EMPTY_DATE_LABEL
  }
  const total = Math.max(0, Math.round(minutes))
  if (total < 60) return `${total} min`

  const hours = Math.floor(total / 60)
  const rest = total % 60
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`
}

/**
 * Whole calendar days from `from` to `to`, counted in `timeZone`.
 *
 * Subtracting timestamps and dividing by 86 400 000 is wrong across a DST boundary and wrong for
 * "tomorrow at 00:30" — both give a fractional day that rounds to today. Comparing the rendered
 * calendar dates is what "is this tomorrow" actually means.
 */
function calendarDaysBetween(from: Date, to: Date, timeZone?: string): number {
  const fromDay = calendarDayNumber(from, timeZone)
  const toDay = calendarDayNumber(to, timeZone)
  if (fromDay === null || toDay === null) return Number.NaN
  return toDay - fromDay
}

/** Days since the epoch for the calendar date `date` falls on in `timeZone`. */
function calendarDayNumber(date: Date, timeZone?: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      timeZone,
    }).format(date)
    // `en-CA` renders as YYYY-MM-DD, so Date.parse reads it as a UTC midnight.
    const parsed = Date.parse(`${parts}T00:00:00Z`)
    return Number.isNaN(parsed) ? null : Math.round(parsed / 86_400_000)
  } catch {
    return Math.floor(date.getTime() / 86_400_000)
  }
}
