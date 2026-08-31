/**
 * GET /api/leagues/table — one division's standings.
 *
 * Open to signed-out callers on purpose: a league table is the product's best recruiting page,
 * and it is exactly the link a captain pastes into a group chat.
 *
 * `league_table()` decides what is publishable — only teams whose `is_public` is set — so this
 * handler adds no filtering of its own. Note the consequence for the caller: a private team is
 * absent from the table even for its own members here. `GET /api/leagues` is the route that
 * answers "where do MY teams stand", and it ignores that flag deliberately.
 */

import { z } from "zod"

import { fail, handleRoute, ok } from "@/lib/api-response"
import { loadLeagueTable } from "@/lib/leagues"
import { API_ERROR_CODES } from "@halisaha/shared/domain"
import { DIVISIONS, type Division, type LeagueStanding } from "@halisaha/shared/leagues"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const querySchema = z.object({
  // Length-capped and trimmed: it goes into an equality predicate, not a LIKE, so this is about
  // keeping the query sane rather than about injection.
  city: z.string().trim().min(1).max(80),
  division: z.enum(DIVISIONS).default("bronze"),
  seasonId: z.string().uuid().optional(),
})

export interface LeagueTablePayload {
  city: string
  division: Division
  standings: LeagueStanding[]
}

export async function GET(request: Request): Promise<Response> {
  return handleRoute<LeagueTablePayload>(async () => {
    const url = new URL(request.url)
    const parsed = querySchema.safeParse({
      city: url.searchParams.get("city") ?? undefined,
      division: url.searchParams.get("division") ?? undefined,
      seasonId: url.searchParams.get("seasonId") ?? undefined,
    })

    if (!parsed.success) {
      return fail(
        API_ERROR_CODES.VALIDATION_FAILED,
        `city zorunlu, division şunlardan biri olmalı: ${DIVISIONS.join(", ")}.`,
        422,
      )
    }

    const { city, division, seasonId } = parsed.data
    const standings = await loadLeagueTable(city, division, seasonId ?? null)

    return ok<LeagueTablePayload>({ city, division, standings })
  })
}
