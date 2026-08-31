/**
 * app/(app)/venues/page.tsx
 *
 * Saha bul. This is the front door of the booking funnel.
 *
 * ---------------------------------------------------------------------------
 * WHY THE QUERY RUNS HERE AND NOT IN THE BROWSER
 * ---------------------------------------------------------------------------
 * The read goes through the cookie-bound client, so `venues_select_active_or_own` and
 * `pitches_select_visible` decide the result set — the same policies that would apply to any
 * other caller, evaluated by Postgres rather than trusted from the client. Filters live in the
 * URL, which makes a search linkable, shareable and back-button-able, and means the form
 * component owns no results at all.
 *
 * The `is_active` / `charges_enabled` predicates below are a product decision (do not show a
 * customer a venue that cannot take their money) layered on top of RLS. They are not the
 * authorisation, and removing them would widen what is asked for, never what is allowed.
 *
 * ---------------------------------------------------------------------------
 * "FREE ON SATURDAY EVENING" COSTS TWO QUERIES, NOT N
 * ---------------------------------------------------------------------------
 * A date filter turns this into an availability search. The shortlist is resolved first, then a
 * single bookings read and a single blocks read cover every pitch on the page, and the grids are
 * folded in memory by `lib/booking/availability.ts`. Those two reads use the service-role client
 * for the reason spelled out at the end of `0002_rls.sql`: a customer cannot see other people's
 * bookings, so free/busy is computed server-side from anonymised intervals instead of by
 * loosening the policy. Nothing but interval boundaries is selected.
 */

import type { ReactNode } from "react"
import type { Metadata } from "next"
import Link from "next/link"
import { z } from "zod"

import { VenueCard, type VenueCardVenue } from "@/components/booking/venue-card"
import { VenueSearch, type VenueSearchValues } from "@/components/booking/venue-search"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  availabilityPitch,
  buildAvailabilityGrid,
  countAvailable,
  coveringWindow,
  isDateKey,
  parseTimeOfDay,
  restrictToWindow,
  SLOT_HOLDING_STATUSES,
} from "@/lib/booking/availability"
import { getSessionUser } from "@/lib/rbac"
import { createAdminClient } from "@/lib/supabase/admin"
import { createClient } from "@/lib/supabase/server"
import { parseRange, toRangeLiteral, type Interval } from "@/lib/venue/metrics"
import { Constants, type Enums } from "@halisaha/shared/database"
import { DEFAULT_CURRENCY, fromMinor } from "@halisaha/shared/domain"

export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "Saha bul",
  description: "İşletmeleri şehre, formata, zemine ve fiyata göre ara, sonra saatini ayır.",
}

const PAGE_SIZE = 12
/** Cap on how many pitches one page will fold availability for. */
const MAX_AVAILABILITY_PITCHES = 60

/* -------------------------------------------------------------------------- */
/*  Filters                                                                    */
/* -------------------------------------------------------------------------- */

const filterSchema = z.object({
  q: z.string().max(80).optional(),
  city: z.string().max(80).optional(),
  format: z.enum(Constants.public.Enums.match_format).optional(),
  surface: z.enum(Constants.public.Enums.pitch_surface).optional(),
  indoor: z.enum(["true", "false"]).optional(),
  maxPriceMinor: z.coerce.number().int().min(0).max(100_000_000).optional(),
  date: z.string().refine(isDateKey).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  page: z.coerce.number().int().min(1).max(500).default(1),
})

type Filters = z.infer<typeof filterSchema>

type SearchParams = Record<string, string | string[] | undefined>

function firstValue(params: SearchParams, key: string): string | undefined {
  const value = params[key]
  if (typeof value === "string") return value.length > 0 ? value : undefined
  if (Array.isArray(value)) {
    const head = value[0]
    return typeof head === "string" && head.length > 0 ? head : undefined
  }
  return undefined
}

/**
 * Parse what is in the URL, and ignore what does not parse.
 *
 * A hand-edited query string is a browsing accident, not an attack; answering it with a 422 page
 * would be hostile. Unrecognised values fall back to "no filter" and the form re-renders with
 * what actually took effect.
 */
function readFilters(params: SearchParams): Filters {
  const parsed = filterSchema.safeParse({
    q: firstValue(params, "q"),
    city: firstValue(params, "city"),
    format: firstValue(params, "format"),
    surface: firstValue(params, "surface"),
    indoor: firstValue(params, "indoor"),
    maxPriceMinor: firstValue(params, "maxPriceMinor"),
    date: firstValue(params, "date"),
    from: firstValue(params, "from"),
    to: firstValue(params, "to"),
    page: firstValue(params, "page"),
  })
  return parsed.success ? parsed.data : { page: 1 }
}

/** The filters, as the client form wants them (major-unit price, `any` sentinels). */
function toFormValues(filters: Filters): VenueSearchValues {
  return {
    q: filters.q ?? "",
    city: filters.city ?? "",
    format: filters.format ?? "any",
    surface: filters.surface ?? "any",
    indoor: filters.indoor === "true" ? "indoor" : filters.indoor === "false" ? "outdoor" : "any",
    maxPrice:
      filters.maxPriceMinor === undefined
        ? ""
        : String(fromMinor(filters.maxPriceMinor, DEFAULT_CURRENCY)),
    date: filters.date ?? "",
    from: filters.from ?? "",
    to: filters.to ?? "",
  }
}

/** Rebuild the query string for a pagination link. */
function pageHref(params: SearchParams, page: number): string {
  const query = new URLSearchParams()
  for (const key of ["q", "city", "format", "surface", "indoor", "maxPriceMinor", "date", "from", "to"]) {
    const value = firstValue(params, key)
    if (value) query.set(key, value)
  }
  if (page > 1) query.set("page", String(page))
  const rendered = query.toString()
  return rendered ? `/venues?${rendered}` : "/venues"
}

/** PostgREST filter syntax lives in the query string; strip it out of free text. */
function sanitisePattern(raw: string): string {
  return raw
    .replace(/[,.()"'\\%*]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60)
}

/* -------------------------------------------------------------------------- */
/*  Rows                                                                       */
/* -------------------------------------------------------------------------- */

interface VenueRow {
  id: string
  name: string
  slug: string
  city: string | null
  district: string | null
  timezone: string
  photos: string[] | null
  amenities: string[] | null
  is_active: boolean
  charges_enabled: boolean
  pitches: Array<{
    id: string
    venue_id: string
    name: string
    format: Enums<"match_format">
    hourly_rate_minor: number
    currency: string
    slot_minutes: number
    opening_time: string
    closing_time: string
    is_active: boolean
  }>
}

const VENUE_SELECT = `
  id, name, slug, city, district, timezone, photos, amenities, is_active, charges_enabled,
  pitches!inner (
    id, venue_id, name, format, hourly_rate_minor, currency,
    slot_minutes, opening_time, closing_time, is_active
  )
`

/* -------------------------------------------------------------------------- */

export default async function VenuesPage({ searchParams }: { searchParams?: SearchParams }) {
  const params = searchParams ?? {}
  const session = await getSessionUser()
  if (!session) return null // the (app) layout has already redirected

  const filters = readFilters(params)
  const offset = (filters.page - 1) * PAGE_SIZE
  const supabase = await createClient()

  let builder = supabase
    .from("venues")
    .select(VENUE_SELECT)
    .eq("is_active", true)
    .eq("charges_enabled", true)
    .eq("pitches.is_active", true)

  if (filters.city) {
    const pattern = sanitisePattern(filters.city)
    if (pattern) builder = builder.ilike("city", `%${pattern}%`)
  }
  if (filters.q) {
    const pattern = sanitisePattern(filters.q)
    if (pattern) {
      builder = builder.or(`name.ilike.%${pattern}%,city.ilike.%${pattern}%,district.ilike.%${pattern}%`)
    }
  }
  if (filters.format) builder = builder.eq("pitches.format", filters.format)
  if (filters.surface) builder = builder.eq("pitches.surface", filters.surface)
  if (filters.indoor) builder = builder.eq("pitches.is_indoor", filters.indoor === "true")
  if (filters.maxPriceMinor !== undefined) {
    // `.lte()` only types plain columns; an embedded path has to go through `.filter()`.
    builder = builder.filter("pitches.hourly_rate_minor", "lte", filters.maxPriceMinor)
  }

  const { data, error } = await builder
    .order("name", { ascending: true })
    .range(offset, offset + PAGE_SIZE)
    .returns<VenueRow[]>()

  if (error) {
    console.error("[venues] search failed", { code: error.code })
    return (
      <PageFrame filters={filters}>
        <Alert variant="destructive">
          <AlertTitle>İşletmeler yüklenemedi</AlertTitle>
          <AlertDescription>
            Arama yapılırken bir şeyler ters gitti. Sayfayı yenile; devam ederse bize haber ver.
          </AlertDescription>
        </Alert>
      </PageFrame>
    )
  }

  const rows = data ?? []
  const hasMore = rows.length > PAGE_SIZE
  const pageRows = hasMore ? rows.slice(0, PAGE_SIZE) : rows

  const { venues, availabilityFailed } = filters.date
    ? await withAvailability(pageRows, filters)
    : { venues: pageRows.map((row) => toCardVenue(row, null)), availabilityFailed: false }

  return (
    <PageFrame filters={filters} resultCount={venues.length}>
      {availabilityFailed && (
        <Alert variant="destructive">
          <AlertTitle>Müsaitlik kontrol edilemedi</AlertTitle>
          <AlertDescription>
            Tarih filtresi uygulanamadı; satılmış olabilecek sonuçları göstermek yerine hiçbir sonuç gösterilmiyor. Tekrar dene ya da tarihsiz ara.
          </AlertDescription>
        </Alert>
      )}

      {venues.length === 0 && !availabilityFailed ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Bu filtrelere uyan bir şey yok</CardTitle>
            <CardDescription>
              {filters.date
                ? "No pitch on this page is free in that window. Try another date, a wider time range, or drop a filter."
                : "Try a different city, another format, or a higher price ceiling."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline">
              <Link href="/venues">Filtreleri temizle</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {venues.map((venue) => (
            <li key={venue.id} className="h-full">
              <VenueCard venue={venue} />
            </li>
          ))}
        </ul>
      )}

      {(filters.page > 1 || hasMore) && (
        <nav aria-label="Sayfalama" className="flex items-center justify-between gap-3 pt-2">
          {filters.page > 1 ? (
            <Button asChild variant="outline">
              <Link href={pageHref(params, filters.page - 1)} rel="prev">
                Önceki
              </Link>
            </Button>
          ) : (
            <span />
          )}
          <p className="text-sm text-muted-foreground">Page {filters.page}</p>
          {hasMore ? (
            <Button asChild variant="outline">
              <Link href={pageHref(params, filters.page + 1)} rel="next">
                Sonraki
              </Link>
            </Button>
          ) : (
            <span />
          )}
        </nav>
      )}
    </PageFrame>
  )
}

/* -------------------------------------------------------------------------- */
/*  Frame                                                                      */
/* -------------------------------------------------------------------------- */

function PageFrame({
  filters,
  resultCount,
  children,
}: {
  filters: Filters
  resultCount?: number
  children: ReactNode
}) {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Saha bul</h1>
          <p className="text-sm text-muted-foreground">
            Şehre, formata ve fiyata göre ara. Saatler ve fiyatlar işletmenin kendi bilgileridir.
          </p>
        </div>
        <Button asChild variant="outline">
          <Link href="/bookings">Rezervasyonlarım</Link>
        </Button>
      </div>

      <VenueSearch initial={toFormValues(filters)} resultCount={resultCount} />

      {children}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Availability fold                                                          */
/* -------------------------------------------------------------------------- */

async function withAvailability(
  rows: readonly VenueRow[],
  filters: Filters,
): Promise<{ venues: VenueCardVenue[]; availabilityFailed: boolean }> {
  const date = filters.date
  if (!date) return { venues: rows.map((row) => toCardVenue(row, null)), availabilityFailed: false }

  const fromMinutes = filters.from ? parseTimeOfDay(filters.from) : null
  const toMinutes = filters.to ? parseTimeOfDay(filters.to) : null

  const pitchIds: string[] = []
  let windowStart = Number.POSITIVE_INFINITY
  let windowEnd = Number.NEGATIVE_INFINITY

  for (const row of rows) {
    for (const pitchRow of row.pitches) {
      if (pitchIds.length >= MAX_AVAILABILITY_PITCHES) break
      const window = coveringWindow(availabilityPitch(pitchRow), [date], row.timezone)
      if (!window) continue
      pitchIds.push(pitchRow.id)
      if (window.start < windowStart) windowStart = window.start
      if (window.end > windowEnd) windowEnd = window.end
    }
  }

  if (pitchIds.length === 0) return { venues: [], availabilityFailed: false }

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
    console.error("[venues] availability read failed", {
      bookings: bookingResult.error?.code,
      blocks: blockResult.error?.code,
    })
    return { venues: [], availabilityFailed: true }
  }

  const busy = groupIntervals(bookingResult.data ?? [], (row) => row.time_range)
  const blocked = groupIntervals(blockResult.data ?? [], (row) => row.block_range)

  const venues: VenueCardVenue[] = []
  for (const row of rows) {
    let free = 0
    for (const pitchRow of row.pitches) {
      if (!pitchIds.includes(pitchRow.id)) continue
      const grid = buildAvailabilityGrid({
        pitch: availabilityPitch(pitchRow),
        timezone: row.timezone,
        dates: [date],
        bookings: busy.get(pitchRow.id) ?? [],
        blocks: blocked.get(pitchRow.id) ?? [],
        venuePayable: row.is_active && row.charges_enabled,
      })
      const narrowed =
        fromMinutes !== null || toMinutes !== null
          ? restrictToWindow(grid, fromMinutes ?? 0, toMinutes ?? 24 * 60)
          : grid
      free += countAvailable(narrowed)
    }
    if (free === 0) continue
    venues.push(toCardVenue(row, free))
  }

  return { venues, availabilityFailed: false }
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

function toCardVenue(row: VenueRow, availableSlots: number | null): VenueCardVenue {
  const formats: Enums<"match_format">[] = []
  let fromPriceMinor: number | null = null
  let currency = DEFAULT_CURRENCY

  for (const pitch of row.pitches) {
    if (!formats.includes(pitch.format)) formats.push(pitch.format)
    if (fromPriceMinor === null || pitch.hourly_rate_minor < fromPriceMinor) {
      fromPriceMinor = pitch.hourly_rate_minor
      currency = (pitch.currency || DEFAULT_CURRENCY).toLowerCase()
    }
  }

  const photos = row.photos ?? []

  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    city: row.city,
    district: row.district,
    amenities: row.amenities ?? [],
    photoUrl: photos.length > 0 ? (photos[0] ?? null) : null,
    fromPriceMinor,
    currency,
    pitchCount: row.pitches.length,
    formats,
    availableSlots,
  }
}
