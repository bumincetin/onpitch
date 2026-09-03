/**
 * app/api/internal/anomaly/check/route.ts
 *
 *   POST /api/internal/anomaly/check   { "matchId": "<uuid>" }
 *
 * The bridge between Postgres and the Python Isolation Forest sidecar.
 *
 *   anomaly_features(match_id)  ->  POST {ANOMALY_SERVICE_URL}/score  ->  record_anomaly_verdict()
 *
 * ── Not publicly callable ───────────────────────────────────────────────────
 * Guarded by `INTERNAL_API_TOKEN` (Bearer, or `X-Internal-Token`), compared with
 * `timingSafeEqual`. There is no user session involved: the feature vector is
 * cross-match behavioural intelligence — repeat-pairing counts, shared reporter
 * IP hashes, account ages — and `private.assert_integrity_reader()` in 0005
 * already refuses to hand it to anyone but an admin or a server-side caller.
 * Handing a player their own match's anomaly score would also hand them the
 * model's decision boundary, which is why 0002 keeps `match_anomaly_flags`
 * invisible to participants too.
 *
 * ── The fallback is the whole design ────────────────────────────────────────
 * The sidecar is ADVISORY. If it is unreachable, slow, non-2xx, or answers
 * something that does not parse, this route computes the deterministic
 * rule-engine verdict from the same feature vector and records it with
 * `source = 'rule_engine'`. That is not a degraded mode to be alarmed about —
 * it is the documented contract:
 *
 *     A MATCH MUST NEVER FAIL TO FINALISE BECAUSE AN ML SERVICE IS DOWN.
 *
 * `AnomalyVerdict.source` tells the caller which brain answered, and under the
 * fallback `leafDepth` / `averagePathLength` / `modelVersion` are null because
 * there was no forest to read them from. The sidecar has a matching honesty
 * rule of its own: with no trained artefact it labels itself
 * `rules-fallback-v1` rather than pretending.
 *
 * ── Score orientation ───────────────────────────────────────────────────────
 * `anomalyScore = 2^(-E[h(x)] / c(n))` in [0,1]. A SHORT average path length
 * means the point was easily isolated, which means anomalous, so HIGHER IS
 * WORSE. Crossing `public.anomaly_score_threshold()` (default 0.62) makes
 * `record_anomaly_verdict` open a peer-consensus round even when the reports
 * agreed — agreement between colluding parties is exactly what this catches.
 */

import { Buffer } from "node:buffer"
import { createHmac, timingSafeEqual } from "node:crypto"

import { createAdminClient } from "@/lib/supabase/admin"
import { ApiRouteError, handleRoute, ok } from "@/lib/api-response"
import { asRecord, callRpc } from "@/lib/matchmaking"
import {
  API_ERROR_CODES,
  anomalyCheckRequestSchema,
  anomalyFeatureVectorSchema,
  anomalyVerdictResponseSchema,
  type AnomalyFeatureVector,
  type AnomalyVerdict,
} from "@onpitch/shared/domain"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Hard deadline for the sidecar. Past this we fall back rather than wait. */
const SIDECAR_TIMEOUT_MS = 2500

/** Matches `public.anomaly_score_threshold()`'s default, used if the RPC fails. */
const DEFAULT_THRESHOLD = 0.62

/** Signature headers. Mirrored byte-for-byte in `services/anomaly/`. */
const SIGNATURE_HEADER = "X-OnPitch-Signature"
const TIMESTAMP_HEADER = "X-OnPitch-Timestamp"

export async function POST(request: Request): Promise<Response> {
  return handleRoute<AnomalyVerdict>(async () => {
    requireInternalToken(request)

    const body = anomalyCheckRequestSchema.parse(await request.json())
    const admin = createAdminClient()

    /* -- 1. Feature vector, straight from the database -------------------- */
    const rawFeatures = await callRpc(admin, "anomaly_features", { p_match_id: body.matchId })
    const featureRecord = asRecord(rawFeatures)
    if (!featureRecord) {
      throw new ApiRouteError(
        API_ERROR_CODES.NOT_FOUND,
        "Bu maç için öznitelik vektörü oluşturulamadı.",
        404,
      )
    }

    // Parsed, not asserted: the RPC is trusted, but a schema drift between
    // `match_anomaly_feature_row` and `AnomalyFeatureVector` should fail loudly
    // here rather than silently post garbage to the model.
    const features = anomalyFeatureVectorSchema.parse(toFeatureVector(featureRecord, body.matchId))
    const collusion: Record<string, unknown> = asRecord(featureRecord.collusion) ?? {}

    const threshold = await readThreshold(admin)

    /* -- 2. Ask the sidecar; fall back to the rule engine ------------------ */
    const scored = await scoreWithSidecar(features)

    const verdict: AnomalyVerdict = scored
      ? {
          matchId: body.matchId,
          source: "isolation_forest",
          anomalyScore: scored.anomalyScore,
          isAnomalous: scored.isAnomalous,
          leafDepth: scored.leafDepth,
          averagePathLength: scored.averagePathLength,
          modelVersion: scored.modelVersion,
          // The database is the authority on the cut-off, not the sidecar: the
          // service's own threshold is advisory and may be stale.
          threshold,
          reasons: scored.reasons,
        }
      : ruleEngineVerdict(body.matchId, features, collusion, threshold)

    /* -- 3. Persist ------------------------------------------------------- */
    // `record_anomaly_verdict` writes the flag, stamps `anomaly_checked_at`,
    // refreshes the collusion cache, and opens a consensus round when the score
    // crosses the threshold on a match that has not been confirmed yet.
    await callRpc(admin, "record_anomaly_verdict", {
      p_match_id: verdict.matchId,
      p_source: verdict.source,
      p_anomaly_score: verdict.anomalyScore,
      p_is_anomalous: verdict.isAnomalous,
      p_reasons: verdict.reasons,
      p_model_version: verdict.modelVersion,
      p_leaf_depth: verdict.leafDepth,
      p_average_path_length: verdict.averagePathLength,
    })

    return ok<AnomalyVerdict>(verdict)
  })
}

/* ========================================================================== */
/*  Authentication                                                            */
/* ========================================================================== */

/**
 * Constant-time comparison against `INTERNAL_API_TOKEN`.
 *
 * `timingSafeEqual` throws on unequal lengths, which would itself leak the
 * secret's length, so the lengths are compared first and a mismatch answers the
 * same generic 401 as a wrong token. A missing env var is a 503, not a 401 —
 * "the server is not configured" and "you are not allowed" are different facts
 * and conflating them makes the misconfiguration undebuggable.
 */
function requireInternalToken(request: Request): void {
  const expected = process.env.INTERNAL_API_TOKEN
  if (!expected) {
    console.error("[api/internal/anomaly] INTERNAL_API_TOKEN is not set; refusing all callers")
    throw new ApiRouteError(
      API_ERROR_CODES.INTERNAL,
      "Bu uç nokta yapılandırılmamış.",
      503,
    )
  }

  const header = request.headers.get("authorization")
  const bearer = header?.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : null
  const presented = bearer ?? request.headers.get("x-internal-token")

  if (!presented || !constantTimeEquals(presented, expected)) {
    throw new ApiRouteError(API_ERROR_CODES.FORBIDDEN, "Yetkin yok.", 401)
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8")
  const right = Buffer.from(b, "utf8")
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/* ========================================================================== */
/*  The sidecar call                                                          */
/* ========================================================================== */

interface SidecarVerdict {
  anomalyScore: number
  isAnomalous: boolean
  leafDepth: number | null
  averagePathLength: number | null
  modelVersion: string | null
  reasons: string[]
}

/**
 * Sign and POST the feature vector.
 *
 * Signature scheme, identical to the FastAPI verifier:
 *
 *     X-OnPitch-Timestamp: <unix seconds>
 *     X-OnPitch-Signature: hex(hmac_sha256(secret, `${timestamp}.${body}`))
 *
 * The timestamp is inside the signed material, which is what makes replay
 * protection possible: the sidecar rejects anything outside a 300s window with
 * `hmac.compare_digest`. Signing the body alone would let a captured request be
 * replayed forever.
 *
 * Returns `null` — never throws — for every failure mode. The caller treats
 * `null` as "use the rule engine".
 */
async function scoreWithSidecar(features: AnomalyFeatureVector): Promise<SidecarVerdict | null> {
  const baseUrl = process.env.ANOMALY_SERVICE_URL
  const secret = process.env.ANOMALY_SERVICE_SECRET

  if (!baseUrl || !secret) {
    // Entirely normal on a dev machine, and normal in production before the
    // sidecar is deployed. Not an error; the rule engine covers it.
    console.info("[api/internal/anomaly] sidecar not configured; using the rule engine", {
      matchId: features.matchId,
    })
    return null
  }

  const body = JSON.stringify(features)
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`, "utf8").digest("hex")

  try {
    const response = await fetch(new URL("/score", baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [TIMESTAMP_HEADER]: timestamp,
        [SIGNATURE_HEADER]: signature,
      },
      body,
      cache: "no-store",
      signal: AbortSignal.timeout(SIDECAR_TIMEOUT_MS),
    })

    if (!response.ok) {
      console.error("[api/internal/anomaly] sidecar returned non-2xx; falling back", {
        matchId: features.matchId,
        status: response.status,
      })
      return null
    }

    // Parsed, never asserted (docs/SECURITY.md §2): the sidecar is a trust
    // boundary and an ML service answering with garbage must degrade to the
    // rule engine, not poison `match_anomaly_flags`.
    const parsed = anomalyVerdictResponseSchema.safeParse(await response.json())
    if (!parsed.success) {
      console.error("[api/internal/anomaly] sidecar response failed validation; falling back", {
        matchId: features.matchId,
        issues: parsed.error.issues.map((issue) => issue.path.join(".")),
      })
      return null
    }

    if (parsed.data.matchId !== features.matchId) {
      console.error("[api/internal/anomaly] sidecar answered about a different match", {
        expected: features.matchId,
        received: parsed.data.matchId,
      })
      return null
    }

    return {
      anomalyScore: parsed.data.anomalyScore,
      isAnomalous: parsed.data.isAnomalous,
      leafDepth: parsed.data.leafDepth,
      averagePathLength: parsed.data.averagePathLength,
      modelVersion: parsed.data.modelVersion,
      reasons: parsed.data.reasons,
    }
  } catch (error) {
    // Timeout, DNS failure, connection refused, TLS error — all identical from
    // here: the model did not answer in time, so the rule engine decides.
    console.error("[api/internal/anomaly] sidecar unreachable; falling back", {
      matchId: features.matchId,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

/* ========================================================================== */
/*  The in-database rule engine, mirrored                                     */
/* ========================================================================== */

/**
 * The documented fallback verdict.
 *
 * Every input is already computed by Postgres — the feature vector and the
 * `collusion` object `anomaly_features()` nests inside it — so this adds no
 * queries and no model, it just blends the signals the way an explainable
 * heuristic should: additive, saturating, each contribution named in `reasons`.
 *
 * The base term is deliberately the SAME formula
 * `evaluate_score_consensus` uses for its own `rule_engine` flag —
 * `least(1.0, variance / 20.0)` — so a match scored here and a match scored by
 * the trigger sit on one comparable scale.
 *
 * Weights are judgement calls, not fitted parameters, and they are capped at 1.
 * They exist to be replaced by the Isolation Forest, not to compete with it.
 */
function ruleEngineVerdict(
  matchId: string,
  features: AnomalyFeatureVector,
  collusion: Record<string, unknown>,
  threshold: number,
): AnomalyVerdict {
  const reasons: string[] = []
  let score = Math.min(1, Math.max(0, features.scoreVariance / 20))
  if (features.scoreVariance > 0) {
    reasons.push(`score variance ${features.scoreVariance.toFixed(2)} across reports`)
  }

  const add = (amount: number, reason: string): void => {
    score += amount
    reasons.push(reason)
  }

  if (collusion.is_suspicious === true) {
    const collusionScore = typeof collusion.collusion_score === "number" ? collusion.collusion_score : 0
    add(0.25, `collusion heuristics flagged (score ${collusionScore.toFixed(2)})`)
  }
  if (collusion.lopsided_fast_report === true) {
    add(0.2, "lopsided result filed unusually quickly")
  }
  if (typeof collusion.shared_ip_reporter_pairs === "number" && collusion.shared_ip_reporter_pairs > 0) {
    add(0.2, "opposing reporters share a network fingerprint")
  }

  if (features.reporterCount <= 1) {
    add(0.15, "only one participant reported the result")
  } else if (features.opposingReportAgreement === 0) {
    add(0.15, "the two sides reported different results")
  }

  if (features.reporterAccountAgeDays < 7) {
    add(0.1, `reporter account age ${features.reporterAccountAgeDays.toFixed(1)} days`)
  }
  if (features.participantOverlapRatio >= 0.9) {
    add(0.1, "these two line-ups play almost exclusively each other")
  }
  if (features.historicalReportDeviation >= 3) {
    add(0.1, "reporters historically diverge from the confirmed score")
  }
  // A report filed BEFORE the final whistle is negative here by construction:
  // `reporting_delay_seconds` is measured from kickoff + duration.
  if (features.reportingDelaySeconds < 0) {
    add(0.1, "result reported before the scheduled final whistle")
  }

  const anomalyScore = round(Math.min(1, score), 6)

  if (reasons.length === 0) reasons.push("no rule-engine signal")

  return {
    matchId,
    source: "rule_engine",
    anomalyScore,
    isAnomalous: anomalyScore >= threshold,
    // There is no forest, so there is no path through one. Null rather than 0:
    // a leaf depth of 0 would be a meaningful — and very anomalous — reading.
    leafDepth: null,
    averagePathLength: null,
    modelVersion: null,
    threshold,
    reasons,
  }
}

/* ========================================================================== */
/*  Helpers                                                                   */
/* ========================================================================== */

/** `match_anomaly_feature_row` (snake_case jsonb) -> `AnomalyFeatureVector`. */
function toFeatureVector(row: Record<string, unknown>, matchId: string): Record<string, unknown> {
  return {
    matchId: typeof row.match_id === "string" ? row.match_id : matchId,
    scoreVariance: num(row.score_variance),
    reportingDelaySeconds: num(row.reporting_delay_seconds),
    reporterCount: num(row.reporter_count),
    opposingReportAgreement: num(row.opposing_report_agreement),
    participantOverlapRatio: num(row.participant_overlap_ratio),
    historicalReportDeviation: num(row.historical_report_deviation),
    goalDiff: num(row.goal_diff),
    kickoffHour: num(row.kickoff_hour),
    venueBookingsLast7d: num(row.venue_bookings_last_7d),
    reporterAccountAgeDays: num(row.reporter_account_age_days),
  }
}

/**
 * jsonb `numeric` normally arrives as a JS number, but PostgREST can render a
 * high-precision numeric as a string. Accept both rather than failing the whole
 * check on a formatting detail.
 */
function num(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

/** The database owns the cut-off; the constant is only a last resort. */
async function readThreshold(admin: unknown): Promise<number> {
  try {
    const raw = await callRpc(admin, "anomaly_score_threshold")
    const value = num(raw)
    if (value > 0 && value <= 1) return value
  } catch (error) {
    console.error("[api/internal/anomaly] anomaly_score_threshold() failed; using the default", {
      error: error instanceof Error ? error.message : String(error),
    })
  }
  return DEFAULT_THRESHOLD
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}
