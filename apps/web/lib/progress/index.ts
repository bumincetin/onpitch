import "server-only"

import {
  assertLevelCurveMatchesSql,
  leaderboardRowSchema,
  playerProgressSchema,
  toLeaderboardEntry,
  venueScorecardSchema,
  type LeaderboardEntry,
  type LeaderboardScope,
  type PlayerProgress,
  type VenueScorecard,
} from "@onpitch/shared/gamification"

import { createRouteClient } from "@/lib/supabase/server"

/**
 * lib/progress/index.ts
 *
 * Server-side reads for the progression system.
 *
 * Every one of these goes through a SECURITY DEFINER function rather than a table read,
 * for reasons that differ per call and are worth keeping straight:
 *
 *   `my_progress()`      — needs to WRITE before it reads (open this week's challenges,
 *                          capture the caller's baseline), and needs six tables in one round
 *                          trip on a screen people open daily.
 *   `leaderboard_page()` — needs `profiles.display_name` for people the caller has no column
 *                          grant to read, so it applies the privacy rule itself.
 *   `venue_scorecard()`  — aggregates over `bookings` joined to `pitches`, and re-checks
 *                          ownership because SECURITY DEFINER has stepped around RLS.
 *
 * EVERY READ USES `createRouteClient()`, NOT `createClient()`. These loaders are called from
 * two places with two different transports: a Server Component rendering `/dashboard`, where the
 * session is a cookie, and `/api/progress`, which the Expo app calls with
 * `Authorization: Bearer`. `createClient()` reads the cookie jar only, so under a bearer caller
 * it produces an ANONYMOUS client — `my_progress()` then raises 28000, the loader returns null,
 * and the phone shows "we could not load your progress" while the browser works fine.
 * `createRouteClient()` resolves the bearer token when there is one and falls back to the cookie
 * client when there is not, so one loader serves both.
 *
 * Nothing here trusts the shape that comes back. The RPCs answer with `jsonb`, which is
 * `Json` on this side — an opaque tree — so each payload is parsed with the schema from
 * `@onpitch/shared/gamification`. A migration that renames a key surfaces as one legible
 * failure here instead of as `undefined` in the middle of a render.
 */

/* ========================================================================== */
/*  Player progression                                                        */
/* ========================================================================== */

/**
 * The caller's whole progression state, or null when signed out or unreadable.
 *
 * Returns null rather than throwing: the dashboard has plenty to show without it, and a
 * progression outage should not take the page with it.
 */
export async function loadMyProgress(): Promise<PlayerProgress | null> {
  // Cheap in development, absent from a production bundle. The curve lives in two places by
  // necessity (SQL owns the stored level, TypeScript draws the ring), and this is where a
  // drift between them announces itself.
  if (process.env.NODE_ENV !== "production") assertLevelCurveMatchesSql()

  const supabase = await createRouteClient()
  const { data, error } = await supabase.rpc("my_progress")

  if (error) {
    console.error("[progress] my_progress() failed", { code: error.code, message: error.message })
    return null
  }

  const parsed = playerProgressSchema.safeParse(data)
  if (!parsed.success) {
    console.error("[progress] my_progress() returned an unexpected shape", parsed.error.flatten())
    return null
  }

  return parsed.data
}

/* ========================================================================== */
/*  Leaderboard                                                               */
/* ========================================================================== */

export interface LeaderboardQuery {
  scope?: LeaderboardScope
  /** Exact match against `profiles.city`. Null or omitted means every city. */
  city?: string | null
  limit?: number
  offset?: number
}

export async function loadLeaderboard(query: LeaderboardQuery = {}): Promise<LeaderboardEntry[]> {
  const supabase = await createRouteClient()

  const { data, error } = await supabase.rpc("leaderboard_page", {
    p_scope: query.scope ?? "xp",
    p_city: query.city ?? null,
    p_limit: query.limit ?? 25,
    p_offset: query.offset ?? 0,
  })

  if (error) {
    console.error("[progress] leaderboard_page() failed", { code: error.code })
    return []
  }

  const rows = Array.isArray(data) ? data : []
  const entries: LeaderboardEntry[] = []
  for (const row of rows) {
    const parsed = leaderboardRowSchema.safeParse(row)
    // One malformed row is dropped rather than blanking the table. A ranking with a gap is
    // still a useful ranking; an empty one tells the reader nothing.
    if (parsed.success) entries.push(toLeaderboardEntry(parsed.data))
  }
  return entries
}

/* ========================================================================== */
/*  Venue scorecard                                                           */
/* ========================================================================== */

export async function loadVenueScorecard(
  venueId: string,
  days = 90,
): Promise<VenueScorecard | null> {
  const supabase = await createRouteClient()
  const { data, error } = await supabase.rpc("venue_scorecard", {
    p_venue_id: venueId,
    p_days: days,
  })

  if (error) {
    // 42501 is the function refusing a caller who does not own the venue. That is the
    // authorisation boundary doing its job, not an outage, so it is not logged as one.
    if (error.code !== "42501") {
      console.error("[progress] venue_scorecard() failed", { code: error.code })
    }
    return null
  }

  const parsed = venueScorecardSchema.safeParse(data)
  if (!parsed.success) {
    console.error("[progress] venue_scorecard() returned an unexpected shape")
    return null
  }
  return parsed.data
}

/* ========================================================================== */
/*  Recent form                                                               */
/* ========================================================================== */

export type FormResult = "win" | "draw" | "loss"

export interface RecentForm {
  /** Oldest first, so the row reads left to right like a fixture list. */
  results: FormResult[]
  lastFive: { matchId: string; result: FormResult; kickoffAt: string }[]
}

/**
 * The caller's last five finalized results.
 *
 * Read directly rather than through an RPC: `matches_select_involved` and
 * `match_participants` policies already restrict this to the caller's own matches, so RLS is
 * exactly the right filter and there is nothing for a definer function to add.
 */
export async function loadRecentForm(userId: string, take = 5): Promise<RecentForm> {
  const supabase = await createRouteClient()

  const { data, error } = await supabase
    .from("match_participants")
    .select("team_side, matches!inner(id, kickoff_at, status, home_score, away_score)")
    .eq("player_id", userId)
    .eq("matches.status", "finalized")
    .order("kickoff_at", { referencedTable: "matches", ascending: false })
    .limit(take)

  if (error || !data) {
    if (error) console.error("[progress] recent form failed", { code: error.code })
    return { results: [], lastFive: [] }
  }

  const rows = data
    .map((row) => {
      // postgrest-js types an `!inner` embed as either an object or an array depending on the
      // relationship it infers; normalising once here keeps the narrowing out of the mapping.
      const match = Array.isArray(row.matches) ? row.matches[0] : row.matches
      if (!match || match.home_score === null || match.away_score === null) return null

      const mine = row.team_side === "away" ? match.away_score : match.home_score
      const theirs = row.team_side === "away" ? match.home_score : match.away_score
      const result: FormResult = mine > theirs ? "win" : mine === theirs ? "draw" : "loss"

      return { matchId: match.id, result, kickoffAt: match.kickoff_at }
    })
    .filter((row): row is { matchId: string; result: FormResult; kickoffAt: string } => row !== null)
    .reverse()

  return { results: rows.map((row) => row.result), lastFive: rows }
}

/* ========================================================================== */
/*  Next fixture                                                              */
/* ========================================================================== */

export interface NextFixture {
  matchId: string
  kickoffAt: string
  durationMinutes: number
  status: string
  venueName: string | null
  city: string | null
  timezone: string | null
  side: "home" | "away" | null
  isConfirmed: boolean
}

/** The caller's next kick-off, or null when there is nothing booked. */
export async function loadNextFixture(userId: string): Promise<NextFixture | null> {
  const supabase = await createRouteClient()

  const { data, error } = await supabase
    .from("match_participants")
    .select(
      "team_side, is_confirmed, matches!inner(id, kickoff_at, duration_minutes, status, venue_id)",
    )
    .eq("player_id", userId)
    .gte("matches.kickoff_at", new Date().toISOString())
    .in("matches.status", ["scheduled", "live"])
    .order("kickoff_at", { referencedTable: "matches", ascending: true })
    .limit(1)

  if (error || !data || data.length === 0) {
    if (error) console.error("[progress] next fixture failed", { code: error.code })
    return null
  }

  const row = data[0]
  if (!row) return null
  const match = Array.isArray(row.matches) ? row.matches[0] : row.matches
  if (!match) return null

  let venueName: string | null = null
  let city: string | null = null
  let timezone: string | null = null

  if (match.venue_id) {
    const { data: venue } = await supabase
      .from("venues")
      .select("name, city, timezone")
      .eq("id", match.venue_id)
      .maybeSingle()
    venueName = venue?.name ?? null
    city = venue?.city ?? null
    timezone = venue?.timezone ?? null
  }

  return {
    matchId: match.id,
    kickoffAt: match.kickoff_at,
    durationMinutes: match.duration_minutes,
    status: match.status,
    venueName,
    city,
    timezone,
    side: row.team_side === "home" || row.team_side === "away" ? row.team_side : null,
    isConfirmed: row.is_confirmed,
  }
}
