/**
 * app/api/matches/[id]/join/route.ts
 *
 *   POST /api/matches/[id]/join
 *
 * Adds the caller to an open match on whichever side keeps the fixture even.
 *
 * ── Trust boundaries ────────────────────────────────────────────────────────
 * The participant row is inserted with the USER's client, so
 * `match_participants_insert_self_or_organiser` is what authorises it: you may
 * insert yourself, with `is_confirmed = false`, and nothing else. That policy is
 * the real guard — everything this handler does around it is either a
 * pre-flight check that produces a better error message, or something RLS
 * cannot express at all.
 *
 * Match row itself is READ with the service-role client, because
 * `matches_select_involved` hides it from anybody not already in it — and
 * somebody joining a match is, by definition, not yet in it. The handler only
 * exposes what it needs to and refuses to touch matches that are not open.
 *
 * `match_quality` / `predicted_draw_probability` are refreshed with the
 * service-role client for the same reason as in `POST /api/matches`: they are
 * not in the `authenticated` UPDATE grant, and a joiner is not the organiser, so
 * they could not write them even if they were.
 *
 * ── The capacity race ───────────────────────────────────────────────────────
 * There is no exclusion constraint for "at most 2*teamSize participants" — the
 * schema has one for double-booked pitches, not for roster size — so two
 * simultaneous joiners can both pass a pre-check. Rather than pretend otherwise,
 * this handler inserts and then RE-COUNTS: if the row it just wrote turns out to
 * be over the line, it deletes its own row and answers 409. That is a
 * compensating action, not a lock, and it is honest about it: the loser of the
 * race is told the match filled up, which is exactly what happened.
 */

import { createRouteClient } from "@/lib/supabase/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { getSessionUser } from "@/lib/rbac"
import { ApiRouteError, handleRoute, ok } from "@/lib/api-response"
import {
  FORMAT_TEAM_SIZE,
  assertConsented,
  chooseSideForJoin,
  loadRatings,
  predictBalance,
  ratingsFor,
  defaultRating,
  type Rating,
} from "@/lib/matchmaking"
import { API_ERROR_CODES, joinMatchSchema, type MatchQuality, type TeamSide } from "@onpitch/shared/domain"
import type { Tables } from "@onpitch/shared/database"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

interface JoinMatchResult {
  matchId: string
  teamSide: TeamSide
  participant: Tables<"match_participants">
  /** Why that side: quality of the fixture with the joiner on each option. */
  qualityIfHome: number
  qualityIfAway: number
  quality: MatchQuality
  teamSize: number
  homeCount: number
  awayCount: number
  spotsRemaining: number
}

/** Statuses that still accept new players. Everything else has kicked off or is done. */
const JOINABLE_STATUSES: ReadonlySet<string> = new Set(["scheduled"])

export async function POST(
  request: Request,
  context: { params: { id: string } },
): Promise<Response> {
  return handleRoute<JoinMatchResult>(async () => {
    const matchId = context.params.id

    const session = await getSessionUser()
    if (!session) {
      throw new ApiRouteError(API_ERROR_CODES.UNAUTHENTICATED, "Maça katılmak için giriş yap.", 401)
    }
    assertConsented(session.profile)

    const body = joinMatchSchema.parse(await readJsonBody(request))

    // `createRouteClient` — not `createClient` — because the Expo app has no cookie jar and
    // authenticates with `Authorization: Bearer <access token>`. A cookie-only client would run
    // the INSERT below as `anon` with auth.uid() null for a mobile caller, and
    // `match_participants_insert_self_or_organiser` would refuse it. Still the caller's own,
    // RLS-scoped client either way.
    const supabase = await createRouteClient(request)
    const admin = createAdminClient()

    /* -- 1. Load the match ------------------------------------------------- */
    const { data: match, error: matchError } = await admin
      .from("matches")
      .select("id, status, format, kickoff_at, is_ranked, home_team_id, away_team_id")
      .eq("id", matchId)
      .maybeSingle()

    if (matchError) throw matchError
    if (!match) {
      throw new ApiRouteError(API_ERROR_CODES.NOT_FOUND, "Böyle bir maç yok.", 404)
    }

    if (!JOINABLE_STATUSES.has(match.status)) {
      throw new ApiRouteError(
        API_ERROR_CODES.VALIDATION_FAILED,
        match.status === "cancelled"
          ? "That match was cancelled."
          : "That match is no longer accepting players.",
        409,
      )
    }

    if (Date.parse(match.kickoff_at) <= Date.now()) {
      throw new ApiRouteError(
        API_ERROR_CODES.VALIDATION_FAILED,
        "Bu maç çoktan başladı.",
        409,
      )
    }

    /* -- 2. Current line-up ------------------------------------------------ */
    const teamSize = FORMAT_TEAM_SIZE[match.format]
    const lineup = await loadLineup(admin, matchId)

    if (lineup.all.some((p) => p.playerId === session.user.id)) {
      throw new ApiRouteError(
        API_ERROR_CODES.VALIDATION_FAILED,
        "Bu maçın kadrosunda zaten varsın.",
        409,
      )
    }

    if (lineup.all.length >= teamSize * 2) {
      throw new ApiRouteError(API_ERROR_CODES.VALIDATION_FAILED, "Bu maç dolu.", 409)
    }

    /* -- 3. Pick a side ---------------------------------------------------- */
    const playerIds = lineup.all.map((p) => p.playerId)
    const ratings = await loadRatings(admin, [...playerIds, session.user.id])
    const joinerRating: Rating = ratings.get(session.user.id) ?? defaultRating()

    const homeRatings = ratingsFor(lineup.home, ratings)
    const awayRatings = ratingsFor(lineup.away, ratings)

    const suggestion = chooseSideForJoin(homeRatings, awayRatings, joinerRating, { teamSize })

    // An explicit request is honoured whenever that side has room. People join
    // matches to play with their friends, and overriding that to gain 0.01 of
    // predicted quality is the kind of cleverness that loses users.
    let teamSide: TeamSide = suggestion.side
    if (body.teamSide) {
      const requestedCount = body.teamSide === "home" ? lineup.home.length : lineup.away.length
      if (requestedCount >= teamSize) {
        throw new ApiRouteError(
          API_ERROR_CODES.VALIDATION_FAILED,
          `The ${body.teamSide} side is already full. Leave the side out and we will place you.`,
          409,
        )
      }
      teamSide = body.teamSide
    }

    /* -- 4. Insert as the user: RLS is the authorisation ------------------- */
    const { data: participant, error: insertError } = await supabase
      .from("match_participants")
      .insert({
        match_id: matchId,
        player_id: session.user.id,
        team_side: teamSide,
        is_confirmed: false,
      })
      .select("*")
      .single()

    if (insertError) {
      // 23505 = match_participants_unique. Somebody double-clicked, or two tabs
      // raced; either way they are on the sheet, which is what they wanted.
      if (insertError.code === "23505") {
        throw new ApiRouteError(
          API_ERROR_CODES.VALIDATION_FAILED,
          "Bu maçın kadrosunda zaten varsın.",
          409,
        )
      }
      throw insertError
    }

    /* -- 5. Compensating capacity check ------------------------------------ */
    const after = await loadLineup(admin, matchId)
    if (after.all.length > teamSize * 2) {
      // The roster is read in a total, stable order (joined_at, then player_id),
      // so every racing request computes the SAME surplus tail. Each one then
      // withdraws only its own row if it finds itself in that tail — nobody ever
      // deletes somebody else's place, and the person who genuinely arrived last
      // is the one who loses.
      const surplus = after.all.slice(teamSize * 2).map((p) => p.playerId)
      if (surplus.includes(session.user.id)) {
        await supabase
          .from("match_participants")
          .delete()
          .eq("match_id", matchId)
          .eq("player_id", session.user.id)

        throw new ApiRouteError(
          API_ERROR_CODES.VALIDATION_FAILED,
          "Sen katılırken bu maç doldu. Başka bir maç dene.",
          409,
        )
      }
    }

    /* -- 6. Refresh the stored balance ------------------------------------- */
    // `ratings` already covers the joiner; anybody without a `player_ratings`
    // row resolves to the same prior `ratingsFor` would use anyway.
    const finalHome = ratingsFor(after.home, ratings)
    const finalAway = ratingsFor(after.away, ratings)
    const quality = predictBalance(pad(finalHome, teamSize), pad(finalAway, teamSize))

    const { error: updateError } = await admin
      .from("matches")
      .update({
        match_quality: quality.quality,
        predicted_draw_probability: quality.drawProbability,
      })
      .eq("id", matchId)

    if (updateError) {
      console.error("[api/matches/join] failed to refresh predicted balance", {
        matchId,
        code: updateError.code,
      })
    }

    return ok<JoinMatchResult>(
      {
        matchId,
        teamSide,
        participant,
        qualityIfHome: suggestion.qualityIfHome,
        qualityIfAway: suggestion.qualityIfAway,
        quality,
        teamSize,
        homeCount: after.home.length,
        awayCount: after.away.length,
        spotsRemaining: Math.max(0, teamSize * 2 - after.all.length),
      },
      { status: 201 },
    )
  })
}

/* ========================================================================== */
/*  Helpers                                                                   */
/* ========================================================================== */

interface Lineup {
  home: string[]
  away: string[]
  all: Array<{ playerId: string; side: TeamSide }>
}

/**
 * The current team sheet, ordered by `joined_at` then `player_id` so the order
 * is total and identical on every read — which is what makes the compensating
 * capacity check in step 5 agree with itself across concurrent requests.
 */
async function loadLineup(
  admin: ReturnType<typeof createAdminClient>,
  matchId: string,
): Promise<Lineup> {
  const { data, error } = await admin
    .from("match_participants")
    .select("player_id, team_side, joined_at")
    .eq("match_id", matchId)
    .order("joined_at", { ascending: true })
    .order("player_id", { ascending: true })

  if (error) throw error

  const home: string[] = []
  const away: string[] = []
  const all: Array<{ playerId: string; side: TeamSide }> = []

  for (const row of data ?? []) {
    const side: TeamSide = row.team_side === "away" ? "away" : "home"
    all.push({ playerId: row.player_id, side })
    if (side === "home") home.push(row.player_id)
    else away.push(row.player_id)
  }

  return { home, away, all }
}

/** Pad a side to the format size with fresh-player priors. */
function pad(side: Rating[], size: number): Rating[] {
  const out = [...side]
  const prior = defaultRating()
  while (out.length < size) out.push(prior)
  return out
}

/**
 * `POST` with no body at all is a perfectly reasonable "just put me somewhere",
 * so an empty body parses to `{}` rather than 400-ing on invalid JSON.
 */
async function readJsonBody(request: Request): Promise<unknown> {
  const text = await request.text()
  if (text.trim().length === 0) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new ApiRouteError(
      API_ERROR_CODES.VALIDATION_FAILED,
      "İstek gövdesi geçerli JSON değildi.",
      400,
    )
  }
}
