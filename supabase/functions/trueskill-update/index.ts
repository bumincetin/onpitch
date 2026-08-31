/// <reference types="https://esm.sh/@supabase/functions-js@2/src/edge-runtime.d.ts" />

/**
 * supabase/functions/trueskill-update/index.ts
 *
 *   POST /functions/v1/trueskill-update   { "matchId": "<uuid>" }
 *
 * Applies the TrueSkill 2 update for one match and answers with the per-player
 * deltas.
 *
 * ── Deploy ──────────────────────────────────────────────────────────────────
 *     supabase functions deploy trueskill-update
 *     supabase functions serve trueskill-update --no-verify-jwt      # local only
 *
 * Required secrets: none beyond the platform-injected `SUPABASE_URL`,
 * `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY`. Set `INTERNAL_API_TOKEN`
 * as well if you want the Next.js app to be able to call it:
 *
 *     supabase secrets set INTERNAL_API_TOKEN=<same value as the app>
 *
 * Do NOT deploy with `--no-verify-jwt` in production: this function accepts a
 * user JWT, and platform-level verification is the cheap first gate.
 *
 * ── Why this exists when a route handler could do it ────────────────────────
 * It is callable from `pg_cron` / a Supabase scheduled function with the
 * service-role key and no Next.js deployment in the path, which keeps rating
 * application working during an app deploy. It is also the manual lever in the
 * runbook ("ratings unchanged after a match"): one call, one match, an explicit
 * answer about what happened.
 *
 * ── Authorisation ───────────────────────────────────────────────────────────
 * `public.apply_match_rating` is granted to `service_role` only, so the RPC has
 * to run on the service client. That means this function has to do the
 * authorisation itself rather than leaning on RLS, and it does it explicitly:
 *
 *   * service-role key or `INTERNAL_API_TOKEN`  -> allowed (a trusted server);
 *   * a user JWT                                -> allowed only for the match
 *     organiser, the owner of the hosting venue, or a platform admin. That is
 *     the same set `private.can_manage_match()` defines in 0002, restated here
 *     because `private` is not reachable through PostgREST.
 *
 * A plain participant is deliberately not allowed: applying ratings is an
 * organiser action, and the pipeline applies them automatically anyway.
 *
 * ── Idempotency ─────────────────────────────────────────────────────────────
 * `apply_match_rating` row-locks the match and returns 0 without touching
 * anything when `rating_applied_at` is already set, so a retry, a double-click
 * and a cron overlap are all no-ops. The response says which happened.
 */

import { EdgeError, handleEdge, jsonOk } from "../_shared/cors.ts"
import {
  createServiceClient,
  identifyCaller,
  readJson,
  requireUuid,
  toEdgeError,
  type PostgrestLikeError,
} from "../_shared/supabase.ts"

interface PlayerDelta {
  playerId: string
  muBefore: number | null
  sigmaBefore: number | null
  muAfter: number | null
  sigmaAfter: number | null
  /** `mu_after - mu_before`, the GENERATED column on `player_stats`. */
  ratingDelta: number | null
  teamSide: string | null
}

Deno.serve((request: Request) =>
  handleEdge(request, async () => {
    if (request.method !== "POST") {
      throw new EdgeError("VALIDATION_FAILED", "Use POST.", 405)
    }

    const body = await readJson(request)
    const matchId = requireUuid(body, "matchId")

    const caller = await identifyCaller(request)
    const service = createServiceClient()

    /* -- 1. Authorise ------------------------------------------------------ */
    const match = await loadMatch(service, matchId)

    if (!caller.isServiceRole && !caller.isInternal) {
      if (!caller.userId) {
        throw new EdgeError(
          "UNAUTHENTICATED",
          "Sign in, or call this function with the service-role key.",
          401,
        )
      }
      await assertCanManageMatch(service, match, caller.userId)
    }

    /* -- 2. Apply ---------------------------------------------------------- */
    const alreadyApplied = match.rating_applied_at !== null

    let playersRated = 0
    if (!alreadyApplied) {
      const { data, error } = await service.rpc("apply_match_rating", { p_match_id: matchId })

      if (error) throw translateApplyError(error as PostgrestLikeError)

      // The SQL returns `integer` (players rated). The hand-written
      // `types/database.ts` currently declares `boolean`; the SQL is what runs.
      // Anything that is not a number is reported as 0 and the `deltas` array
      // below — read straight from `player_stats` — is the authoritative answer.
      playersRated = typeof data === "number" ? data : 0
    }

    /* -- 3. Report the deltas ---------------------------------------------- */
    // `player_stats` is where `apply_match_rating` folds the before/after
    // snapshot, so it is the authoritative record of what the update did — more
    // useful than echoing the RPC's row count, and it also answers correctly for
    // a match that had already been rated.
    const { data: statRows, error: statsError } = await service
      .from("player_stats")
      .select("player_id, team_side, mu_before, sigma_before, mu_after, sigma_after, rating_delta")
      .eq("match_id", matchId)
      .order("player_id", { ascending: true })

    if (statsError) throw toEdgeError(statsError, "Could not read the rating deltas.")

    const deltas: PlayerDelta[] = (statRows ?? []).map((row: Record<string, unknown>) => ({
      playerId: String(row.player_id),
      muBefore: numberOrNull(row.mu_before),
      sigmaBefore: numberOrNull(row.sigma_before),
      muAfter: numberOrNull(row.mu_after),
      sigmaAfter: numberOrNull(row.sigma_after),
      ratingDelta: numberOrNull(row.rating_delta),
      teamSide: typeof row.team_side === "string" ? row.team_side : null,
    }))

    const after = await loadMatch(service, matchId)

    return jsonOk({
      matchId,
      alreadyApplied,
      playersRated: alreadyApplied ? 0 : playersRated,
      ratingAppliedAt: after.rating_applied_at,
      status: after.status,
      homeScore: after.home_score,
      awayScore: after.away_score,
      deltas,
    })
  }),
)

/* ========================================================================== */
/*  Helpers                                                                   */
/* ========================================================================== */

interface MatchRow {
  id: string
  status: string
  is_ranked: boolean
  requires_consensus: boolean
  rating_applied_at: string | null
  score_confirmed_at: string | null
  home_score: number | null
  away_score: number | null
  created_by: string | null
  venue_id: string | null
  pitch_id: string | null
}

async function loadMatch(
  service: ReturnType<typeof createServiceClient>,
  matchId: string,
): Promise<MatchRow> {
  const { data, error } = await service
    .from("matches")
    .select(
      "id, status, is_ranked, requires_consensus, rating_applied_at, score_confirmed_at, home_score, away_score, created_by, venue_id, pitch_id",
    )
    .eq("id", matchId)
    .maybeSingle()

  if (error) throw toEdgeError(error, "Could not read that match.")
  if (!data) throw new EdgeError("NOT_FOUND", "That match does not exist.", 404)
  return data as unknown as MatchRow
}

/**
 * Restates `private.can_manage_match()`: the organiser, the owner of the venue
 * (directly, or via the pitch), or a platform admin.
 */
async function assertCanManageMatch(
  service: ReturnType<typeof createServiceClient>,
  match: MatchRow,
  userId: string,
): Promise<void> {
  if (match.created_by === userId) return

  const { data: profile, error: profileError } = await service
    .from("profiles")
    .select("role, deleted_at")
    .eq("id", userId)
    .maybeSingle()

  if (profileError) throw toEdgeError(profileError, "Could not verify your account.")
  if (profile && profile.role === "admin" && profile.deleted_at === null) return

  if (match.venue_id) {
    const { data: venue, error: venueError } = await service
      .from("venues")
      .select("owner_id")
      .eq("id", match.venue_id)
      .maybeSingle()
    if (venueError) throw toEdgeError(venueError, "Could not verify venue ownership.")
    if (venue && venue.owner_id === userId) return
  }

  if (match.pitch_id) {
    const { data: pitch, error: pitchError } = await service
      .from("pitches")
      .select("venue_id, venues(owner_id)")
      .eq("id", match.pitch_id)
      .maybeSingle()
    if (pitchError) throw toEdgeError(pitchError, "Could not verify pitch ownership.")
    const embedded = (pitch as Record<string, unknown> | null)?.venues
    const owner = Array.isArray(embedded) ? embedded[0] : embedded
    if (owner && (owner as Record<string, unknown>).owner_id === userId) return
  }

  throw new EdgeError(
    "FORBIDDEN",
    "Only the organiser, the hosting venue or an administrator can apply ratings for this match.",
    403,
  )
}

/**
 * `apply_match_rating` guards with SQLSTATE `22023`, whose messages name internal
 * function arguments. They are not forwarded; the state that caused them is
 * re-derived into something a human can act on.
 */
function translateApplyError(error: PostgrestLikeError): EdgeError {
  if (error.code === "22023") {
    const message = error.message ?? ""
    if (message.includes("requires consensus")) {
      return new EdgeError(
        "CONFLICT",
        "This match is still in a consensus round. Resolve the vote before applying ratings.",
        409,
      )
    }
    if (message.includes("not ranked")) {
      return new EdgeError("CONFLICT", "This match is unranked, so it has no ratings to apply.", 409)
    }
    if (message.includes("no recorded score")) {
      return new EdgeError("CONFLICT", "This match has no confirmed score yet.", 409)
    }
    if (message.includes("participants")) {
      return new EdgeError(
        "CONFLICT",
        "This match needs players on both sides before it can be rated.",
        409,
      )
    }
    return new EdgeError("CONFLICT", "This match is not in a state that can be rated.", 409)
  }

  if (error.code === "P0002") {
    return new EdgeError("NOT_FOUND", "That match does not exist.", 404)
  }

  return toEdgeError(error, "The rating update could not be applied.")
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}
