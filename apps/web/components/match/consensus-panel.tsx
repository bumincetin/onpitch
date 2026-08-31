"use client"

/**
 * components/match/consensus-panel.tsx
 *
 * Peer ratification of a contested result.
 *
 * ---------------------------------------------------------------------------------------------
 * THE CANONICAL PAYLOAD, AND WHY THE BYTES MATTER
 * ---------------------------------------------------------------------------------------------
 *
 * `public.submit_consensus_approval()` will not accept a bare "yes". It requires
 * `sha256(canonical_payload)` computed by the CLIENT, recomputes the same digest server-side, and
 * rejects the vote if they differ. That check is the entire point of this screen: a bare approval
 * does not say WHAT was approved, so a compromised or stale client could show you 3–2, take your
 * yes, and have the server finalise 5–0. Binding the vote to a digest makes an approval a
 * commitment to one specific scoreline, one specific line-up and one specific round nonce.
 *
 * The digest is only meaningful if both sides hash IDENTICAL BYTES. The server's bytes are the
 * Postgres `jsonb::text` rendering of the payload — pinned in the comment on
 * `public.consensus_payload()` in `0005_integrity_consensus.sql` — and reproducing it in
 * JavaScript takes three rules, none of them what a JS developer would guess:
 *
 *   1. KEY ORDER is (byte length ASC, then bytewise ASC), NOT alphabetical. For this payload that
 *      resolves to: nonce, match_id, away_score, home_score, reported_at, participant_ids.
 *      `nonce` comes first because it is the shortest key; `away_score` precedes `home_score`
 *      only because they tie on length. `JSON.stringify` with sorted keys gets this WRONG.
 *
 *   2. WHITESPACE is not stripped. Postgres renders exactly one space after every `:` and every
 *      `,` — `{"a": 1, "b": [1, 2]}`. `JSON.stringify` emits none, and would produce a completely
 *      different digest.
 *
 *   3. VALUES are rendered Postgres-style: participant uuids lowercase and sorted by byte
 *      (COLLATE "C"), the timestamp already forced to UTC with second precision by the server,
 *      scores as bare JSON integers.
 *
 * {@link canonicalizeJsonb} implements exactly that. It is deliberately strict — it throws rather
 * than guess on a float, a nested object, or a non-finite number — because a wrong digest is
 * rejected by the server anyway, and a loud failure here is much easier to diagnose than
 * "your vote does not match the result currently on the table".
 *
 * The digest is NOT a secret. Anyone entitled to read the payload can compute it, and the server
 * hands the expected value back in the mismatch error so an honest client can resync. What it buys
 * is evidentiary: a stored approval records precisely which scoreline and roster its owner
 * assented to, and a client showing a stale score can never have that assent counted.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import type { PostgrestError } from "@supabase/supabase-js"

import { createClient } from "@/lib/supabase/client"
import { toPlainError } from "@/components/match/score-reporter"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

/* ========================================================================== */
/*  Canonical JSON — a faithful reimplementation of Postgres `jsonb::text`    */
/* ========================================================================== */

const encoder = new TextEncoder()

/** Byte length, because jsonb orders keys by bytes and not by UTF-16 code units. */
function byteLength(value: string): number {
  return encoder.encode(value).length
}

/**
 * jsonb's key collation: shorter key first; ties broken by unsigned byte comparison.
 *
 * This is `lengthCompareJsonbStringValue` in the Postgres source, and it is the single most
 * surprising thing about reproducing jsonb output — every other JSON canonicalisation scheme in
 * the world sorts keys lexicographically.
 */
function compareJsonbKeys(a: string, b: string): number {
  const aBytes = encoder.encode(a)
  const bBytes = encoder.encode(b)
  if (aBytes.length !== bBytes.length) return aBytes.length - bBytes.length
  for (let index = 0; index < aBytes.length; index += 1) {
    const av = aBytes[index] ?? 0
    const bv = bBytes[index] ?? 0
    if (av !== bv) return av - bv
  }
  return 0
}

/**
 * Postgres `escape_json`: quote, backslash, the five shorthand controls, then `\u00xx` (lowercase
 * hex) for anything else below 0x20. Everything at or above 0x20 is emitted raw as UTF-8 —
 * Postgres never escapes non-ASCII, and neither does this.
 */
function escapeJsonString(value: string): string {
  let out = '"'
  for (const char of value) {
    switch (char) {
      case '"':
        out += '\\"'
        break
      case "\\":
        out += "\\\\"
        break
      case "\b":
        out += "\\b"
        break
      case "\f":
        out += "\\f"
        break
      case "\n":
        out += "\\n"
        break
      case "\r":
        out += "\\r"
        break
      case "\t":
        out += "\\t"
        break
      default: {
        const code = char.codePointAt(0) ?? 0
        out += code < 0x20 ? `\\u${code.toString(16).padStart(4, "0")}` : char
      }
    }
  }
  return `${out}"`
}

export class CanonicalizationError extends Error {
  constructor(message: string) {
    super(`[consensus] cannot canonicalise payload: ${message}`)
    this.name = "CanonicalizationError"
  }
}

/**
 * Renders a value exactly as `jsonb::text` would.
 *
 * Strict on purpose. A silently-wrong digest is a vote the server refuses with a message about
 * the *scoreline* being stale, which sends everybody looking in the wrong place.
 */
export function canonicalizeJsonb(value: unknown): string {
  if (value === null) return "null"
  if (typeof value === "boolean") return value ? "true" : "false"
  if (typeof value === "string") return escapeJsonString(value)

  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new CanonicalizationError("non-finite number")
    if (!Number.isInteger(value)) {
      // jsonb stores numbers as `numeric` and renders them with Postgres's own algorithm, which
      // does not agree with JS float formatting in general. Every number in the consensus payload
      // is an integer, so refuse rather than produce a digest that might not match.
      throw new CanonicalizationError(`non-integer number ${value} (only integers are canonicalised)`)
    }
    return String(value)
  }

  if (Array.isArray(value)) {
    // jsonb preserves array order and separates members with ", ".
    return `[${value.map((entry) => canonicalizeJsonb(entry)).join(", ")}]`
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort(compareJsonbKeys)
    const members = keys.map((key) => `${escapeJsonString(key)}: ${canonicalizeJsonb(record[key])}`)
    return `{${members.join(", ")}}`
  }

  throw new CanonicalizationError(`unsupported value of type ${typeof value}`)
}

/** Lowercase hex SHA-256 of a string, via WebCrypto. */
export async function sha256Hex(input: string): Promise<string> {
  if (typeof crypto === "undefined" || !crypto.subtle) {
    // `crypto.subtle` exists only in a secure context. On plain http (other than localhost) it is
    // simply absent, so say so rather than throwing "cannot read property digest of undefined".
    throw new Error(
      "Your browser will not compute a secure hash on an insecure connection. Open this page over HTTPS to vote.",
    )
  }
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input))
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

/* ========================================================================== */
/*  Payload shape                                                             */
/* ========================================================================== */

interface ConsensusPayloadShape {
  nonce: string
  match_id: string
  away_score: number
  home_score: number
  reported_at: string
  participant_ids: string[]
}

function parsePayload(value: unknown): ConsensusPayloadShape | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (typeof raw.nonce !== "string") return null
  if (typeof raw.match_id !== "string") return null
  if (typeof raw.reported_at !== "string") return null
  if (!Number.isInteger(raw.home_score) || !Number.isInteger(raw.away_score)) return null
  if (!Array.isArray(raw.participant_ids)) return null
  if (!raw.participant_ids.every((entry) => typeof entry === "string")) return null

  return {
    nonce: raw.nonce,
    match_id: raw.match_id,
    away_score: raw.away_score as number,
    home_score: raw.home_score as number,
    reported_at: raw.reported_at,
    participant_ids: raw.participant_ids as string[],
  }
}

/* ========================================================================== */
/*  Quorum arithmetic — mirrors public.finalize_consensus()                   */
/* ========================================================================== */

interface QuorumState {
  /** Confirmed participants, falling back to the whole line-up when nobody checked in. */
  eligible: number
  /** ceil(2/3 of the electorate), never fewer than two. */
  required: number
  approvals: number
  rejections: number
  hasHomeApproval: boolean
  hasAwayApproval: boolean
  callerHasVoted: boolean
  callerDecision: "approve" | "reject" | null
}

function computeQuorum(
  participants: { player_id: string; team_side: string | null; is_confirmed: boolean }[],
  approvals: { approver_id: string; decision: string; payload_digest: string | null }[],
  currentDigestHex: string | null,
  callerId: string,
): QuorumState {
  const confirmed = participants.filter((participant) => participant.is_confirmed).length
  const eligible = confirmed > 0 ? confirmed : participants.length
  const required = Math.max(2, Math.ceil((2 * eligible) / 3))

  const sideByPlayer = new Map(participants.map((participant) => [participant.player_id, participant.team_side]))

  /*
   * Only votes cast against the CURRENT canonical payload count. `finalize_consensus` filters on
   * exactly this (plus the round nonce, which rotating a round already clears), and it matters:
   * a late score report can change the most-corroborated scoreline underneath an open round, and
   * nobody may be counted as approving a result they were never shown. Mirroring the filter here
   * keeps the progress bar honest instead of promising a quorum the server will not recognise.
   */
  const expected = currentDigestHex ? `\\x${currentDigestHex}` : null
  const counted = expected
    ? approvals.filter((approval) => (approval.payload_digest ?? "").toLowerCase() === expected)
    : approvals

  let approvalCount = 0
  let rejectionCount = 0
  let hasHomeApproval = false
  let hasAwayApproval = false
  let callerDecision: "approve" | "reject" | null = null

  for (const vote of counted) {
    if (vote.decision === "approve") {
      approvalCount += 1
      const side = sideByPlayer.get(vote.approver_id)
      if (side === "home") hasHomeApproval = true
      if (side === "away") hasAwayApproval = true
    } else if (vote.decision === "reject") {
      rejectionCount += 1
    }
    if (vote.approver_id === callerId) {
      callerDecision = vote.decision === "approve" ? "approve" : "reject"
    }
  }

  // The caller's own vote counts as cast even against a superseded digest — they cannot vote twice
  // (`consensus_approvals_unique`), so hiding their earlier vote would offer them a button that
  // can only fail.
  const votedAtAll = approvals.some((approval) => approval.approver_id === callerId)

  return {
    eligible,
    required,
    approvals: approvalCount,
    rejections: rejectionCount,
    hasHomeApproval,
    hasAwayApproval,
    callerHasVoted: votedAtAll,
    callerDecision,
  }
}

/* ========================================================================== */
/*  Countdown                                                                 */
/* ========================================================================== */

function useCountdown(deadline: string | null): { text: string; expired: boolean; ready: boolean } {
  // `null` until the browser has ticked, so server and client markup agree.
  const [now, setNow] = useState<number | null>(null)

  useEffect(() => {
    if (!deadline) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [deadline])

  return useMemo(() => {
    if (!deadline || now === null) return { text: "", expired: false, ready: false }
    const end = Date.parse(deadline)
    if (Number.isNaN(end)) return { text: "", expired: false, ready: false }

    const remaining = Math.floor((end - now) / 1000)
    if (remaining <= 0) return { text: "Voting has closed", expired: true, ready: true }

    const hours = Math.floor(remaining / 3600)
    const minutes = Math.floor((remaining % 3600) / 60)
    const seconds = remaining % 60

    const text =
      hours > 0
        ? `${hours}h ${minutes.toString().padStart(2, "0")}m left`
        : minutes > 0
          ? `${minutes}m ${seconds.toString().padStart(2, "0")}s left`
          : `${seconds}s left`

    return { text, expired: false, ready: true }
  }, [deadline, now])
}

/* ========================================================================== */
/*  The panel                                                                 */
/* ========================================================================== */

export interface ConsensusPanelProps {
  matchId: string
  /** The signed-in profile id. Only a row in `match_participants` may vote. */
  viewerId: string
  /** `matches.consensus_deadline`. */
  deadline: string | null
  homeTeamName?: string | null
  awayTeamName?: string | null
  /** False for spectators and the venue owner: they may read the round, not vote in it. */
  canVote: boolean
  /**
   * The VENUE's IANA zone, for rendering `reported_at`. `consensus_payload()` returns that
   * timestamp forced to UTC (the digest depends on it), which is not a wall clock any player
   * recognises. Defaults to the same zone `formatKickoff` does.
   */
  timeZone?: string
  className?: string
}

type LoadState =
  | { phase: "loading" }
  | { phase: "error"; title: string; body: string; hint?: string }
  | {
      phase: "ready"
      payload: ConsensusPayloadShape
      canonical: string
      digest: string
      quorum: QuorumState
    }

export function ConsensusPanel({
  matchId,
  viewerId,
  deadline,
  homeTeamName,
  awayTeamName,
  canVote,
  timeZone = "Europe/Istanbul",
  className,
}: ConsensusPanelProps) {
  const supabase = useMemo(() => createClient(), [])
  const router = useRouter()

  const [state, setState] = useState<LoadState>({ phase: "loading" })
  const [submitting, setSubmitting] = useState<"approve" | "reject" | null>(null)
  const [voteError, setVoteError] = useState<{ title: string; body: string; hint?: string } | null>(null)
  const [showBytes, setShowBytes] = useState(false)

  const countdown = useCountdown(deadline)

  const home = homeTeamName ?? "Home"
  const away = awayTeamName ?? "Away"

  /* ---- load ------------------------------------------------------------ */

  const load = useCallback(async () => {
    setState({ phase: "loading" })
    setVoteError(null)

    const { data, error } = await supabase.rpc("consensus_payload", { p_match_id: matchId })

    if (error) {
      const plain = toPlainError(error as PostgrestError)
      setState({ phase: "error", title: plain.title, body: plain.body, hint: plain.hint })
      return
    }

    const payload = parsePayload(data)
    if (!payload) {
      setState({
        phase: "error",
        title: "Tur okunamadı",
        body: "Sunucu, uygulamanın bu sürümünün anlamadığı bir uzlaşma verisi döndürdü. Sayfayı yenile.",
      })
      return
    }

    let canonical: string
    let digest: string
    try {
      canonical = canonicalizeJsonb(payload)
      digest = await sha256Hex(canonical)
    } catch (cause) {
      setState({
        phase: "error",
        title: "Bu cihaz sonucu doğrulayamıyor",
        body: cause instanceof Error ? cause.message : "Veri bu cihazda özetlenemedi.",
      })
      return
    }

    const [participantsResult, approvalsResult] = await Promise.all([
      supabase
        .from("match_participants")
        .select("player_id, team_side, is_confirmed")
        .eq("match_id", matchId),
      supabase
        .from("consensus_approvals")
        .select("approver_id, decision, payload_digest")
        .eq("match_id", matchId),
    ])

    const quorum = computeQuorum(
      participantsResult.data ?? [],
      approvalsResult.data ?? [],
      digest,
      viewerId,
    )

    setState({ phase: "ready", payload, canonical, digest, quorum })
  }, [supabase, matchId, viewerId])

  useEffect(() => {
    void load()
  }, [load])

  /* ---- vote ------------------------------------------------------------ */

  const vote = useCallback(
    async (decision: "approve" | "reject") => {
      if (state.phase !== "ready") return
      setSubmitting(decision)
      setVoteError(null)

      try {
        const { error } = await supabase.rpc("submit_consensus_approval", {
          p_match_id: matchId,
          p_decision: decision,
          // bytea over PostgREST is the Postgres hex input format: a literal backslash, an 'x',
          // then the digest. The server compares it byte-for-byte with its own recomputation.
          p_client_digest: `\\x${state.digest}`,
          // No signature is sent. `signature` is an evidentiary receipt HMAC'd with a
          // session-derived key, and no key-derivation scheme is defined for this client yet; the
          // column is nullable precisely so the Ed25519 upgrade can land later without changing
          // the call shape. Sending a fabricated value would be worse than sending none.
        })

        if (error) {
          const plain = toPlainError(error as PostgrestError)
          setVoteError(plain)
          // A digest mismatch means the scoreline moved under us — the only honest response is to
          // re-read the payload and make the user look at the new one before voting again.
          if (error.code === "PT409") void load()
          return
        }

        await load()
        router.refresh()
      } finally {
        setSubmitting(null)
      }
    },
    [state, supabase, matchId, load, router],
  )

  /* ---- render ---------------------------------------------------------- */

  if (state.phase === "loading") {
    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle className="text-base">Sonuç üzerinde uzlaşma</CardTitle>
          <CardDescription>Loading the round…</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </CardContent>
      </Card>
    )
  }

  if (state.phase === "error") {
    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle className="text-base">Sonuç üzerinde uzlaşma</CardTitle>
        </CardHeader>
        <CardContent>
          <Alert variant="destructive">
            <AlertTitle>{state.title}</AlertTitle>
            <AlertDescription>
              {state.body}
              {state.hint ? <span className="mt-1 block text-xs opacity-80">{state.hint}</span> : null}
            </AlertDescription>
          </Alert>
        </CardContent>
        <CardFooter>
          <Button variant="outline" onClick={() => void load()}>
            Tekrar dene
          </Button>
        </CardFooter>
      </Card>
    )
  }

  const { payload, canonical, digest, quorum } = state
  const approvalProgress = Math.min(100, Math.round((quorum.approvals / quorum.required) * 100))
  const votingClosed = countdown.expired
  const bothSides = quorum.hasHomeApproval && quorum.hasAwayApproval

  return (
    <Card className={cn("border-amber-500/40", className)}>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base">Sonucu onayla</CardTitle>
            <CardDescription>
              Bu maçın bildirimleri çeliştiği için hangi skorun geçerli olacağına kadro karar veriyor.
            </CardDescription>
          </div>
          {deadline ? (
            <Badge variant={votingClosed ? "destructive" : "outline"} className="shrink-0 tabular-nums">
              {countdown.ready ? countdown.text : "—"}
            </Badge>
          ) : null}
        </div>
      </CardHeader>

      <CardContent className="space-y-5">
        {/* -------- what is on the table --------------------------------- */}
        <div className="rounded-lg border bg-muted/40 p-4">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Oylanan</p>
          <p className="mt-1 flex flex-wrap items-baseline gap-x-3 text-2xl font-semibold tabular-nums">
            <span className="truncate text-base font-medium">{home}</span>
            <span>
              {payload.home_score}
              <span className="px-1 text-muted-foreground" aria-hidden="true">
                –
              </span>
              {payload.away_score}
            </span>
            <span className="truncate text-base font-medium">{away}</span>
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            First reported{" "}
            <time dateTime={payload.reported_at}>
              {formatReportedAt(payload.reported_at, timeZone)}
            </time>{" "}
            ·{" "}
            {payload.participant_ids.length}{" "}
            {payload.participant_ids.length === 1 ? "player" : "players"} in the line-up
          </p>
        </div>

        {/* -------- the one-sentence explanation -------------------------- */}
        <p className="text-sm leading-relaxed">
          Your vote is stamped with a fingerprint of{" "}
          <strong>tam olarak bu skor, bu kadro ve bu tur</strong> — so an approval can
          never be counted towards a different result than the one on your screen.
        </p>

        {/* -------- the digest -------------------------------------------- */}
        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-mono text-xs text-muted-foreground">
              <span className="sr-only">Veri parmak izi (SHA-256): </span>
              <span aria-hidden="true">sha256 </span>
              {digest.slice(0, 8)}…{digest.slice(-8)}
            </p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => setShowBytes((current) => !current)}
              aria-expanded={showBytes}
            >
              {showBytes ? "Hide" : "Show"} what was hashed
            </Button>
          </div>

          {showBytes ? (
            <div className="space-y-2">
              <pre className="max-h-48 overflow-auto rounded-md border bg-background p-3 text-[11px] leading-relaxed">
                <code>{canonical}</code>
              </pre>
              <p className="break-all font-mono text-[11px] text-muted-foreground">{digest}</p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Bunlar tarayıcının özetlediği baytların aynısı. Sunucu bunları bağımsız olarak yeniden üretir ve iki özet farklıysa oyu reddeder; böylece ne bu sayfa ne de ağ, senin evetinin arkasına başka bir sonuç koyabilir.
              </p>
            </div>
          ) : null}
        </div>

        <Separator />

        {/* -------- quorum ------------------------------------------------ */}
        <div className="space-y-3">
          <div className="flex items-baseline justify-between gap-2 text-sm">
            <span className="font-medium">Onaylar</span>
            <span className="tabular-nums text-muted-foreground">
              {quorum.approvals} of {quorum.required} needed
            </span>
          </div>

          <div
            className="h-2 w-full overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-valuenow={quorum.approvals}
            aria-valuemin={0}
            aria-valuemax={quorum.required}
            aria-label={`${quorum.approvals} of ${quorum.required} approvals needed`}
          >
            <div
              className="h-full rounded-full bg-emerald-500 transition-[width] duration-500"
              style={{ width: `${approvalProgress}%` }}
            />
          </div>

          <ul className="space-y-1.5 text-xs text-muted-foreground">
            <li className="flex items-center gap-2">
              <Tick on={quorum.approvals >= quorum.required} />
              Two thirds of the {quorum.eligible} checked-in{" "}
              {quorum.eligible === 1 ? "player" : "players"} have approved
            </li>
            <li className="flex items-center gap-2">
              <Tick on={bothSides} />
              At least one approval from each side{" "}
              <span className="opacity-80">
                ({quorum.hasHomeApproval ? home : `no ${home} yet`},{" "}
                {quorum.hasAwayApproval ? away : `no ${away} yet`})
              </span>
            </li>
          </ul>

          <p className="text-xs leading-relaxed text-muted-foreground">
            Both conditions are required. Without the cross-side rule, one stacked dressing room
            could ratify a result on its own.
            {quorum.rejections > 0 ? (
              <>
                {" "}
                <span className="text-destructive">
                  {quorum.rejections} {quorum.rejections === 1 ? "player has" : "players have"}{" "}
                  rejected this scoreline.
                </span>
              </>
            ) : null}
          </p>
        </div>

        {voteError ? (
          <Alert variant="destructive" role="alert">
            <AlertTitle>{voteError.title}</AlertTitle>
            <AlertDescription>
              {voteError.body}
              {voteError.hint ? (
                <span className="mt-1 block text-xs opacity-80">{voteError.hint}</span>
              ) : null}
            </AlertDescription>
          </Alert>
        ) : null}
      </CardContent>

      <CardFooter className="flex-col items-stretch gap-3">
        {quorum.callerHasVoted ? (
          <p className="text-sm text-muted-foreground">
            Bu sonucu{" "}
            <strong>{quorum.callerDecision === "reject" ? "reddettin" : "onayladın"}</strong>. Oy
            bir kez verilir ve sonradan değiştirilemez.
          </p>
        ) : !canVote ? (
          <p className="text-sm text-muted-foreground">
            Bu maçın sonucuna yalnızca maçta oynayanlar oy verebilir. Turu izleyebilirsin ama katılamazsın.
          </p>
        ) : votingClosed ? (
          <p className="text-sm text-muted-foreground">
            Oylama süresi kapandı. Sonucu bir yönetici karara bağlayacak.
          </p>
        ) : (
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              type="button"
              className="flex-1"
              disabled={submitting !== null}
              onClick={() => void vote("approve")}
            >
              {submitting === "approve" ? "Submitting…" : `Approve ${payload.home_score}–${payload.away_score}`}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="flex-1"
              disabled={submitting !== null}
              onClick={() => void vote("reject")}
            >
              {submitting === "reject" ? "Submitting…" : "That is not the score"}
            </Button>
          </div>
        )}

        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="self-start text-xs"
          onClick={() => void load()}
          disabled={submitting !== null}
        >
          Turu yenile
        </Button>
      </CardFooter>
    </Card>
  )
}

/* -------------------------------------------------------------------------- */

/**
 * `reported_at` in the venue's zone, with the zone named.
 *
 * The raw value is the server's canonical UTC rendering (`2026-08-30T18:00:00Z`), which is what
 * the digest is computed over and must stay untouched in `dateTime`. Printing it verbatim showed
 * a voter a wall clock up to three hours off the kickoff they attended, so the visible text goes
 * through `Intl` in the venue's zone like every other date on the match surface. An unparseable
 * value falls back to the raw string rather than rendering nothing.
 */
function formatReportedAt(isoInstant: string, timeZone: string): string {
  const instant = new Date(isoInstant)
  if (Number.isNaN(instant.getTime())) return isoInstant

  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone,
      dateStyle: "medium",
      timeStyle: "short",
      timeZoneName: "short",
    }).format(instant)
  } catch {
    // An unknown IANA zone from the venue row must not blank out the round.
    return isoInstant
  }
}

/**
 * The state marker for a quorum criterion.
 *
 * The glyph is decorative, but whether the criterion is MET is not — with the tick `aria-hidden`
 * and nothing else carrying the state, a screen reader read "Two thirds ... have approved" as a
 * flat assertion whether or not it was true. The `sr-only` span puts the state back in the
 * accessible name of the list item.
 */
function Tick({ on }: { on: boolean }) {
  return (
    <>
      <span
        aria-hidden="true"
        className={cn(
          "grid size-4 shrink-0 place-items-center rounded-full text-[10px] font-bold",
          on ? "bg-emerald-500 text-white" : "border border-current text-muted-foreground",
        )}
      >
        {on ? "✓" : ""}
      </span>
      <span className="sr-only">{on ? "Met: " : "Not yet met: "}</span>
    </>
  )
}
