/**
 * POST /api/messages/[id]/read — the caller has seen this thread up to now.
 *
 * Moves `conversation_members.last_read_at` and marks the thread's `message.received`
 * notification read, both inside `mark_conversation_read()`.
 */

import { fail, handleRoute, ok } from "@/lib/api-response"
import { loadUnreadConversationCount, rpcFailure } from "@/lib/messaging"
import { getSessionUser } from "@/lib/rbac"
import { createRouteClient } from "@/lib/supabase/server"
import { isUuid } from "@onpitch/shared/channels"
import { API_ERROR_CODES } from "@onpitch/shared/domain"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: Request, { params }: { params: { id: string } }): Promise<Response> {
  return handleRoute<{ readAt: string; unreadConversations: number }>(async () => {
    if (!isUuid(params.id)) return fail(API_ERROR_CODES.NOT_FOUND, "Böyle bir sohbet yok.", 404)
    const session = await getSessionUser()
    if (!session) return fail(API_ERROR_CODES.UNAUTHENTICATED, "Giriş yap.", 401)

    const supabase = await createRouteClient(request)
    const { data, error } = await supabase.rpc("mark_conversation_read", { p_conversation: params.id })
    if (error) return rpcFailure(error)

    const unreadConversations = await loadUnreadConversationCount(supabase)
    return ok({ readAt: typeof data === "string" ? data : new Date().toISOString(), unreadConversations })
  })
}
