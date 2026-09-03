/**
 * lib/matchmaking/index.ts
 *
 * Barrel re-exporting the matchmaking engine — which now lives in
 * `packages/shared/src/{trueskill,balance,quality}.ts` and is shared with the
 * Expo app — plus the small amount of plumbing the match route handlers need.
 *
 *     import { balanceTeams, matchQuality, rankCandidates } from "@/lib/matchmaking"
 *
 * ── Why the RPC plumbing lives here ─────────────────────────────────────────
 * `callRpc()`, `mapDatabaseError()` and `canonicalJsonbText()` are not
 * matchmaking. They live in this barrel because every route handler under
 * `app/api/matches/**` needs them and this is the only shared module in that
 * feature's ownership boundary — duplicating forty lines of SQLSTATE mapping
 * across five route files would be strictly worse. They are deliberately
 * dependency-light: no `node:*` imports, no Supabase import, nothing that would
 * stop this module being pulled into a client bundle for a rating preview.
 */

export * from "@onpitch/shared/trueskill"
export * from "@onpitch/shared/balance"
export * from "@onpitch/shared/quality"

import { ApiRouteError } from "@/lib/api-response"
import { isMinor } from "@/lib/gdpr"
import { API_ERROR_CODES, type MatchQuality } from "@onpitch/shared/domain"
import type { Tables } from "@onpitch/shared/database"

import { defaultRating, matchQualityForStorage, outcomeProbabilities, type Rating } from "@onpitch/shared/trueskill"

/* ========================================================================== */
/*  1. A loosely-typed view of the Supabase client                            */
/* ========================================================================== */

/**
 * `packages/shared/src/database.ts` is a HAND-WRITTEN mirror of the schema and it
 * does not yet describe everything migrations 0004/0005 actually shipped:
 *
 *   * `public.match_quality` really takes `(p_team_a, p_team_b)`, not
 *     `(p_home_player_ids, p_away_player_ids)`.
 *   * `apply_match_rating` returns `integer` (players rated), not `boolean`.
 *   * `submit_consensus_approval` has a fifth `p_signature_alg` parameter.
 *   * `matches_pending_anomaly_check`, `anomaly_score_threshold` and
 *     `expire_consensus_rounds` are absent from the type entirely.
 *   * `matches.consensus_nonce` / `consensus_nonce_issued_at` were added by
 *     0005 and are not on the generated `Row`.
 *
 * The SQL wins: it is what the database will execute. Rather than call these
 * RPCs with argument names PostgREST would reject just to satisfy a stale type,
 * every such call goes through this narrow escape hatch. It is intentionally
 * ugly and intentionally centralised, so `grep loose(` finds every place the
 * generated types are being bypassed. Delete it the day
 * `supabase gen types typescript` is run for real.
 */
export interface PostgrestLikeError {
  code?: string | null
  message?: string | null
  details?: string | null
  hint?: string | null
}

export interface LooseResult {
  data: unknown
  error: PostgrestLikeError | null
}

export interface LooseQuery extends PromiseLike<LooseResult> {
  select(columns?: string): LooseQuery
  eq(column: string, value: unknown): LooseQuery
  neq(column: string, value: unknown): LooseQuery
  gt(column: string, value: unknown): LooseQuery
  gte(column: string, value: unknown): LooseQuery
  lt(column: string, value: unknown): LooseQuery
  lte(column: string, value: unknown): LooseQuery
  is(column: string, value: unknown): LooseQuery
  in(column: string, values: readonly unknown[]): LooseQuery
  order(column: string, options?: { ascending?: boolean }): LooseQuery
  limit(count: number): LooseQuery
  single(): PromiseLike<LooseResult>
  maybeSingle(): PromiseLike<LooseResult>
}

export interface LooseSupabase {
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<LooseResult>
  from(table: string): LooseQuery
}

/** Widen a typed Supabase client so an RPC the generated types do not know about can be called. */
export function loose(client: unknown): LooseSupabase {
  return client as unknown as LooseSupabase
}

/* ========================================================================== */
/*  2. SQLSTATE -> ApiRouteError                                              */
/* ========================================================================== */

/**
 * Migration 0005 raises PostgREST-style SQLSTATEs — `PT401`, `PT403`, `PT404`,
 * `PT409`, `PT422`, `PT429` — whose messages are WRITTEN TO BE READ BY A PLAYER
 * ("You have already voted in this round."). PostgREST maps the code to an HTTP
 * status by itself, but supabase-js hands us the raw error, and
 * `handleRoute()`'s generic Postgres branch would flatten every one of them into
 * a 500 "Something went wrong".
 *
 * So this function runs FIRST, in every handler that calls one of those RPCs.
 *
 * Message policy: the `PT*` family and `42501` are curated, user-facing strings
 * authored in the migration, so they are forwarded verbatim, which is what the
 * convention is for. Every other SQLSTATE gets a generic message and its
 * detail goes to the log, per the house rule in `lib/api-response.ts`.
 */
export function mapDatabaseError(
  error: PostgrestLikeError | null | undefined,
  options: { fallbackMessage?: string; duplicateMessage?: string } = {},
): ApiRouteError | null {
  if (!error) return null

  const code = typeof error.code === "string" ? error.code : ""
  const message = typeof error.message === "string" && error.message.length > 0 ? error.message : null

  switch (code) {
    case "PT401":
      return new ApiRouteError(
        API_ERROR_CODES.UNAUTHENTICATED,
        message ?? "You need to be signed in to do that.",
        401,
      )
    case "PT403":
      return new ApiRouteError(
        API_ERROR_CODES.FORBIDDEN,
        message ?? "You are not allowed to do that.",
        403,
      )
    case "PT404":
      return new ApiRouteError(API_ERROR_CODES.NOT_FOUND, message ?? "Not found.", 404)
    case "PT409":
      // A digest mismatch is the one 409 with its own client-visible meaning:
      // the UI has to re-fetch the round and re-render before offering to vote
      // again, which is different from "you already voted".
      return new ApiRouteError(
        /digest|does not match the result/i.test(message ?? "")
          ? API_ERROR_CODES.DIGEST_MISMATCH
          : API_ERROR_CODES.REPORT_REJECTED,
        message ?? "That conflicts with the current state of the match.",
        409,
      )
    case "PT422":
      return new ApiRouteError(
        API_ERROR_CODES.REPORT_REJECTED,
        message ?? "That request was rejected.",
        422,
      )
    case "PT429":
      return new ApiRouteError(
        API_ERROR_CODES.RATE_LIMITED,
        message ?? "Too many requests. Try again shortly.",
        429,
      )
    case "42501":
      // `public.assert_consented` and the GDPR guards raise insufficient_privilege.
      return new ApiRouteError(
        /guardian|consent|Art\. 8/i.test(message ?? "")
          ? API_ERROR_CODES.CONSENT_REQUIRED
          : API_ERROR_CODES.FORBIDDEN,
        message ?? "You are not allowed to do that.",
        403,
      )
    case "23505":
      return new ApiRouteError(
        API_ERROR_CODES.REPORT_REJECTED,
        options.duplicateMessage ?? "That has already been recorded.",
        409,
      )
    case "23P01":
      // Let `handleRoute()` disambiguate the two exclusion constraints.
      return null
    case "22023":
      // trueskill2_update / apply_match_rating invalid-parameter guards. The
      // messages name internal function arguments, so they are NOT forwarded.
      return new ApiRouteError(
        API_ERROR_CODES.REPORT_REJECTED,
        options.fallbackMessage ?? "This match is not in a state that allows that yet.",
        409,
      )
    case "P0002":
      return new ApiRouteError(API_ERROR_CODES.NOT_FOUND, "Bulunamadı.", 404)
    default:
      return null
  }
}

/**
 * Throw the mapped error when there is one; otherwise re-throw the raw error so
 * `handleRoute()`'s Postgres branch can log it and answer 500.
 */
export function throwDatabaseError(
  error: PostgrestLikeError,
  options: { fallbackMessage?: string; duplicateMessage?: string } = {},
): never {
  const mapped = mapDatabaseError(error, options)
  if (mapped) throw mapped
  throw error
}

/* ========================================================================== */
/*  3. callRpc                                                                */
/* ========================================================================== */

/**
 * Call a Postgres function through supabase-js, mapping failures to clean
 * client errors. The return value is `unknown` on purpose: everything crossing
 * this boundary is parsed or narrowed by the caller, never asserted.
 */
export async function callRpc(
  client: unknown,
  fn: string,
  args: Record<string, unknown> = {},
  options: { fallbackMessage?: string; duplicateMessage?: string } = {},
): Promise<unknown> {
  const { data, error } = await loose(client).rpc(fn, args)
  if (error) throwDatabaseError(error, options)
  return data
}

/* ========================================================================== */
/*  4. Canonical jsonb rendering                                              */
/* ========================================================================== */

/**
 * Reproduce PostgreSQL's `jsonb::text` output for a decoded jsonb value.
 *
 * `public.consensus_payload()` returns jsonb, and the consensus digest is
 * `sha256(payload::text)` computed over PostgreSQL's rendering of it. supabase-js
 * hands us the value already parsed by `JSON.parse`, so to recompute the same
 * digest we have to re-render it with PostgreSQL's exact rules:
 *
 *   * object keys sorted by (LENGTH ascending, then bytewise ascending) — this
 *     is jsonb's internal ordering, NOT plain alphabetical;
 *   * `": "` after every key and `", "` between members;
 *   * no newlines, no trailing space;
 *   * arrays keep their stored order (the SQL already sorts participant ids).
 *
 * For the consensus key set that resolves to exactly one ordering:
 * `nonce, match_id, away_score, home_score, reported_at, participant_ids`.
 * `nonce` leads because it is the shortest key, and `away_score` precedes
 * `home_score` only because they tie on length. Getting this wrong does not
 * corrupt anything — the server recomputes the digest and rejects the vote —
 * but it does make every vote fail, so it is worth reproducing precisely.
 *
 * Numbers are emitted via `JSON.stringify`, which is correct here because every
 * numeric field in the payload is a small integer. A jsonb `numeric` with a
 * fractional part would need PostgreSQL's own numeric formatting; the payload
 * deliberately contains none.
 */
export function canonicalJsonbText(value: unknown): string {
  if (value === null || value === undefined) return "null"
  if (typeof value === "boolean") return value ? "true" : "false"
  if (typeof value === "number") return JSON.stringify(value)
  if (typeof value === "string") return JSON.stringify(value)

  if (Array.isArray(value)) {
    return `[${value.map(canonicalJsonbText).join(", ")}]`
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, v]) => v !== undefined,
    )
    entries.sort(compareJsonbKeys)
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}: ${canonicalJsonbText(v)}`).join(", ")}}`
  }

  return "null"
}

/**
 * jsonb's key collation: shorter keys first, then bytewise on the UTF-8 bytes.
 * Comparing UTF-16 code units is equivalent to comparing UTF-8 bytes for every
 * key in this schema (they are all ASCII); the length is measured in UTF-8
 * bytes so a non-ASCII key added later still sorts the way Postgres sorts it.
 */
function compareJsonbKeys(a: [string, unknown], b: [string, unknown]): number {
  const la = utf8Length(a[0])
  const lb = utf8Length(b[0])
  if (la !== lb) return la - lb
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0
}

function utf8Length(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i += 1) {
    const code = text.codePointAt(i) as number
    if (code > 0xffff) i += 1
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code < 0x10000) bytes += 3
    else bytes += 4
  }
  return bytes
}

/* ========================================================================== */
/*  5. bytea helpers                                                          */
/* ========================================================================== */

/**
 * PostgREST decodes a JSON string into `bytea` using PostgreSQL's hex input
 * format, so a digest must travel as `\xdeadbeef…` — a single backslash, a
 * literal `x`, then lowercase hex.
 */
export function toByteaHex(hex: string): string {
  return `\\x${hex.toLowerCase()}`
}

/** The inverse: `\xdead…` (or a bare hex string) back to lowercase hex. */
export function fromByteaHex(value: string): string {
  return (value.startsWith("\\x") ? value.slice(2) : value).toLowerCase()
}

/* ========================================================================== */
/*  6. Shared match-route helpers                                             */
/* ========================================================================== */

/**
 * GDPR Art. 8 gate, mirroring `public.assert_consented`.
 *
 * The database raises `42501` for the same condition, and `mapDatabaseError`
 * turns that into `CONSENT_REQUIRED` too — this is the pre-flight copy, so the
 * user gets an actionable error before a write is attempted rather than a
 * trigger failure halfway through one. Minority is decided by `isMinor()`, which
 * recomputes the age from `date_of_birth` rather than trusting the STORED
 * generated `is_minor` snapshot; that is what the database trigger and the
 * checkout gate do, and reading the stale snapshot here would keep locking out
 * players who have since turned 16.
 */
export function assertConsented(profile: Tables<"profiles">): void {
  if (profile.deleted_at) {
    throw new ApiRouteError(
      API_ERROR_CODES.FORBIDDEN,
      "Bu hesap kapalı ve maçlara katılamaz.",
      403,
    )
  }
  if (isMinor(profile) && profile.parental_consent_status !== "granted") {
    throw new ApiRouteError(
      API_ERROR_CODES.CONSENT_REQUIRED,
      "Oynayabilmen için bir veli veya vasinin bu hesabı onaylaması gerekiyor (KVKK / GDPR md. 8).",
      403,
    )
  }
}

/**
 * Quality plus the full outcome distribution for a fixture, each value rounded
 * exactly as its `numeric(6,5)` column stores it, so what the API returns is
 * what the database holds.
 */
export function predictBalance(home: readonly Rating[], away: readonly Rating[]): MatchQuality {
  const probabilities = outcomeProbabilities(home, away)
  return {
    quality: matchQualityForStorage(home, away),
    drawProbability: probabilities.drawProbability,
    homeWinProbability: probabilities.homeWinProbability,
    awayWinProbability: probabilities.awayWinProbability,
  }
}

/**
 * Load `player_ratings` for a set of players in one round trip. Ids with no row
 * yet fall back to the prior `(mu0, sigma0)` — the same treatment
 * `public.match_quality` gives them, so an unrated ringer correctly drags a
 * predicted quality down instead of being silently skipped.
 */
export async function loadRatings(
  client: unknown,
  playerIds: readonly string[],
): Promise<Map<string, Rating>> {
  const out = new Map<string, Rating>()
  if (playerIds.length === 0) return out

  const { data, error } = await loose(client)
    .from("player_ratings")
    .select("player_id, mu, sigma")
    .in("player_id", playerIds)

  if (error) throwDatabaseError(error)

  for (const row of asRows(data)) {
    const id = row.player_id
    const mu = row.mu
    const sigma = row.sigma
    if (typeof id === "string" && typeof mu === "number" && typeof sigma === "number") {
      out.set(id, { mu, sigma })
    }
  }
  return out
}

/** Ratings for a line-up, in the given order, filling gaps with the prior. */
export function ratingsFor(
  playerIds: readonly string[],
  ratings: ReadonlyMap<string, Rating>,
): Rating[] {
  return playerIds.map((id) => ratings.get(id) ?? defaultRating())
}

/** Narrow an untyped PostgREST payload to an array of records. */
export function asRows(data: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(data)) return []
  return data.filter(
    (row): row is Record<string, unknown> => typeof row === "object" && row !== null,
  )
}

/** Narrow an untyped PostgREST payload to a single record. */
export function asRecord(data: unknown): Record<string, unknown> | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null
  return data as Record<string, unknown>
}
