/**
 * lib/messaging.ts
 *
 * Direct messages on the phone: the inbox, one thread, the unread badge, and the actions.
 *
 * Every write is an RPC from 0011 called directly — `open_conversation`, `send_message`,
 * `mark_conversation_read`, … — because those functions carry the whole rule set (who may write
 * to whom, blocks, the per-minute budget) and raise PostgREST-mapped codes when they refuse.
 * There is nothing a route handler would add on top. Reads are the same RLS selects and inbox
 * RPCs the web app uses, parsed with the shared schemas rather than cast.
 *
 * Realtime follows `lib/hooks/use-notifications.ts`: `setAuth` before `subscribe`, one topic per
 * hook, `removeChannel` on teardown. `messages`, `conversations` and `conversation_members` are
 * in the publication; RLS is evaluated per event, so the socket only hears about threads this
 * person is in.
 */

import * as React from 'react'

import {
  MESSAGE_PAGE_SIZE,
  blockedUserListSchema,
  conversationListSchema,
  messageRowSchema,
  toMessageView,
  type BlockedUser,
  type ConversationSummary,
  type MessageView,
  type ReportReason,
} from '@onpitch/shared/messaging'

import { supabase, useSession } from '@/lib/supabase'

/* -------------------------------------------------------------------------- */
/*  Errors                                                                    */
/* -------------------------------------------------------------------------- */

/** The RPC's own sentence, or a plain one for machine noise. */
export function messagingErrorText(error: { code?: string; message?: string } | null | undefined, fallback: string): string {
  if (!error) return fallback
  if (error.code && /^PT4\d\d$/.test(error.code)) return error.message || fallback
  if (error.code === '42501') return 'Buna iznin yok.'
  return fallback
}

/* -------------------------------------------------------------------------- */
/*  Realtime plumbing                                                         */
/* -------------------------------------------------------------------------- */

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && 'then' in value && typeof (value as { then: unknown }).then === 'function'
}

async function authoriseRealtime(): Promise<void> {
  const { data } = await supabase.auth.getSession()
  try {
    const result: unknown = supabase.realtime.setAuth(data.session?.access_token ?? undefined)
    if (isThenable(result)) await result
  } catch {
    // The join may still succeed with the token the socket holds.
  }
}

type Channel = ReturnType<typeof supabase.channel>

/**
 * Joins `topic`, binds through `bind`, and returns the teardown. Setup is async because of
 * `setAuth`; the returned function waits for it before removing the channel.
 */
function joinChannel(topic: string, bind: (channel: Channel) => Channel, onSubscribed?: () => void): () => void {
  let cancelled = false
  const pending = (async (): Promise<Channel | null> => {
    await authoriseRealtime()
    if (cancelled) return null
    return bind(supabase.channel(topic)).subscribe((status) => {
      if (status === 'SUBSCRIBED') onSubscribed?.()
    })
  })()
  return () => {
    cancelled = true
    void pending.then((channel) => channel && supabase.removeChannel(channel)).catch(() => undefined)
  }
}

/* -------------------------------------------------------------------------- */
/*  Reads                                                                     */
/* -------------------------------------------------------------------------- */

export async function readConversations(): Promise<ConversationSummary[]> {
  const { data, error } = await supabase.rpc('my_conversations')
  if (error) throw new Error(error.message || 'Sohbetler yüklenemedi.')
  const parsed = conversationListSchema.safeParse(data)
  if (!parsed.success) throw new Error('Sohbetler beklenmedik bir biçimde geldi.')
  return parsed.data
}

export async function readUnreadConversations(): Promise<number> {
  const { data, error } = await supabase.rpc('unread_conversation_count')
  if (error || typeof data !== 'number') return 0
  return data
}

export async function readBlockedUsers(): Promise<BlockedUser[]> {
  const { data, error } = await supabase.rpc('my_blocks')
  if (error) return []
  const parsed = blockedUserListSchema.safeParse(data)
  return parsed.success ? parsed.data : []
}

export async function canMessage(recipientId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('can_message', { p_recipient: recipientId })
  return !error && data === true
}

export interface MessagePage {
  messages: MessageView[]
  nextBefore: string | null
}

export async function readMessagePage(conversationId: string, before: string | null = null, limit = MESSAGE_PAGE_SIZE): Promise<MessagePage> {
  let query = supabase
    .from('messages')
    .select('id, conversation_id, sender_id, body, client_id, created_at, edited_at, deleted_at, redacted_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(limit + 1)
  if (before) query = query.lt('created_at', before)

  const { data, error } = await query
  if (error) throw new Error(error.message || 'Mesajlar yüklenemedi.')

  const rows = (data ?? []).flatMap((row) => {
    const parsed = messageRowSchema.safeParse(row)
    return parsed.success ? [parsed.data] : []
  })
  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  const oldest = page[page.length - 1]
  return { messages: page.map(toMessageView).reverse(), nextBefore: hasMore && oldest ? oldest.created_at : null }
}

/* -------------------------------------------------------------------------- */
/*  Writes                                                                    */
/* -------------------------------------------------------------------------- */

export class MessagingError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
  ) {
    super(message)
    this.name = 'MessagingError'
    Object.setPrototypeOf(this, MessagingError.prototype)
  }
}

function raise(error: { code?: string; message?: string }, fallback: string): never {
  throw new MessagingError(messagingErrorText(error, fallback), error.code ?? null)
}

export async function openConversation(recipientId: string): Promise<string> {
  const { data, error } = await supabase.rpc('open_conversation', { p_recipient: recipientId })
  if (error) raise(error, 'Sohbet açılamadı.')
  if (typeof data !== 'string') throw new MessagingError('Sohbet açılamadı.', null)
  return data
}

export async function sendMessage(conversationId: string, body: string, clientId: string): Promise<MessageView> {
  const { data, error } = await supabase.rpc('send_message', { p_conversation: conversationId, p_body: body, p_client_id: clientId })
  if (error) raise(error, 'Mesaj gönderilemedi.')
  const parsed = messageRowSchema.safeParse(data)
  if (!parsed.success) throw new MessagingError('Mesaj kaydedildi ama okunamadı.', null)
  return toMessageView(parsed.data)
}

export async function markConversationRead(conversationId: string): Promise<void> {
  await supabase.rpc('mark_conversation_read', { p_conversation: conversationId })
}

export async function setConversationMuted(conversationId: string, muted: boolean): Promise<boolean> {
  const { data, error } = await supabase.rpc('set_conversation_muted', { p_conversation: conversationId, p_muted: muted })
  if (error) raise(error, 'Ayar kaydedilemedi.')
  return data === true
}

export async function leaveConversation(conversationId: string): Promise<void> {
  const { error } = await supabase.rpc('leave_conversation', { p_conversation: conversationId })
  if (error) raise(error, 'Sohbetten çıkılamadı.')
}

export async function deleteMessage(messageId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('delete_message', { p_message: messageId })
  if (error) raise(error, 'Mesaj geri alınamadı.')
  return data === true
}

export async function reportMessage(messageId: string, reason: ReportReason, details?: string): Promise<void> {
  const { error } = await supabase.rpc('report_message', { p_message: messageId, p_reason: reason, p_details: details ?? null })
  if (error) raise(error, 'Bildirim gönderilemedi.')
}

export async function blockUser(userId: string): Promise<void> {
  const { error } = await supabase.rpc('block_user', { p_user: userId })
  if (error) raise(error, 'Engellenemedi.')
}

export async function unblockUser(userId: string): Promise<void> {
  const { error } = await supabase.rpc('unblock_user', { p_user: userId })
  if (error) raise(error, 'Engel kaldırılamadı.')
}

export async function isBlocked(viewerId: string, userId: string): Promise<boolean> {
  const { data } = await supabase.from('user_blocks').select('blocked_id').eq('blocker_id', viewerId).eq('blocked_id', userId).maybeSingle()
  return Boolean(data)
}

/* -------------------------------------------------------------------------- */
/*  Hooks                                                                     */
/* -------------------------------------------------------------------------- */

export interface UnreadConversationsState {
  count: number
  refresh: () => Promise<void>
}

/** Threads with something unread. The Messages tab badge. */
export function useUnreadConversations(): UnreadConversationsState {
  const { user } = useSession()
  const userId = user?.id ?? null
  const [count, setCount] = React.useState(0)

  const refresh = React.useCallback(async (): Promise<void> => {
    if (userId === null) {
      setCount(0)
      return
    }
    setCount(await readUnreadConversations())
  }, [userId])

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  React.useEffect(() => {
    if (userId === null) return
    return joinChannel(
      `unread-conversations:${userId}`,
      (channel) =>
        channel
          .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, () => void refresh())
          .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'conversation_members', filter: `user_id=eq.${userId}` }, () => void refresh()),
      () => void refresh(),
    )
  }, [refresh, userId])

  return { count, refresh }
}

export interface ConversationsState {
  items: ConversationSummary[]
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
}

/** The inbox, kept current from the `conversations` stream. */
export function useConversations(): ConversationsState {
  const { user } = useSession()
  const userId = user?.id ?? null
  const [items, setItems] = React.useState<ConversationSummary[]>([])
  const [loading, setLoading] = React.useState(userId !== null)
  const [error, setError] = React.useState<string | null>(null)
  const readIdRef = React.useRef(0)

  const refresh = React.useCallback(async (): Promise<void> => {
    const readId = ++readIdRef.current
    if (userId === null) {
      setItems([])
      setLoading(false)
      return
    }
    try {
      const next = await readConversations()
      if (readIdRef.current !== readId) return
      setItems(next)
      setError(null)
    } catch (caught) {
      if (readIdRef.current !== readId) return
      setError(caught instanceof Error ? caught.message : 'Sohbetler yüklenemedi.')
    } finally {
      if (readIdRef.current === readId) setLoading(false)
    }
  }, [userId])

  React.useEffect(() => {
    setLoading(userId !== null)
    void refresh()
  }, [refresh, userId])

  React.useEffect(() => {
    if (userId === null) return
    return joinChannel(
      `inbox:${userId}`,
      (channel) =>
        channel
          .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'conversations' }, () => void refresh())
          .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'conversation_members', filter: `user_id=eq.${userId}` }, () => void refresh()),
      () => void refresh(),
    )
  }, [refresh, userId])

  return { items, loading, error, refresh }
}

export interface ThreadState {
  messages: MessageView[]
  loading: boolean
  error: string | null
  nextBefore: string | null
  loadOlder: () => Promise<void>
  send: (body: string) => Promise<void>
  sending: boolean
  unsend: (message: MessageView) => Promise<void>
}

function newClientId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * One thread: first page, older pages on demand, live inserts and updates, optimistic sends
 * matched back on `client_id`, and a read mark whenever something arrives from the other side.
 */
export function useThread(conversationId: string | null): ThreadState {
  const { user } = useSession()
  const viewerId = user?.id ?? null
  const [messages, setMessages] = React.useState<MessageView[]>([])
  const [loading, setLoading] = React.useState(conversationId !== null)
  const [error, setError] = React.useState<string | null>(null)
  const [nextBefore, setNextBefore] = React.useState<string | null>(null)
  const [sending, setSending] = React.useState(false)

  const upsert = React.useCallback((incoming: MessageView) => {
    setMessages((current) => {
      const byId = current.findIndex((m) => m.id === incoming.id)
      if (byId !== -1) {
        const next = [...current]
        next[byId] = { ...incoming, pending: false }
        return next
      }
      const byClient = incoming.clientId ? current.findIndex((m) => m.pending && m.clientId === incoming.clientId) : -1
      if (byClient !== -1) {
        const next = [...current]
        next[byClient] = { ...incoming, pending: false }
        return next
      }
      return [...current, incoming].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    })
  }, [])

  const loadFirst = React.useCallback(async (): Promise<void> => {
    if (conversationId === null) return
    try {
      const page = await readMessagePage(conversationId)
      setMessages(page.messages)
      setNextBefore(page.nextBefore)
      setError(null)
      void markConversationRead(conversationId)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Mesajlar yüklenemedi.')
    } finally {
      setLoading(false)
    }
  }, [conversationId])

  React.useEffect(() => {
    setMessages([])
    setLoading(conversationId !== null)
    void loadFirst()
  }, [conversationId, loadFirst])

  React.useEffect(() => {
    if (conversationId === null || viewerId === null) return
    return joinChannel(
      `thread:${conversationId}`,
      (channel) =>
        channel.on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'messages', filter: `conversation_id=eq.${conversationId}` },
          (payload: { eventType: string; new: unknown }) => {
            const parsed = messageRowSchema.safeParse(payload.new)
            if (!parsed.success) return
            const view = toMessageView(parsed.data)
            upsert(view)
            if (payload.eventType === 'INSERT' && view.senderId !== viewerId) void markConversationRead(conversationId)
          },
        ),
      () => void loadFirst(),
    )
  }, [conversationId, loadFirst, upsert, viewerId])

  const loadOlder = React.useCallback(async (): Promise<void> => {
    if (conversationId === null || !nextBefore) return
    const page = await readMessagePage(conversationId, nextBefore)
    setMessages((current) => {
      const known = new Set(current.map((m) => m.id))
      return [...page.messages.filter((m) => !known.has(m.id)), ...current]
    })
    setNextBefore(page.nextBefore)
  }, [conversationId, nextBefore])

  const send = React.useCallback(
    async (body: string): Promise<void> => {
      const text = body.trim()
      if (conversationId === null || viewerId === null || !text) return
      const clientId = newClientId()
      const optimistic: MessageView = {
        id: `pending-${clientId}`,
        conversationId,
        senderId: viewerId,
        body: text,
        createdAt: new Date().toISOString(),
        deleted: false,
        redacted: false,
        pending: true,
        clientId,
      }
      setMessages((current) => [...current, optimistic])
      setSending(true)
      try {
        upsert(await sendMessage(conversationId, text, clientId))
      } catch (caught) {
        setMessages((current) => current.filter((m) => m.id !== optimistic.id))
        throw caught
      } finally {
        setSending(false)
      }
    },
    [conversationId, upsert, viewerId],
  )

  const unsend = React.useCallback(
    async (message: MessageView): Promise<void> => {
      if (await deleteMessage(message.id)) upsert({ ...message, body: '', deleted: true })
    },
    [upsert],
  )

  return { messages, loading, error, nextBefore, loadOlder, send, sending, unsend }
}
