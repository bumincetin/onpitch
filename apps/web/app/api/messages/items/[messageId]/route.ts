/**
 * DELETE /api/messages/items/[messageId] — unsend.
 *
 * Sender only, enforced by `delete_message()`. The row stays as a tombstone so the thread keeps
 * its shape and any report filed against it keeps its excerpt.
 */

import { fail, handleRoute, ok } from "@/lib/api-response"
import { rpcFailure } from "@/lib/messaging"
import { getSessionUser } from "@/lib/rbac"
import { createRouteClient } from "@/lib/supabase/server"
import { isUuid } from "@onpitch/shared/channels"
import { API_ERROR_CODES } from "@onpitch/shared/domain"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function DELETE(
  request: Request,
  { params }: { params: { messageId: string } },
): Promise<Response> {
  return handleRoute<{ deleted: boolean }>(async () => {
    if (!isUuid(params.messageId)) return fail(API_ERROR_CODES.NOT_FOUND, "Böyle bir mesaj yok.", 404)
    const session = await getSessionUser()
    if (!session) return fail(API_ERROR_CODES.UNAUTHENTICATED, "Giriş yap.", 401)

    const supabase = await createRouteClient(request)
    const { data, error } = await supabase.rpc("delete_message", { p_message: params.messageId })
    if (error) return rpcFailure(error, "Mesaj geri alınamadı.")
    if (data !== true) return fail(API_ERROR_CODES.NOT_FOUND, "Bu mesaj senin değil ya da zaten kaldırılmış.", 404)
    return ok({ deleted: true })
  })
}
