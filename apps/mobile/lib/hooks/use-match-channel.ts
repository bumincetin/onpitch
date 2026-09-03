/**
 * lib/hooks/use-match-channel.ts
 *
 * The live-match subscription for the app. One channel, two transports, and the AppState listener
 * the web version has no need for.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY TWO TRANSPORTS
 * ---------------------------------------------------------------------------------------------
 *
 *   BROADCAST         fast, cheap, LOSSY. Authorised once, at join time, against
 *                     `realtime.messages` RLS. Nothing is stored, so a message sent while the
 *                     socket was down is gone. Good for a goal appearing in 50ms.
 *
 *   POSTGRES CHANGES  authoritative, and RLS-checked per subscriber per changed row against the
 *                     `matches` SELECT policy. Carries the row itself. Also not replayable across
 *                     a disconnect, which is what {@link UseMatchChannelResult.resync} is for.
 *
 * Reconciliation is LAST WRITE WINS ON `updated_at`. The Postgres Changes payload and the server
 * broadcast from `public.broadcast_match_event()` describe the same write and both carry the row's
 * real `updated_at`, so either may arrive first and the older one is dropped. That makes the two
 * transports idempotent with respect to each other and makes out-of-order delivery after a
 * reconnect harmless.
 *
 * Client-authored ticks (`score_update`) are NOT reconciled into the score. They never touched the
 * database and never can — `matches.home_score` and `away_score` appear in no column-level UPDATE
 * grant (0002_rls.sql §4), because "a result can only ever enter the system through
 * `score_reports`". They land in {@link UseMatchChannelResult.tally}, and the UI has to label that
 * lane as the unofficial running count it is.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY setAuth() IS CALLED, AND CALLED AGAIN
 * ---------------------------------------------------------------------------------------------
 *
 * The Realtime socket authorises with the JWT it was handed, at the moment it was handed it. It is
 * not re-validated, and an expired token does not raise; delivery just stops. The channel still
 * reports SUBSCRIBED and the UI still says "Live" while nothing arrives. Supabase
 * access tokens last an hour and gotrue refreshes them in the background, so any session that
 * outlives one refresh hits this unless the socket is re-authorised.
 *
 * Hence `realtime.setAuth(token)` before every join attempt, and again on every `TOKEN_REFRESHED`
 * and `SIGNED_IN`.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY APPSTATE, WHICH THE WEB HOOK HAS NO EQUIVALENT OF
 * ---------------------------------------------------------------------------------------------
 *
 * A backgrounded React Native app loses its WebSocket. iOS suspends the process outright; Android
 * kills long-lived sockets under Doze. Neither delivers a close frame the client can act on, so
 * the channel comes back to the foreground in `joined` state on a socket that no longer exists,
 * and it never notices. A browser tab does not have this problem — it keeps running.
 *
 * So every return to `active` does two things: re-read the row (closing the gap the background
 * opened, because neither transport replays) and force a reconnect when the socket is not
 * genuinely connected. Both are idempotent, which is why they run unconditionally rather than
 * behind a guess about how long the app was away.
 *
 * ---------------------------------------------------------------------------------------------
 * ONE CHANNEL PER TOPIC PER CLIENT
 * ---------------------------------------------------------------------------------------------
 *
 * Phoenix rejects a second join on a topic the socket has already joined. Two screens in the same
 * navigation stack subscribing to the same match — the detail screen and the live screen, say —
 * leaves the second one erroring forever, and the symptom is "the score updates on one screen and
 * not the other". Mount this hook in one place per match and pass its result down.
 */

import type { RealtimeChannel } from '@supabase/supabase-js'
import * as React from 'react'
import { AppState, type AppStateStatus } from 'react-native'

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
} from '@onpitch/shared/channels'

import { supabase } from '@/lib/supabase'

export { CONNECTION_LABEL }
export type { RealtimeConnection }

/* ========================================================================== */
/*  Types                                                                     */
/* ========================================================================== */

/** The starting point, read from the `matches` row. Everything the hook does is a delta on it. */
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
  scoredBy: 'home' | 'away' | null
  actorId: string | null
  at: string
  seq: number
}

export interface UseMatchChannelOptions {
  matchId: string
  /**
   * The row as the screen last read it. Seeds the state and, when it changes, is re-applied
   * through the same last-write-wins guard as a live event — so a pull-to-refresh can never move
   * the scoreboard backwards.
   */
  initial: MatchSnapshot
  /** False holds the socket closed: a finished match, a screen that is not focused. */
  enabled?: boolean
  /** Presence payload for this viewer, or null to watch without appearing in the headcount. */
  presence?: MatchPresencePayload | null
  /** Fired for every roster hint. A cheap trigger for re-reading the line-up. */
  onRosterChange?: (payload: RosterChangePayload) => void
}

export interface UseMatchChannelResult {
  /** The reconciled, AUTHORITATIVE score. Null until a result exists. */
  score: { home: number | null; away: number | null }
  /** The reconciled, authoritative status. */
  status: BroadcastMatchStatus
  connection: RealtimeConnection
  /** When anything last arrived on either transport. */
  lastEventAt: Date | null
  /** The unofficial broadcast-only tally. Null until somebody ticks it. */
  tally: LiveTally | null
  /** Presence, keyed by profile id. */
  presence: Record<string, MatchPresencePayload>
  /** The same thing sorted, for rendering. */
  members: MatchPresencePayload[]
  /** Last non-fatal problem, in plain language. */
  error: string | null
  /** `matches.updated_at` of the newest authoritative write applied. */
  updatedAt: string
  /** Push an optimistic tally tick. Resolves false when the send did not reach the server. */
  broadcastScore: (next: {
    home: number
    away: number
    scoredBy?: 'home' | 'away' | null
  }) => Promise<boolean>
  /** Push a status hint (kick-off, full time). Changes nothing in the database. */
  broadcastStatus: (status: BroadcastMatchStatus) => Promise<boolean>
  /** Push a roster hint. */
  broadcastRoster: (payload: Omit<RosterChangePayload, 'matchId' | 'at'>) => Promise<boolean>
  /** Re-read the row and close any gap a disconnect opened. Safe to call at any time. */
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
 * Without the jitter, every phone watching a match that just lost its Realtime node would
 * reconnect in lockstep and re-create the outage it is recovering from.
 */
function backoffDelay(attempt: number): number {
  const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.min(attempt, 6))
  return Math.floor(Math.random() * ceiling)
}

/* -------------------------------------------------------------------------- */
/*  Duplicate-topic guard                                                      */
/* -------------------------------------------------------------------------- */

/** How many live subscriptions this process holds per topic. See the header. */
const activeTopics = new Map<string, number>()

function claimTopic(topic: string): void {
  const next = (activeTopics.get(topic) ?? 0) + 1
  activeTopics.set(topic, next)
  if (next > 1 && process.env.NODE_ENV !== 'production') {
    console.error(
      `[realtime] two components subscribed to "${topic}" at once. Realtime allows one channel ` +
        'per topic per client, so the second join will fail. Subscribe in one screen and pass the ' +
        'result down.',
    )
  }
}

function releaseTopic(topic: string): void {
  const next = (activeTopics.get(topic) ?? 1) - 1
  if (next <= 0) activeTopics.delete(topic)
  else activeTopics.set(topic, next)
}

/** `setAuth` is sync in older supabase-js and async in newer. Tolerate both. */
async function setRealtimeAuth(token: string | null): Promise<void> {
  try {
    const result: unknown = supabase.realtime.setAuth(token ?? undefined)
    if (result && typeof (result as Promise<void>).then === 'function') {
      await (result as Promise<void>)
    }
  } catch (cause) {
    // The socket keeps whatever token it had, which is still usable until it expires. Throwing
    // here would unmount the screen over a problem that fixes itself on the next join.
    console.warn('[realtime] setAuth failed', cause)
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

/**
 * True when we hold a channel reference whose socket is not actually carrying traffic.
 *
 * `state` is a public field on RealtimeChannel but is not in the published type, and
 * `realtime.isConnected` is not guaranteed across minor versions — both are read defensively so a
 * dependency bump degrades to "reconnect anyway" rather than a type error or a crash.
 */
function connectionIsDown(channel: RealtimeChannel | null): boolean {
  if (!channel) return true

  const socket: { isConnected?: () => boolean } = supabase.realtime
  if (typeof socket.isConnected === 'function' && !socket.isConnected()) return true

  const state = (channel as unknown as { state?: string }).state
  return state !== 'joined' && state !== 'joining'
}

/* ========================================================================== */
/*  The hook                                                                  */
/* ========================================================================== */

export function useMatchChannel(options: UseMatchChannelOptions): UseMatchChannelResult {
  const { matchId, initial, enabled = true, presence = null, onRosterChange } = options

  const [snapshot, setSnapshot] = React.useState<MatchSnapshot>(initial)
  const [connection, setConnection] = React.useState<RealtimeConnection>(
    enabled ? 'connecting' : 'disabled',
  )
  const [lastEventAt, setLastEventAt] = React.useState<Date | null>(null)
  const [tally, setTally] = React.useState<LiveTally | null>(null)
  const [presenceState, setPresenceState] = React.useState<Record<string, MatchPresencePayload>>({})
  const [error, setError] = React.useState<string | null>(null)

  /* --- refs: what the effect reads without re-subscribing ------------------ */

  const channelRef = React.useRef<RealtimeChannel | null>(null)
  const attemptRef = React.useRef(0)
  const retryTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const disposedRef = React.useRef(false)
  /** `updated_at` of the newest authoritative write applied. */
  const appliedAtRef = React.useRef(initial.updatedAt)
  /** Our own outgoing tick counter, so concurrent senders can be ordered. */
  const seqRef = React.useRef(0)
  const presenceRef = React.useRef<MatchPresencePayload | null>(presence)
  const rosterHandlerRef = React.useRef<UseMatchChannelOptions['onRosterChange']>(onRosterChange)

  presenceRef.current = presence
  rosterHandlerRef.current = onRosterChange

  /** Presence identity changes rarely; serialise it so the track effect is not identity-driven. */
  const presenceKey = presence ? JSON.stringify(presence) : ''

  /* ---------------------------------------------------------------------- */
  /*  Authoritative apply                                                    */
  /* ---------------------------------------------------------------------- */

  /**
   * Applies an update if and only if it is newer than what we already have.
   *
   * Postgres Changes and the server broadcast describe the same write and both arrive, and a
   * reconnect replays a `resync()` that can race an in-flight event. Comparing `updated_at` makes
   * every path idempotent and order-independent.
   */
  const applyAuthoritative = React.useCallback((next: MatchSnapshot) => {
    // Drop anything strictly older. Equal timestamps fall through to the identity check below, so
    // the duplicate that always arrives — one write, two transports — costs a comparison and no
    // re-render.
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

  // Re-seed when the screen re-reads the row (pull to refresh, a write that returned the new row).
  // Routed through the same guard, so a stale re-read cannot undo a live update.
  // Depends on the FIELDS, not on the object: a screen that builds `initial` inline gets a new
  // identity every render, and an identity-keyed effect would then run on every render.
  React.useEffect(() => {
    applyAuthoritative(initial)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial.homeScore, initial.awayScore, initial.status, initial.updatedAt, applyAuthoritative])

  /* ---------------------------------------------------------------------- */
  /*  resync — the gap closer                                                */
  /* ---------------------------------------------------------------------- */

  const resync = React.useCallback(async (): Promise<void> => {
    const { data, error: readError } = await supabase
      .from('matches')
      .select('home_score, away_score, status, updated_at')
      .eq('id', matchId)
      .maybeSingle()

    if (readError) {
      setError('Could not refresh the match. Retrying in the background.')
      return
    }
    if (!data) {
      // RLS returned no row, which is not an error: this viewer may not read this match.
      return
    }

    setError(null)
    applyAuthoritative({
      homeScore: data.home_score,
      awayScore: data.away_score,
      status: data.status,
      updatedAt: data.updated_at,
    })
  }, [matchId, applyAuthoritative])

  /* ---------------------------------------------------------------------- */
  /*  Subscribe / reconnect                                                  */
  /* ---------------------------------------------------------------------- */

  React.useEffect(() => {
    disposedRef.current = false

    if (!enabled) {
      setConnection('disabled')
      return () => {
        disposedRef.current = true
      }
    }

    if (!isUuid(matchId)) {
      // matchTopic() throws on a malformed id by design. Catching it here turns "the route param
      // was garbage" into a rendered screen that says so, rather than an exception from an effect.
      setConnection('offline')
      setError('This match link is not valid, so live updates cannot start.')
      return () => {
        disposedRef.current = true
      }
    }

    let cancelled = false
    const topic = matchTopic(matchId)
    claimTopic(topic)

    const clearRetry = (): void => {
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current)
        retryTimerRef.current = null
      }
    }

    const teardown = async (): Promise<void> => {
      clearRetry()
      const channel = channelRef.current
      channelRef.current = null
      if (channel) {
        // removeChannel() unsubscribes AND drops the channel from the client registry. Skipping
        // the registry half is how a long-lived app accumulates dead channels on one socket and
        // eventually has a join rejected for a topic it "already joined".
        try {
          await supabase.removeChannel(channel)
        } catch (cause) {
          console.warn('[realtime] removeChannel failed', cause)
        }
      }
    }

    const scheduleReconnect = (): void => {
      if (cancelled || disposedRef.current) return
      clearRetry()
      const delay = backoffDelay(attemptRef.current)
      attemptRef.current += 1
      setConnection('reconnecting')
      retryTimerRef.current = setTimeout(() => {
        void connect()
      }, delay)
    }

    const connect = async (): Promise<void> => {
      if (cancelled || disposedRef.current) return

      await teardown()
      if (cancelled || disposedRef.current) return

      // Re-authorise on every attempt. When the previous attempt failed *because* the token had
      // expired, this is the step that fixes it.
      const { data: sessionData } = await supabase.auth.getSession()
      await setRealtimeAuth(sessionData.session?.access_token ?? null)
      if (cancelled || disposedRef.current) return

      const self = presenceRef.current

      const channel = supabase.channel(topic, {
        config: {
          // `private: true` is what makes Realtime consult realtime.messages RLS at all. Without
          // it this channel performs no authorisation and 0006 §5 never runs.
          private: true,
          // Keyed by profile id, never by connection: a player who drops to 4G replaces their own
          // entry instead of appearing twice, so a headcount converges (0006 §7).
          presence: { key: self?.profileId ?? '' },
          broadcast: { self: false, ack: true },
        },
      })

      channelRef.current = channel

      const stamp = (): void => setLastEventAt(new Date())

      /* ---- transport 1: broadcast --------------------------------------- */

      // Server fan-out from public.broadcast_match_event(). Authoritative: carries updated_at.
      const onServerEvent = (message: { payload?: unknown }): void => {
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

      channel.on('broadcast', { event: SERVER_MATCH_EVENT.SCORE }, onServerEvent)
      channel.on('broadcast', { event: SERVER_MATCH_EVENT.STATUS }, onServerEvent)

      // Client ticks. Unofficial by construction — see the module header.
      channel.on(
        'broadcast',
        { event: MATCH_EVENT.SCORE_UPDATE },
        (message: { payload?: unknown }) => {
          const parsed: ScoreUpdatePayload | null = parseScoreUpdate(message.payload)
          if (!parsed || parsed.matchId !== matchId.toLowerCase()) return
          stamp()
          setTally((current) => {
            // Two phones tapping at once arrive in arbitrary order. Resolve on (at, seq) rather
            // than on arrival, so every device converges on the same number.
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
        },
      )

      channel.on(
        'broadcast',
        { event: MATCH_EVENT.STATUS_CHANGE },
        (message: { payload?: unknown }) => {
          const parsed: StatusChangePayload | null = parseStatusChange(message.payload)
          if (!parsed || parsed.matchId !== matchId.toLowerCase()) return
          stamp()
          // A status HINT never moves `snapshot.status`. That column is written by the server and
          // arrives with an `updated_at`; a hint only prompts a re-read, which either confirms it
          // or drops it. This is what stops a participant "finalising" a match on your screen.
          void resync()
        },
      )

      channel.on(
        'broadcast',
        { event: MATCH_EVENT.ROSTER_CHANGE },
        (message: { payload?: unknown }) => {
          const parsed = parseRosterChange(message.payload)
          if (!parsed || parsed.matchId !== matchId.toLowerCase()) return
          stamp()
          rosterHandlerRef.current?.(parsed)
        },
      )

      /* ---- transport 2: postgres changes -------------------------------- */

      channel.on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'matches', filter: `id=eq.${matchId}` },
        (payload: { new?: unknown }) => {
          const row = asRow(payload.new)
          if (!row) return
          stamp()
          applyAuthoritative(row)
        },
      )

      /* ---- presence ------------------------------------------------------ */

      const syncPresence = (): void => {
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

      channel.on('presence', { event: 'sync' }, syncPresence)
      channel.on('presence', { event: 'join' }, syncPresence)
      channel.on('presence', { event: 'leave' }, syncPresence)

      /* ---- subscribe ----------------------------------------------------- */

      channel.subscribe((status, subscribeError) => {
        if (cancelled || disposedRef.current) return

        switch (status) {
          case 'SUBSCRIBED': {
            attemptRef.current = 0
            setConnection('connected')
            setError(null)
            // Close the gap the disconnect opened. Neither transport replays.
            void resync()
            const identity = presenceRef.current
            if (identity) {
              // Cast: `track` wants an index-signature type and a TS interface never gets an
              // implicit one. The shape is validated by parseMatchPresence on the way back in.
              void channel.track(identity as unknown as Record<string, unknown>).catch((cause) => {
                console.warn('[realtime] presence track failed', cause)
              })
            }
            return
          }

          case 'CHANNEL_ERROR': {
            // The commonest cause is an RLS denial on realtime.messages — this viewer may not read
            // this match — and the second commonest is an expired JWT. They look identical from
            // here, so retry (which re-runs setAuth) and keep the copy neutral.
            setError(
              subscribeError?.message
                ? `Live updates stopped: ${subscribeError.message}`
                : 'Live updates stopped. Trying again…',
            )
            scheduleReconnect()
            return
          }

          case 'TIMED_OUT': {
            setError('The live connection timed out. Trying again…')
            scheduleReconnect()
            return
          }

          case 'CLOSED': {
            // Also fires on a deliberate removeChannel(); teardown() nulls the ref first, so an
            // intentional close is distinguishable from a dropped socket.
            if (channelRef.current === channel) {
              setConnection('offline')
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
      if (event !== 'TOKEN_REFRESHED' && event !== 'SIGNED_IN') return
      // The socket keeps using the JWT it was given. Once that token expires it stops delivering
      // without closing or erroring — the UI keeps saying "Live" and nothing arrives. Pushing the
      // fresh token in is what this listener is for.
      void setRealtimeAuth(session?.access_token ?? null)
    })

    /* ---- heal on return to the foreground ------------------------------ */

    const onAppStateChange = (next: AppStateStatus): void => {
      if (next !== 'active') return
      // Always re-read: the app may have been away for a second or for a day, and the row is
      // cheap. Reconnect only when the socket is genuinely down, so a quick app switch does not
      // tear down a healthy channel.
      void resync()
      if (connectionIsDown(channelRef.current)) scheduleReconnect()
    }

    const appStateSubscription = AppState.addEventListener('change', onAppStateChange)

    return () => {
      cancelled = true
      disposedRef.current = true
      appStateSubscription.remove()
      authSubscription.unsubscribe()
      releaseTopic(topic)
      void teardown()
    }
    // `presence` and `onRosterChange` are read through refs, so a new object identity does not
    // tear the socket down and rebuild it on every render.
  }, [matchId, enabled, applyAuthoritative, resync])

  /* ---------------------------------------------------------------------- */
  /*  Re-track presence when the viewer's own payload changes                */
  /* ---------------------------------------------------------------------- */

  React.useEffect(() => {
    const channel = channelRef.current
    if (!channel || connection !== 'connected') return
    const identity = presenceRef.current
    if (!identity) {
      void channel.untrack().catch(() => undefined)
      return
    }
    void channel.track(identity as unknown as Record<string, unknown>).catch((cause) => {
      console.warn('[realtime] presence re-track failed', cause)
    })
  }, [presenceKey, connection])

  /* ---------------------------------------------------------------------- */
  /*  Senders                                                                */
  /* ---------------------------------------------------------------------- */

  const send = React.useCallback(
    async (event: string, payload: Record<string, unknown>): Promise<boolean> => {
      const channel = channelRef.current
      if (!channel) return false
      try {
        const result = await channel.send({ type: 'broadcast', event, payload })
        return result === 'ok'
      } catch (cause) {
        console.warn('[realtime] broadcast send failed', cause)
        return false
      }
    },
    [],
  )

  const broadcastScore = React.useCallback<UseMatchChannelResult['broadcastScore']>(
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
      // Paint locally first. `broadcast.self` is false — an echo of our own message would race the
      // optimistic paint and make the number flicker — so nothing else will apply this for us.
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

  const broadcastStatus = React.useCallback<UseMatchChannelResult['broadcastStatus']>(
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

  const broadcastRoster = React.useCallback<UseMatchChannelResult['broadcastRoster']>(
    async (partial) => {
      const payload: RosterChangePayload = { ...partial, matchId, at: new Date().toISOString() }
      return send(MATCH_EVENT.ROSTER_CHANGE, payload as unknown as Record<string, unknown>)
    },
    [matchId, send],
  )

  const members = React.useMemo(
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

/* ========================================================================== */
/*  Narrowing helpers                                                         */
/* ========================================================================== */

/**
 * The `new` record of a Postgres Changes payload, narrowed to the four fields we apply.
 *
 * Written as a parse rather than a cast because the payload arrives off a socket: a replication
 * message for a column set we did not expect must produce "no update", not an update built out of
 * `undefined`.
 */
function asRow(value: unknown): MatchSnapshot | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>

  if (typeof raw.updated_at !== 'string') return null
  if (!isBroadcastStatus(raw.status)) return null

  return {
    homeScore: typeof raw.home_score === 'number' ? raw.home_score : null,
    awayScore: typeof raw.away_score === 'number' ? raw.away_score : null,
    status: raw.status,
    updatedAt: raw.updated_at,
  }
}

const BROADCAST_STATUSES: readonly BroadcastMatchStatus[] = [
  'scheduled',
  'live',
  'awaiting_report',
  'requires_consensus',
  'disputed',
  'finalized',
  'cancelled',
]

function isBroadcastStatus(value: unknown): value is BroadcastMatchStatus {
  return typeof value === 'string' && BROADCAST_STATUSES.some((status) => status === value)
}
