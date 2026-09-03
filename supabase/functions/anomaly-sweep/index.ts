/// <reference types="https://esm.sh/@supabase/functions-js@2/src/edge-runtime.d.ts" />

/**
 * supabase/functions/anomaly-sweep/index.ts
 *
 *   POST /functions/v1/anomaly-sweep   { "limit": 50 }        (body optional)
 *
 * Batch-scores every match whose score reports have not been through the
 * Isolation Forest yet, and records a verdict for each one.
 *
 *   matches_pending_anomaly_check(n)
 *     -> POST {ANOMALY_SERVICE_URL}/score        (per match, HMAC-signed)
 *     -> record_anomaly_verdict(...)
 *
 * ── Deploy ──────────────────────────────────────────────────────────────────
 *     supabase functions deploy anomaly-sweep
 *     supabase secrets set \
 *       ANOMALY_SERVICE_URL=https://anomaly.internal \
 *       ANOMALY_SERVICE_SECRET=<shared with services/anomaly> \
 *       INTERNAL_API_TOKEN=<shared with the Next.js app>
 *
 * ── Schedule it ─────────────────────────────────────────────────────────────
 * Every ten minutes is a sensible cadence: the reporting window is 48h and the
 * consensus deadline is 24h, so nothing here is latency-critical.
 *
 * With Supabase scheduled functions (dashboard), or with pg_cron:
 *
 *     select cron.schedule(
 *       'anomaly-sweep',
 *       '*\/10 * * * *',
 *       $$
 *       select net.http_post(
 *         url     := 'https://<project-ref>.functions.supabase.co/anomaly-sweep',
 *         headers := jsonb_build_object(
 *                      'Content-Type',  'application/json',
 *                      'Authorization', 'Bearer ' || current_setting('app.service_role_key', true)
 *                    ),
 *         body    := '{"limit": 50}'::jsonb
 *       );
 *       $$
 *     );
 *
 * ── The fallback, again ─────────────────────────────────────────────────────
 * Identical policy to `POST /api/internal/anomaly/check`: if the sidecar is
 * unreachable, slow or unparseable, a deterministic rule-engine verdict is
 * recorded with `source = 'rule_engine'` instead, so no match is skipped and no
 * caller is blocked. `matches_pending_anomaly_check()` re-offers any match
 * whose reports changed since the last pass, so a rule-engine verdict is
 * superseded by a real one on the next sweep once the service is back.
 *
 * The Deno copy of the rule engine is intentionally narrower than the Node one:
 * `matches_pending_anomaly_check()` returns the feature vector without the
 * nested `collusion` object that `anomaly_features()` provides, so the
 * collusion-derived terms are absent here. The trade is one RPC per match
 * against slightly coarser fallback scoring, and for a background sweep whose
 * whole purpose is to be cheap, coarser wins. `record_anomaly_verdict` refreshes
 * the collusion cache on every call regardless, so the admin queue stays current.
 *
 * ── Time budget ─────────────────────────────────────────────────────────────
 * Matches are processed sequentially with a wall-clock deadline. Hitting the
 * deadline is not a failure: the function reports what it did and how many are
 * left, and the next tick picks them up. A batch that ran until the platform
 * killed the isolate would lose the verdicts it had already computed.
 */

import { EdgeError, handleEdge, jsonOk } from "../_shared/cors.ts"
import {
  createServiceClient,
  env,
  identifyCaller,
  readJson,
  requireMachineCaller,
  toEdgeError,
} from "../_shared/supabase.ts"

/** Hard deadline for one sidecar call. Matches the Next.js bridge. */
const SIDECAR_TIMEOUT_MS = 2500

/** Stop starting new work after this much wall clock. */
const SWEEP_BUDGET_MS = 50_000

/** Mirrors `public.anomaly_score_threshold()`'s default. */
const DEFAULT_THRESHOLD = 0.62

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

/** Signature headers. Identical to the Next.js bridge and to `services/anomaly/`. */
const SIGNATURE_HEADER = "X-OnPitch-Signature"
const TIMESTAMP_HEADER = "X-OnPitch-Timestamp"

/** Camel-cased feature vector, field-for-field `AnomalyFeatureVector`. */
interface FeatureVector {
  matchId: string
  scoreVariance: number
  reportingDelaySeconds: number
  reporterCount: number
  opposingReportAgreement: number
  participantOverlapRatio: number
  historicalReportDeviation: number
  goalDiff: number
  kickoffHour: number
  venueBookingsLast7d: number
  reporterAccountAgeDays: number
}

interface Verdict {
  source: "isolation_forest" | "rule_engine"
  anomalyScore: number
  isAnomalous: boolean
  leafDepth: number | null
  averagePathLength: number | null
  modelVersion: string | null
  reasons: string[]
}

Deno.serve((request: Request) =>
  handleEdge(request, async () => {
    if (request.method !== "POST") {
      throw new EdgeError("VALIDATION_FAILED", "Use POST.", 405)
    }

    // Cross-match behavioural intelligence: cron and the app only, never a user.
    const caller = await identifyCaller(request)
    requireMachineCaller(caller)

    const body = await readJson(request)
    const limit = clampLimit(body.limit)

    const service = createServiceClient()
    const startedAt = Date.now()

    /* -- 1. What needs scoring -------------------------------------------- */
    const { data: pending, error: pendingError } = await service.rpc(
      "matches_pending_anomaly_check",
      { p_limit: limit },
    )
    if (pendingError) throw toEdgeError(pendingError, "Could not read the anomaly queue.")

    const rows = Array.isArray(pending) ? pending : []
    const threshold = await readThreshold(service)

    /* -- 2. Score each one ------------------------------------------------- */
    let scoredByModel = 0
    let scoredByRules = 0
    let openedConsensus = 0
    let failed = 0
    let processed = 0
    const failures: Array<{ matchId: string; error: string }> = []

    for (const row of rows) {
      if (Date.now() - startedAt > SWEEP_BUDGET_MS) break

      const features = toFeatureVector(row as Record<string, unknown>)
      if (!features) {
        failed += 1
        continue
      }

      processed += 1

      const fromModel = await scoreWithSidecar(features)
      const verdict: Verdict = fromModel ?? ruleEngineVerdict(features, threshold)
      if (fromModel) scoredByModel += 1
      else scoredByRules += 1

      const { data: recorded, error: recordError } = await service.rpc("record_anomaly_verdict", {
        p_match_id: features.matchId,
        p_source: verdict.source,
        p_anomaly_score: verdict.anomalyScore,
        p_is_anomalous: verdict.isAnomalous,
        p_reasons: verdict.reasons,
        p_model_version: verdict.modelVersion,
        p_leaf_depth: verdict.leafDepth,
        p_average_path_length: verdict.averagePathLength,
      })

      if (recordError) {
        // One bad match must not abort the sweep — the rest of the queue is
        // still worth clearing, and this one will be re-offered next tick.
        failed += 1
        failures.push({
          matchId: features.matchId,
          error: recordError.message ?? "record_anomaly_verdict failed",
        })
        console.error("[anomaly-sweep] failed to record a verdict", {
          matchId: features.matchId,
          code: recordError.code,
        })
        continue
      }

      if (
        typeof recorded === "object" &&
        recorded !== null &&
        (recorded as Record<string, unknown>).opened_consensus === true
      ) {
        openedConsensus += 1
      }
    }

    return jsonOk({
      queued: rows.length,
      processed,
      scoredByModel,
      scoredByRules,
      openedConsensus,
      failed,
      failures: failures.slice(0, 10),
      remaining: Math.max(0, rows.length - processed - failed),
      threshold,
      elapsedMs: Date.now() - startedAt,
      sidecarConfigured: Boolean(env("ANOMALY_SERVICE_URL") && env("ANOMALY_SERVICE_SECRET")),
    })
  }),
)

/* ========================================================================== */
/*  The sidecar                                                               */
/* ========================================================================== */

/**
 * HMAC-sign and POST one feature vector.
 *
 *     X-OnPitch-Timestamp: <unix seconds>
 *     X-OnPitch-Signature: hex(hmac_sha256(secret, `${timestamp}.${body}`))
 *
 * The timestamp is inside the signed material so the sidecar can enforce its
 * 300s skew window; signing the body alone would leave a captured request
 * replayable forever.
 *
 * Returns `null` for every failure, which the caller reads as "use the rules".
 */
async function scoreWithSidecar(features: FeatureVector): Promise<Verdict | null> {
  const baseUrl = env("ANOMALY_SERVICE_URL")
  const secret = env("ANOMALY_SERVICE_SECRET")
  if (!baseUrl || !secret) return null

  const body = JSON.stringify(features)
  const timestamp = Math.floor(Date.now() / 1000).toString()

  try {
    const signature = await hmacSha256Hex(secret, `${timestamp}.${body}`)

    const response = await fetch(new URL("/score", baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [TIMESTAMP_HEADER]: timestamp,
        [SIGNATURE_HEADER]: signature,
      },
      body,
      signal: AbortSignal.timeout(SIDECAR_TIMEOUT_MS),
    })

    if (!response.ok) {
      console.error("[anomaly-sweep] sidecar non-2xx", {
        matchId: features.matchId,
        status: response.status,
      })
      return null
    }

    const parsed = await response.json()
    return normaliseSidecarVerdict(parsed, features.matchId)
  } catch (error) {
    console.error("[anomaly-sweep] sidecar unreachable", {
      matchId: features.matchId,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

/**
 * Validate the sidecar's answer by hand.
 *
 * The Next.js side parses it with the zod schema from `types/domain.ts`; that
 * module cannot be imported here (Deno, no path alias, and it pulls in zod), so
 * the same field constraints are checked structurally. Anything that fails —
 * a wrong match id, a score outside [0,1], a missing boolean — returns null and
 * degrades to the rule engine, exactly as an unreachable service would.
 */
function normaliseSidecarVerdict(value: unknown, expectedMatchId: string): Verdict | null {
  if (typeof value !== "object" || value === null) return null
  const raw = value as Record<string, unknown>

  if (raw.matchId !== expectedMatchId) {
    console.error("[anomaly-sweep] sidecar answered about a different match", {
      expected: expectedMatchId,
      received: raw.matchId,
    })
    return null
  }

  const anomalyScore = raw.anomalyScore
  if (typeof anomalyScore !== "number" || !Number.isFinite(anomalyScore)) return null
  if (anomalyScore < 0 || anomalyScore > 1) return null
  if (typeof raw.isAnomalous !== "boolean") return null

  return {
    source: "isolation_forest",
    anomalyScore,
    isAnomalous: raw.isAnomalous,
    leafDepth: typeof raw.leafDepth === "number" ? raw.leafDepth : null,
    averagePathLength: typeof raw.averagePathLength === "number" ? raw.averagePathLength : null,
    modelVersion: typeof raw.modelVersion === "string" ? raw.modelVersion : null,
    reasons: Array.isArray(raw.reasons)
      ? raw.reasons.filter((r): r is string => typeof r === "string").slice(0, 20)
      : [],
  }
}

/** Web Crypto HMAC-SHA256, hex encoded. Deno has no `node:crypto` shortcut here. */
async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message))
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

/* ========================================================================== */
/*  Rule engine (feature-only variant)                                        */
/* ========================================================================== */

/**
 * Deterministic fallback score.
 *
 * The base term is the same one `evaluate_score_consensus` uses for its own
 * `rule_engine` flag — `least(1.0, variance / 20.0)` — so verdicts recorded by
 * the trigger, by the Next.js bridge and by this sweep all sit on one scale.
 * Everything after it is an additive, saturating, named contribution.
 */
function ruleEngineVerdict(features: FeatureVector, threshold: number): Verdict {
  const reasons: string[] = []
  let score = Math.min(1, Math.max(0, features.scoreVariance / 20))

  if (features.scoreVariance > 0) {
    reasons.push(`score variance ${features.scoreVariance.toFixed(2)} across reports`)
  }

  const add = (amount: number, reason: string): void => {
    score += amount
    reasons.push(reason)
  }

  if (features.reporterCount <= 1) {
    add(0.15, "only one participant reported the result")
  } else if (features.opposingReportAgreement === 0) {
    add(0.2, "the two sides reported different results")
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
  // `reporting_delay_seconds` is measured from kickoff + duration, so a negative
  // value means the result was filed before the scheduled final whistle.
  if (features.reportingDelaySeconds < 0) {
    add(0.1, "result reported before the scheduled final whistle")
  }
  if (features.goalDiff >= 5 && features.reportingDelaySeconds < 120) {
    add(0.15, "lopsided result filed unusually quickly")
  }

  const anomalyScore = Math.round(Math.min(1, score) * 1e6) / 1e6
  if (reasons.length === 0) reasons.push("no rule-engine signal")

  return {
    source: "rule_engine",
    anomalyScore,
    isAnomalous: anomalyScore >= threshold,
    // No forest, so no path through one. Null rather than 0 — a leaf depth of 0
    // would itself be a meaningful, very anomalous reading.
    leafDepth: null,
    averagePathLength: null,
    modelVersion: null,
    reasons,
  }
}

/* ========================================================================== */
/*  Helpers                                                                   */
/* ========================================================================== */

/** `public.match_anomaly_feature_row` (snake_case) -> the camelCase contract. */
function toFeatureVector(row: Record<string, unknown>): FeatureVector | null {
  const matchId = row.match_id
  if (typeof matchId !== "string") return null

  return {
    matchId,
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

/** PostgREST can render a high-precision `numeric` as a string. Accept both. */
function num(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

async function readThreshold(service: ReturnType<typeof createServiceClient>): Promise<number> {
  const { data, error } = await service.rpc("anomaly_score_threshold")
  if (error) {
    console.error("[anomaly-sweep] anomaly_score_threshold() failed; using the default", {
      code: error.code,
    })
    return DEFAULT_THRESHOLD
  }
  const value = num(data)
  return value > 0 && value <= 1 ? value : DEFAULT_THRESHOLD
}

function clampLimit(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(parsed)))
}
