/**
 * /api/messages
 *
 *   GET   the caller's inbox — every thread they are in, newest first, with unread counts.
 *   POST  open a thread with somebody, optionally sending the first message in the same call.
 *
 * Who may open a thread with whom is `public.can_message()` in 0011, evaluated inside
 * `open_conversation()`; this route never decides it. The RPC's refusal codes are mapped to
 * HTTP by `rpcFailure()` so the client gets a sentence and the right status.
 */

import { fail, handleRoute, ok } from "@/lib/api-response"
import { loadConversations, loadUnreadConversationCount, rpcFailure } from "@/lib/messaging"
import { getSessionUser } from "@/lib/rbac"
import { createRouteClient } from "@/lib/supabase/server"
import { API_ERROR_CODES } from "@onpitch/shared/domain"
import {
  messageRowSchema,
  startConversationSchema,
  toMessageView,
  type ConversationListResult,
  type StartConversationResult,
} from "@onpitch/shared/messaging"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: Request): Promise<Response> {
  return handleRoute<ConversationListResult>(async () => {
    const session = await getSessionUser()
    if (!session) return fail(API_ERROR_CODES.UNAUTHENTICATED, "Mesajların için giriş yap.", 401)

    const supabase = await createRouteClient(request)
    const [conversations, unreadConversations] = await Promise.all([
      loadConversations(supabase),
      loadUnreadConversationCount(supabase),
    ])
    return ok<ConversationListResult>({ conversations, unreadConversations })
  })
}

export async function POST(request: Request): Promise<Response> {
  return handleRoute<StartConversationResult>(async () => {
    const session = await getSessionUser()
    if (!session) return fail(API_ERROR_CODES.UNAUTHENTICATED, "Mesaj göndermek için giriş yap.", 401)

    const raw: unknown = await request.json().catch(() => null)
    const parsed = startConversationSchema.safeParse(raw)
    if (!parsed.success) {
      return fail(API_ERROR_CODES.VALIDATION_FAILED, "Girdiğin bilgilerin bir kısmı geçersiz.", 422, {
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      })
    }

    const supabase = await createRouteClient(request)
    const opened = await supabase.rpc("open_conversation", { p_recipient: parsed.data.recipientId })
    if (opened.error) return rpcFailure(opened.error, "Sohbet açılamadı.")
    const conversationId = opened.data

    if (!parsed.data.body) {
      return ok<StartConversationResult>({ conversationId, message: null })
    }

    const sent = await supabase.rpc("send_message", {
      p_conversation: conversationId,
      p_body: parsed.data.body,
      p_client_id: parsed.data.clientId ?? null,
    })
    if (sent.error) return rpcFailure(sent.error, "Mesaj gönderilemedi.")

    const row = messageRowSchema.safeParse(sent.data)
    return ok<StartConversationResult>({
      conversationId,
      message: row.success ? toMessageView(row.data) : null,
    })
  })
}
