/**
 * components/profile/player-history.tsx
 *
 * The reads behind a profile screen, in one place so the own-profile tab and another player's
 * page cannot drift apart.
 *
 * WHY SEPARATE QUERIES AND NOT ONE EMBEDDED SELECT
 * ---------------------------------------------
 * PostgREST could embed `matches` inside the `player_stats` select. It is not done here because
 * the two tables have different visibility rules — `player_stats` admits your own rows plus rows
 * from matches you can see, `matches_select_*` decides the second half — and an embed silently
 * drops the parent row when the child is filtered out. Reading them separately means a stat row
 * whose match this viewer cannot see still renders, with the fields that are missing shown as
 * missing. That is the honest result, and it is also the one that does not look like data loss.
 *
 * `player_ratings` is world-readable to any signed-in user by design: mu and sigma are
 * non-identifying, and it is the NAME attached to a rating that `profiles`' policies protect. So
 * this returns a rating for a private profile, which is exactly what the player page renders.
 */

import type { Enums } from '@halisaha/shared/database'
import type { TeamSide } from '@halisaha/shared/domain'

import { dataError } from '@/lib/data-error'
import { supabase } from '@/lib/supabase'

import type { PlayerRating } from './rating-card'
import type { MatchHistoryEntry } from './match-history'

/** How many `player_stats` rows a profile screen reads. */
export const HISTORY_LIMIT = 20

const RATING_COLUMNS =
  'player_id, mu, sigma, conservative_rating, matches_played, wins, draws, losses, last_match_at'
const STAT_COLUMNS = 'id, match_id, team_side, goals, assists, rating_delta, created_at'
const MATCH_COLUMNS = 'id, kickoff_at, status, home_score, away_score, is_ranked, venue_id'

/** The `matches` columns a history row needs. Declared rather than inferred so the map below has
 *  one concrete element type instead of a union of "empty" and "loaded". */
interface MatchSummary {
  id: string
  kickoff_at: string
  status: Enums<'match_status'>
  home_score: number | null
  away_score: number | null
  is_ranked: boolean
  venue_id: string | null
}

export interface PlayerHistory {
  /** Null when the player has never been rated. */
  rating: PlayerRating | null
  /** Newest first. */
  entries: MatchHistoryEntry[]
  /** Summed over `entries`, which is a window and not a career total. */
  goals: number
  assists: number
  /** How many stat rows the totals above cover. */
  window: number
}

/** `player_stats.team_side` is `text` with a CHECK, so it is narrowed rather than trusted. */
function toTeamSide(value: string | null): TeamSide | null {
  return value === 'home' || value === 'away' ? value : null
}

/** Milliseconds for sorting; unparseable or absent dates sink to the bottom. */
function timeOf(value: string | null): number {
  if (!value) return 0
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? 0 : parsed
}

/**
 * Reads a player's rating and recent matches.
 *
 * @throws {Error} with a message fit for a retry state when a query fails.
 */
export async function loadPlayerHistory(
  playerId: string,
  limit: number = HISTORY_LIMIT,
): Promise<PlayerHistory> {
  const [ratingResult, statsResult] = await Promise.all([
    supabase.from('player_ratings').select(RATING_COLUMNS).eq('player_id', playerId).maybeSingle(),
    supabase
      .from('player_stats')
      .select(STAT_COLUMNS)
      .eq('player_id', playerId)
      .order('created_at', { ascending: false })
      .limit(limit),
  ])

  if (ratingResult.error) {
    throw dataError('Could not load the rating.', ratingResult.error)
  }
  if (statsResult.error) {
    throw dataError('Could not load the match history.', statsResult.error)
  }

  const stats = statsResult.data ?? []
  const matchIds = stats.map((row) => row.match_id)

  // `.in()` with an empty array is a query that can never match; skipping it saves the round trip.
  const matches = new Map<string, MatchSummary>()
  if (matchIds.length > 0) {
    const { data, error } = await supabase.from('matches').select(MATCH_COLUMNS).in('id', matchIds)
    if (error) throw dataError('Could not load those matches.', error)
    for (const row of data ?? []) matches.set(row.id, row)
  }

  // A fourth read, for one column: the zone the kick-off is quoted in. Without it a history row
  // renders at the device's offset while the match screen it opens renders at the venue's, and
  // the same fixture shows two different times. A venue the viewer cannot read simply yields no
  // zone, which the row then labels as device time rather than passing off as venue time — so
  // this failure is swallowed rather than thrown.
  const venueIds = new Set<string>()
  for (const row of matches.values()) {
    if (row.venue_id) venueIds.add(row.venue_id)
  }

  const timezones = new Map<string, string>()
  if (venueIds.size > 0) {
    const { data } = await supabase.from('venues').select('id, timezone').in('id', [...venueIds])
    for (const row of data ?? []) timezones.set(row.id, row.timezone)
  }

  let goals = 0
  let assists = 0

  const entries: MatchHistoryEntry[] = stats.map((row) => {
    goals += row.goals
    assists += row.assists

    const match = matches.get(row.match_id) ?? null

    return {
      statId: row.id,
      matchId: row.match_id,
      kickoffAt: match?.kickoff_at ?? null,
      timezone: match?.venue_id ? (timezones.get(match.venue_id) ?? null) : null,
      status: match?.status ?? null,
      homeScore: match?.home_score ?? null,
      awayScore: match?.away_score ?? null,
      teamSide: toTeamSide(row.team_side),
      isRanked: match?.is_ranked ?? true,
      ratingDelta: row.rating_delta,
      goals: row.goals,
      assists: row.assists,
    }
  })

  // Stat rows are ordered by when the score was filed; a player reads their history by kickoff.
  entries.sort((a, b) => timeOf(b.kickoffAt) - timeOf(a.kickoffAt))

  const rating = ratingResult.data

  return {
    rating: rating
      ? {
          mu: rating.mu,
          sigma: rating.sigma,
          conservative_rating: rating.conservative_rating,
          matches_played: rating.matches_played,
          wins: rating.wins,
          draws: rating.draws,
          losses: rating.losses,
          last_match_at: rating.last_match_at,
        }
      : null,
    entries,
    goals,
    assists,
    window: stats.length,
  }
}
