/**
 * GET /api/venues/search
 *
 * Pitch discovery: the query behind the browse page, and the endpoint the mobile app calls for
 * the same thing.
 *
 * ---------------------------------------------------------------------------
 * WHAT DECIDES THE RESULT SET
 * ---------------------------------------------------------------------------
 * The venue and pitch reads go through the caller's own client, so `venues_select_active_or_own`
 * and `pitches_select_visible` decide what exists as far as this request is concerned. The
 * explicit `is_active` filters below are a query optimisation and a UX decision (an owner should
 * not find their own unpublished venue in a customer's search results) — they are not the
 * authorisation. Deleting them would change what is ASKED FOR, never what is ALLOWED.
 *
 * ---------------------------------------------------------------------------
 * THE DATE FILTER COSTS TWO EXTRA QUERIES, NOT N
 * ---------------------------------------------------------------------------
 * "Free on Saturday evening" cannot be answered in SQL against a `tstzrange` column without
 * either a stored procedure or a per-pitch round trip. So the shortlist is resolved first, then
 * ONE bookings read and ONE blocks read cover every pitch on it, and the grid is folded in
 * memory by `lib/booking/availability.ts`. Those two reads run on the service-role client for
 * the reason set out in `app/api/pitches/[id]/slots/route.ts`: a customer cannot see other
 * people's bookings, and the correct fix is an anonymised free/busy computation on the server,
 * not a relaxed RLS policy. Only interval boundaries are read; no `booked_by`, no blackout
 * reason, nothing that names anyone.
 */

import { z } from "zod"

import { fail, handleRoute, ok } from "@/lib/api-response"
import {
  availabilityPitch,
  buildAvailabilityGrid,
  coveringWindow,
  countAvailable,
  firstAvailable,
  isDateKey,
  parseTimeOfDay,
  restrictToWindow,
  SLOT_HOLDING_STATUSES,
} from "@/lib/booking/availability"
import { getSessionUser } from "@/lib/rbac"
import { createAdminClient } from "@/lib/supabase/admin"
import { createRouteClient } from "@/lib/supabase/server"
import { parseRange, toRangeLiteral, type Interval } from "@/lib/venue/metrics"
import { Constants, type Enums } from "@halisaha/shared/database"
import { API_ERROR_CODES } from "@halisaha/shared/domain"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/* ========================================================================== */
/*  Query                                                                     */
/* ========================================================================== */

/** Upper bound on venues per page. */
const MAX_LIMIT = 30
/** Upper bound on pitches the availability pass will fold, across the whole page. */
const MAX_AVAILABILITY_PITCHES = 60

/**
 * PostgREST reads its filters out of the query string, where `,` separates arguments, `.`
 * separates operator from value, and `()` group them. A raw search term containing those would
 * not be a security hole — supabase-js sends the value in the URL and Postgres still parameterises
 * it — but it does produce a 400 from the API instead of an empty result, which reads as a broken
 * search box. Strip the syntax, keep the letters.
 */
function sanitisePattern(raw: string): string {
  return raw
    .replace(/[,.()"'\\%*]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60)
}

const queryBoolean = z
  .enum(["true", "false", "1", "0"])
  .optional()
  .transform((value) => (value === undefined ? undefined : value === "true" || value === "1"))

const searchQuerySchema = z.object({
  /** Free text over venue name, city and district. */
  q: z.string().max(80).optional(),
  city: z.string().max(80).optional(),
  format: z.enum(Constants.public.Enums.match_format).optional(),
  surface: z.enum(Constants.public.Enums.pitch_surface).optional(),
  /** `true` = indoor only, `false` = outdoor only, absent = either. */
  indoor: queryBoolean,
  /** Price ceiling per hour, in minor units — the same unit `pitches.hourly_rate_minor` uses. */
  maxPriceMinor: z.coerce.number().int().min(0).max(100_000_000).optional(),
  /** Local calendar day at the venue. Turns the search into an availability search. */
  date: z.string().refine(isDateKey, "expected a real calendar date as YYYY-MM-DD").optional(),
  /** Earliest acceptable kickoff, venue wall clock, `HH:MM`. */
  from: z.string().optional(),
  /** Exclusive latest kickoff, venue wall clock, `HH:MM`. */
  to: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(12),
  offset: z.coerce.number().int().min(0).max(5_000).default(0),
})

export type VenueSearchQuery = z.infer<typeof searchQuerySchema>

/* ========================================================================== */
/*  Wire shapes                                                               */
/* ========================================================================== */

export interface VenueSearchPitch {
  id: string
  name: string
  format: Enums<"match_format">
  surface: Enums<"pitch_surface">
  isIndoor: boolean
  capacity: number | null
  hourlyRateMinor: number
  currency: string
  slotMinutes: number
  openingTime: string
  closingTime: string
  /** Free slots on the requested day, or null when the search carried no date. */
  availableSlots: number | null
  /** ISO instant of the earliest free slot on that day, when there is one. */
  nextAvailableAt: string | null
}

export interface VenueSearchItem {
  id: string
  name: string
  slug: string
  city: string | null
  district: string | null
  timezone: string
  amenities: string[]
  /** First photo, or null. Rendering decides whether it trusts the origin. */
  photoUrl: string | null
  /** Published and able to take a charge. False venues are filtered out of search entirely. */
  isPayable: boolean
  /** Cheapest hourly rate among the matching pitches. */
  fromPriceMinor: number | null
  currency: string
  pitches: VenueSearchPitch[]
}

export interface VenueSearchResponse {
  results: VenueSearchItem[]
  /** Venues on this page. There is no global count — an exact one costs a second scan. */
  count: number
  limit: number
  offset: number
  /** True when another page is likely to exist. */
  hasMore: boolean
  /** Echo of the filters actually applied, after parsing and clamping. */
  filters: {
    q: string | null
    city: string | null
    format: Enums<"match_format"> | null
    surface: Enums<"pitch_surface"> | null
    indoor: boolean | null
    maxPriceMinor: number | null
    date: string | null
    from: string | null
    to: string | null
  }
}

/** The venue + embedded pitch shape this route selects. */
interface SearchVenueRow {
  id: string
  name: string
  slug: string
  city: string | null
  district: string | null
  timezone: string
  photos: string[] | null
  amenities: string[] | null
  charges_enabled: boolean
  is_active: boolean
  pitches: Array<{
    id: string
    venue_id: string
    name: string
    format: Enums<"match_format">
    surface: Enums<"pitch_surface">
    is_indoor: boolean
    capacity: number | null
    hourly_rate_minor: number
    currency: string
    slot_minutes: number
    opening_time: string
    closing_time: string
    is_active: boolean
  }>
}

const VENUE_SELECT = `
  id, name, slug, city, district, timezone, photos, amenities, charges_enabled, is_active,
  pitches!inner (
    id, venue_id, name, format, surface, is_indoor, capacity,
    hourly_rate_minor, currency, slot_minutes, opening_time, closing_time, is_active
  )
`

/* ========================================================================== */
/*  Handler                                                                   */
/* ========================================================================== */

export async function GET(request: Request): Promise<Response> {
  return handleRoute<VenueSearchResponse>(async () => {
    const session = await getSessionUser()
    if (!session) {
      return fail(API_ERROR_CODES.UNAUTHENTICATED, "Saha aramak için giriş yap.", 401)
    }

    const url = new URL(request.url)
    const parsed = searchQuerySchema.safeParse(Object.fromEntries(url.searchParams.entries()))
    if (!parsed.success) {
      return fail(API_ERROR_CODES.VALIDATION_FAILED, "Bu arama filtreleri geçersiz.", 422, {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      })
    }
    const query = parsed.data

    const fromMinutes = query.from ? parseTimeOfDay(query.from) : null
    const toMinutes = query.to ? parseTimeOfDay(query.to) : null
    if ((query.from && fromMinutes === null) || (query.to && toMinutes === null)) {
      return fail(API_ERROR_CODES.VALIDATION_FAILED, "Saat aralığı 18:00 biçiminde olmalı.", 422)
    }

    const supabase = await createRouteClient(request)

    let builder = supabase
      .from("venues")
      .select(VENUE_SELECT)
      .eq("is_active", true)
      .eq("charges_enabled", true)
      .eq("pitches.is_active", true)

    if (query.city) {
      const pattern = sanitisePattern(query.city)
      if (pattern) builder = builder.ilike("city", `%${pattern}%`)
    }
    if (query.q) {
      const pattern = sanitisePattern(query.q)
      if (pattern) {
        builder = builder.or(
          `name.ilike.%${pattern}%,city.ilike.%${pattern}%,district.ilike.%${pattern}%`,
        )
      }
    }
    if (query.format) builder = builder.eq("pitches.format", query.format)
    if (query.surface) builder = builder.eq("pitches.surface", query.surface)
    if (query.indoor !== undefined) builder = builder.eq("pitches.is_indoor", query.indoor)
    if (query.maxPriceMinor !== undefined) {
      // `.lte()` only types plain columns; an embedded path has to go through `.filter()`.
      builder = builder.filter("pitches.hourly_rate_minor", "lte", query.maxPriceMinor)
    }

    // One row past the page, so "is there more" costs nothing extra.
    const { data, error } = await builder
      .order("name", { ascending: true })
      .range(query.offset, query.offset + query.limit)
      .returns<SearchVenueRow[]>()

    if (error) {
      console.error("[venues/search] query failed", { code: error.code })
      return fail(API_ERROR_CODES.INTERNAL, "Bu arama çalıştırılamadı.", 500)
    }

    const rows = data ?? []
    const hasMore = rows.length > query.limit
    const page = hasMore ? rows.slice(0, query.limit) : rows

    const results = query.date
      ? await withAvailability(page, {
          date: query.date,
          fromMinutes,
          toMinutes,
        })
      : page.map((row) => toItem(row, new Map()))

    return ok<VenueSearchResponse>({
      results,
      count: results.length,
      limit: query.limit,
      offset: query.offset,
      hasMore,
      filters: {
        q: query.q ?? null,
        city: query.city ?? null,
        format: query.format ?? null,
        surface: query.surface ?? null,
        indoor: query.indoor ?? null,
        maxPriceMinor: query.maxPriceMinor ?? null,
        date: query.date ?? null,
        from: query.from ?? null,
        to: query.to ?? null,
      },
    })
  })
}

/* ========================================================================== */
/*  Availability fold                                                         */
/* ========================================================================== */

interface AvailabilitySummary {
  availableSlots: number
  nextAvailableAt: string | null
}

interface AvailabilityPassInput {
  date: string
  fromMinutes: number | null
  toMinutes: number | null
}

/**
 * Annotate the shortlist with free-slot counts for one day, then drop what is fully booked.
 *
 * A venue with no free pitch on the requested day is removed entirely: the customer asked "who
 * can host me on Saturday", and answering with a venue that cannot is worse than a shorter list.
 */
async function withAvailability(
  rows: readonly SearchVenueRow[],
  input: AvailabilityPassInput,
): Promise<VenueSearchItem[]> {
  const pitchIds: string[] = []
  let windowStart = Number.POSITIVE_INFINITY
  let windowEnd = Number.NEGATIVE_INFINITY

  for (const row of rows) {
    for (const pitchRow of row.pitches) {
      if (pitchIds.length >= MAX_AVAILABILITY_PITCHES) break
      const window = coveringWindow(availabilityPitch(pitchRow), [input.date], row.timezone)
      if (!window) continue
      pitchIds.push(pitchRow.id)
      if (window.start < windowStart) windowStart = window.start
      if (window.end > windowEnd) windowEnd = window.end
    }
  }

  if (pitchIds.length === 0 || !Number.isFinite(windowStart) || !Number.isFinite(windowEnd)) {
    return []
  }

  const admin = createAdminClient()
  const literal = toRangeLiteral(new Date(windowStart), new Date(windowEnd))

  const [bookingResult, blockResult] = await Promise.all([
    admin
      .from("bookings")
      .select("pitch_id, time_range")
      .in("pitch_id", pitchIds)
      .in("status", [...SLOT_HOLDING_STATUSES])
      .filter("time_range", "ov", literal),
    admin
      .from("pitch_availability_blocks")
      .select("pitch_id, block_range")
      .in("pitch_id", pitchIds)
      .filter("block_range", "ov", literal),
  ])

  if (bookingResult.error || blockResult.error) {
    console.error("[venues/search] availability read failed", {
      bookings: bookingResult.error?.code,
      blocks: blockResult.error?.code,
    })
    // Availability is unknown, so the date filter cannot be honoured. Answering with an
    // unfiltered list would show pitches that are already sold; an empty list is the honest one.
    return []
  }

  const busyByPitch = groupIntervals(bookingResult.data ?? [], (row) => row.time_range)
  const blocksByPitch = groupIntervals(blockResult.data ?? [], (row) => row.block_range)

  const items: VenueSearchItem[] = []
  for (const row of rows) {
    const summaries = new Map<string, AvailabilitySummary>()

    for (const pitchRow of row.pitches) {
      if (!pitchIds.includes(pitchRow.id)) continue
      const pitch = availabilityPitch(pitchRow)
      const full = buildAvailabilityGrid({
        pitch,
        timezone: row.timezone,
        dates: [input.date],
        bookings: busyByPitch.get(pitchRow.id) ?? [],
        blocks: blocksByPitch.get(pitchRow.id) ?? [],
        venuePayable: row.is_active && row.charges_enabled,
      })
      const grid =
        input.fromMinutes !== null || input.toMinutes !== null
          ? restrictToWindow(full, input.fromMinutes ?? 0, input.toMinutes ?? 24 * 60)
          : full

      const available = countAvailable(grid)
      if (available === 0) continue
      summaries.set(pitchRow.id, {
        availableSlots: available,
        nextAvailableAt: firstAvailable(grid)?.startsAt ?? null,
      })
    }

    if (summaries.size === 0) continue
    items.push(toItem(row, summaries))
  }

  return items
}

function groupIntervals<T extends { pitch_id: string }>(
  rows: readonly T[],
  pick: (row: T) => string | null,
): Map<string, Interval[]> {
  const grouped = new Map<string, Interval[]>()
  for (const row of rows) {
    const parsed = parseRange(pick(row))
    if (!parsed) continue
    const bucket = grouped.get(row.pitch_id)
    if (bucket) bucket.push(parsed)
    else grouped.set(row.pitch_id, [parsed])
  }
  return grouped
}

/**
 * Project a row onto the wire shape.
 *
 * When `summaries` is non-empty the search carried a date, and only the pitches it names survive
 * — the others were fully booked in the requested window.
 */
function toItem(row: SearchVenueRow, summaries: Map<string, AvailabilitySummary>): VenueSearchItem {
  const filtered = summaries.size > 0 ? row.pitches.filter((p) => summaries.has(p.id)) : row.pitches

  const pitches: VenueSearchPitch[] = filtered.map((pitchRow) => {
    const summary = summaries.get(pitchRow.id)
    return {
      id: pitchRow.id,
      name: pitchRow.name,
      format: pitchRow.format,
      surface: pitchRow.surface,
      isIndoor: pitchRow.is_indoor,
      capacity: pitchRow.capacity,
      hourlyRateMinor: pitchRow.hourly_rate_minor,
      currency: (pitchRow.currency || "try").toLowerCase(),
      slotMinutes: pitchRow.slot_minutes,
      openingTime: pitchRow.opening_time,
      closingTime: pitchRow.closing_time,
      availableSlots: summary?.availableSlots ?? null,
      nextAvailableAt: summary?.nextAvailableAt ?? null,
    }
  })

  let fromPriceMinor: number | null = null
  for (const pitch of pitches) {
    if (fromPriceMinor === null || pitch.hourlyRateMinor < fromPriceMinor) {
      fromPriceMinor = pitch.hourlyRateMinor
    }
  }

  const firstPitch = pitches[0]
  const photos = row.photos ?? []
  const firstPhoto = photos.length > 0 ? photos[0] : undefined

  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    city: row.city,
    district: row.district,
    timezone: row.timezone,
    amenities: row.amenities ?? [],
    photoUrl: firstPhoto ?? null,
    isPayable: row.is_active && row.charges_enabled,
    fromPriceMinor,
    currency: firstPitch?.currency ?? "try",
    pitches,
  }
}
