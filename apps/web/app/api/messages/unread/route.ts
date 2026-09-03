/** GET /api/messages/unread — threads with something unread. The header badge's refresh. */

import { fail, handleRoute, ok } from "@/lib/api-response"
import { loadUnreadConversationCount } from "@/lib/messaging"
import { getSessionUser } from "@/lib/rbac"
import { createRouteClient } from "@/lib/supabase/server"
import { API_ERROR_CODES } from "@onpitch/shared/domain"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: Request): Promise<Response> {
  return handleRoute<{ unreadConversations: number }>(async () => {
    const session = await getSessionUser()
    if (!session) return fail(API_ERROR_CODES.UNAUTHENTICATED, "Giriş yap.", 401)
    const supabase = await createRouteClient(request)
    return ok({ unreadConversations: await loadUnreadConversationCount(supabase) })
  })
}
