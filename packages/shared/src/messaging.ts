/**
 * packages/shared/src/messaging.ts
 *
 * Wire shapes for direct messages. The RPCs in 0011 return `jsonb`; every consumer parses it
 * with these schemas rather than casting (docs/SECURITY.md §2). The request-body schemas for
 * `/api/messages/*` live here too so the Expo client and the web app send the same thing.
 */

import { z } from "zod"

import { accentColorSchema } from "./profile"

/* -------------------------------------------------------------------------- */
/*  Limits — mirrored from the CHECK constraints and the RPC guards            */
/* -------------------------------------------------------------------------- */

export const MESSAGE_BODY_MAX = 2000
export const MESSAGE_CLIENT_ID_MAX = 64
export const MESSAGE_PAGE_SIZE = 50

export const REPORT_REASONS = ["harassment", "spam", "inappropriate", "other"] as const
export type ReportReason = (typeof REPORT_REASONS)[number]
export const REPORT_REASON_LABEL: Record<ReportReason, string> = {
  harassment: "Taciz ya da hakaret",
  spam: "İstenmeyen mesaj / reklam",
  inappropriate: "Uygunsuz içerik",
  other: "Başka bir şey",
}

/* -------------------------------------------------------------------------- */
/*  Shapes coming OUT of the database                                          */
/* -------------------------------------------------------------------------- */

const uuid = z.string().uuid()
const iso = z.string().min(1)

export const conversationCounterpartSchema = z.object({
  id: uuid,
  displayName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  accentColor: accentColorSchema.catch("gold"),
  role: z.string(),
  erased: z.boolean(),
})
export type ConversationCounterpart = z.infer<typeof conversationCounterpartSchema>

export const conversationLastMessageSchema = z.object({
  id: uuid,
  senderId: uuid,
  body: z.string(),
  removed: z.boolean(),
  createdAt: iso,
})

/** One row of `my_conversations()`. */
export const conversationSummarySchema = z.object({
  id: uuid,
  bookingId: uuid.nullable(),
  lastMessageAt: iso.nullable(),
  mutedAt: iso.nullable(),
  lastReadAt: iso.nullable(),
  unreadCount: z.number().int().min(0),
  counterpart: conversationCounterpartSchema.nullable(),
  lastMessage: conversationLastMessageSchema.nullable(),
})
export type ConversationSummary = z.infer<typeof conversationSummarySchema>

export const conversationListSchema = z.array(conversationSummarySchema)

/** A `messages` row as PostgREST and Realtime deliver it. */
export const messageRowSchema = z.object({
  id: uuid,
  conversation_id: uuid,
  sender_id: uuid,
  body: z.string(),
  client_id: z.string().nullable().optional(),
  created_at: iso,
  edited_at: iso.nullable().optional(),
  deleted_at: iso.nullable().optional(),
  redacted_at: iso.nullable().optional(),
})
export type MessageRow = z.infer<typeof messageRowSchema>

/** What a screen renders. */
export interface MessageView {
  id: string
  conversationId: string
  senderId: string
  body: string
  createdAt: string
  /** The sender unsent it. */
  deleted: boolean
  /** The sender's account was erased. */
  redacted: boolean
  /** True while an optimistic send is in flight. */
  pending?: boolean
  clientId?: string | null
}

export function toMessageView(row: MessageRow): MessageView {
  const deleted = Boolean(row.deleted_at)
  const redacted = Boolean(row.redacted_at)
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderId: row.sender_id,
    body: deleted || redacted ? "" : row.body,
    createdAt: row.created_at,
    deleted,
    redacted,
    clientId: row.client_id ?? null,
  }
}

export const blockedUserSchema = z.object({
  id: uuid,
  displayName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  accentColor: accentColorSchema.catch("gold"),
  blockedAt: iso,
})
export type BlockedUser = z.infer<typeof blockedUserSchema>
export const blockedUserListSchema = z.array(blockedUserSchema)

/* -------------------------------------------------------------------------- */
/*  Request bodies                                                            */
/* -------------------------------------------------------------------------- */

const bodySchema = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => value.length >= 1 && value.length <= MESSAGE_BODY_MAX, {
    message: `Mesaj 1 ile ${MESSAGE_BODY_MAX} karakter arasında olmalı.`,
  })

/** `POST /api/messages` — open a thread, optionally with a first message. */
export const startConversationSchema = z
  .object({
    recipientId: uuid,
    body: bodySchema.optional(),
    clientId: z.string().max(MESSAGE_CLIENT_ID_MAX).optional(),
  })
  .strict()
export type StartConversationInput = z.infer<typeof startConversationSchema>

/** `POST /api/messages/[id]` — send into a thread. */
export const sendMessageSchema = z
  .object({
    body: bodySchema,
    clientId: z.string().max(MESSAGE_CLIENT_ID_MAX).optional(),
  })
  .strict()
export type SendMessageInput = z.infer<typeof sendMessageSchema>

/** `POST /api/messages/[id]/mute`. */
export const muteConversationSchema = z.object({ muted: z.boolean() }).strict()

/** `POST /api/messages/items/[messageId]/report`. */
export const reportMessageSchema = z
  .object({
    reason: z.enum(REPORT_REASONS),
    details: z.string().max(1000).optional(),
  })
  .strict()
export type ReportMessageInput = z.infer<typeof reportMessageSchema>

/** `GET /api/messages/[id]?before=&limit=`. */
export const messagePageQuerySchema = z.object({
  before: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(MESSAGE_PAGE_SIZE),
})

/* -------------------------------------------------------------------------- */
/*  Responses                                                                 */
/* -------------------------------------------------------------------------- */

export interface ConversationListResult {
  conversations: ConversationSummary[]
  unreadConversations: number
}

export interface MessagePageResult {
  conversationId: string
  messages: MessageView[]
  /** Pass back as `?before=` for older messages; null when exhausted. */
  nextBefore: string | null
}

export interface SendMessageResult {
  message: MessageView
}

export interface StartConversationResult {
  conversationId: string
  message: MessageView | null
}

/* -------------------------------------------------------------------------- */
/*  Small pure helpers                                                        */
/* -------------------------------------------------------------------------- */

/** The wire text for a message a screen must not show verbatim. */
export function removedMessageLabel(message: Pick<MessageView, "deleted" | "redacted">): string | null {
  if (message.redacted) return "Bu hesap silindi; mesaj kaldırıldı."
  if (message.deleted) return "Mesaj geri alındı."
  return null
}

/** Whether two ISO timestamps fall on the same calendar day in Istanbul. */
export function sameIstanbulDay(a: string, b: string): boolean {
  return istanbulDayKey(a) === istanbulDayKey(b)
}

const DAY_KEY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Istanbul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
})

export function istanbulDayKey(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? "" : DAY_KEY.format(date)
}

/**
 * Group a chronological list into day sections and, inside a day, into runs by the same
 * sender within five minutes — the shape every chat UI draws.
 */
export interface MessageRun {
  senderId: string
  messages: MessageView[]
}
export interface MessageDay {
  dayKey: string
  /** The first message's timestamp, for the day label. */
  at: string
  runs: MessageRun[]
}

const RUN_WINDOW_MS = 5 * 60_000

export function groupMessages(messages: readonly MessageView[]): MessageDay[] {
  const days: MessageDay[] = []
  for (const message of messages) {
    const key = istanbulDayKey(message.createdAt)
    let day = days[days.length - 1]
    if (!day || day.dayKey !== key) {
      day = { dayKey: key, at: message.createdAt, runs: [] }
      days.push(day)
    }
    const run = day.runs[day.runs.length - 1]
    const last = run?.messages[run.messages.length - 1]
    const continues =
      run &&
      last &&
      run.senderId === message.senderId &&
      Date.parse(message.createdAt) - Date.parse(last.createdAt) < RUN_WINDOW_MS
    if (continues) run.messages.push(message)
    else day.runs.push({ senderId: message.senderId, messages: [message] })
  }
  return days
}
