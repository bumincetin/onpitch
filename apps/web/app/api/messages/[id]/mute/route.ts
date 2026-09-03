/**
 * POST /api/messages/[id]/mute — `{ muted: boolean }`.
 *
 * Muting silences the notification for new messages in this thread. It never hides a message:
 * the thread keeps filling up and the unread count keeps counting.
 */

import { fail, handleRoute, ok } from "@/lib/api-response"
import { rpcFailure } from "@/lib/messaging"
import { getSessionUser } from "@/lib/rbac"
import { createRouteClient } from "@/lib/supabase/server"
import { isUuid } from "@onpitch/shared/channels"
import { API_ERROR_CODES } from "@onpitch/shared/domain"
import { muteConversationSchema } from "@onpitch/shared/messaging"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: Request, { params }: { params: { id: string } }): Promise<Response> {
  return handleRoute<{ muted: boolean }>(async () => {
    if (!isUuid(params.id)) return fail(API_ERROR_CODES.NOT_FOUND, "Böyle bir sohbet yok.", 404)
    const session = await getSessionUser()
    if (!session) return fail(API_ERROR_CODES.UNAUTHENTICATED, "Giriş yap.", 401)

    const raw: unknown = await request.json().catch(() => null)
    const parsed = muteConversationSchema.safeParse(raw)
    if (!parsed.success) return fail(API_ERROR_CODES.VALIDATION_FAILED, "`muted` true ya da false olmalı.", 422)

    const supabase = await createRouteClient(request)
    const { data, error } = await supabase.rpc("set_conversation_muted", {
      p_conversation: params.id,
      p_muted: parsed.data.muted,
    })
    if (error) return rpcFailure(error)
    return ok({ muted: data === true })
  })
}
