import "server-only"

/**
 * lib/messaging/index.ts
 *
 * Server-side reads for direct messages, and the one place that turns an RPC refusal into an
 * API envelope.
 *
 * Every write is an RPC in 0011 (`open_conversation`, `send_message`, …) that raises with a
 * PostgREST-mapped SQLSTATE — `PT403` for "not allowed", `PT429` for "slow down" — so a refusal
 * already carries its HTTP status. `rpcFailure()` reads that code and answers with the matching
 * envelope instead of a generic 500, which is what lets the chat UI say "this person is not
 * accepting messages" rather than "something went wrong".
 *
 * Reads are plain selects under RLS (`messages_select_member`) or the two inbox RPCs, and the
 * jsonb they return is parsed with the shared schemas rather than cast.
 */

import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js"

import { fail } from "@/lib/api-response"
import type { Database } from "@onpitch/shared/database"
import { API_ERROR_CODES } from "@onpitch/shared/domain"
import {
  MESSAGE_PAGE_SIZE,
  blockedUserListSchema,
  conversationListSchema,
  messageRowSchema,
  toMessageView,
  type BlockedUser,
  type ConversationSummary,
  type MessageView,
} from "@onpitch/shared/messaging"

type Client = SupabaseClient<Database>

/* -------------------------------------------------------------------------- */
/*  Refusals                                                                  */
/* -------------------------------------------------------------------------- */

const STATUS_BY_SQLSTATE: Readonly<Record<string, { status: number; code: string }>> = {
  PT401: { status: 401, code: API_ERROR_CODES.UNAUTHENTICATED },
  PT403: { status: 403, code: API_ERROR_CODES.FORBIDDEN },
  PT404: { status: 404, code: API_ERROR_CODES.NOT_FOUND },
  PT410: { status: 410, code: API_ERROR_CODES.NOT_FOUND },
  PT422: { status: 422, code: API_ERROR_CODES.VALIDATION_FAILED },
  PT429: { status: 429, code: API_ERROR_CODES.RATE_LIMITED },
  "42501": { status: 403, code: API_ERROR_CODES.FORBIDDEN },
}

/** The RPC's own sentence when it has one; a fixed one when the error is machine noise. */
export function rpcFailure(error: PostgrestError, fallback = "Bu işlem tamamlanamadı."): Response {
  const mapped = STATUS_BY_SQLSTATE[error.code ?? ""]
  if (mapped) return fail(mapped.code, error.message || fallback, mapped.status)
  console.error("[messaging] rpc failed", { code: error.code })
  return fail(API_ERROR_CODES.INTERNAL, fallback, 500)
}

/* -------------------------------------------------------------------------- */
/*  Reads                                                                     */
/* -------------------------------------------------------------------------- */

export async function loadConversations(supabase: Client): Promise<ConversationSummary[]> {
  const { data, error } = await supabase.rpc("my_conversations")
  if (error) {
    console.error("[messaging] my_conversations failed", { code: error.code })
    return []
  }
  const parsed = conversationListSchema.safeParse(data)
  if (!parsed.success) {
    console.error("[messaging] my_conversations returned an unexpected shape")
    return []
  }
  return parsed.data
}

export async function loadUnreadConversationCount(supabase: Client): Promise<number> {
  const { data, error } = await supabase.rpc("unread_conversation_count")
  if (error || typeof data !== "number") return 0
  return data
}

export async function loadBlockedUsers(supabase: Client): Promise<BlockedUser[]> {
  const { data, error } = await supabase.rpc("my_blocks")
  if (error) return []
  const parsed = blockedUserListSchema.safeParse(data)
  return parsed.success ? parsed.data : []
}

export async function loadCanMessage(supabase: Client, recipientId: string): Promise<boolean> {
  const { data, error } = await supabase.rpc("can_message", { p_recipient: recipientId })
  return !error && data === true
}

export interface MessagePage {
  messages: MessageView[]
  /** ISO timestamp to pass as `before` for the next older page; null when exhausted. */
  nextBefore: string | null
}

/**
 * One page of a thread, oldest first. Reads one row past the page so the caller learns whether
 * an older page exists without a second count query.
 */
export async function loadMessagePage(
  supabase: Client,
  conversationId: string,
  options: { before?: string | null; limit?: number } = {},
): Promise<MessagePage> {
  const limit = Math.min(Math.max(options.limit ?? MESSAGE_PAGE_SIZE, 1), 100)

  let query = supabase
    .from("messages")
    .select("id, conversation_id, sender_id, body, client_id, created_at, edited_at, deleted_at, redacted_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(limit + 1)

  if (options.before) query = query.lt("created_at", options.before)

  const { data, error } = await query
  if (error) {
    console.error("[messaging] message page failed", { code: error.code })
    return { messages: [], nextBefore: null }
  }

  const rows = (data ?? []).flatMap((row) => {
    const parsed = messageRowSchema.safeParse(row)
    return parsed.success ? [parsed.data] : []
  })

  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows
  const oldest = page[page.length - 1]

  return {
    messages: page.map(toMessageView).reverse(),
    nextBefore: hasMore && oldest ? oldest.created_at : null,
  }
}
