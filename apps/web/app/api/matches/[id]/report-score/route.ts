/**
 * app/api/matches/[id]/report-score/route.ts
 *
 *   POST /api/matches/[id]/report-score
 *
 * File one score report and run the pipeline that may follow from it.
 *
 * ── The handler does not adjudicate anything ────────────────────────────────
 * All of the anti-griefing logic lives in `public.validate_score_report()`, the
 * BEFORE INSERT trigger from 0005: participation, match state, kickoff, 48h
 * window, scoreline plausibility, client-clock sanity, per-reporter rate limit.
 * Reimplementing any of it here would create a second copy that drifts, and
 * would still be bypassable by anything writing to the table directly.
 *
 * So the insert goes through the USER's client and the trigger's SQLSTATEs are
 * the error contract. They arrive as `PT403 / PT404 / PT409 / PT422 / PT429`
 * with messages written to be read by a player, and `mapDatabaseError()` turns
 * them into the matching `ApiResponse` error rather than letting
 * `handleRoute()` flatten them into a 500.
 *
 * ── Why `evaluate_score_consensus` is called conditionally ──────────────────
 * 0005 also installs an AFTER INSERT trigger (`trg_score_reports_evaluate`) that
 * already runs the corroboration pass inside the writing transaction. Calling
 * it unconditionally a second time would insert a DUPLICATE `rule_engine` row
 * into `match_anomaly_flags` on the contested path, because that insert happens
 * before the "is a round already open?" check.
 *
 * So it is called only when the match is still UNDECIDED after the insert. That
 * covers the 24h accept-by-default deadline, and it means a deployment where the
 * AFTER trigger was dropped still converges — without doubling up side effects
 * on the normal path.
 *
 * ── Order of operations, and why it matters ─────────────────────────────────
 *   1. insert          the report itself
 *   2. evaluate        corroboration -> finalize / wait / open a consensus round
 *   3. anomaly check   the Isolation Forest sidecar, best-effort
 *   4. apply ratings   ONLY if still finalized and consensus-free
 *
 * Step 3 sits before step 4 deliberately: `record_anomaly_verdict` can push a
 * match into `requires_consensus` even when the two reports agreed, which is
 * precisely the colluding-parties case the detector exists to catch. Rating a
 * match before hearing from it would defeat the whole mechanism. Step 3 is
 * best-effort in the other direction too — a down ML service must never block a
 * finalisation, so its failure is logged and ignored.
 */

import { createRouteClient } from "@/lib/supabase/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { getSessionUser } from "@/lib/rbac"
import { enforceRateLimit } from "@/lib/rate-limit"
import { ApiRouteError, handleRoute, ok } from "@/lib/api-response"
import { assertConsented, callRpc, throwDatabaseError } from "@/lib/matchmaking"
import {
  API_ERROR_CODES,
  reportScoreSchema,
  type ReportScoreResult,
  type ScoreVerdict,
} from "@halisaha/shared/domain"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** How long the anomaly bridge gets before we give up and finalise without it. */
const ANOMALY_CALL_TIMEOUT_MS = 3000

interface MatchState {
  status: string
  requires_consensus: boolean
  score_confirmed_at: string | null
  is_ranked: boolean
  rating_applied_at: string | null
  home_score: number | null
  away_score: number | null
}

export async function POST(
  request: Request,
  context: { params: { id: string } },
): Promise<Response> {
  return handleRoute<ReportScoreResult>(async () => {
    const matchId = context.params.id

    const limited = await enforceRateLimit("score_report")
    if (limited) return limited

    const session = await getSessionUser()
    if (!session) {
      throw new ApiRouteError(
        API_ERROR_CODES.UNAUTHENTICATED,
        "Skor bildirmek için giriş yap.",
        401,
      )
    }
    assertConsented(session.profile)

    const body = reportScoreSchema.parse(await request.json())

    // `createRouteClient` — not `createClient` — because the Expo app has no cookie jar and
    // authenticates with `Authorization: Bearer <access token>`. A cookie-only client would run
    // the `score_reports` INSERT below as `anon` with auth.uid() null for a mobile caller, and
    // RLS would refuse it. Still the caller's own, RLS-scoped client either way.
    const supabase = await createRouteClient(request)
    const admin = createAdminClient()

    /* -- 1. Insert the report; the trigger is the referee ------------------ */
    // `team_side` is passed through as given: the trigger overwrites it with the
    // reporter's actual side, and raises PT422 if the two disagree. `payload_hash`
    // and `ip_hash` are withheld from the INSERT grant on purpose — a hash the
    // client chose proves nothing, so the trigger computes its own.
    const { error: insertError } = await supabase.from("score_reports").insert({
      match_id: matchId,
      reported_by: session.user.id,
      team_side: body.teamSide ?? null,
      home_score: body.homeScore,
      away_score: body.awayScore,
      client_reported_at: body.clientReportedAt,
    })

    if (insertError) {
      throwDatabaseError(insertError, {
        duplicateMessage:
          "You have already reported a score for this match. Reports cannot be edited — they are the evidence a disagreement is judged on.",
      })
    }

    /* -- 2. Corroboration pass, when the AFTER trigger left it open -------- */
    let match = await readMatchState(admin, matchId)

    if (isUndecided(match)) {
      await callRpc(
        admin,
        "evaluate_score_consensus",
        { p_match_id: matchId },
        { fallbackMessage: "That score could not be reconciled with the other reports." },
      )
      match = await readMatchState(admin, matchId)
    }

    /* -- 3. Anomaly check — advisory, never blocking ----------------------- */
    await fireAnomalyCheck(request, matchId)
    match = await readMatchState(admin, matchId)

    /* -- 4. Ratings, if the result really did settle ----------------------- */
    // `evaluate_score_consensus` already calls `private.apply_rating_once` when
    // it finalises, so on the happy path `rating_applied_at` is set and this is
    // skipped. The call is kept for the cases the corroboration pass does not
    // cover — an admin-confirmed score, or a finalisation that raced a retry —
    // and `apply_match_rating` is itself idempotent, returning 0 for a match it
    // has already rated.
    if (
      isFinalized(match) &&
      !match.requires_consensus &&
      match.is_ranked &&
      match.rating_applied_at === null
    ) {
      try {
        await callRpc(admin, "apply_match_rating", { p_match_id: matchId })
      } catch (error) {
        // A rating that cannot be applied yet is not a failed report. The nightly
        // sweep and the `trueskill-update` Edge Function both retry.
        console.error("[api/matches/report-score] apply_match_rating deferred", {
          matchId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    /* -- 5. Answer -------------------------------------------------------- */
    const reports = await summariseReports(admin, matchId)

    return ok<ReportScoreResult>(
      {
        verdict: verdictFor(match),
        variance: reports.variance,
        reportsCount: reports.count,
        requiresConsensus: match.requires_consensus,
      },
      { status: 201 },
    )
  })
}

/* ========================================================================== */
/*  Match state                                                               */
/* ========================================================================== */

async function readMatchState(
  admin: ReturnType<typeof createAdminClient>,
  matchId: string,
): Promise<MatchState> {
  const { data, error } = await admin
    .from("matches")
    .select(
      "status, requires_consensus, score_confirmed_at, is_ranked, rating_applied_at, home_score, away_score",
    )
    .eq("id", matchId)
    .maybeSingle()

  if (error) throw error
  if (!data) {
    throw new ApiRouteError(API_ERROR_CODES.NOT_FOUND, "Böyle bir maç yok.", 404)
  }
  return data
}

function isFinalized(match: MatchState): boolean {
  return match.status === "finalized" || match.score_confirmed_at !== null
}

/** Still open for scoring and not yet in a consensus round. */
function isUndecided(match: MatchState): boolean {
  return !isFinalized(match) && !match.requires_consensus && match.status !== "cancelled"
}

function verdictFor(match: MatchState): ScoreVerdict {
  if (isFinalized(match)) return "finalized"
  if (match.requires_consensus || match.status === "requires_consensus" || match.status === "disputed") {
    return "requires_consensus"
  }
  return "awaiting_opponent"
}

/**
 * Report count and score variance for the match.
 *
 * Computed here rather than taken from `evaluate_score_consensus`'s descriptor
 * because that RPC is now called conditionally — and because it must be
 * reported even when the AFTER trigger already settled everything. The formula
 * is deliberately the same one the SQL uses: `var_pop(home_score) +
 * var_pop(away_score)`, i.e. POPULATION variance (divide by n, not n-1), summed
 * over both columns. A single report therefore has variance 0, not undefined.
 */
async function summariseReports(
  admin: ReturnType<typeof createAdminClient>,
  matchId: string,
): Promise<{ count: number; variance: number }> {
  const { data, error } = await admin
    .from("score_reports")
    .select("home_score, away_score")
    .eq("match_id", matchId)

  if (error) throw error

  const rows = data ?? []
  if (rows.length === 0) return { count: 0, variance: 0 }

  const variance =
    populationVariance(rows.map((r) => r.home_score)) +
    populationVariance(rows.map((r) => r.away_score))

  return { count: rows.length, variance: round(variance, 6) }
}

function populationVariance(values: readonly number[]): number {
  if (values.length === 0) return 0
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length
  return values.reduce((sum, v) => sum + (v - mean) * (v - mean), 0) / values.length
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/* ========================================================================== */
/*  The anomaly bridge                                                        */
/* ========================================================================== */

/**
 * Ask `/api/internal/anomaly/check` to score this match.
 *
 * Called over HTTP against this deployment's own origin rather than by importing
 * the handler, because a Next.js `route.ts` may only export HTTP verbs and route
 * config — anything else is rejected by the framework's route type check. The
 * internal route is not public: it demands `INTERNAL_API_TOKEN`, which only the
 * server holds.
 *
 * EVERY failure mode is swallowed:
 *   * no token configured (a dev machine without the sidecar wired up),
 *   * the route answering non-2xx,
 *   * the request timing out.
 *
 * The `anomaly-sweep` Edge Function re-scores anything that was missed —
 * `matches_pending_anomaly_check()` returns matches whose reports changed since
 * the last pass — so nothing is lost, it is only delayed. A match must never
 * fail to finalise because an ML service is down.
 */
async function fireAnomalyCheck(request: Request, matchId: string): Promise<void> {
  const token = process.env.INTERNAL_API_TOKEN
  if (!token) {
    console.warn("[api/matches/report-score] INTERNAL_API_TOKEN unset; anomaly check deferred", {
      matchId,
    })
    return
  }

  try {
    const url = new URL("/api/internal/anomaly/check", request.url)
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ matchId }),
      cache: "no-store",
      signal: AbortSignal.timeout(ANOMALY_CALL_TIMEOUT_MS),
    })

    if (!response.ok) {
      console.error("[api/matches/report-score] anomaly check returned non-2xx", {
        matchId,
        status: response.status,
      })
    }
  } catch (error) {
    console.error("[api/matches/report-score] anomaly check unreachable", {
      matchId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
