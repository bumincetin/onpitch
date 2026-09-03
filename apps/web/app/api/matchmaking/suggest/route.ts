/**
 * app/api/matchmaking/suggest/route.ts
 *
 *   GET /api/matchmaking/suggest?limit=&city=&format=&withinKm=
 *
 * Ranked open matches for the caller. The scoring model, its weights and the
 * reasoning behind each term live in `lib/matchmaking/quality.ts`; this handler
 * is the data-gathering half.
 *
 * ── Why the service-role client ─────────────────────────────────────────────
 * Same reason as `GET /api/matches`: `matches_select_involved` restricts SELECT
 * to people already involved in a match, and a player looking for a game is by
 * definition not involved in any of the matches they want to find. Discovery is
 * therefore authorised by this handler rather than by RLS, and the handler keeps
 * a deliberately tight contract:
 *
 *   * only future, `scheduled`, non-full matches are considered;
 *   * the response carries NO participant identities — the roster is reduced to
 *     anonymous `(mu, sigma)` pairs before it is scored, and only aggregates
 *     survive into the payload;
 *   * `player_ratings` is world-readable to signed-in users anyway (0002 §5.10),
 *     so nothing here is exposed that the leaderboard does not already show.
 *
 * ── Minors ──────────────────────────────────────────────────────────────────
 * `location_sharing_enabled` is false for every minor by constraint. This route
 * reads the flag and passes it straight through; `scoreCandidate()` then drops
 * the distance term entirely rather than defaulting it, and `distanceKm` comes
 * back `null`. The privacy default propagates into the algorithm — it is not
 * worked around by falling back to the city, which would be an approximate
 * location for somebody who asked not to share one.
 *
 * ── Query budget ────────────────────────────────────────────────────────────
 * Five bounded queries, no N+1: candidate matches, their venues, their
 * participants, the ratings of everybody involved, and one history query used
 * for both the caller's own preferences and the counterparties' reliability.
 */

import { createAdminClient } from "@/lib/supabase/admin"
import { getSessionUser } from "@/lib/rbac"
import { ApiRouteError, handleRoute, ok } from "@/lib/api-response"
import {
  FORMAT_TEAM_SIZE,
  MATCHMAKING_WEIGHTS,
  asRows,
  defaultRating,
  loadRatings,
  loose,
  rankCandidates,
  throwDatabaseError,
  type MatchCandidateInput,
  type Rating,
  type SeekerContext,
} from "@/lib/matchmaking"
import { API_ERROR_CODES, matchFormatSchema, type MatchmakingCandidate } from "@onpitch/shared/domain"
import type { Enums } from "@onpitch/shared/database"
import { z } from "zod"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** How far ahead to look. Beyond this a "suggestion" is speculation. */
const HORIZON_DAYS = 21

/** Hard cap on candidate matches pulled before ranking. */
const MAX_CANDIDATES = 60

/** Hard cap on history rows read for the reliability + preference terms. */
const MAX_HISTORY_ROWS = 2000

const suggestQuerySchema = z.object({
  city: z.string().max(80).optional(),
  format: matchFormatSchema.optional(),
  /** Drops candidates further away than this. Ignored when location is private. */
  withinKm: z.coerce.number().min(1).max(500).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
})

interface SuggestResult {
  candidates: MatchmakingCandidate[]
  /** Echoed so a client can explain the ranking without hard-coding the model. */
  weights: typeof MATCHMAKING_WEIGHTS
  /** True when the distance term was dropped for privacy rather than absence. */
  distanceSkipped: boolean
  /** The caller's own reliability, surfaced but NOT used to rank — see quality.ts. */
  callerNoShowRate: number
  consideredMatches: number
}

export async function GET(request: Request): Promise<Response> {
  return handleRoute<SuggestResult>(async () => {
    const session = await getSessionUser()
    if (!session) {
      throw new ApiRouteError(
        API_ERROR_CODES.UNAUTHENTICATED,
        "Maç önerileri için giriş yap.",
        401,
      )
    }

    const url = new URL(request.url)
    const query = suggestQuerySchema.parse(Object.fromEntries(url.searchParams))

    const admin = createAdminClient()
    const now = new Date()
    const horizon = new Date(now.getTime() + HORIZON_DAYS * 24 * 60 * 60 * 1000)

    /* -- 1. Candidate matches --------------------------------------------- */
    let builder = admin
      .from("matches")
      .select("id, kickoff_at, format, status, venue_id, is_ranked")
      .eq("status", "scheduled")
      .gte("kickoff_at", now.toISOString())
      .lte("kickoff_at", horizon.toISOString())
      .order("kickoff_at", { ascending: true })
      .limit(MAX_CANDIDATES)

    if (query.format) builder = builder.eq("format", query.format)

    const { data: matchRows, error: matchError } = await builder
    if (matchError) throw matchError

    const matches = matchRows ?? []
    if (matches.length === 0) {
      return ok<SuggestResult>({
        candidates: [],
        weights: MATCHMAKING_WEIGHTS,
        distanceSkipped: !session.profile.location_sharing_enabled,
        callerNoShowRate: 0,
        consideredMatches: 0,
      })
    }

    const matchIds = matches.map((m) => m.id)

    /* -- 2. Venues (name, city, coordinates) ------------------------------- */
    const venueIds = [
      ...new Set(matches.map((m) => m.venue_id).filter((id): id is string => Boolean(id))),
    ]
    const venues = new Map<
      string,
      { name: string; city: string | null; latitude: number | null; longitude: number | null }
    >()
    if (venueIds.length > 0) {
      const { data, error } = await admin
        .from("venues")
        .select("id, name, city, latitude, longitude")
        .in("id", venueIds)
      if (error) throw error
      for (const venue of data ?? []) {
        venues.set(venue.id, {
          name: venue.name,
          city: venue.city,
          latitude: venue.latitude,
          longitude: venue.longitude,
        })
      }
    }

    /* -- 3. Rosters -------------------------------------------------------- */
    const { data: participantRows, error: participantError } = await admin
      .from("match_participants")
      .select("match_id, player_id, team_side")
      .in("match_id", matchIds)
    if (participantError) throw participantError

    const rosters = new Map<string, { home: string[]; away: string[] }>()
    const everyone = new Set<string>()
    const callerIsIn = new Set<string>()

    for (const row of participantRows ?? []) {
      const entry = rosters.get(row.match_id) ?? { home: [], away: [] }
      if (row.team_side === "away") entry.away.push(row.player_id)
      else entry.home.push(row.player_id)
      rosters.set(row.match_id, entry)
      everyone.add(row.player_id)
      if (row.player_id === session.user.id) callerIsIn.add(row.match_id)
    }

    /* -- 4. Ratings -------------------------------------------------------- */
    const ratings = await loadRatings(admin, [...everyone, session.user.id])
    const callerRating: Rating = ratings.get(session.user.id) ?? defaultRating()

    /* -- 5. History: reliability + the caller's own habits ----------------- */
    const history = await loadHistory(admin, [...everyone, session.user.id], session.user.id, now)

    // Coordinates for the venues the caller has recently played at. Fetched
    // separately because `venues` above only covers the CANDIDATE matches, and
    // the caller's history is very often somewhere else entirely.
    const anchorVenues = await loadVenueCoordinates(admin, history.callerVenues)

    /* -- 6. Assemble and rank --------------------------------------------- */
    const seeker: SeekerContext = {
      playerId: session.user.id,
      rating: {
        mu: callerRating.mu,
        sigma: callerRating.sigma,
        conservativeRating: callerRating.mu - 3 * callerRating.sigma,
      },
      // `is_minor` is a GENERATED column; typed `boolean | null` because the DDL
      // allows null, but the backing function never returns null.
      isMinor: session.profile.is_minor === true,
      locationSharingEnabled: session.profile.location_sharing_enabled,
      latitude: null,
      longitude: null,
      city: session.profile.city,
      preferredPosition: session.profile.preferred_position,
      recentFormats: history.callerFormats,
      preferredKickoffHours: history.callerHours,
      noShowRate: history.rateFor(session.user.id),
    }

    // A player's own coordinates are not stored on `profiles` (only `city` is),
    // so the distance term anchors on the city centroid of the venues they have
    // recently played at. When there is no such anchor the term is dropped the
    // same way it is for a minor — an absent location and a private one are
    // treated identically, which is the point.
    if (seeker.locationSharingEnabled && !seeker.isMinor) {
      const anchor = anchorFromHistory(history.callerVenues, anchorVenues)
      seeker.latitude = anchor?.latitude ?? null
      seeker.longitude = anchor?.longitude ?? null
    }

    const candidates: MatchCandidateInput[] = matches
      // Never suggest a match the caller is already on the sheet for.
      .filter((m) => !callerIsIn.has(m.id))
      .map((m) => {
        const roster = rosters.get(m.id) ?? { home: [], away: [] }
        const venue = m.venue_id ? venues.get(m.venue_id) : undefined
        const teamSize = FORMAT_TEAM_SIZE[m.format]
        const total = roster.home.length + roster.away.length
        return {
          matchId: m.id,
          kickoffAt: m.kickoff_at,
          format: m.format as Enums<"match_format">,
          status: m.status as Enums<"match_status">,
          venueId: m.venue_id,
          venueName: venue?.name ?? null,
          city: venue?.city ?? null,
          venueLatitude: venue?.latitude ?? null,
          venueLongitude: venue?.longitude ?? null,
          homeRatings: roster.home.map((id) => ratings.get(id) ?? defaultRating()),
          awayRatings: roster.away.map((id) => ratings.get(id) ?? defaultRating()),
          spotsRemaining: Math.max(0, teamSize * 2 - total),
          isRanked: m.is_ranked,
          participantNoShowRates: [...roster.home, ...roster.away].map((id) =>
            history.rateFor(id),
          ),
        }
      })
      // A full match is not a suggestion.
      .filter((c) => c.spotsRemaining > 0)
      .filter((c) => (query.city ? matchesCity(c.city, query.city) : true))

    let ranked = rankCandidates(seeker, candidates, { now, limit: query.limit })

    if (query.withinKm !== undefined) {
      // `distanceKm === null` means the term was skipped for privacy. Applying a
      // radius filter to those would silently return nothing for every minor, so
      // they are kept: a filter the user cannot satisfy is worse than no filter.
      const radius = query.withinKm
      ranked = ranked.filter((c) => c.distanceKm === null || c.distanceKm <= radius)
    }

    return ok<SuggestResult>({
      candidates: ranked,
      weights: MATCHMAKING_WEIGHTS,
      distanceSkipped: seeker.isMinor || !seeker.locationSharingEnabled,
      callerNoShowRate: seeker.noShowRate ?? 0,
      consideredMatches: candidates.length,
    })
  })
}

/* ========================================================================== */
/*  History                                                                   */
/* ========================================================================== */

interface History {
  /** Proxy no-show rate in [0,1] for a player; 0 when there is no history. */
  rateFor(playerId: string): number
  /** Formats the caller has played, most recent first. */
  callerFormats: Enums<"match_format">[]
  /** Local kickoff hours the caller usually plays at. */
  callerHours: number[]
  /** Venue ids the caller has recently played at, most recent first. */
  callerVenues: string[]
}

/**
 * One bounded query that feeds three terms.
 *
 * ── The no-show proxy, stated plainly ───────────────────────────────────────
 * The schema has NO attendance ledger. There is no `attended` column, no
 * no-show table, and `player_stats.minutes_played` defaults to 0 for everybody,
 * so it cannot distinguish "did not play" from "nobody filled in the stats".
 *
 * The closest real signal is `match_participants.is_confirmed`: a player who was
 * on the team sheet for a match that has already kicked off and never confirmed
 * their attendance is the best available evidence of a no-show. It is a PROXY,
 * and it over-reports for anyone whose group simply does not use check-in.
 *
 * That is exactly why `MATCHMAKING_WEIGHTS.noShowReliability` is the smallest
 * weight (0.05) and why `scoreReliability()` smooths towards "reliable" with a
 * prior. When a real attendance ledger ships, replace this function and nothing
 * above it changes.
 *
 * Uses the `loose` client because the query embeds `matches` and the hand-written
 * `types/database.ts` cannot type an embedded select.
 */
async function loadHistory(
  admin: unknown,
  playerIds: readonly string[],
  callerId: string,
  now: Date,
): Promise<History> {
  const empty: History = {
    rateFor: () => 0,
    callerFormats: [],
    callerHours: [],
    callerVenues: [],
  }
  if (playerIds.length === 0) return empty

  const { data, error } = await loose(admin)
    .from("match_participants")
    .select("player_id, is_confirmed, joined_at, matches!inner(kickoff_at, format, venue_id)")
    .in("player_id", playerIds)
    .lt("matches.kickoff_at", now.toISOString())
    .order("joined_at", { ascending: false })
    .limit(MAX_HISTORY_ROWS)

  if (error) throwDatabaseError(error)

  const played = new Map<string, number>()
  const missed = new Map<string, number>()
  const callerFormats: Enums<"match_format">[] = []
  const callerHours: number[] = []
  const callerVenues: string[] = []

  for (const row of asRows(data)) {
    const playerId = typeof row.player_id === "string" ? row.player_id : null
    if (!playerId) continue

    played.set(playerId, (played.get(playerId) ?? 0) + 1)
    if (row.is_confirmed !== true) missed.set(playerId, (missed.get(playerId) ?? 0) + 1)

    if (playerId !== callerId) continue

    // PostgREST returns a to-one embed as an object, but older versions and some
    // planner shapes return a single-element array. Accept both.
    const embedded = Array.isArray(row.matches) ? row.matches[0] : row.matches
    const match = typeof embedded === "object" && embedded !== null
      ? (embedded as Record<string, unknown>)
      : null
    if (!match) continue

    if (typeof match.format === "string" && callerFormats.length < 20) {
      callerFormats.push(match.format as Enums<"match_format">)
    }
    if (typeof match.kickoff_at === "string" && callerHours.length < 20) {
      const at = Date.parse(match.kickoff_at)
      if (Number.isFinite(at)) {
        // +03:00 — Turkey has not observed DST since 2016, so a fixed offset is
        // exact rather than an approximation.
        callerHours.push(new Date(at + 180 * 60000).getUTCHours())
      }
    }
    if (typeof match.venue_id === "string" && callerVenues.length < 20) {
      callerVenues.push(match.venue_id)
    }
  }

  return {
    rateFor(playerId: string): number {
      const total = played.get(playerId) ?? 0
      if (total === 0) return 0
      return (missed.get(playerId) ?? 0) / total
    },
    callerFormats,
    callerHours,
    callerVenues,
  }
}

/**
 * Coordinates for a small, bounded set of venue ids. Returns an empty map for an
 * empty input rather than issuing a query with an empty `IN` list.
 */
async function loadVenueCoordinates(
  admin: ReturnType<typeof createAdminClient>,
  venueIds: readonly string[],
): Promise<Map<string, { latitude: number | null; longitude: number | null }>> {
  const out = new Map<string, { latitude: number | null; longitude: number | null }>()
  const ids = [...new Set(venueIds)].slice(0, 20)
  if (ids.length === 0) return out

  const { data, error } = await admin
    .from("venues")
    .select("id, latitude, longitude")
    .in("id", ids)
  if (error) throw error

  for (const venue of data ?? []) {
    out.set(venue.id, { latitude: venue.latitude, longitude: venue.longitude })
  }
  return out
}

/**
 * Approximate the caller's location as the centroid of the venues they have
 * recently played at. Returns null when none of them have coordinates, which
 * drops the distance term rather than guessing.
 */
function anchorFromHistory(
  venueIds: readonly string[],
  venues: ReadonlyMap<string, { latitude: number | null; longitude: number | null }>,
): { latitude: number; longitude: number } | null {
  let lat = 0
  let lon = 0
  let n = 0
  for (const id of venueIds) {
    const venue = venues.get(id)
    if (!venue || venue.latitude === null || venue.longitude === null) continue
    lat += venue.latitude
    lon += venue.longitude
    n += 1
  }
  if (n === 0) return null
  return { latitude: lat / n, longitude: lon / n }
}

/** Case-insensitive city compare using Turkish casing rules (dotted/dotless i). */
function matchesCity(city: string | null, wanted: string): boolean {
  if (!city) return false
  return city.trim().toLocaleLowerCase("tr") === wanted.trim().toLocaleLowerCase("tr")
}
