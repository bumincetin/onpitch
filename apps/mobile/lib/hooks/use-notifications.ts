/**
 * lib/hooks/use-notifications.ts
 *
 * The unread badge and the notification feed, both live.
 *
 * `notifications` is in the `supabase_realtime` publication (0006_realtime.sql §1), so this
 * subscribes to `postgres_changes` rather than polling. The `user_id=eq.<uuid>` filter is applied
 * server-side on the replication stream, so rows belonging to other people are never sent to this
 * socket. That filter saves bandwidth; `notifications_select_own` is what decides what this client
 * may see, and Realtime evaluates it for every change event.
 *
 * THREE CONSTRAINTS ON SETUP AND TEARDOWN
 * ---------------------------------------
 *   * Realtime authorises a join with whatever token the socket last held, so `setAuth` has to run
 *     BEFORE `subscribe()`. That makes setup async, which makes teardown a promise chain.
 *   * `removeChannel` both unsubscribes and drops the registry entry. Skipping the second half is
 *     how a long-lived app ends up unable to rejoin a topic it "already joined".
 *   * One channel per topic per socket. The count hook and the feed hook can be mounted at the
 *     same time, so they use different topic names.
 *
 * ONE CHANNEL PER TOPIC, SHARED AND REFERENCE-COUNTED
 * ---------------------------------------------------
 * Distinct topic names are not enough, because the SAME hook can be mounted twice -- the tab bar
 * owns the unread badge and the notification settings screen shows the same number. supabase-js
 * does not reject that: `RealtimeClient.channel()` hands back the channel it already holds for the
 * topic, `RealtimeChannel._on` then DROPS the second `postgres_changes` binding as a duplicate,
 * and `subscribe()` is a no-op on an already-open channel. So the second mount receives nothing,
 * and its unmount calls `removeChannel` on the shared object, which kills the first mount's
 * subscription for the rest of the session.
 *
 * `acquireSharedChannel` below is the fix: one channel per topic, a set of listeners fanned out to
 * from a single binding, and `removeChannel` only once the LAST consumer has let go.
 *
 * Teardown runs on unmount AND on sign-out: `userId` is the effect's dependency, so signing out
 * re-runs it with null, which releases the channel and clears the state rather than leaving a badge
 * from the previous account on screen.
 *
 * REPLICA IDENTITY DEFAULT means an UPDATE payload's `old` carries the primary key only, so the
 * previous read state is unknowable from the event. An update that lands on a read row is treated
 * as "one fewer unread" and floored at zero. A DELETE says nothing at all about read state, so it
 * triggers an exact re-count, and so does every successful (re)subscribe. Any drift therefore
 * lasts until the next reconnect rather than until the next launch.
 */

import * as React from 'react'

import type { Tables } from '@halisaha/shared/database'
import { z } from 'zod'

import { supabase, useSession } from '@/lib/supabase'

/** The columns a notification row is read with. */
export type NotificationRow = Pick<
  Tables<'notifications'>,
  'id' | 'type' | 'title' | 'body' | 'data' | 'read_at' | 'created_at'
>

const COLUMNS = 'id, type, title, body, data, read_at, created_at'

/** Realtime hands rows through as loose JSON; only the fields that move state are parsed. */
const changedRowSchema = z
  .object({
    id: z.string(),
    read_at: z.string().nullable().optional(),
  })
  .passthrough()

/** The shape every `postgres_changes` payload satisfies, narrowed to what this file reads. */
interface ChangePayload {
  eventType: string
  new: unknown
  old: unknown
}

/**
 * `RealtimeClient.setAuth` returns void in some versions and a promise in others. Awaiting a
 * non-thenable is a no-op, so this handles both without branching on the version.
 */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof (value as { then: unknown }).then === 'function'
  )
}

async function authoriseRealtime(): Promise<void> {
  const { data } = await supabase.auth.getSession()
  try {
    const result: unknown = supabase.realtime.setAuth(data.session?.access_token ?? undefined)
    if (isThenable(result)) await result
  } catch {
    // The socket keeps whatever token it had and the join may still succeed. A failure to refresh
    // the realtime token must never take a screen down.
  }
}

/* -------------------------------------------------------------------------- */
/*  Shared, reference-counted channels                                         */
/* -------------------------------------------------------------------------- */

type NotificationChannel = ReturnType<typeof supabase.channel>

interface SharedChannel {
  refs: number
  listeners: Set<(payload: ChangePayload) => void>
  subscribed: Set<() => void>
  /** Resolves to the joined channel, or null when every consumer left before the join. */
  pending: Promise<NotificationChannel | null>
}

const sharedChannels = new Map<string, SharedChannel>()

/**
 * Joins `topic` once, however many callers ask for it.
 *
 * @param onChange called for every `postgres_changes` payload on the topic.
 * @param onSubscribed called on each successful (re)join, for the caller to reconcile state.
 * @returns the release function. Call it exactly once, from the effect's cleanup.
 */
function acquireSharedChannel(
  topic: string,
  userId: string,
  onChange: (payload: ChangePayload) => void,
  onSubscribed: () => void,
): () => void {
  let entry = sharedChannels.get(topic)

  if (!entry) {
    const created: SharedChannel = {
      refs: 0,
      listeners: new Set(),
      subscribed: new Set(),
      pending: Promise.resolve(null),
    }

    created.pending = (async () => {
      await authoriseRealtime()
      // Everybody let go while the token was being read. Joining now would leave a channel with
      // no owner and nothing left to release it.
      if (created.refs === 0) return null

      return supabase
        .channel(topic)
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'notifications', filter: `user_id=eq.${userId}` },
          (payload: ChangePayload) => {
            // Copied before iterating: a listener may release during the loop.
            for (const listener of [...created.listeners]) listener(payload)
          },
        )
        .subscribe((status) => {
          if (status !== 'SUBSCRIBED') return
          for (const callback of [...created.subscribed]) callback()
        })
    })()

    sharedChannels.set(topic, created)
    entry = created
  }

  const active = entry
  active.refs += 1
  active.listeners.add(onChange)
  active.subscribed.add(onSubscribed)

  let released = false
  return () => {
    if (released) return
    released = true
    active.listeners.delete(onChange)
    active.subscribed.delete(onSubscribed)
    active.refs -= 1
    if (active.refs > 0) return

    void active.pending
      .then(async (channel) => {
        // A remount inside the same tick (React re-running an effect, a tab regaining focus)
        // takes a reference back before this resolves. Keeping the channel is then correct.
        if (active.refs > 0) return
        sharedChannels.delete(topic)
        if (channel) await supabase.removeChannel(channel)
      })
      .catch(() => {
        // Teardown of a channel that never joined is not worth surfacing.
      })
  }
}

async function readUnreadCount(userId: string): Promise<number> {
  const { count, error } = await supabase
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .is('read_at', null)

  if (error) throw new Error(error.message || 'Could not count your notifications.')
  return count ?? 0
}

/* ========================================================================== */
/*  Unread count                                                              */
/* ========================================================================== */

export interface UnreadNotificationsState {
  /** Unread rows for the signed-in user. Zero while signed out. */
  count: number
  loading: boolean
  error: string | null
  /** Re-counts from the server. Cheap: a HEAD request against a partial index. */
  refresh: () => Promise<void>
  /** Clears every unread row and returns how many it changed. */
  markAllRead: () => Promise<number>
  /** True while `markAllRead` is in flight. */
  updating: boolean
}

/**
 * The live unread count. Drives the tab badge.
 *
 * @example
 * const { count } = useUnreadNotifications()
 */
export function useUnreadNotifications(): UnreadNotificationsState {
  const { user } = useSession()
  const userId = user?.id ?? null

  const [count, setCount] = React.useState(0)
  const [loading, setLoading] = React.useState(userId !== null)
  const [error, setError] = React.useState<string | null>(null)
  const [updating, setUpdating] = React.useState(false)

  const readIdRef = React.useRef(0)

  const load = React.useCallback(async (id: string | null): Promise<void> => {
    const readId = ++readIdRef.current

    if (id === null) {
      setCount(0)
      setError(null)
      setLoading(false)
      return
    }

    try {
      const next = await readUnreadCount(id)
      if (readIdRef.current !== readId) return
      setCount(next)
      setError(null)
    } catch (caught) {
      if (readIdRef.current !== readId) return
      setError(caught instanceof Error ? caught.message : 'Bildirimlerin sayılamadı.')
    } finally {
      if (readIdRef.current === readId) setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    setLoading(userId !== null)
    void load(userId)
  }, [load, userId])

  React.useEffect(() => {
    if (userId === null) return

    return acquireSharedChannel(
      `notifications-count:${userId}`,
      userId,
      (payload) => {
        if (payload.eventType === 'INSERT') {
          const row = changedRowSchema.safeParse(payload.new)
          if (row.success && !row.data.read_at) setCount((current) => current + 1)
          return
        }

        if (payload.eventType === 'UPDATE') {
          const row = changedRowSchema.safeParse(payload.new)
          if (row.success && row.data.read_at) {
            setCount((current) => Math.max(0, current - 1))
          }
          return
        }

        // DELETE tells us nothing about the row's read state, so re-count instead of guessing.
        void load(userId)
      },
      () => {
        // Every successful (re)join reconciles the optimistic arithmetic above with the truth.
        void load(userId)
      },
    )
  }, [load, userId])

  const refresh = React.useCallback(async (): Promise<void> => {
    await load(userId)
  }, [load, userId])

  const markAllRead = React.useCallback(async (): Promise<number> => {
    if (userId === null) return 0

    setUpdating(true)
    setError(null)
    try {
      // `is('read_at', null)` keeps the original timestamp on rows already read, so this is safe
      // to press twice. `select('id')` is what makes the row count come back.
      const { data, error: writeError } = await supabase
        .from('notifications')
        .update({ read_at: new Date().toISOString() })
        .eq('user_id', userId)
        .is('read_at', null)
        .select('id')

      if (writeError) {
        setError(writeError.message || 'Could not mark your notifications as read.')
        return 0
      }

      setCount(0)
      return data?.length ?? 0
    } finally {
      setUpdating(false)
    }
  }, [userId])

  return { count, loading, error, refresh, markAllRead, updating }
}

/* ========================================================================== */
/*  Feed                                                                      */
/* ========================================================================== */

export interface NotificationFeedState {
  items: readonly NotificationRow[]
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
  /** Marks one row read. No-op when it already was. */
  markRead: (id: string) => Promise<void>
}

const DEFAULT_FEED_LIMIT = 20

/**
 * The most recent notifications, newest first, updated as they arrive.
 *
 * A separate topic from {@link useUnreadNotifications} so both can be mounted on one screen.
 */
export function useNotificationFeed(limit: number = DEFAULT_FEED_LIMIT): NotificationFeedState {
  const { user } = useSession()
  const userId = user?.id ?? null

  const [items, setItems] = React.useState<readonly NotificationRow[]>([])
  const [loading, setLoading] = React.useState(userId !== null)
  const [error, setError] = React.useState<string | null>(null)

  const readIdRef = React.useRef(0)

  const load = React.useCallback(
    async (id: string | null): Promise<void> => {
      const readId = ++readIdRef.current

      if (id === null) {
        setItems([])
        setError(null)
        setLoading(false)
        return
      }

      try {
        const { data, error: readError } = await supabase
          .from('notifications')
          .select(COLUMNS)
          .eq('user_id', id)
          .order('created_at', { ascending: false })
          .limit(limit)

        if (readIdRef.current !== readId) return

        if (readError) {
          setError(readError.message || 'Could not load your notifications.')
          return
        }

        setItems(data ?? [])
        setError(null)
      } catch (caught) {
        if (readIdRef.current !== readId) return
        setError(caught instanceof Error ? caught.message : 'Bildirimlerin yüklenemedi.')
      } finally {
        if (readIdRef.current === readId) setLoading(false)
      }
    },
    [limit],
  )

  React.useEffect(() => {
    setLoading(userId !== null)
    void load(userId)
  }, [load, userId])

  React.useEffect(() => {
    if (userId === null) return

    // A payload only carries the columns in the publication's row image, and re-reading the page
    // keeps the list consistent with the ordering and the limit. Notifications arrive at human
    // pace, so one small query per event is the cheaper mistake to make.
    return acquireSharedChannel(
      `notifications-feed:${userId}`,
      userId,
      () => {
        void load(userId)
      },
      () => {
        // postgres_changes does not replay, so a row inserted while the socket was down would
        // stay invisible until an unrelated event arrived. Re-read on every successful (re)join,
        // exactly as the count hook re-counts; `readIdRef` discards an out-of-order answer.
        void load(userId)
      },
    )
  }, [load, userId])

  const refresh = React.useCallback(async (): Promise<void> => {
    await load(userId)
  }, [load, userId])

  const markRead = React.useCallback(async (id: string): Promise<void> => {
    const readAt = new Date().toISOString()

    // Optimistic, because the row is on screen and the user just tapped it.
    setItems((current) =>
      current.map((row) => (row.id === id && row.read_at === null ? { ...row, read_at: readAt } : row)),
    )

    const { error: writeError } = await supabase
      .from('notifications')
      .update({ read_at: readAt })
      .eq('id', id)
      .is('read_at', null)

    if (writeError) {
      setItems((current) =>
        current.map((row) => (row.id === id ? { ...row, read_at: null } : row)),
      )
      setError(writeError.message || 'Could not mark that as read.')
    }
  }, [])

  return { items, loading, error, refresh, markRead }
}
