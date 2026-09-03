/**
 * GET /api/pitches/[id]/slots?date=YYYY-MM-DD&days=1
 *
 * The bookable grid for one pitch, in the VENUE's timezone. This is what the slot picker reads,
 * and the numbers on it are the numbers `POST /api/bookings/checkout` will charge — both sides
 * price through `slotPriceMinor()`, so the grid cannot quote one figure and the card be charged
 * another.
 *
 * ---------------------------------------------------------------------------
 * WHY THE FREE/BUSY READ RUNS AS service_role
 * ---------------------------------------------------------------------------
 * `bookings_select_stakeholders` (0002_rls.sql) shows a user their own bookings, their team's,
 * and — if they own the pitch — everyone's. A stranger browsing a venue sees NONE, which is the
 * correct privacy posture: a booking row names the person who made it. It also means a customer
 * cannot build an availability grid out of `select time_range from bookings`, and the migration
 * says so explicitly: expose free/busy through a SECURITY DEFINER RPC returning anonymised
 * ranges, or compute it in a route handler on `createAdminClient()`. This is that route handler.
 *
 * The privilege is contained by three things:
 *
 *   1. The user's OWN cookie/bearer-bound client resolves the pitch and the venue first. If RLS
 *      says the pitch is not visible to this caller, the request 404s before the admin client is
 *      constructed. The elevated read is only ever reached for a pitch the caller may already see.
 *   2. The elevated queries project `time_range` and `block_range` and nothing else — no
 *      `booked_by`, no `team_id`, no blackout `reason`. What leaves the server is a set of
 *      anonymous intervals.
 *   3. They are pinned to this one pitch and to the window the grid covers.
 *
 * A grid is a forecast. The slot is reserved by the exclusion constraint at checkout, never here,
 * so a slot shown free can still be lost in the seconds it takes to click it — the picker handles
 * `SLOT_TAKEN` by refetching rather than by pretending this read was authoritative.
 */

import { z } from "zod"

import { fail, handleRoute, ok } from "@/lib/api-response"
import {
  availabilityPitch,
  buildAvailabilityGrid,
  coveringWindow,
  dateKeysFrom,
  isDateKey,
  SLOT_HOLDING_STATUSES,
  todayKey,
} from "@/lib/booking/availability"
import { getSessionUser } from "@/lib/rbac"
import { createAdminClient } from "@/lib/supabase/admin"
import { createRouteClient } from "@/lib/supabase/server"
import { parseRange, toRangeLiteral, type Interval } from "@/lib/venue/metrics"
import type { Enums } from "@onpitch/shared/database"
import { API_ERROR_CODES, type AvailabilityGrid } from "@onpitch/shared/domain"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** A week is as far ahead as the picker ever asks for in one request. */
const MAX_DAYS = 7

const slotsQuerySchema = z.object({
  /** Local calendar day at the venue. Defaults to today, there. */
  date: z
    .string()
    .refine(isDateKey, "expected a real calendar date as YYYY-MM-DD")
    .optional(),
  days: z.coerce.number().int().min(1).max(MAX_DAYS).default(1),
})

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface SlotsPitchSummary {
  id: string
  name: string
  format: Enums<"match_format">
  surface: Enums<"pitch_surface">
  isIndoor: boolean
  capacity: number | null
  openingTime: string
  closingTime: string
}

export interface SlotsVenueSummary {
  id: string
  name: string
  slug: string
  city: string | null
  timezone: string
  /** Published AND able to accept a charge. False means nothing on this grid is bookable. */
  isPayable: boolean
}

export interface PitchSlotsResponse {
  pitch: SlotsPitchSummary
  venue: SlotsVenueSummary
  grid: AvailabilityGrid
  /** When the free/busy snapshot was taken. Slots go stale in seconds, so say when. */
  generatedAt: string
}

export async function GET(
  request: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  return handleRoute<PitchSlotsResponse>(async () => {
    const session = await getSessionUser()
    if (!session) {
      return fail(API_ERROR_CODES.UNAUTHENTICATED, "Bu sahanın boş saatlerini görmek için giriş yap.", 401)
    }

    const pitchId = params.id
    if (!UUID_PATTERN.test(pitchId)) {
      return fail(API_ERROR_CODES.VALIDATION_FAILED, "Geçersiz saha referansı.", 422)
    }

    const url = new URL(request.url)
    const parsedQuery = slotsQuerySchema.safeParse({
      date: url.searchParams.get("date") ?? undefined,
      days: url.searchParams.get("days") ?? undefined,
    })
    if (!parsedQuery.success) {
      return fail(API_ERROR_CODES.VALIDATION_FAILED, "Bu tarih aralığı geçersiz.", 422, {
        issues: parsedQuery.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      })
    }

    /* ------------------------------------------------- 1. RLS-scoped lookup */
    const supabase = await createRouteClient(request)

    const { data: pitchRow, error: pitchError } = await supabase
      .from("pitches")
      .select(
        "id, venue_id, name, format, surface, is_indoor, capacity, hourly_rate_minor, currency, slot_minutes, opening_time, closing_time, is_active",
      )
      .eq("id", pitchId)
      .maybeSingle()

    if (pitchError) {
      console.error("[pitches/slots] pitch lookup failed", { code: pitchError.code })
      return fail(API_ERROR_CODES.INTERNAL, "Bu saha yüklenemedi.", 500)
    }
    if (!pitchRow) {
      // Either it does not exist or `pitches_select_visible` hides it. One answer for both: a
      // 403 here would confirm the id belongs to something real.
      return fail(API_ERROR_CODES.NOT_FOUND, "Bu saha müsait değil.", 404)
    }

    const { data: venueRow, error: venueError } = await supabase
      .from("venues")
      .select("id, name, slug, city, timezone, is_active, charges_enabled")
      .eq("id", pitchRow.venue_id)
      .maybeSingle()

    if (venueError) {
      console.error("[pitches/slots] venue lookup failed", { code: venueError.code })
      return fail(API_ERROR_CODES.INTERNAL, "Tesis yüklenemedi.", 500)
    }
    if (!venueRow) {
      return fail(API_ERROR_CODES.NOT_FOUND, "Bu saha müsait değil.", 404)
    }

    /* ------------------------------------------------------- 2. the window */
    const timezone = venueRow.timezone
    const pitch = availabilityPitch(pitchRow)
    const startKey = parsedQuery.data.date ?? todayKey(timezone)
    const dates = dateKeysFrom(startKey, parsedQuery.data.days)
    const window = coveringWindow(pitch, dates, timezone)

    /* ------------------------------------------- 3. anonymised free/busy */
    let bookings: Interval[] = []
    let blocks: Interval[] = []

    if (window) {
      const admin = createAdminClient()
      const literal = toRangeLiteral(new Date(window.start), new Date(window.end))

      const [bookingResult, blockResult] = await Promise.all([
        admin
          .from("bookings")
          .select("time_range")
          .eq("pitch_id", pitch.id)
          .in("status", [...SLOT_HOLDING_STATUSES])
          .filter("time_range", "ov", literal),
        admin
          .from("pitch_availability_blocks")
          .select("block_range")
          .eq("pitch_id", pitch.id)
          .filter("block_range", "ov", literal),
      ])

      if (bookingResult.error || blockResult.error) {
        console.error("[pitches/slots] free/busy read failed", {
          bookings: bookingResult.error?.code,
          blocks: blockResult.error?.code,
        })
        // Refusing is the only safe answer: a grid drawn without the busy set would advertise
        // slots that are already sold.
        return fail(API_ERROR_CODES.INTERNAL, "Müsaitlik kontrol edilemedi. Try again.", 500)
      }

      bookings = collectIntervals(bookingResult.data ?? [], (row) => row.time_range)
      blocks = collectIntervals(blockResult.data ?? [], (row) => row.block_range)
    }

    /* --------------------------------------------------------- 4. the grid */
    const grid = buildAvailabilityGrid({
      pitch,
      timezone,
      dates,
      bookings,
      blocks,
      venuePayable: venueRow.is_active && venueRow.charges_enabled,
    })

    return ok<PitchSlotsResponse>(
      {
        pitch: {
          id: pitchRow.id,
          name: pitchRow.name,
          format: pitchRow.format,
          surface: pitchRow.surface,
          isIndoor: pitchRow.is_indoor,
          capacity: pitchRow.capacity,
          openingTime: pitchRow.opening_time,
          closingTime: pitchRow.closing_time,
        },
        venue: {
          id: venueRow.id,
          name: venueRow.name,
          slug: venueRow.slug,
          city: venueRow.city,
          timezone,
          isPayable: venueRow.is_active && venueRow.charges_enabled,
        },
        grid,
        generatedAt: new Date().toISOString(),
      },
      // Availability is per-user only in the sense that it is behind auth; it is still volatile
      // enough that no cache should hold it. `ok()` already sends `no-store`.
    )
  })
}

/** Parse `tstzrange` literals, dropping any row Postgres rendered in a shape we cannot read. */
function collectIntervals<T>(rows: readonly T[], pick: (row: T) => string | null): Interval[] {
  const intervals: Interval[] = []
  for (const row of rows) {
    const parsed = parseRange(pick(row))
    if (parsed) intervals.push(parsed)
  }
  return intervals
}
