/**
 * packages/shared/src/channels.ts
 *
 * THE single source of truth for Realtime topic strings and broadcast event names.
 *
 * Nothing else in the codebase may build a topic by string concatenation. Every topic here is
 * mirrored, character for character, by an RLS policy on `realtime.messages` in
 * `supabase/migrations/0006_realtime.sql`. A topic this file cannot
 * produce is a topic no policy authorises, and Realtime fails a private-channel join with no
 * rows rather than an error — so a typo does not throw, it silently delivers nothing.
 *
 * ---------------------------------------------------------------------------------------------
 * TOPIC  <->  POLICY MAP  (supabase/migrations/0006_realtime.sql §5)
 * ---------------------------------------------------------------------------------------------
 *
 *   matchTopic(id)         `match:<uuid>`
 *                            READ   rt_match_public_read   — anyone who may SELECT the match
 *                                                            (private.realtime_can_read_match,
 *                                                            SECURITY INVOKER, so it *is* the
 *                                                            matches SELECT policy from 0002)
 *                            WRITE  rt_match_public_write  — participants, the venue owner of
 *                                                            the match, admins
 *                            Carries: live score ticks, status hints, roster hints, presence.
 *
 *   matchPrivateTopic(id)  `match:<uuid>:private`
 *                            READ   rt_match_private_read  — rows in match_participants
 *                                                            (confirmed or not) + admins
 *                            WRITE  rt_match_private_write — same audience
 *                            Carries: consensus prompts, dispute traffic, integrity state.
 *
 *   venueTopic(id)         `venue:<uuid>`
 *                            READ   rt_venue_read          — the venue owner + admins
 *                            WRITE  rt_venue_write         — the venue owner + admins
 *                            Carries: occupancy / booking ticks for the owner dashboard.
 *
 *   presenceTopic(id)      IS `match:<uuid>` — an alias, not a fourth topic. 0006 §7 is explicit
 *                          that presence rides the score channel so there is one socket, one
 *                          authorisation, and no `presence:*` topic that would match no policy
 *                          at all (RLS with zero policies denies) and therefore never join.
 *
 * ---------------------------------------------------------------------------------------------
 * TWO RULES
 * ---------------------------------------------------------------------------------------------
 *
 * 1. Every one of these is a PRIVATE channel. You must join with
 *    `supabase.channel(topic, { config: { private: true } })`. A channel joined without
 *    `private: true` performs no authorisation whatsoever — Realtime never consults
 *    `realtime.messages`, so the ACLs above do not run at all, and the feed is readable by
 *    anyone who joins the topic.
 *
 * 2. Topic strings coming back off the wire are attacker-influenced. {@link parseTopic} is total:
 *    given garbage it returns `null`, never throws. The SQL helpers are deliberately built the
 *    same way (`substring(... from <anchored regex>)` rather than `::uuid`, which would raise
 *    22P02 inside a policy and hand a prober a distinguishable error).
 *
 * This module is isomorphic: no React, no `@supabase/*` import, no browser globals. It is safe
 * in a Server Component, a Route Handler, an Edge function and a `'use client'` island alike.
 */

/* ========================================================================== */
/*  UUID recognition — mirrors the anchored regexes in 0006 §4                */
/* ========================================================================== */

/**
 * The exact character class the SQL helpers accept: 8-4-4-4-12 hex, either case.
 *
 * Case-insensitive on the way IN (so a topic minted by another client still parses) and forced
 * lowercase on the way OUT (Postgres renders `uuid::text` lowercase, and the digest / topic
 * comparisons downstream are byte comparisons).
 */
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

const MATCH_TOPIC_RE =
  /^match:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(:private)?$/

const VENUE_TOPIC_RE =
  /^venue:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/

/** True for a canonical 8-4-4-4-12 UUID in either case. */
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value)
}

/**
 * Thrown by the topic builders when handed something that is not a UUID.
 *
 * Building a topic is always a programming step (the id came from the database or the route
 * params), so a bad id is a bug to surface loudly — unlike PARSING a topic, which handles
 * untrusted input and must stay total.
 */
export class InvalidTopicIdError extends Error {
  constructor(kind: string, value: unknown) {
    super(`[realtime] cannot build a ${kind} topic from ${JSON.stringify(value)}: not a UUID.`)
    this.name = "InvalidTopicIdError"
  }
}

function requireUuid(kind: string, value: string): string {
  if (!isUuid(value)) throw new InvalidTopicIdError(kind, value)
  return value.toLowerCase()
}

/* ========================================================================== */
/*  Topic builders                                                            */
/* ========================================================================== */

/** `match:<uuid>` — the wide live-score topic. Wide READ, narrow WRITE. */
export function matchTopic(matchId: string): string {
  return `match:${requireUuid("match", matchId)}`
}

/** `match:<uuid>:private` — participants and admins only. */
export function matchPrivateTopic(matchId: string): string {
  return `match:${requireUuid("match", matchId)}:private`
}

/** `venue:<uuid>` — the owning venue owner and admins. */
export function venueTopic(venueId: string): string {
  return `venue:${requireUuid("venue", venueId)}`
}

/**
 * Presence for a match.
 *
 * Identical to {@link matchTopic} on purpose (0006 §7): presence rides the score channel.
 * The alias exists so a call site can say what it wants — `presenceTopic(id)` at a headcount
 * and `matchTopic(id)` at a scoreboard — while both resolve to one channel, one join, one ACL.
 */
export function presenceTopic(matchId: string): string {
  return matchTopic(matchId)
}

/* ========================================================================== */
/*  Topic parsing — total, never throws                                       */
/* ========================================================================== */

export type TopicKind = "match" | "match_private" | "venue"

export interface ParsedTopic {
  kind: TopicKind
  /** Lowercase UUID of the match (kind `match` / `match_private`) or venue (kind `venue`). */
  id: string
  /** The normalised topic string, i.e. what the builders would have produced. */
  topic: string
}

/**
 * Parses a topic string back into `{ kind, id }`, or `null` when it is not one of ours.
 *
 * Total by contract — this is the mirror of the SQL helpers, which return NULL for malformed
 * input so that every downstream `EXISTS` collapses to false and the join fails closed.
 */
export function parseTopic(topic: unknown): ParsedTopic | null {
  if (typeof topic !== "string") return null

  const matchHit = MATCH_TOPIC_RE.exec(topic)
  if (matchHit) {
    const raw = matchHit[1]
    if (!raw) return null
    const id = raw.toLowerCase()
    const isPrivate = matchHit[2] === ":private"
    return {
      kind: isPrivate ? "match_private" : "match",
      id,
      topic: isPrivate ? `match:${id}:private` : `match:${id}`,
    }
  }

  const venueHit = VENUE_TOPIC_RE.exec(topic)
  if (venueHit) {
    const raw = venueHit[1]
    if (!raw) return null
    const id = raw.toLowerCase()
    return { kind: "venue", id, topic: `venue:${id}` }
  }

  return null
}

/** Convenience: the match id carried by `match:<id>` or `match:<id>:private`, else `null`. */
export function matchIdFromTopic(topic: unknown): string | null {
  const parsed = parseTopic(topic)
  return parsed && parsed.kind !== "venue" ? parsed.id : null
}

/* ========================================================================== */
/*  Broadcast event names                                                     */
/* ========================================================================== */

/**
 * Events this application's CLIENTS emit onto `match:<id>`.
 *
 * These are the fast, lossy, optimistic lane: a player taps "+1" and every watching device
 * paints the goal in ~50ms instead of waiting for a database round trip it may never get
 * (nobody can write `matches.home_score` from a browser — see the note on
 * {@link ScoreUpdatePayload}).
 */
export const MATCH_EVENT = {
  /** A running, UNOFFICIAL tally tick. Payload: {@link ScoreUpdatePayload}. */
  SCORE_UPDATE: "score_update",
  /** Kickoff / half time / full time hint. Payload: {@link StatusChangePayload}. */
  STATUS_CHANGE: "status_change",
  /** Somebody joined, left, or switched sides. Payload: {@link RosterChangePayload}. */
  ROSTER_CHANGE: "roster_change",
} as const

export type MatchEventName = (typeof MATCH_EVENT)[keyof typeof MATCH_EVENT]

/**
 * Events the SERVER emits, from `public.broadcast_match_event()` (0006 §6).
 *
 * Note the names differ from {@link MATCH_EVENT}. That is not an oversight to be "fixed" here:
 * the trigger computes `case when score changed then 'score' else 'status' end`, so those two
 * strings are pinned by a migration and renaming them client-side would just mean the client
 * stops hearing the authoritative fan-out. Any subscriber that wants the whole picture binds
 * both sets — {@link ALL_MATCH_EVENTS} does exactly that.
 */
export const SERVER_MATCH_EVENT = {
  /** `matches.home_score` / `away_score` changed. Payload: {@link ServerMatchEventPayload}. */
  SCORE: "score",
  /** `matches.status` changed. Payload: {@link ServerMatchEventPayload}. */
  STATUS: "status",
} as const

export type ServerMatchEventName = (typeof SERVER_MATCH_EVENT)[keyof typeof SERVER_MATCH_EVENT]

/** Every broadcast event name a match channel can carry, client- and server-authored. */
export const ALL_MATCH_EVENTS: readonly (MatchEventName | ServerMatchEventName)[] = [
  MATCH_EVENT.SCORE_UPDATE,
  MATCH_EVENT.STATUS_CHANGE,
  MATCH_EVENT.ROSTER_CHANGE,
  SERVER_MATCH_EVENT.SCORE,
  SERVER_MATCH_EVENT.STATUS,
]

/* ========================================================================== */
/*  Payload types                                                             */
/* ========================================================================== */

/**
 * `public.match_status`, repeated here rather than imported from `./database`.
 *
 * A broadcast payload is a wire format, not a table row. Coupling the two would mean a schema
 * refactor silently changes what an old client is allowed to receive, and this module has to
 * stay importable from anywhere. The runtime guard below is what actually protects the union.
 */
export const MATCH_STATUSES = [
  "scheduled",
  "live",
  "awaiting_report",
  "requires_consensus",
  "disputed",
  "finalized",
  "cancelled",
] as const

export type BroadcastMatchStatus = (typeof MATCH_STATUSES)[number]

function isMatchStatus(value: unknown): value is BroadcastMatchStatus {
  return typeof value === "string" && (MATCH_STATUSES as readonly string[]).includes(value)
}

function isNullableInt(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isInteger(value))
}

function isIsoish(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value))
}

/** Fields shared by every match broadcast. */
export interface MatchEventEnvelope {
  matchId: string
  /** When the SENDER says it happened. A client clock — evidence, never truth. */
  at: string
}

/**
 * A client-authored live tally tick.
 *
 * **The score of record never travels on this payload.** `matches.home_score` / `away_score`
 * appear in no column-level UPDATE grant (`0002_rls.sql` §4), by design: "a result can only
 * ever enter the system through `score_reports`". So this payload is an ephemeral, unofficial,
 * best-effort count that lets everyone at the pitch watch the same number go up. The durable record is the end-of-match
 * report, and the scoreboard must label the two differently.
 */
export interface ScoreUpdatePayload extends MatchEventEnvelope {
  homeScore: number
  awayScore: number
  /** Which side just scored, when the tick came from a goal button. */
  scoredBy?: "home" | "away" | null
  /** Profile id of the sender. A hint for the UI; the topic ACL is the real check. */
  actorId?: string | null
  /**
   * Monotonic per-sender counter. Broadcast has no ordering guarantee across senders, so two
   * phones tapping at once are resolved by (seq, at) rather than arrival order.
   */
  seq: number
}

/** A client-authored status hint: someone pressed kickoff, half time or full time. */
export interface StatusChangePayload extends MatchEventEnvelope {
  status: BroadcastMatchStatus
  actorId?: string | null
}

/** A client-authored roster hint: joined, left, switched side, checked in. */
export interface RosterChangePayload extends MatchEventEnvelope {
  playerId: string
  action: "joined" | "left" | "confirmed" | "side_changed"
  teamSide?: "home" | "away" | null
  displayName?: string | null
}

/**
 * The payload `public.broadcast_match_event()` sends (0006 §6).
 *
 * snake_case because it is `jsonb_build_object` output, sent verbatim. The extra
 * `requires_consensus` / `consensus_deadline` / `score_confirmed_at` / `is_ranked` /
 * `rating_applied_at` fields are present ONLY on `match:<id>:private` — the wide topic gets the
 * minimal object so anomaly and quality internals are never published to spectators.
 *
 * `updated_at` is the reconciliation key: it is the row's real `updated_at`, so a client can
 * apply last-write-wins against a Postgres Changes payload without a round trip.
 */
export interface ServerMatchEventPayload {
  match_id: string
  event: ServerMatchEventName
  changed: string[]
  status: BroadcastMatchStatus
  home_team_id: string | null
  away_team_id: string | null
  home_score: number | null
  away_score: number | null
  kickoff_at: string
  updated_at: string
  previous: {
    status: BroadcastMatchStatus
    home_score: number | null
    away_score: number | null
  }
  /* --- private topic only --------------------------------------------------- */
  requires_consensus?: boolean
  consensus_deadline?: string | null
  score_confirmed_at?: string | null
  is_ranked?: boolean
  rating_applied_at?: string | null
}

/** What a member publishes with `channel.track()` (0006 §7). Keep it small. */
export interface MatchPresencePayload {
  profileId: string
  displayName: string | null
  teamSide: "home" | "away" | null
  checkedInAt: string
  /**
   * NEVER put coordinates in here. `profiles.location_sharing_enabled` defaults to false and
   * `profiles_minor_privacy_locked_check` hard-locks it off for minors; presence is not an
   * exemption from that constraint, it is just a place people forget it applies.
   */
}

/* ========================================================================== */
/*  Runtime guards — parse, never assert                                      */
/* ========================================================================== */

/*
 * Broadcast payloads are authored by other clients. The topic ACL says the sender is *entitled*
 * to write here; it says nothing about the shape or honesty of what they wrote. Everything below
 * therefore parses rather than casts, per the project rule: nothing crossing a trust boundary is
 * typed by assertion.
 */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function parseScoreUpdate(value: unknown): ScoreUpdatePayload | null {
  const raw = asRecord(value)
  if (!raw) return null
  if (!isUuid(raw.matchId)) return null
  if (typeof raw.homeScore !== "number" || !Number.isInteger(raw.homeScore)) return null
  if (typeof raw.awayScore !== "number" || !Number.isInteger(raw.awayScore)) return null
  if (raw.homeScore < 0 || raw.awayScore < 0) return null
  if (!isIsoish(raw.at)) return null

  const scoredBy = raw.scoredBy === "home" || raw.scoredBy === "away" ? raw.scoredBy : null

  return {
    matchId: raw.matchId.toLowerCase(),
    homeScore: raw.homeScore,
    awayScore: raw.awayScore,
    scoredBy,
    actorId: isUuid(raw.actorId) ? raw.actorId.toLowerCase() : null,
    at: raw.at,
    seq: typeof raw.seq === "number" && Number.isFinite(raw.seq) ? raw.seq : 0,
  }
}

export function parseStatusChange(value: unknown): StatusChangePayload | null {
  const raw = asRecord(value)
  if (!raw) return null
  if (!isUuid(raw.matchId)) return null
  if (!isMatchStatus(raw.status)) return null
  if (!isIsoish(raw.at)) return null

  return {
    matchId: raw.matchId.toLowerCase(),
    status: raw.status,
    actorId: isUuid(raw.actorId) ? raw.actorId.toLowerCase() : null,
    at: raw.at,
  }
}

export function parseRosterChange(value: unknown): RosterChangePayload | null {
  const raw = asRecord(value)
  if (!raw) return null
  if (!isUuid(raw.matchId)) return null
  if (!isUuid(raw.playerId)) return null
  if (
    raw.action !== "joined" &&
    raw.action !== "left" &&
    raw.action !== "confirmed" &&
    raw.action !== "side_changed"
  ) {
    return null
  }
  if (!isIsoish(raw.at)) return null

  return {
    matchId: raw.matchId.toLowerCase(),
    playerId: raw.playerId.toLowerCase(),
    action: raw.action,
    teamSide: raw.teamSide === "home" || raw.teamSide === "away" ? raw.teamSide : null,
    displayName: typeof raw.displayName === "string" ? raw.displayName.slice(0, 80) : null,
    at: raw.at,
  }
}

/**
 * Parses a `public.broadcast_match_event()` payload.
 *
 * Stricter than the client parsers on one field: `updated_at` MUST be a usable timestamp,
 * because it is the reconciliation key. A server event without it cannot be ordered against the
 * Postgres Changes row and is safer dropped than applied out of sequence.
 */
export function parseServerMatchEvent(value: unknown): ServerMatchEventPayload | null {
  const raw = asRecord(value)
  if (!raw) return null
  if (!isUuid(raw.match_id)) return null
  if (raw.event !== SERVER_MATCH_EVENT.SCORE && raw.event !== SERVER_MATCH_EVENT.STATUS) return null
  if (!isMatchStatus(raw.status)) return null
  if (!isIsoish(raw.updated_at)) return null
  if (!isNullableInt(raw.home_score) || !isNullableInt(raw.away_score)) return null

  const previous = asRecord(raw.previous)

  return {
    match_id: raw.match_id.toLowerCase(),
    event: raw.event,
    changed: Array.isArray(raw.changed) ? raw.changed.filter((c): c is string => typeof c === "string") : [],
    status: raw.status,
    home_team_id: isUuid(raw.home_team_id) ? raw.home_team_id.toLowerCase() : null,
    away_team_id: isUuid(raw.away_team_id) ? raw.away_team_id.toLowerCase() : null,
    home_score: raw.home_score,
    away_score: raw.away_score,
    kickoff_at: isIsoish(raw.kickoff_at) ? raw.kickoff_at : new Date(0).toISOString(),
    updated_at: raw.updated_at,
    previous: {
      status: previous && isMatchStatus(previous.status) ? previous.status : raw.status,
      home_score: previous && isNullableInt(previous.home_score) ? previous.home_score : null,
      away_score: previous && isNullableInt(previous.away_score) ? previous.away_score : null,
    },
    requires_consensus: typeof raw.requires_consensus === "boolean" ? raw.requires_consensus : undefined,
    consensus_deadline: isIsoish(raw.consensus_deadline) ? raw.consensus_deadline : undefined,
    score_confirmed_at: isIsoish(raw.score_confirmed_at) ? raw.score_confirmed_at : undefined,
    is_ranked: typeof raw.is_ranked === "boolean" ? raw.is_ranked : undefined,
    rating_applied_at: isIsoish(raw.rating_applied_at) ? raw.rating_applied_at : undefined,
  }
}

export function parseMatchPresence(value: unknown): MatchPresencePayload | null {
  const raw = asRecord(value)
  if (!raw) return null
  if (!isUuid(raw.profileId)) return null

  return {
    profileId: raw.profileId.toLowerCase(),
    displayName: typeof raw.displayName === "string" ? raw.displayName.slice(0, 80) : null,
    teamSide: raw.teamSide === "home" || raw.teamSide === "away" ? raw.teamSide : null,
    checkedInAt: isIsoish(raw.checkedInAt) ? raw.checkedInAt : new Date().toISOString(),
  }
}

/* ========================================================================== */
/*  Connection status — shared vocabulary for the hooks and the UI            */
/* ========================================================================== */

/**
 * A deliberately smaller vocabulary than Realtime's raw statuses.
 *
 * `CHANNEL_ERROR`, `TIMED_OUT` and an unexpected `CLOSED` are three causes of one user-visible
 * fact — "you are not receiving updates right now" — and the UI should not have to know which.
 * `reconnecting` is what the backoff loop reports between attempts.
 */
export type RealtimeConnection = "connecting" | "connected" | "reconnecting" | "offline" | "disabled"

/** Human copy for a connection indicator. Short enough for a badge. */
export const CONNECTION_LABEL: Record<RealtimeConnection, string> = {
  connecting: "Connecting…",
  connected: "Live",
  reconnecting: "Reconnecting…",
  offline: "Offline",
  disabled: "Paused",
}
