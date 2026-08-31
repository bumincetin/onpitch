/**
 * components/match/consensus-card.tsx
 *
 * Peer ratification of a contested result, and the canonicalisation the vote is built on.
 *
 * ---------------------------------------------------------------------------------------------
 * THE CANONICAL PAYLOAD, AND WHY THE BYTES MATTER
 * ---------------------------------------------------------------------------------------------
 *
 * `public.submit_consensus_approval()` will not accept a bare "yes". It requires
 * `sha256(canonical_payload)` computed by the CLIENT, recomputes the digest server-side, and
 * rejects the vote when they differ. That is the whole point: a bare approval does not say WHAT
 * was approved, so a stale or tampered client could show you 3–2, take your yes, and have the
 * server record 5–0. Binding the vote to a digest makes it a commitment to one scoreline, one
 * line-up and one round nonce.
 *
 * The digest only means anything if both sides hash IDENTICAL BYTES. The server's bytes are
 * PostgreSQL's `jsonb::text` rendering of `public.consensus_payload(match_id)`, pinned in the
 * comment on that function in `0005_integrity_consensus.sql`. Reproducing it takes three rules,
 * none of them what a JavaScript developer would guess:
 *
 *   1. KEY ORDER is (byte length ASC, then bytewise ASC) — NOT alphabetical. For this payload that
 *      resolves to nonce, match_id, away_score, home_score, reported_at, participant_ids.
 *      `nonce` is first because it is the shortest key; `away_score` precedes `home_score` only
 *      because they tie on length. Sorted-key `JSON.stringify` gets this wrong.
 *
 *   2. WHITESPACE IS NOT STRIPPED. Postgres emits exactly one space after every `:` and every `,`
 *      — `{"a": 1, "b": [1, 2]}`. `JSON.stringify` emits none, which is a different digest.
 *
 *   3. VALUES are rendered Postgres-style: participant uuids lowercase and already sorted by byte
 *      (COLLATE "C") by the server, the timestamp already forced to UTC at second precision,
 *      scores as bare JSON integers.
 *
 * {@link canonicalizeJsonb} implements exactly that, and is deliberately strict — it throws rather
 * than guess on a float or a nested object, because a wrong digest comes back from the server as a
 * message about the SCORELINE being stale, which sends everybody looking in the wrong place.
 *
 * This is a port of `canonicalizeJsonb` in `apps/web/components/match/consensus-panel.tsx`, which
 * is one of the two reference implementations the migration names. Keep them identical.
 *
 * The digest is not a secret: anyone entitled to read the payload can compute it, and the server
 * returns the expected value in the mismatch error so an honest client can resync. What it buys is
 * evidentiary — a stored approval records precisely which scoreline and roster its owner assented
 * to, and a client showing a stale score can never have that assent counted.
 */

// REQUIRES `expo-crypto`. Hermes has no WebCrypto: `crypto.subtle` is undefined on device, so the
// browser implementation cannot be reused. Add it with `npx expo install expo-crypto`.
import * as Crypto from 'expo-crypto'
import * as React from 'react'
import { View } from 'react-native'

import { Badge, Button, Notice, Separator, Text } from '@/components/ui'
import { formatRelative } from '@/lib/format'
import { useTheme } from '@/lib/theme'

/* ========================================================================== */
/*  Canonical JSON — a faithful reimplementation of Postgres `jsonb::text`    */
/* ========================================================================== */

/**
 * Length of a string in UTF-8 bytes, because jsonb orders keys by bytes and not by UTF-16 units.
 *
 * Counted by hand rather than with `TextEncoder`. Hermes does not guarantee that global, and
 * `react-native-url-polyfill` only supplies `URL` and `URLSearchParams` — a missing constructor at
 * module scope would throw while this file is being imported and take every match screen with it.
 * The arithmetic is fixed by the UTF-8 spec and cannot drift.
 */
export function utf8Length(value: string): number {
  let bytes = 0
  // A `for…of` over a string iterates by CODE POINT, so an emoji is one step of four bytes rather
  // than two surrogate halves of three.
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code < 0x10000) bytes += 3
    else bytes += 4
  }
  return bytes
}

/** Code points of a string, in order. */
function codePointsOf(value: string): number[] {
  return Array.from(value, (char) => char.codePointAt(0) ?? 0)
}

/**
 * jsonb's key collation: shorter key first, ties broken by unsigned byte comparison.
 *
 * This is `lengthCompareJsonbStringValue` in the Postgres source, and it is the single most
 * surprising thing about reproducing jsonb output — every other JSON canonicalisation scheme in
 * the world sorts keys lexicographically.
 *
 * The tie-break compares CODE POINTS, which is the same ordering as comparing UTF-8 bytes (UTF-8
 * is order-preserving) and is not the same as JavaScript's `<`, which compares UTF-16 units and
 * therefore sorts an astral character below U+E000.
 */
function compareJsonbKeys(a: string, b: string): number {
  const aLength = utf8Length(a)
  const bLength = utf8Length(b)
  if (aLength !== bLength) return aLength - bLength

  const aPoints = codePointsOf(a)
  const bPoints = codePointsOf(b)
  const shared = Math.min(aPoints.length, bPoints.length)

  for (let index = 0; index < shared; index += 1) {
    // `noUncheckedIndexedAccess`: both reads are `number | undefined` until defaulted, and the
    // loop stops at the shorter array, so the default is never actually reached.
    const av = aPoints[index] ?? 0
    const bv = bPoints[index] ?? 0
    if (av !== bv) return av - bv
  }

  return aPoints.length - bPoints.length
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
      case '\\':
        out += '\\\\'
        break
      case '\b':
        out += '\\b'
        break
      case '\f':
        out += '\\f'
        break
      case '\n':
        out += '\\n'
        break
      case '\r':
        out += '\\r'
        break
      case '\t':
        out += '\\t'
        break
      default: {
        const code = char.codePointAt(0) ?? 0
        out += code < 0x20 ? `\\u${code.toString(16).padStart(4, '0')}` : char
      }
    }
  }
  return `${out}"`
}

export class CanonicalizationError extends Error {
  constructor(message: string) {
    super(`[consensus] cannot canonicalise payload: ${message}`)
    this.name = 'CanonicalizationError'
    // Hermes runs the class down-level in some release configurations, and without this
    // `err instanceof CanonicalizationError` quietly returns false in a release build.
    Object.setPrototypeOf(this, CanonicalizationError.prototype)
  }
}

/**
 * Renders a value exactly as `jsonb::text` would.
 *
 * Strict on purpose. A silently-wrong digest is refused by the server with a message about the
 * scoreline being stale, and that is a bad place to start debugging.
 */
export function canonicalizeJsonb(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'string') return escapeJsonString(value)

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new CanonicalizationError('non-finite number')
    if (!Number.isInteger(value)) {
      // jsonb stores numbers as `numeric` and renders them with Postgres's own algorithm, which
      // does not agree with JavaScript float formatting in general. Every number in the consensus
      // payload is an integer, so refuse rather than produce a digest that might not match.
      throw new CanonicalizationError(
        `non-integer number ${value} (only integers are canonicalised)`,
      )
    }
    return String(value)
  }

  if (Array.isArray(value)) {
    // jsonb preserves array order and separates members with ", ".
    return `[${value.map((entry) => canonicalizeJsonb(entry)).join(', ')}]`
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort(compareJsonbKeys)
    const members = keys.map((key) => `${escapeJsonString(key)}: ${canonicalizeJsonb(record[key])}`)
    return `{${members.join(', ')}}`
  }

  throw new CanonicalizationError(`unsupported value of type ${typeof value}`)
}

/**
 * Lowercase hex SHA-256, computed on the device.
 *
 * `expo-crypto` rather than WebCrypto: Hermes ships no `crypto.subtle`, so the browser path used
 * by the web panel does not exist here. `digestStringAsync` encodes the input as UTF-8 and hands
 * the work to the platform's own crypto library, which is the same bytes the server hashed.
 */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, input, {
    encoding: Crypto.CryptoEncoding.HEX,
  })
  return digest.toLowerCase()
}

/* ========================================================================== */
/*  Payload shape                                                             */
/* ========================================================================== */

/** The object `public.consensus_payload()` returns, as it comes off the wire. */
export interface ConsensusPayloadShape {
  nonce: string
  match_id: string
  away_score: number
  home_score: number
  reported_at: string
  participant_ids: string[]
}

/**
 * Parses the RPC result, or returns null.
 *
 * A parse and not a cast: this is a trust boundary, and the digest computed from a half-present
 * object would be a vote for something nobody was shown.
 */
export function parseConsensusPayload(value: unknown): ConsensusPayloadShape | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>

  if (typeof raw.nonce !== 'string') return null
  if (typeof raw.match_id !== 'string') return null
  if (typeof raw.reported_at !== 'string') return null
  if (typeof raw.home_score !== 'number' || !Number.isInteger(raw.home_score)) return null
  if (typeof raw.away_score !== 'number' || !Number.isInteger(raw.away_score)) return null
  if (!Array.isArray(raw.participant_ids)) return null

  const participantIds: string[] = []
  for (const entry of raw.participant_ids) {
    if (typeof entry !== 'string') return null
    participantIds.push(entry)
  }

  return {
    nonce: raw.nonce,
    match_id: raw.match_id,
    away_score: raw.away_score,
    home_score: raw.home_score,
    reported_at: raw.reported_at,
    participant_ids: participantIds,
  }
}

/**
 * The device's own view of the round: the bytes it built and the digest it computed over them.
 *
 * Both are kept, not just the digest, because the canonical string is what makes a mismatch
 * diagnosable — it can be compared with `ConsensusRound.canonical` from the API character by
 * character instead of guessing which of the three rules went wrong.
 */
export interface LocalDigest {
  canonical: string
  digest: string
}

/**
 * Canonicalise and hash on this device.
 *
 * Takes the RAW value the RPC returned, not the parsed shape. If a future migration adds a field
 * to the payload, the raw object still hashes to what the server hashed, whereas a re-built object
 * would silently drop the new field and produce a digest that is rejected as stale.
 * {@link parseConsensusPayload} is for rendering; this is for signing.
 */
export async function computeLocalDigest(raw: unknown): Promise<LocalDigest> {
  const canonical = canonicalizeJsonb(raw)
  const digest = await sha256Hex(canonical)
  return { canonical, digest }
}

/* ========================================================================== */
/*  The card                                                                  */
/* ========================================================================== */

/** The counting state of the open round, from `GET /api/matches/[id]/consensus`. */
export interface ConsensusRoundState {
  deadline: string | null
  quorumRequired: number
  approvals: number
  rejections: number
  hasHomeApproval: boolean
  hasAwayApproval: boolean
  callerHasVoted: boolean
}

export interface ConsensusCardProps {
  payload: ConsensusPayloadShape
  /** What this device computed. Submitted with the vote. */
  local: LocalDigest
  /** The digest the server reported for the same round, or null when it was not read. */
  serverDigest: string | null
  round: ConsensusRoundState
  homeLabel: string
  awayLabel: string
  /** Which button is busy, if either. */
  submitting: 'approve' | 'reject' | null
  onVote: (decision: 'approve' | 'reject') => void
  /** Set when voting is not possible — not a participant, round closed, digest mismatch. */
  disabledReason?: string | null
}

export function ConsensusCard({
  payload,
  local,
  serverDigest,
  round,
  homeLabel,
  awayLabel,
  submitting,
  onVote,
  disabledReason = null,
}: ConsensusCardProps): React.ReactElement {
  const theme = useTheme()

  const mismatch = serverDigest !== null && serverDigest !== local.digest
  const busy = submitting !== null
  const blocked = mismatch || round.callerHasVoted || Boolean(disabledReason)

  const progress = Math.min(1, round.quorumRequired > 0 ? round.approvals / round.quorumRequired : 0)

  return (
    <View
      style={{
        gap: theme.spacing.lg,
        padding: theme.spacing.lg,
        borderRadius: theme.radius.xl,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.card,
      }}
    >
      <View style={{ gap: theme.spacing.xs }}>
        <Text variant="heading" accessibilityRole="header">
          Sonucu onayla
        </Text>
        <Text variant="body" tone="muted">
          The reports disagreed, so the line-up decides. It takes {round.quorumRequired} approvals
          including at least one from each side.
        </Text>
      </View>

      {/* The document being voted on. */}
      <View
        accessible
        accessibilityLabel={`The scoreline on the table: ${homeLabel} ${payload.home_score}, ${awayLabel} ${payload.away_score}, with ${payload.participant_ids.length} players in the line-up.`}
        style={{
          gap: theme.spacing.sm,
          padding: theme.spacing.lg,
          borderRadius: theme.radius.lg,
          backgroundColor: theme.colors.muted,
        }}
      >
        <Text variant="label" tone="muted">
          Oylanan
        </Text>
        <Text variant="display" weight="700" style={{ fontVariant: ['tabular-nums'] }}>
          {payload.home_score} – {payload.away_score}
        </Text>
        <Text variant="caption" tone="muted">
          {homeLabel} against {awayLabel} · {payload.participant_ids.length} players in the line-up
          · first reported {formatRelative(payload.reported_at)}
        </Text>
      </View>

      {/* The one line that says what a yes actually commits to. */}
      <Text variant="body">
        Oyun tam olarak bu skora ve bu kadroya bağlıdır — biri değişirse oy sayılmaz ve sana yeniden sorulur.
      </Text>

      <Text variant="caption" tone="muted">
        Checked on this device: digest {local.digest.slice(0, 12)}… over{' '}
        {utf8Length(local.canonical)} bytes, round {payload.nonce.slice(0, 8)}…
      </Text>

      {mismatch ? (
        <Notice
          tone="destructive"
          live
          title="Sunucunun saydığı sonuç bu değil"
          description="Bu ekran açıkken skor değişti ya da veri yolda değiştirildi. Oy vermeden önce yenile — yanlış belgeye verilen oy zaten reddedilir."
        />
      ) : null}

      <Separator />

      {/* Quorum progress. */}
      <View style={{ gap: theme.spacing.sm }}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            gap: theme.spacing.sm,
          }}
        >
          <Text variant="label" tone="muted">
            Onaylar
          </Text>
          <Text variant="label" style={{ fontVariant: ['tabular-nums'] }}>
            {round.approvals} of {round.quorumRequired}
          </Text>
        </View>

        <View
          accessibilityRole="progressbar"
          accessibilityLabel={`${round.approvals} of ${round.quorumRequired} approvals`}
          accessibilityValue={{ min: 0, max: round.quorumRequired, now: round.approvals }}
          style={{
            height: 8,
            borderRadius: theme.radius.full,
            backgroundColor: theme.colors.muted,
            overflow: 'hidden',
          }}
        >
          <View
            style={{
              width: `${Math.round(progress * 100)}%`,
              height: '100%',
              backgroundColor: theme.colors.primary,
            }}
          />
        </View>

        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm }}>
          <Badge tone={round.hasHomeApproval ? 'success' : 'outline'} size="sm">
            {round.hasHomeApproval ? 'Home approved' : 'Home has not approved'}
          </Badge>
          <Badge tone={round.hasAwayApproval ? 'success' : 'outline'} size="sm">
            {round.hasAwayApproval ? 'Away approved' : 'Away has not approved'}
          </Badge>
          {round.rejections > 0 ? (
            <Badge tone="destructive" size="sm">
              {round.rejections} against
            </Badge>
          ) : null}
        </View>

        {round.deadline ? (
          <Text variant="caption" tone="muted">
            Voting closes {formatRelative(round.deadline)}. After that an administrator settles it.
          </Text>
        ) : null}
      </View>

      {/* Actions. */}
      {round.callerHasVoted ? (
        <Notice
          tone="success"
          title="Oyun kaydedildi"
          description="Bir oyu değiştiremezsin; çünkü o, neyi onayladığının kaydıdır. Tur, yeterli sayıda oy verildiğinde ya da süre dolduğunda kapanır."
        />
      ) : disabledReason ? (
        <Notice tone="info" title="Bu turda oy veremezsin" description={disabledReason} />
      ) : (
        <View style={{ gap: theme.spacing.md }}>
          <Button
            title={`Approve ${payload.home_score}–${payload.away_score}`}
            size="lg"
            fullWidth
            loading={submitting === 'approve'}
            disabled={blocked || busy}
            onPress={() => onVote('approve')}
          />
          <Button
            title="Skor bu değil"
            variant="outline"
            size="lg"
            fullWidth
            loading={submitting === 'reject'}
            disabled={blocked || busy}
            onPress={() => onVote('reject')}
          />
        </View>
      )}
    </View>
  )
}
