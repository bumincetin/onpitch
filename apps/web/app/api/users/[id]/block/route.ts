/**
 * /api/users/[id]/block
 *
 *   POST    block this person. Stops messages both ways and every thread-start path.
 *   DELETE  unblock.
 *
 * Both are RPCs in 0011 (`block_user`, `unblock_user`); blocking is audited and rate-limited
 * there. The blocked person is never told.
 */

import { fail, handleRoute, ok } from "@/lib/api-response"
import { rpcFailure } from "@/lib/messaging"
import { getSessionUser } from "@/lib/rbac"
import { createRouteClient } from "@/lib/supabase/server"
import { isUuid } from "@onpitch/shared/channels"
import { API_ERROR_CODES } from "@onpitch/shared/domain"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

interface Context {
  params: { id: string }
}

export async function POST(request: Request, { params }: Context): Promise<Response> {
  return handleRoute<{ blocked: boolean }>(async () => {
    if (!isUuid(params.id)) return fail(API_ERROR_CODES.NOT_FOUND, "Böyle biri yok.", 404)
    const session = await getSessionUser()
    if (!session) return fail(API_ERROR_CODES.UNAUTHENTICATED, "Giriş yap.", 401)

    const supabase = await createRouteClient(request)
    const { error } = await supabase.rpc("block_user", { p_user: params.id })
    if (error) return rpcFailure(error, "Engellenemedi.")
    return ok({ blocked: true })
  })
}

export async function DELETE(request: Request, { params }: Context): Promise<Response> {
  return handleRoute<{ blocked: boolean }>(async () => {
    if (!isUuid(params.id)) return fail(API_ERROR_CODES.NOT_FOUND, "Böyle biri yok.", 404)
    const session = await getSessionUser()
    if (!session) return fail(API_ERROR_CODES.UNAUTHENTICATED, "Giriş yap.", 401)

    const supabase = await createRouteClient(request)
    const { error } = await supabase.rpc("unblock_user", { p_user: params.id })
    if (error) return rpcFailure(error, "Engel kaldırılamadı.")
    return ok({ blocked: false })
  })
}
