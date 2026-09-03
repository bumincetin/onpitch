import "server-only"

import {
  assertDivisionLadderMatchesSql,
  leagueCitySchema,
  leagueTableRowSchema,
  myLeaguesSchema,
  toLeagueStanding,
  type Division,
  type LeagueCityRow,
  type LeagueStanding,
  type MyLeagueEntry,
} from "@onpitch/shared/leagues"

import { createRouteClient } from "@/lib/supabase/server"

/**
 * lib/leagues/index.ts
 *
 * Server-side reads for the city leagues.
 *
 * Like `lib/progress`, everything goes through a SECURITY DEFINER function and everything uses
 * `createRouteClient()` so one loader serves both transports — a Server Component with a session
 * cookie and the Expo app with a bearer token.
 *
 * `league_table()` is definer because it joins `teams` for a name and crest and then re-applies
 * the visibility rule itself; `my_leagues()` is definer because it deliberately IGNORES that
 * rule for the caller's own squads. Both answer with rows or `jsonb` that is opaque on this
 * side, so both are parsed rather than cast.
 */

/* ========================================================================== */
/*  The caller's own tables                                                   */
/* ========================================================================== */

export async function loadMyLeagues(): Promise<MyLeagueEntry[]> {
  // Cheap in development, absent from a production bundle. The ladder lives in two places by
  // necessity, and this is where a drift between them announces itself.
  if (process.env.NODE_ENV !== "production") assertDivisionLadderMatchesSql()

  const supabase = await createRouteClient()
  const { data, error } = await supabase.rpc("my_leagues")

  if (error) {
    console.error("[leagues] my_leagues() failed", { code: error.code })
    return []
  }

  const parsed = myLeaguesSchema.safeParse(data)
  if (!parsed.success) {
    console.error("[leagues] my_leagues() returned an unexpected shape", parsed.error.flatten())
    return []
  }
  return parsed.data
}

/* ========================================================================== */
/*  A division's table                                                        */
/* ========================================================================== */

export async function loadLeagueTable(
  city: string,
  division: Division,
  seasonId?: string | null,
): Promise<LeagueStanding[]> {
  const supabase = await createRouteClient()
  const { data, error } = await supabase.rpc("league_table", {
    p_city: city,
    p_division: division,
    p_season_id: seasonId ?? null,
  })

  if (error) {
    console.error("[leagues] league_table() failed", { code: error.code })
    return []
  }

  const rows = Array.isArray(data) ? data : []
  const standings: LeagueStanding[] = []
  for (const row of rows) {
    const parsed = leagueTableRowSchema.safeParse(row)
    // A malformed row is dropped rather than blanking the table: a standings page with a gap is
    // still readable, an empty one says nothing.
    if (parsed.success) standings.push(toLeagueStanding(parsed.data))
  }
  return standings
}

/* ========================================================================== */
/*  Cities with a live season                                                 */
/* ========================================================================== */

export interface LeagueCity {
  city: string
  seasonId: string
  seasonName: string
  endsOn: string
  teams: number
}

export async function loadLeagueCities(): Promise<LeagueCity[]> {
  const supabase = await createRouteClient()
  const { data, error } = await supabase.rpc("league_cities")

  if (error) {
    console.error("[leagues] league_cities() failed", { code: error.code })
    return []
  }

  const rows = Array.isArray(data) ? data : []
  const cities: LeagueCity[] = []
  for (const row of rows) {
    const parsed = leagueCitySchema.safeParse(row as LeagueCityRow)
    if (parsed.success) {
      cities.push({
        city: parsed.data.city,
        seasonId: parsed.data.season_id,
        seasonName: parsed.data.season_name,
        endsOn: parsed.data.ends_on,
        teams: parsed.data.teams,
      })
    }
  }
  return cities
}
