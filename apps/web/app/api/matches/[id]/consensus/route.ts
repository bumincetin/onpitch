/**
 * app/api/matches/[id]/consensus/route.ts
 *
 *   GET  /api/matches/[id]/consensus   the state of the open round
 *   POST /api/matches/[id]/consensus   cast one signed vote
 *
 * ── What a vote actually commits to ─────────────────────────────────────────
 * A bare "I approve" is worthless: it does not say WHAT was approved. A client
 * could be shown 3-2, tap yes, and have the server record 5-0. So an approval is
 * bound to a digest of the exact document the voter was shown — one scoreline,
 * one roster, one round nonce.
 *
 * `public.consensus_payload(match_id)` is the ONLY producer of that document.
 * The digest is `sha256` over PostgreSQL's `jsonb::text` rendering of it, which
 * has a pinned canonical form (keys ordered by length then bytes; `": "` after
 * every key; `", "` between members; UTC second-precision timestamp; participant
 * uuids sorted ascending). `canonicalJsonbText()` reproduces that rendering from
 * the parsed value supabase-js hands back — see the long comment on it.
 *
 * Three independent computations of the same digest have to agree before a vote
 * counts:
 *   1. the BROWSER's, over the bytes it rendered on screen;
 *   2. THIS HANDLER's, which rejects a mismatch before touching the database;
 *   3. `submit_consensus_approval`'s own, inside the transaction that writes it.
 *
 * (2) exists so a stale UI gets a clean `DIGEST_MISMATCH` and a re-fetch prompt
 * instead of a Postgres exception. (3) is the one that actually secures it —
 * this handler could be bypassed, the RPC cannot.
 *
 * ── Client choice ───────────────────────────────────────────────────────────
 * Everything here runs on the USER's cookie-bound client. `consensus_payload`
 * and `submit_consensus_approval` both read `(select auth.uid())` to decide who
 * is asking and to attribute the vote; calling them as `service_role` would make
 * `auth.uid()` null and either skip the authorisation branch or fail outright.
 * That is exactly the right coupling — the voter's identity IS the session.
 */

import { createHash } from "node:crypto"

import { createRouteClient } from "@/lib/supabase/server"
import { getSessionUser } from "@/lib/rbac"
import { ApiRouteError, handleRoute, ok } from "@/lib/api-response"
import { enforceRateLimit } from "@/lib/rate-limit"
import {
  asRecord,
  asRows,
  callRpc,
  canonicalJsonbText,
  fromByteaHex,
  loose,
  throwDatabaseError,
  toByteaHex,
} from "@/lib/matchmaking"
import {
  API_ERROR_CODES,
  consensusApprovalSchema,
  type ConsensusPayload,
  type ConsensusRound,
  type TeamSide,
} from "@halisaha/shared/domain"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Bumped only when the canonical document's SHAPE changes, never its values. */
const CONSENSUS_PAYLOAD_VERSION = 1

interface SubmitConsensusResult {
  approvalId: string | null
  decision: "approve" | "reject"
  teamSide: TeamSide | null
  payloadDigest: string
  /** Raw descriptor from `finalize_consensus`, run at the end of every vote. */
  finalization: unknown
  round: ConsensusRound
}

/* ========================================================================== */
/*  GET — round state                                                         */
/* ========================================================================== */

export async function GET(
  request: Request,
  context: { params: { id: string } },
): Promise<Response> {
  return handleRoute<ConsensusRound>(async () => {
    const matchId = context.params.id
    const session = await requireSession()
    // `createRouteClient` — not `createClient` — because the Expo app has no cookie jar and
    // authenticates with `Authorization: Bearer <access token>`; a cookie-only client reads as
    // `anon` with auth.uid() null for a mobile caller and RLS hands back nothing.
    const supabase = await createRouteClient(request)

    const round = await buildRound(supabase, matchId, session.userId)
    return ok<ConsensusRound>(round)
  })
}

/* ========================================================================== */
/*  POST — cast a vote                                                        */
/* ========================================================================== */

export async function POST(
  request: Request,
  context: { params: { id: string } },
): Promise<Response> {
  return handleRoute<SubmitConsensusResult>(async () => {
    const matchId = context.params.id
    const session = await requireSession()

    // Budgets are counted in Postgres, not in this process — see lib/rate-limit.ts.
    const limited = await enforceRateLimit("consensus_vote")
    if (limited) return limited

    const body = consensusApprovalSchema.parse(await request.json())
    // `createRouteClient` — not `createClient` — because the Expo app has no cookie jar and
    // authenticates with `Authorization: Bearer <access token>`. The RPCs below read
    // `(select auth.uid())`, which is null on a cookie-only client for a mobile caller.
    const supabase = await createRouteClient(request)

    /* -- Recompute the canonical bytes before spending a transaction ------- */
    const payload = await fetchCanonicalPayload(supabase, matchId)

    if (body.clientDigest !== payload.digest) {
      // The scoreline on the table moved under the voter (a late report can
      // change the most-corroborated result), or their tab is stale. Either way
      // they must be re-shown what they are being asked to ratify.
      throw new ApiRouteError(
        API_ERROR_CODES.DIGEST_MISMATCH,
        "Oyladığın sonuç şu anda masadaki sonuç değil. Maçı yenileyip tekrar oy ver.",
        409,
        { expectedDigest: payload.digest },
      )
    }

    /* -- Cast it. The RPC recomputes the digest a third time. -------------- */
    const raw = await callRpc(
      supabase,
      "submit_consensus_approval",
      {
        p_match_id: matchId,
        p_decision: body.decision,
        p_client_digest: toByteaHex(payload.digest),
        p_signature: body.signature ?? null,
        p_signature_alg: body.signatureAlg ?? "hmac-sha256",
      },
      { duplicateMessage: "You have already voted in this round." },
    )

    const result: Record<string, unknown> = asRecord(raw) ?? {}

    // Re-read rather than reconstruct: `submit_consensus_approval` calls
    // `finalize_consensus` on its way out, so the round may have closed during
    // this very request and the caller needs the state that actually resulted.
    const round = await buildRound(supabase, matchId, session.userId)

    return ok<SubmitConsensusResult>(
      {
        approvalId: typeof result.approval_id === "string" ? result.approval_id : null,
        decision: body.decision,
        teamSide: normaliseSide(result.team_side),
        payloadDigest: payload.digest,
        finalization: result.finalization ?? null,
        round,
      },
      { status: 201 },
    )
  })
}

/* ========================================================================== */
/*  Shared: the canonical payload                                             */
/* ========================================================================== */

interface CanonicalPayload {
  /** The decoded jsonb, exactly as `public.consensus_payload()` built it. */
  raw: Record<string, unknown>
  /** PostgreSQL's `jsonb::text` rendering of it — the bytes that are hashed. */
  canonical: string
  /** Lowercase hex SHA-256 of `canonical`. */
  digest: string
}

async function fetchCanonicalPayload(
  supabase: unknown,
  matchId: string,
): Promise<CanonicalPayload> {
  // PT403 (not involved), PT404 (no such match) and PT409 (no open round /
  // nothing reported yet) all arrive here as curated, user-facing messages.
  const data = await callRpc(supabase, "consensus_payload", { p_match_id: matchId })

  const raw = asRecord(data)
  if (!raw) {
    throw new ApiRouteError(
      API_ERROR_CODES.INTERNAL,
      "Bu maçın oylama verisi okunamadı.",
      500,
    )
  }

  const canonical = canonicalJsonbText(raw)
  const digest = createHash("sha256").update(canonical, "utf8").digest("hex")

  return { raw, canonical, digest }
}

/* ========================================================================== */
/*  Shared: round state                                                       */
/* ========================================================================== */

async function buildRound(
  supabase: unknown,
  matchId: string,
  callerId: string,
): Promise<ConsensusRound> {
  const payload = await fetchCanonicalPayload(supabase, matchId)

  /* -- Match row. `consensus_nonce_issued_at` was added by 0005 and is
        not on the generated `Row` type, hence the loose query. -------------- */
  const { data: matchData, error: matchError } = await loose(supabase)
    .from("matches")
    .select(
      "id, kickoff_at, home_team_id, away_team_id, consensus_deadline, consensus_nonce_issued_at",
    )
    .eq("id", matchId)
    .maybeSingle()

  if (matchError) throwDatabaseError(matchError)
  const match = asRecord(matchData)
  if (!match) {
    throw new ApiRouteError(API_ERROR_CODES.NOT_FOUND, "Böyle bir maç yok.", 404)
  }

  /* -- Electorate ------------------------------------------------------- */
  const { data: participants, error: participantError } = await loose(supabase)
    .from("match_participants")
    .select("player_id, team_side, is_confirmed")
    .eq("match_id", matchId)

  if (participantError) throwDatabaseError(participantError)

  const sideOf = new Map<string, TeamSide>()
  let confirmed = 0
  let lineup = 0
  for (const row of asRows(participants)) {
    const id = typeof row.player_id === "string" ? row.player_id : null
    if (!id) continue
    lineup += 1
    if (row.is_confirmed === true) confirmed += 1
    sideOf.set(id, row.team_side === "away" ? "away" : "home")
  }

  // Mirrors `finalize_consensus`: `is_confirmed` defaults to false and plenty of
  // pickup matches never run a check-in, so an empty confirmed set falls back to
  // the whole line-up rather than handing quorum to a single voter.
  const eligible = confirmed > 0 ? confirmed : lineup
  // Two thirds, rounded up, never fewer than two. Below two eligible voters
  // `finalize_consensus` bails with `insufficient_electorate` and an admin has
  // to settle it, so 2 is still the honest number to display.
  const quorumRequired = Math.max(2, Math.ceil((2 * eligible) / 3))

  /* -- Votes cast against THIS payload ----------------------------------- */
  // Filtered by digest, not just by match: a late score report can change the
  // scoreline underneath an open round, and nobody may be counted as approving
  // a result they were never shown. `finalize_consensus` applies the same
  // filter, so these counts match what the database will act on.
  const { data: approvals, error: approvalError } = await loose(supabase)
    .from("consensus_approvals")
    .select("approver_id, decision, payload_digest")
    .eq("match_id", matchId)

  if (approvalError) throwDatabaseError(approvalError)

  let approvalCount = 0
  let rejectionCount = 0
  let hasHomeApproval = false
  let hasAwayApproval = false
  let callerHasVoted = false

  for (const row of asRows(approvals)) {
    const approverId = typeof row.approver_id === "string" ? row.approver_id : null
    if (!approverId) continue

    if (approverId === callerId) callerHasVoted = true

    const digest = typeof row.payload_digest === "string" ? fromByteaHex(row.payload_digest) : ""
    if (digest !== payload.digest) continue

    if (row.decision === "approve") {
      approvalCount += 1
      const side = sideOf.get(approverId)
      if (side === "home") hasHomeApproval = true
      if (side === "away") hasAwayApproval = true
    } else if (row.decision === "reject") {
      rejectionCount += 1
    }
  }

  return {
    matchId,
    payload: toDomainPayload(payload.raw, match, matchId),
    canonical: payload.canonical,
    digest: payload.digest,
    deadline: typeof match.consensus_deadline === "string" ? match.consensus_deadline : null,
    quorumRequired,
    approvals: approvalCount,
    rejections: rejectionCount,
    hasHomeApproval,
    hasAwayApproval,
    callerHasVoted,
  }
}

/**
 * Present the database's canonical document as the `ConsensusPayload` the client
 * types declare.
 *
 * THE DIGEST IS NOT COMPUTED FROM THIS OBJECT. `ConsensusRound.canonical` holds
 * the exact bytes that were hashed; this is the friendly decoding of them, with
 * `homeTeamId` / `awayTeamId` / `kickoffAt` / `issuedAt` joined in from the match
 * row for display. Re-serialising this object and hashing THAT would produce a
 * different digest and every vote would be rejected — which is why
 * `types/domain.ts` says the client hashes the bytes it received and never
 * re-serialises the object.
 */
function toDomainPayload(
  raw: Record<string, unknown>,
  match: Record<string, unknown>,
  matchId: string,
): ConsensusPayload {
  const participantIds = Array.isArray(raw.participant_ids)
    ? raw.participant_ids.filter((id): id is string => typeof id === "string")
    : []

  return {
    version: CONSENSUS_PAYLOAD_VERSION,
    matchId,
    homeTeamId: typeof match.home_team_id === "string" ? match.home_team_id : null,
    awayTeamId: typeof match.away_team_id === "string" ? match.away_team_id : null,
    homeScore: typeof raw.home_score === "number" ? raw.home_score : 0,
    awayScore: typeof raw.away_score === "number" ? raw.away_score : 0,
    kickoffAt: typeof match.kickoff_at === "string" ? match.kickoff_at : "",
    participantIds,
    nonce: typeof raw.nonce === "string" ? raw.nonce : "",
    issuedAt:
      typeof match.consensus_nonce_issued_at === "string"
        ? match.consensus_nonce_issued_at
        : typeof raw.reported_at === "string"
          ? raw.reported_at
          : "",
  }
}

/* ========================================================================== */
/*  Small helpers                                                             */
/* ========================================================================== */

async function requireSession(): Promise<{ userId: string }> {
  const session = await getSessionUser()
  if (!session) {
    throw new ApiRouteError(
      API_ERROR_CODES.UNAUTHENTICATED,
      "Oylamaya katılmak için giriş yap.",
      401,
    )
  }
  return { userId: session.user.id }
}

function normaliseSide(value: unknown): TeamSide | null {
  if (value === "home" || value === "away") return value
  return null
}
