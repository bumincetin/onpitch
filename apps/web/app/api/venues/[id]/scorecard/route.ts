/**
 * GET /api/venues/[id]/scorecard — the venue owner's standing.
 *
 * Sits beside `/api/venues/[id]/metrics`, which answers with occupancy and revenue. This one
 * answers with the single number an owner can move — paid bookings and repeat customers, minus
 * what it costs to cancel on people — plus the tier it lands in.
 *
 * Ownership is checked twice and neither check is redundant. `venue_scorecard()` raises 42501
 * for a caller who does not own the venue, because SECURITY DEFINER has already stepped around
 * RLS and something has to make the check RLS would have made. The role gate here is the cheap
 * one that stops a player's request doing any database work at all.
 */

import { z } from "zod"

import { fail, handleRoute, ok } from "@/lib/api-response"
import { requireRole } from "@/lib/rbac"
import { loadVenueScorecard } from "@/lib/progress"
import { API_ERROR_CODES } from "@halisaha/shared/domain"
import type { VenueScorecard } from "@halisaha/shared/gamification"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const idSchema = z.string().uuid()
const daysSchema = z.coerce.number().int().min(1).max(365).default(90)

export async function GET(
  request: Request,
  context: { params: { id: string } },
): Promise<Response> {
  return handleRoute<VenueScorecard>(async () => {
    await requireRole("venue_owner", "admin")

    const parsedId = idSchema.safeParse(context.params.id)
    if (!parsedId.success) {
      return fail(API_ERROR_CODES.VALIDATION_FAILED, "Bu tesis kimliği geçersiz.", 422)
    }

    const url = new URL(request.url)
    const parsedDays = daysSchema.safeParse(url.searchParams.get("days") ?? undefined)
    if (!parsedDays.success) {
      return fail(API_ERROR_CODES.VALIDATION_FAILED, "days 1 ile 365 arasında olmalı.", 422)
    }

    const scorecard = await loadVenueScorecard(parsedId.data, parsedDays.data)
    if (!scorecard) {
      // The loader returns null both for "not yours" and for "unreadable". Saying "not found"
      // to a caller who does not own the venue is the right amount of information: it does not
      // confirm that the venue exists.
      return fail(API_ERROR_CODES.NOT_FOUND, "Bu tesise erişimin yok.", 404)
    }

    return ok<VenueScorecard>(scorecard)
  })
}
