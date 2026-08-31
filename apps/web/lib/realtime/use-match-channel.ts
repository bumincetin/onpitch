"use client"

/**
 * lib/realtime/use-match-channel.ts
 *
 * The live-match subscription: one channel on one socket, carrying two transports.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY TWO TRANSPORTS
 * ---------------------------------------------------------------------------------------------
 *
 *   BROADCAST         fast, cheap, LOSSY. Authorised once, at channel-join time, against
 *                     `realtime.messages` RLS. Nothing is stored: a message sent while your
 *                     socket was reconnecting is gone forever, and there is no replay. Good for
 *                     a goal appearing in 50ms.
 *
 *   POSTGRES CHANGES  authoritative, slower, RLS-checked per subscriber per changed row against
 *                     the `matches` SELECT policy. The row in the database is the truth. Also
 *                     not replayable across a disconnect — which is why {@link resync} exists.
 *
 * The reconciliation rule is LAST WRITE WINS ON `updated_at`. Both the Postgres Changes payload
 * and the server-side broadcast from `public.broadcast_match_event()` carry the row's real
 * `updated_at`, so they are directly comparable and either may arrive first. Anything not newer
 * than what we already applied is dropped, which makes the two transports idempotent with
 * respect to each other and makes out-of-order delivery after a reconnect harmless.
 *
 * Client-authored ticks (`score_update`) are deliberately NOT reconciled into `score`. They have
 * no `updated_at` because they never touched the database and never can: `matches.home_score`
 * and `away_score` appear in no column-level UPDATE grant (0002_rls.sql §4) — "a result can only
 * ever enter the system through `score_reports`". They land in {@link UseMatchChannelResult.tally}
 * instead, and the UI must label that lane as the unofficial running count it is.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY setAuth() IS CALLED, AND CALLED AGAIN
 * ---------------------------------------------------------------------------------------------
 *
 * The Realtime socket authorises with THE JWT IT WAS HANDED, at the moment it was handed it. It
 * is not re-validated continuously, and an expired token does not raise — it stops delivering.
 * The channel still reports SUBSCRIBED, the UI still says "Live", and nothing ever arrives
 * again. Supabase access tokens are short-lived (1h by default) and
 * `@supabase/ssr` refreshes them in the background, so ANY session outliving one refresh will hit
 * this unless the socket is re-authorised.
 *
 * Hence: `realtime.setAuth(token)` before the first join, and again on every `TOKEN_REFRESHED`
 * (and `SIGNED_IN`) from `onAuthStateChange`. Without it the private-channel ACLs in 0006 §5,
 * which are the only authorisation this feed has, are evaluated against a dead token.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js"

import { createClient } from "@/lib/supabase/client"
import type { Database } from "@halisaha/shared/database"
import {
  CONNECTION_LABEL,
  MATCH_EVENT,
  SERVER_MATCH_EVENT,
  isUuid,
  matchTopic,
  parseMatchPresence,
  parseRosterChange,
  parseScoreUpdate,
  parseServerMatchEvent,
  parseStatusChange,
  type BroadcastMatchStatus,
  type MatchPresencePayload,
  type RealtimeConnection,
  type RosterChangePayload,
  type ScoreUpdatePayload,
  type StatusChangePayload,
} from "@halisaha/shared/channels"

export { CONNECTION_LABEL }

/* ========================================================================== */
/*  Types                                                                     */
/* ========================================================================== */

/** The server-rendered starting point. Everything the hook does is a delta on this. */
export interface MatchSnapshot {
  homeScore: number | null
  awayScore: number | null
  status: BroadcastMatchStatus
  /** `matches.updated_at`. The reconciliation key — never invent one. */
  updatedAt: string
}

/** The unofficial, broadcast-only running count. */
export interface LiveTally {
  home: number
  away: number
  scoredBy: "home" | "away" | null
  actorId: string | null
  at: string
  seq: number
}

export interface UseMatchChannelOptions {
  matchId: string
  /** Server-rendered `matches` row fields. Renders instantly and seeds `updated_at`. */
  initial: MatchSnapshot
  /**
   * Set false to hold the socket closed (a finished match, a hidden tab, a user who opted out).
   * Flipping it re-joins cleanly; the hook never leaks a channel across the transition.
   */
  enabled?: boolean
  /**
   * Presence payload to publish for this viewer, or `null` to watch without appearing.
   *
   * Presence rides THIS channel (0006 §7) — Phoenix rejects a second join on the same topic from
   * the same socket, so there is no second channel to put it on. If you want presence without the
   * scoreboard, use `usePresence` from `./use-presence`, which is this hook with the score lane
   * switched off.
   */
  presence?: MatchPresencePayload | null
  /** Fired for every roster hint. Cheap way to trigger a router.refresh() or a refetch. */
  onRosterChange?: (payload: RosterChangePayload) => void
}

export interface UseMatchChannelResult {
  /** The reconciled, AUTHORITATIVE score. `null` until a result exists. */
  score: { home: number | null; away: number | null }
  /** The reconciled, authoritative status. */
  status: BroadcastMatchStatus
  connection: RealtimeConnection
  /** When anything last arrived on either transport. Drives the "stale?" affordance. */
  lastEventAt: Date | null
  /** The unofficial broadcast-only tally. `null` until somebody ticks it. */
  tally: LiveTally | null
  /** Presence, keyed by profile id. */
  presence: Record<string, MatchPresencePayload>
  /** The same thing as a stable, sorted array — convenient for rendering. */
  members: MatchPresencePayload[]
  /** Last non-fatal problem, in plain language. */
  error: string | null
  /** `matches.updated_at` of the newest authoritative write applied. */
  updatedAt: string
  /** Push an optimistic tally tick. Resolves false if the send did not reach the server. */
  broadcastScore: (next: { home: number; away: number; scoredBy?: "home" | "away" | null }) => Promise<boolean>
  /** Push a status hint (kickoff / full time). Does not change the database. */
  broadcastStatus: (status: BroadcastMatchStatus) => Promise<boolean>
  /** Push a roster hint. */
  broadcastRoster: (payload: Omit<RosterChangePayload, "matchId" | "at">) => Promise<boolean>
  /** Re-read the row and close any gap opened by a disconnect. Safe to call any time. */
  resync: () => Promise<void>
}

/* ========================================================================== */
/*  Backoff                                                                   */
/* ========================================================================== */

const BASE_DELAY_MS = 1_000
const MAX_DELAY_MS = 30_000

/**
 * Exponential backoff with full jitter: `random(0, min(cap, base * 2^n))`.
 *
 * Full jitter rather than a fixed ramp because every client watching a match that just lost its
 * Realtime node would otherwise reconnect in lockstep and re-create the outage.
 */
function backoffDelay(attempt: number): number {
  const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.min(attempt, 6))
  return Math.floor(Math.random() * ceiling)
}

/* -------------------------------------------------------------------------- */
/*  Duplicate-topic guard                                                      */
/* -------------------------------------------------------------------------- */

/**
 * How many live subscriptions this tab holds per topic.
 *
 * Phoenix — which is what Realtime is built on — rejects a second join on a topic the socket has
 * already joined. The second channel then sits in `errored`, retries forever, and the symptom is
 * "presence works but the score doesn't" (or the reverse) depending on which one won the race.
 * It is invisible in production and maddening to debug, so it is asserted in development instead.
 */
const activeTopics = new Map<string, number>()

function claimTopic(topic: string): void {
  const next = (activeTopics.get(topic) ?? 0) + 1
  activeTopics.set(topic, next)
  if (next > 1 && process.env.NODE_ENV !== "production") {
    console.error(
      `[realtime] two components subscribed to "${topic}" at once. Realtime allows ONE channel ` +
        "per topic per client, so the second join will fail. Lift the subscription to a single " +
        "owner and pass its result down as props — see lib/realtime/use-presence.ts.",
    )
  }
}

function releaseTopic(topic: string): void {
  const next = (activeTopics.get(topic) ?? 1) - 1
  if (next <= 0) activeTopics.delete(topic)
  else activeTopics.set(topic, next)
}

/** `setAuth` is sync in older supabase-js and async in newer. Tolerate both. */
async function setRealtimeAuth(
  supabase: SupabaseClient<Database>,
  token: string | null,
): Promise<void> {
  try {
    const result: unknown = supabase.realtime.setAuth(token ?? undefined)
    if (result && typeof (result as Promise<void>).then === "function") {
      await (result as Promise<void>)
    }
  } catch (cause) {
    // A failure here means the socket keeps whatever token it had. Log rather than throw: the
    // channel is still usable until that token expires, and throwing would unmount the page.
    console.warn("[realtime] setAuth failed", cause)
  }
}

/** Newer of two ISO timestamps, tolerant of an unparseable one. */
function isNewer(candidate: string, current: string): boolean {
  const a = Date.parse(candidate)
  const b = Date.parse(current)
  if (Number.isNaN(a)) return false
  if (Number.isNaN(b)) return true
  return a > b
}

/* ========================================================================== */
/*  The hook                                                                  */
/* ========================================================================== */

export function useMatchChannel(options: UseMatchChannelOptions): UseMatchChannelResult {
  const { matchId, initial, enabled = true, presence = null, onRosterChange } = options

  const supabase = useMemo(() => createClient(), [])

  const [snapshot, setSnapshot] = useState<MatchSnapshot>(initial)
  const [connection, setConnection] = useState<RealtimeConnection>(enabled ? "connecting" : "disabled")
  const [lastEventAt, setLastEventAt] = useState<Date | null>(null)
  const [tally, setTally] = useState<LiveTally | null>(null)
  const [presenceState, setPresenceState] = useState<Record<string, MatchPresencePayload>>({})
  const [error, setError] = useState<string | null>(null)

  /* --- refs: everything the effect must read without re-subscribing -------- */

  const channelRef = useRef<RealtimeChannel | null>(null)
  const attemptRef = useRef(0)
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const disposedRef = useRef(false)
  /** The `updated_at` of the newest authoritative write we have applied. */
  const appliedAtRef = useRef(initial.updatedAt)
  /** Our own outgoing tick counter, so concurrent senders can be ordered. */
  const seqRef = useRef(0)
  const presenceRef = useRef<MatchPresencePayload | null>(presence)
  const rosterHandlerRef = useRef<UseMatchChannelOptions["onRosterChange"]>(onRosterChange)

  presenceRef.current = presence
  rosterHandlerRef.current = onRosterChange

  /** Presence identity changes rarely; serialise it so the track effect is not identity-driven. */
  const presenceKey = presence ? JSON.stringify(presence) : ""

  /* ---------------------------------------------------------------------- */
  /*  Authoritative apply                                                    */
  /* ---------------------------------------------------------------------- */

  /**
   * Applies an authoritative update if and only if it is newer than what we already have.
   *
   * Postgres Changes and the server broadcast describe the SAME write and both will arrive; a reconnect can also replay a `resync()` that races an in-flight event.
   * Comparing `updated_at` makes every path idempotent and order-independent.
   */
  const applyAuthoritative = useCallback((next: MatchSnapshot) => {
    // Drop anything strictly OLDER than what is already applied. Equal timestamps fall through
    // and are absorbed by the identity check below, so the duplicate that always arrives (one
    // write, two transports) costs a comparison and no re-render.
    if (isNewer(appliedAtRef.current, next.updatedAt)) return
    appliedAtRef.current = next.updatedAt
    setSnapshot((current) =>
      current.homeScore === next.homeScore &&
      current.awayScore === next.awayScore &&
      current.status === next.status &&
      current.updatedAt === next.updatedAt
        ? current
        : next,
    )
  }, [])

  /* ---------------------------------------------------------------------- */
  /*  resync — the gap closer                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * Re-reads the row.
   *
   * Neither transport replays. A socket that was down for eight seconds missed every event in
   * those eight seconds and will never be told. So: read the row on every (re)connect, on tab
   * refocus, and whenever the caller asks, or the scoreboard keeps showing the pre-gap number.
   */
  const resync = useCallback(async () => {
    const { data, error: readError } = await supabase
      .from("matches")
      .select("home_score, away_score, status, updated_at")
      .eq("id", matchId)
      .maybeSingle()

    if (readError) {
      setError("Could not refresh the match. Retrying in the background.")
      return
    }
    if (!data) {
      // RLS returned nothing: not an error — the viewer may not read this match.
      return
    }

    setError(null)
    applyAuthoritative({
      homeScore: data.home_score,
      awayScore: data.away_score,
      status: data.status,
      updatedAt: data.updated_at,
    })
  }, [supabase, matchId, applyAuthoritative])

  /* ---------------------------------------------------------------------- */
  /*  Subscribe / reconnect                                                  */
  /* ---------------------------------------------------------------------- */

  useEffect(() => {
    disposedRef.current = false

    if (!enabled) {
      setConnection("disabled")
      return () => {
        disposedRef.current = true
      }
    }

    if (!isUuid(matchId)) {
      // matchTopic() throws on a malformed id by design (building a topic is always a programming
      // step). Catching it here turns "the route param was garbage" into a dead but rendered page
      // instead of an exception thrown from inside an effect.
      setConnection("offline")
      setError("This match link is not valid, so live updates cannot start.")
      return () => {
        disposedRef.current = true
      }
    }

    let cancelled = false
    const topic = matchTopic(matchId)
    claimTopic(topic)

    const clearRetry = () => {
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current)
        retryTimerRef.current = null
      }
    }

    const teardown = async () => {
      clearRetry()
      const channel = channelRef.current
      channelRef.current = null
      if (channel) {
        // removeChannel() both unsubscribes and drops it from the client's registry. Skipping the
        // registry half is how a long-lived SPA ends up with dozens of dead channels on one socket
        // and, eventually, a join rejected for a topic it "already joined".
        try {
          await supabase.removeChannel(channel)
        } catch (cause) {
          console.warn("[realtime] removeChannel failed", cause)
        }
      }
    }

    const scheduleReconnect = () => {
      if (cancelled || disposedRef.current) return
      clearRetry()
      const delay = backoffDelay(attemptRef.current)
      attemptRef.current += 1
      setConnection("reconnecting")
      retryTimerRef.current = setTimeout(() => {
        void connect()
      }, delay)
    }

    const connect = async (): Promise<void> => {
      if (cancelled || disposedRef.current) return

      await teardown()
      if (cancelled || disposedRef.current) return

      // Re-authorise the socket on every join attempt. If the previous attempt failed *because*
      // the token had expired, this is the step that fixes it.
      const { data: sessionData } = await supabase.auth.getSession()
      await setRealtimeAuth(supabase, sessionData.session?.access_token ?? null)
      if (cancelled || disposedRef.current) return

      const self = presenceRef.current

      const channel = supabase.channel(topic, {
        config: {
          // `private: true` is what makes Realtime consult realtime.messages RLS at all. Without
          // it this channel performs NO authorisation and 0006 §5 never runs.
          private: true,
          // Keyed by profile id, never by connection: a player who drops to 4G replaces their own
          // entry instead of appearing twice, so a headcount converges (0006 §7).
          presence: { key: self?.profileId ?? "" },
          broadcast: { self: false, ack: true },
        },
      })

      channelRef.current = channel

      /* ---- transport 1: broadcast --------------------------------------- */

      const stamp = () => setLastEventAt(new Date())

      // Server fan-out from public.broadcast_match_event(). Authoritative: carries updated_at.
      const onServerEvent = (message: { payload?: unknown }) => {
        const parsed = parseServerMatchEvent(message.payload)
        if (!parsed || parsed.match_id !== matchId.toLowerCase()) return
        stamp()
        applyAuthoritative({
          homeScore: parsed.home_score,
          awayScore: parsed.away_score,
          status: parsed.status,
          updatedAt: parsed.updated_at,
        })
      }

      channel.on("broadcast", { event: SERVER_MATCH_EVENT.SCORE }, onServerEvent)
      channel.on("broadcast", { event: SERVER_MATCH_EVENT.STATUS }, onServerEvent)

      // Client ticks. Unofficial by construction — see the module header.
      channel.on("broadcast", { event: MATCH_EVENT.SCORE_UPDATE }, (message: { payload?: unknown }) => {
        const parsed: ScoreUpdatePayload | null = parseScoreUpdate(message.payload)
        if (!parsed || parsed.matchId !== matchId.toLowerCase()) return
        stamp()
        setTally((current) => {
          // Two phones tapping at once arrive in arbitrary order. Resolve on (at, seq), never on
          // arrival, so every device converges on the same number.
          if (current) {
            const currentAt = Date.parse(current.at)
            const nextAt = Date.parse(parsed.at)
            if (nextAt < currentAt || (nextAt === currentAt && parsed.seq <= current.seq)) {
              return current
            }
          }
          return {
            home: parsed.homeScore,
            away: parsed.awayScore,
            scoredBy: parsed.scoredBy ?? null,
            actorId: parsed.actorId ?? null,
            at: parsed.at,
            seq: parsed.seq,
          }
        })
      })

      channel.on("broadcast", { event: MATCH_EVENT.STATUS_CHANGE }, (message: { payload?: unknown }) => {
        const parsed: StatusChangePayload | null = parseStatusChange(message.payload)
        if (!parsed || parsed.matchId !== matchId.toLowerCase()) return
        stamp()
        // A status HINT does not move `snapshot.status` — that column is written by the server and
        // arrives with an updated_at. Hints only prompt a re-read, which either confirms or drops
        // them. This is what stops a malicious participant "finalising" a match on your screen.
        void resync()
      })

      channel.on("broadcast", { event: MATCH_EVENT.ROSTER_CHANGE }, (message: { payload?: unknown }) => {
        const parsed = parseRosterChange(message.payload)
        if (!parsed || parsed.matchId !== matchId.toLowerCase()) return
        stamp()
        rosterHandlerRef.current?.(parsed)
      })

      /* ---- transport 2: postgres changes -------------------------------- */

      channel.on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "matches", filter: `id=eq.${matchId}` },
        (payload: { new?: unknown }) => {
          const row = payload.new as Partial<Database["public"]["Tables"]["matches"]["Row"]> | undefined
          if (!row || typeof row.updated_at !== "string" || typeof row.status !== "string") return
          stamp()
          applyAuthoritative({
            homeScore: typeof row.home_score === "number" ? row.home_score : null,
            awayScore: typeof row.away_score === "number" ? row.away_score : null,
            status: row.status as BroadcastMatchStatus,
            updatedAt: row.updated_at,
          })
        },
      )

      /* ---- presence ------------------------------------------------------ */

      const syncPresence = () => {
        const raw = channel.presenceState<Record<string, unknown>>()
        const next: Record<string, MatchPresencePayload> = {}
        for (const entries of Object.values(raw)) {
          for (const entry of entries) {
            const parsed = parseMatchPresence(entry)
            if (parsed) next[parsed.profileId] = parsed
          }
        }
        setPresenceState(next)
      }

      channel.on("presence", { event: "sync" }, syncPresence)
      channel.on("presence", { event: "join" }, syncPresence)
      channel.on("presence", { event: "leave" }, syncPresence)

      /* ---- subscribe ----------------------------------------------------- */

      channel.subscribe((status, subscribeError) => {
        if (cancelled || disposedRef.current) return

        switch (status) {
          case "SUBSCRIBED": {
            attemptRef.current = 0
            setConnection("connected")
            setError(null)
            // Close the gap the disconnect opened. Neither transport replays.
            void resync()
            const identity = presenceRef.current
            if (identity) {
              // Cast: `track` wants an index-signature type and a TS *interface* never gets an
              // implicit one. The shape is already validated by parseMatchPresence on receipt.
              void channel.track(identity as unknown as Record<string, unknown>).catch((cause) => {
                console.warn("[realtime] presence track failed", cause)
              })
            }
            return
          }

          case "CHANNEL_ERROR": {
            // The commonest real cause is an RLS denial on realtime.messages — i.e. this viewer
            // may not read this match — and the second commonest is an expired JWT. Both look
            // identical from here, so retry (which re-runs setAuth) and keep the copy neutral.
            setError(
              subscribeError?.message
                ? `Live updates stopped: ${subscribeError.message}`
                : "Live updates stopped. Trying again…",
            )
            scheduleReconnect()
            return
          }

          case "TIMED_OUT": {
            setError("The live connection timed out. Trying again…")
            scheduleReconnect()
            return
          }

          case "CLOSED": {
            // Also fires on a deliberate removeChannel(); teardown() nulls the ref first, so an
            // intentional close is distinguishable from a dropped socket.
            if (channelRef.current === channel) {
              setConnection("offline")
              scheduleReconnect()
            }
            return
          }

          default:
            return
        }
      })
    }

    void connect()

    /* ---- re-authorise on token refresh --------------------------------- */

    const {
      data: { subscription: authSubscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (event !== "TOKEN_REFRESHED" && event !== "SIGNED_IN") return
      // The socket keeps using the JWT it was given. Once that token expires it stops delivering
      // WITHOUT closing or erroring — the UI keeps saying "Live" and nothing ever arrives. This
      // listener exists to push the fresh token in.
      void setRealtimeAuth(supabase, session?.access_token ?? null)
    })

    /* ---- heal on refocus / network return ------------------------------ */

    const onWake = () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return
      void resync()
      if (connectionIsDown(channelRef.current)) scheduleReconnect()
    }

    if (typeof window !== "undefined") {
      document.addEventListener("visibilitychange", onWake)
      window.addEventListener("online", onWake)
    }

    return () => {
      cancelled = true
      disposedRef.current = true
      if (typeof window !== "undefined") {
        document.removeEventListener("visibilitychange", onWake)
        window.removeEventListener("online", onWake)
      }
      authSubscription.unsubscribe()
      releaseTopic(topic)
      void teardown()
    }
    // `presence`/`onRosterChange` are read through refs so a new object identity does not tear the
    // socket down and rebuild it on every render.
  }, [supabase, matchId, enabled, applyAuthoritative, resync])

  /* ---------------------------------------------------------------------- */
  /*  Re-track presence when the viewer's own payload changes                */
  /* ---------------------------------------------------------------------- */

  useEffect(() => {
    const channel = channelRef.current
    if (!channel || connection !== "connected") return
    const identity = presenceRef.current
    if (!identity) {
      void channel.untrack().catch(() => undefined)
      return
    }
    void channel.track(identity as unknown as Record<string, unknown>).catch((cause) => {
      console.warn("[realtime] presence re-track failed", cause)
    })
  }, [presenceKey, connection])

  /* ---------------------------------------------------------------------- */
  /*  Senders                                                                */
  /* ---------------------------------------------------------------------- */

  const send = useCallback(async (event: string, payload: Record<string, unknown>): Promise<boolean> => {
    const channel = channelRef.current
    if (!channel) return false
    try {
      const result = await channel.send({ type: "broadcast", event, payload })
      return result === "ok"
    } catch (cause) {
      console.warn("[realtime] broadcast send failed", cause)
      return false
    }
  }, [])

  const broadcastScore = useCallback<UseMatchChannelResult["broadcastScore"]>(
    async (next) => {
      seqRef.current += 1
      const at = new Date().toISOString()
      const payload: ScoreUpdatePayload = {
        matchId,
        homeScore: Math.max(0, Math.trunc(next.home)),
        awayScore: Math.max(0, Math.trunc(next.away)),
        scoredBy: next.scoredBy ?? null,
        actorId: presenceRef.current?.profileId ?? null,
        at,
        seq: seqRef.current,
      }
      // Paint locally first. `broadcast.self` is false (an echo of our own message would race the
      // optimistic paint and make the number flicker), so nothing else will apply this for us.
      setTally({
        home: payload.homeScore,
        away: payload.awayScore,
        scoredBy: payload.scoredBy ?? null,
        actorId: payload.actorId ?? null,
        at,
        seq: payload.seq,
      })
      setLastEventAt(new Date())
      return send(MATCH_EVENT.SCORE_UPDATE, payload as unknown as Record<string, unknown>)
    },
    [matchId, send],
  )

  const broadcastStatus = useCallback<UseMatchChannelResult["broadcastStatus"]>(
    async (status) => {
      const payload: StatusChangePayload = {
        matchId,
        status,
        actorId: presenceRef.current?.profileId ?? null,
        at: new Date().toISOString(),
      }
      return send(MATCH_EVENT.STATUS_CHANGE, payload as unknown as Record<string, unknown>)
    },
    [matchId, send],
  )

  const broadcastRoster = useCallback<UseMatchChannelResult["broadcastRoster"]>(
    async (partial) => {
      const payload: RosterChangePayload = { ...partial, matchId, at: new Date().toISOString() }
      return send(MATCH_EVENT.ROSTER_CHANGE, payload as unknown as Record<string, unknown>)
    },
    [matchId, send],
  )

  /* ---------------------------------------------------------------------- */

  const members = useMemo(
    () =>
      Object.values(presenceState).sort((a, b) =>
        (a.displayName ?? a.profileId).localeCompare(b.displayName ?? b.profileId),
      ),
    [presenceState],
  )

  return {
    score: { home: snapshot.homeScore, away: snapshot.awayScore },
    status: snapshot.status,
    connection,
    lastEventAt,
    tally,
    presence: presenceState,
    members,
    error,
    updatedAt: snapshot.updatedAt,
    broadcastScore,
    broadcastStatus,
    broadcastRoster,
    resync,
  }
}

/** A channel we still hold a reference to but whose socket is not joined. */
function connectionIsDown(channel: RealtimeChannel | null): boolean {
  if (!channel) return true
  const state = (channel as unknown as { state?: string }).state
  return state !== "joined" && state !== "joining"
}
