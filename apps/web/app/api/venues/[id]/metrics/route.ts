/**
 * GET /api/venues/[id]/metrics
 *
 * The venue owner dashboard's numbers, as JSON, for the overview page's client-side range picker
 * and for anything that wants to poll them without re-rendering a whole RSC tree.
 *
 * ---------------------------------------------------------------------------
 * AUTHORISATION — two layers, on purpose
 * ---------------------------------------------------------------------------
 * 1. `requireRole('venue_owner','admin')` is the cheap capability gate: a player has no business
 *    on this endpoint at all, and failing fast avoids four database round trips.
 * 2. RLS is the real boundary. Every read inside `computeVenueMetrics` goes through the caller's
 *    COOKIE-BOUND client, so `bookings_select_stakeholders` and `venue_payouts_select_owner`
 *    decide what rows exist as far as this request is concerned. Even if the ownership check
 *    below were deleted, an owner could not read another owner's revenue.
 *
 * The explicit `owner_id` comparison is still here and still necessary, because `venues` is the
 * one table in this cluster with a deliberately PUBLIC select policy (`venues_select_active_anon`
 * — anyone may browse an active facility). Without it, a venue owner could name someone else's
 * active venue and get back a well-formed all-zeroes report, which leaks the fact that the venue
 * exists and has no bookings visible to them. A 403 is the honest answer.
 */

import { fail, handleRoute, ok } from "@/lib/api-response"
import { requireRole } from "@/lib/rbac"
import { createClient } from "@/lib/supabase/server"
import { computeVenueMetrics, type VenueMetricsResult } from "@/lib/venue/metrics"
import { API_ERROR_CODES, venueMetricsQuerySchema, type VenueDashboardMetrics } from "@halisaha/shared/domain"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * The wire shape. `metrics` is exactly the shared-contract `VenueDashboardMetrics`; everything
 * else is the extra context the dashboard renders around it (the comparison window, the daily
 * series behind the occupancy chart).
 */
export interface VenueMetricsResponse {
  venueId: string
  metrics: VenueDashboardMetrics
  current: VenueMetricsResult["current"]
  previous: VenueMetricsResult["previous"]
  deltas: VenueMetricsResult["deltas"]
  series: VenueMetricsResult["series"]
  range: VenueMetricsResult["range"]
  previousRange: VenueMetricsResult["previousRange"]
  timezone: string
  currency: string
  pitchCount: number
  activePitchCount: number
}

export async function GET(
  request: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  return handleRoute<VenueMetricsResponse>(async () => {
    const { user, profile } = await requireRole("venue_owner", "admin")
    const isAdmin = profile.role === "admin"

    const venueId = params.id
    if (!/^[0-9a-fA-F-]{36}$/.test(venueId)) {
      return fail(API_ERROR_CODES.VALIDATION_FAILED, "Geçersiz tesis referansı.", 422)
    }

    const url = new URL(request.url)
    const parsedQuery = venueMetricsQuerySchema.safeParse({
      from: url.searchParams.get("from") ?? undefined,
      to: url.searchParams.get("to") ?? undefined,
    })
    if (!parsedQuery.success) {
      return fail(
        API_ERROR_CODES.VALIDATION_FAILED,
        "Tarih aralığı geçersizdi.",
        422,
        {
          issues: parsedQuery.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
      )
    }

    const supabase = await createClient()

    const { data: venue, error: venueError } = await supabase
      .from("venues")
      .select("id, owner_id, name, timezone")
      .eq("id", venueId)
      .maybeSingle()

    if (venueError) {
      console.error("[venues/metrics] venue lookup failed", { code: venueError.code })
      return fail(API_ERROR_CODES.INTERNAL, "Tesis yüklenemedi.", 500)
    }
    if (!venue) {
      return fail(API_ERROR_CODES.NOT_FOUND, "Tesis bulunamadı.", 404)
    }
    if (venue.owner_id !== user.id && !isAdmin) {
      return fail(API_ERROR_CODES.FORBIDDEN, "Bu tesisin sahibi değilsin.", 403)
    }

    const result = await computeVenueMetrics({
      supabase,
      venue: { id: venue.id, timezone: venue.timezone },
      from: parsedQuery.data.from,
      to: parsedQuery.data.to,
    })

    const payload: VenueMetricsResponse = {
      venueId: venue.id,
      metrics: result.metrics,
      current: result.current,
      previous: result.previous,
      deltas: result.deltas,
      series: result.series,
      range: result.range,
      previousRange: result.previousRange,
      timezone: result.timezone,
      currency: result.currency,
      pitchCount: result.pitchCount,
      activePitchCount: result.activePitchCount,
    }

    return ok(payload)
  })
}
