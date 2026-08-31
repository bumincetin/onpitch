/**
 * GET /api/leagues — the caller's own league positions, plus the cities with a live season.
 *
 * `my_leagues()` reads `auth.uid()` itself and deliberately ignores `teams.is_public`: your own
 * team's position is yours to see whether or not the team is listed publicly. It also opens the
 * season for every city the caller's teams belong to before answering, so a squad that has not
 * played yet appears in a table rather than nowhere — which is why this is a function and not a
 * view, and why the phone calls it rather than reading the tables.
 */

import { fail, handleRoute, ok } from "@/lib/api-response"
import { getSessionUser } from "@/lib/rbac"
import { loadLeagueCities, loadMyLeagues, type LeagueCity } from "@/lib/leagues"
import { API_ERROR_CODES } from "@halisaha/shared/domain"
import type { MyLeagueEntry } from "@halisaha/shared/leagues"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export interface LeaguesPayload {
  mine: MyLeagueEntry[]
  cities: LeagueCity[]
}

export async function GET(): Promise<Response> {
  return handleRoute<LeaguesPayload>(async () => {
    const session = await getSessionUser()
    if (!session) {
      return fail(API_ERROR_CODES.UNAUTHENTICATED, "Ligleri görmek için giriş yap.", 401)
    }

    const [mine, cities] = await Promise.all([loadMyLeagues(), loadLeagueCities()])
    return ok<LeaguesPayload>({ mine, cities })
  })
}
