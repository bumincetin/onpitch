/**
 * app/api/matches/route.ts
 *
 *   POST /api/matches   create a match, auto-enrol the creator, store the
 *                       predicted balance
 *   GET  /api/matches   filterable discovery list
 *
 * ── Which client does what, and why ─────────────────────────────────────────
 * POST writes through the USER's cookie-bound client, so `matches_insert_organiser`
 * is what decides whether this person may attach this match to that booking.
 * Recreating that check in TypeScript would be a second, drift-prone copy of an
 * authorisation rule the database already enforces.
 *
 * Two columns are then written with the SERVICE-ROLE client: `match_quality` and
 * `predicted_draw_probability`. They are deliberately absent from the
 * `authenticated` INSERT grant in 0002 — a client that could write its own match
 * quality could advertise a stacked fixture as perfectly balanced. So the
 * numbers are computed server-side from `player_ratings` and written by the
 * server, exactly as the grant intends.
 *
 * GET reads through the SERVICE-ROLE client, which needs justifying because it
 * bypasses RLS. `matches_select_involved` restricts SELECT to participants, the
 * organiser, the hosting venue owner and admins — correct for a match detail
 * page, and fatal for discovery: a player looking for a game is by definition
 * not yet involved in any of the matches they want to find. So this handler
 * becomes the authorisation boundary itself and enforces a narrower contract
 * than RLS can express:
 *
 *   * only future, non-cancelled matches are listable;
 *   * the projection carries NO participant identities — counts only, so
 *     "who is playing tonight" is not answerable from this endpoint;
 *   * the caller must still be authenticated, so it is not an open scrape.
 *
 * Anything richer (line-ups, scores, reports) is fetched through the user's own
 * client on the match page, where RLS applies normally.
 */

import { createRouteClient } from "@/lib/supabase/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { getSessionUser } from "@/lib/rbac"
import { ApiRouteError, handleRoute, ok } from "@/lib/api-response"
import { enforceRateLimit } from "@/lib/rate-limit"
import {
  FORMAT_TEAM_SIZE,
  assertConsented,
  defaultRating,
  loadRatings,
  predictBalance,
  ratingsFor,
  type Rating,
} from "@/lib/matchmaking"
import {
  API_ERROR_CODES,
  createMatchSchema,
  matchListQuerySchema,
  type MatchQuality,
} from "@halisaha/shared/domain"
import type { Enums, Tables } from "@halisaha/shared/database"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/* ========================================================================== */
/*  Response shapes                                                           */
/* ========================================================================== */

/** One row of the discovery list. Deliberately identity-free. */
interface MatchListItem {
  id: string
  kickoffAt: string
  durationMinutes: number
  format: Enums<"match_format">
  status: Enums<"match_status">
  isRanked: boolean
  venueId: string | null
  venueName: string | null
  city: string | null
  pitchId: string | null
  teamSize: number
  participantCount: number
  homeCount: number
  awayCount: number
  spotsRemaining: number
  matchQuality: number | null
  predictedDrawProbability: number | null
}

interface CreateMatchResult {
  match: Tables<"matches">
  /** The creator's auto-enrolment. */
  participant: Tables<"match_participants">
  /** Predicted balance for the fixture as it would look once full. */
  quality: MatchQuality
  teamSize: number
  spotsRemaining: number
}

interface MatchListResult {
  matches: MatchListItem[]
  limit: number
  offset: number
}

/* ========================================================================== */
/*  POST — create                                                             */
/* ========================================================================== */

export async function POST(request: Request): Promise<Response> {
  return handleRoute<CreateMatchResult>(async () => {
    const session = await getSessionUser()
    if (!session) {
      throw new ApiRouteError(API_ERROR_CODES.UNAUTHENTICATED, "Maç kurmak için giriş yap.", 401)
    }
    assertConsented(session.profile)

    // Budgets are counted in Postgres, not in this process — see lib/rate-limit.ts.
    const limited = await enforceRateLimit("create_match")
    if (limited) return limited

    const body = createMatchSchema.parse(await request.json())

    // `createRouteClient` — not `createClient` — because the Expo app has no cookie jar and
    // authenticates with `Authorization: Bearer <access token>`. A cookie-only client would run
    // the INSERT below as `anon` with auth.uid() null for a mobile caller, and the `matches`
    // insert policy would refuse it. Still the caller's own, RLS-scoped client either way.
    const supabase = await createRouteClient(request)
    const admin = createAdminClient()

    /* -- Resolve the pitch / venue the match is played at ------------------ */
    // A booking is the strongest anchor: it already names the pitch, and the
    // RLS insert policy separately verifies the caller owns that booking.
    let pitchId = body.pitchId ?? null
    let venueId = body.venueId ?? null

    if (body.bookingId) {
      const { data: booking, error } = await supabase
        .from("bookings")
        .select("id, pitch_id, status")
        .eq("id", body.bookingId)
        .maybeSingle()

      if (error) throw error
      if (!booking) {
        throw new ApiRouteError(
          API_ERROR_CODES.NOT_FOUND,
          "Böyle bir rezervasyon yok veya sana ait değil.",
          404,
        )
      }
      if (booking.status === "cancelled" || booking.status === "refunded") {
        throw new ApiRouteError(
          API_ERROR_CODES.VALIDATION_FAILED,
          "Bu rezervasyon iptal edilmiş, üstüne maç eklenemez.",
          409,
        )
      }
      pitchId = pitchId ?? booking.pitch_id
    }

    if (pitchId && !venueId) {
      const { data: pitch, error } = await supabase
        .from("pitches")
        .select("id, venue_id")
        .eq("id", pitchId)
        .maybeSingle()
      if (error) throw error
      venueId = pitch?.venue_id ?? null
    }

    /* -- Predict the balance BEFORE inserting ------------------------------ */
    const teamSize = FORMAT_TEAM_SIZE[body.format]
    const seed = await collectSeedRatings(admin, {
      creatorId: session.user.id,
      creatorSide: body.creatorSide,
      homeTeamId: body.homeTeamId ?? null,
      awayTeamId: body.awayTeamId ?? null,
      teamSize,
    })
    const quality = predictBalance(seed.home, seed.away)

    /* -- Insert the match as the user, so RLS authorises it ---------------- */
    const { data: match, error: insertError } = await supabase
      .from("matches")
      .insert({
        booking_id: body.bookingId ?? null,
        pitch_id: pitchId,
        venue_id: venueId,
        format: body.format,
        status: "scheduled",
        kickoff_at: body.kickoffAt,
        duration_minutes: body.durationMinutes,
        home_team_id: body.homeTeamId ?? null,
        away_team_id: body.awayTeamId ?? null,
        is_ranked: body.isRanked,
        created_by: session.user.id,
      })
      .select("*")
      .single()

    if (insertError) throw insertError

    /* -- Auto-enrol the creator ------------------------------------------- */
    // `is_confirmed` must start false: `match_participants_insert_self_or_organiser`
    // enforces that a player confirms their own attendance and nobody confirms
    // it for them.
    const { data: participant, error: participantError } = await supabase
      .from("match_participants")
      .insert({
        match_id: match.id,
        player_id: session.user.id,
        team_side: body.creatorSide,
        is_confirmed: false,
      })
      .select("*")
      .single()

    if (participantError) {
      // A match nobody is in is worse than no match: it would sit in the
      // discovery list advertising a game with no organiser. Roll it back with
      // the admin client, which is not bound by the "booking_id is null" limit
      // on the user-facing DELETE policy.
      await admin.from("matches").delete().eq("id", match.id)
      throw participantError
    }

    /* -- Persist the predicted balance ------------------------------------ */
    const { data: updated, error: updateError } = await admin
      .from("matches")
      .update({
        match_quality: quality.quality,
        predicted_draw_probability: quality.drawProbability,
      })
      .eq("id", match.id)
      .select("*")
      .single()

    // A failure here loses a prediction, not a match. Log it and answer with the
    // row we already have rather than 500-ing over a cosmetic column.
    if (updateError) {
      console.error("[api/matches] failed to store predicted balance", {
        matchId: match.id,
        code: updateError.code,
      })
    }

    return ok<CreateMatchResult>(
      {
        match: updated ?? match,
        participant,
        quality,
        teamSize,
        spotsRemaining: teamSize * 2 - 1,
      },
      { status: 201 },
    )
  })
}

/* ========================================================================== */
/*  GET — discovery list                                                      */
/* ========================================================================== */

export async function GET(request: Request): Promise<Response> {
  return handleRoute<MatchListResult>(async () => {
    const session = await getSessionUser()
    if (!session) {
      throw new ApiRouteError(API_ERROR_CODES.UNAUTHENTICATED, "Maçlara göz atmak için giriş yap.", 401)
    }

    const url = new URL(request.url)
    const query = matchListQuerySchema.parse(Object.fromEntries(url.searchParams))

    const admin = createAdminClient()

    // The window defaults to "from now", which is what makes this a discovery
    // list rather than an archive — a finished match is not something to join.
    const from = query.from ?? new Date().toISOString()

    let builder = admin
      .from("matches")
      .select(
        "id, kickoff_at, duration_minutes, format, status, is_ranked, venue_id, pitch_id, match_quality, predicted_draw_probability",
      )
      .neq("status", "cancelled")
      .gte("kickoff_at", from)
      .order("kickoff_at", { ascending: true })
      // City and spare capacity are applied after the fact, so over-fetch;
      // the cap keeps the worst case bounded.
      .limit(Math.min(500, (query.limit + query.offset) * 4 + 50))

    if (query.to) builder = builder.lte("kickoff_at", query.to)
    if (query.format) builder = builder.eq("format", query.format)
    if (query.status) builder = builder.eq("status", query.status)
    else if (query.openOnly) builder = builder.eq("status", "scheduled")

    const { data: rows, error } = await builder
    if (error) throw error

    const matches = rows ?? []
    if (matches.length === 0) {
      return ok<MatchListResult>({ matches: [], limit: query.limit, offset: query.offset })
    }

    /* -- Two bounded companion queries; never a per-row lookup ------------- */
    const venueIds = unique(matches.map((m) => m.venue_id))
    const matchIds = matches.map((m) => m.id)

    const venues = new Map<string, { name: string; city: string | null }>()
    if (venueIds.length > 0) {
      const { data: venueRows, error: venueError } = await admin
        .from("venues")
        .select("id, name, city")
        .in("id", venueIds)
      if (venueError) throw venueError
      for (const venue of venueRows ?? []) {
        venues.set(venue.id, { name: venue.name, city: venue.city })
      }
    }

    const { data: participantRows, error: participantError } = await admin
      .from("match_participants")
      .select("match_id, team_side")
      .in("match_id", matchIds)
    if (participantError) throw participantError

    const counts = new Map<string, { home: number; away: number }>()
    for (const row of participantRows ?? []) {
      const entry = counts.get(row.match_id) ?? { home: 0, away: 0 }
      if (row.team_side === "home") entry.home += 1
      else entry.away += 1
      counts.set(row.match_id, entry)
    }

    const items: MatchListItem[] = matches.map((m) => {
      const venue = m.venue_id ? venues.get(m.venue_id) : undefined
      const count = counts.get(m.id) ?? { home: 0, away: 0 }
      const teamSize = FORMAT_TEAM_SIZE[m.format]
      const total = count.home + count.away
      return {
        id: m.id,
        kickoffAt: m.kickoff_at,
        durationMinutes: m.duration_minutes,
        format: m.format,
        status: m.status,
        isRanked: m.is_ranked,
        venueId: m.venue_id,
        venueName: venue?.name ?? null,
        city: venue?.city ?? null,
        pitchId: m.pitch_id,
        teamSize,
        participantCount: total,
        homeCount: count.home,
        awayCount: count.away,
        spotsRemaining: Math.max(0, teamSize * 2 - total),
        matchQuality: m.match_quality,
        predictedDrawProbability: m.predicted_draw_probability,
      }
    })

    const filtered = items
      .filter((item) => (query.city ? matchesCity(item.city, query.city) : true))
      .filter((item) => (query.openOnly ? item.spotsRemaining > 0 : true))

    return ok<MatchListResult>({
      matches: filtered.slice(query.offset, query.offset + query.limit),
      limit: query.limit,
      offset: query.offset,
    })
  })
}

/* ========================================================================== */
/*  Helpers (module-private — Next.js rejects unknown exports from a route)    */
/* ========================================================================== */

/**
 * Seed ratings for the two sides of a brand-new match.
 *
 * When the organiser named teams, the active rosters of those teams are the best
 * available forecast of who will turn up. Otherwise the only known player is the
 * creator. Either way both sides are padded to the format size with fresh-player
 * priors, so the stored quality answers "how even is this fixture likely to be
 * once it fills?" rather than "how even is one person against nobody?" — which
 * is the question a discovery list is actually asking.
 *
 * Reads through the service-role client: `player_ratings` is world-readable to
 * authenticated users, but the caller may not be able to see the `team_members`
 * rows of a team they are not in.
 */
async function collectSeedRatings(
  admin: ReturnType<typeof createAdminClient>,
  input: {
    creatorId: string
    creatorSide: "home" | "away"
    homeTeamId: string | null
    awayTeamId: string | null
    teamSize: number
  },
): Promise<{ home: Rating[]; away: Rating[] }> {
  const homeIds = new Set<string>()
  const awayIds = new Set<string>()

  if (input.creatorSide === "home") homeIds.add(input.creatorId)
  else awayIds.add(input.creatorId)

  const teamIds = [input.homeTeamId, input.awayTeamId].filter((id): id is string => Boolean(id))

  if (teamIds.length > 0) {
    const { data, error } = await admin
      .from("team_members")
      .select("team_id, player_id")
      .in("team_id", teamIds)
      .is("left_at", null)
    if (error) throw error

    for (const row of data ?? []) {
      if (row.team_id === input.homeTeamId) homeIds.add(row.player_id)
      else if (row.team_id === input.awayTeamId) awayIds.add(row.player_id)
    }
  }

  const homeList = [...homeIds].slice(0, input.teamSize)
  const awayList = [...awayIds].slice(0, input.teamSize)
  const ratings = await loadRatings(admin, [...homeList, ...awayList])

  // Pad both sides to the full format size with the fresh-player prior so the
  // stored quality describes the fixture once it fills.
  return {
    home: padded(ratingsFor(homeList, ratings), input.teamSize),
    away: padded(ratingsFor(awayList, ratings), input.teamSize),
  }
}

/** Fill a side out to `size` with the prior, so quality is comparable across matches. */
function padded(side: Rating[], size: number): Rating[] {
  const out = [...side]
  const prior = defaultRating()
  while (out.length < size) out.push(prior)
  return out
}

function unique<T>(values: readonly (T | null | undefined)[]): T[] {
  const seen = new Set<T>()
  for (const value of values) {
    if (value === null || value === undefined) continue
    seen.add(value)
  }
  return [...seen]
}

/** Case-insensitive city compare using Turkish casing rules (dotted/dotless i). */
function matchesCity(city: string | null, wanted: string): boolean {
  if (!city) return false
  return city.trim().toLocaleLowerCase("tr") === wanted.trim().toLocaleLowerCase("tr")
}
