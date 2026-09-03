/**
 * /api/messages/[id]
 *
 *   GET     one page of the thread, oldest first. `?before=<iso>` pages backwards.
 *   POST    send a message into it.
 *   DELETE  leave it (hides the thread for the caller; the other side keeps it).
 *
 * Reading is RLS (`messages_select_member`): a non-member gets an empty page, not a 403, which
 * is the same answer a made-up id gets. Sending is `send_message()`, which re-checks membership,
 * blocks, the recipient's policy and the per-minute budget.
 */

import { fail, handleRoute, ok } from "@/lib/api-response"
import { loadMessagePage, rpcFailure } from "@/lib/messaging"
import { getSessionUser } from "@/lib/rbac"
import { createRouteClient } from "@/lib/supabase/server"
import { isUuid } from "@onpitch/shared/channels"
import { API_ERROR_CODES } from "@onpitch/shared/domain"
import {
  messagePageQuerySchema,
  messageRowSchema,
  sendMessageSchema,
  toMessageView,
  type MessagePageResult,
  type SendMessageResult,
} from "@onpitch/shared/messaging"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

interface Context {
  params: { id: string }
}

export async function GET(request: Request, { params }: Context): Promise<Response> {
  return handleRoute<MessagePageResult>(async () => {
    if (!isUuid(params.id)) return fail(API_ERROR_CODES.NOT_FOUND, "Böyle bir sohbet yok.", 404)
    const session = await getSessionUser()
    if (!session) return fail(API_ERROR_CODES.UNAUTHENTICATED, "Mesajların için giriş yap.", 401)

    const url = new URL(request.url)
    const query = messagePageQuerySchema.safeParse({
      before: url.searchParams.get("before") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
    })
    if (!query.success) return fail(API_ERROR_CODES.VALIDATION_FAILED, "Sayfa parametreleri geçersiz.", 422)

    const supabase = await createRouteClient(request)
    const page = await loadMessagePage(supabase, params.id, query.data)
    return ok<MessagePageResult>({ conversationId: params.id, ...page })
  })
}

export async function POST(request: Request, { params }: Context): Promise<Response> {
  return handleRoute<SendMessageResult>(async () => {
    if (!isUuid(params.id)) return fail(API_ERROR_CODES.NOT_FOUND, "Böyle bir sohbet yok.", 404)
    const session = await getSessionUser()
    if (!session) return fail(API_ERROR_CODES.UNAUTHENTICATED, "Mesaj göndermek için giriş yap.", 401)

    const raw: unknown = await request.json().catch(() => null)
    const parsed = sendMessageSchema.safeParse(raw)
    if (!parsed.success) {
      return fail(API_ERROR_CODES.VALIDATION_FAILED, parsed.error.issues[0]?.message ?? "Mesaj geçersiz.", 422)
    }

    const supabase = await createRouteClient(request)
    const sent = await supabase.rpc("send_message", {
      p_conversation: params.id,
      p_body: parsed.data.body,
      p_client_id: parsed.data.clientId ?? null,
    })
    if (sent.error) return rpcFailure(sent.error, "Mesaj gönderilemedi.")

    const row = messageRowSchema.safeParse(sent.data)
    if (!row.success) return fail(API_ERROR_CODES.INTERNAL, "Mesaj kaydedildi ama okunamadı.", 500)
    return ok<SendMessageResult>({ message: toMessageView(row.data) })
  })
}

export async function DELETE(request: Request, { params }: Context): Promise<Response> {
  return handleRoute<{ left: boolean }>(async () => {
    if (!isUuid(params.id)) return fail(API_ERROR_CODES.NOT_FOUND, "Böyle bir sohbet yok.", 404)
    const session = await getSessionUser()
    if (!session) return fail(API_ERROR_CODES.UNAUTHENTICATED, "Giriş yap.", 401)

    const supabase = await createRouteClient(request)
    const { data, error } = await supabase.rpc("leave_conversation", { p_conversation: params.id })
    if (error) return rpcFailure(error, "Sohbetten çıkılamadı.")
    return ok({ left: data === true })
  })
}
