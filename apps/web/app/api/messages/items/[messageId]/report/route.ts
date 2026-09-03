/**
 * POST /api/messages/items/[messageId]/report — `{ reason, details? }`.
 *
 * `report_message()` snapshots the body into `message_reports.excerpt` and tells the admins.
 * That excerpt is the only message text an admin can ever read.
 */

import { fail, handleRoute, ok } from "@/lib/api-response"
import { rpcFailure } from "@/lib/messaging"
import { getSessionUser } from "@/lib/rbac"
import { createRouteClient } from "@/lib/supabase/server"
import { isUuid } from "@onpitch/shared/channels"
import { API_ERROR_CODES } from "@onpitch/shared/domain"
import { reportMessageSchema } from "@onpitch/shared/messaging"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(
  request: Request,
  { params }: { params: { messageId: string } },
): Promise<Response> {
  return handleRoute<{ reportId: string }>(async () => {
    if (!isUuid(params.messageId)) return fail(API_ERROR_CODES.NOT_FOUND, "Böyle bir mesaj yok.", 404)
    const session = await getSessionUser()
    if (!session) return fail(API_ERROR_CODES.UNAUTHENTICATED, "Giriş yap.", 401)

    const raw: unknown = await request.json().catch(() => null)
    const parsed = reportMessageSchema.safeParse(raw)
    if (!parsed.success) return fail(API_ERROR_CODES.VALIDATION_FAILED, "Bir sebep seç.", 422)

    const supabase = await createRouteClient(request)
    const { data, error } = await supabase.rpc("report_message", {
      p_message: params.messageId,
      p_reason: parsed.data.reason,
      p_details: parsed.data.details ?? null,
    })
    if (error) return rpcFailure(error, "Bildirim gönderilemedi.")
    return ok({ reportId: String(data) })
  })
}
