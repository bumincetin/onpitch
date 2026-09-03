/**
 * POST /api/notifications/[id]/read — mark one notification as read.
 *
 * `0002_rls.sql` §4.7 grants `authenticated` an UPDATE on the `read_at` column ONLY, and
 * `notifications_update_own` scopes the row to `user_id = auth.uid()`. So this handler cannot
 * change a notification's text even if it wanted to, and it cannot touch somebody else's row.
 *
 * Idempotent by design. The `.is('read_at', null)` guard means a second call does not overwrite
 * the original timestamp; when it matches nothing the handler distinguishes "already read" (200,
 * returning the existing timestamp) from "not yours / does not exist" (404) with one extra read.
 * That matters because the bell fires this on click, and a double click must not look like a
 * failure.
 */

import { z } from "zod"

import { fail, handleRoute, ok } from "@/lib/api-response"
import { getSessionUser } from "@/lib/rbac"
import { createClient } from "@/lib/supabase/server"
import type { NotificationReadResult } from "@/lib/notifications/format"
import { API_ERROR_CODES } from "@onpitch/shared/domain"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const idSchema = z.string().uuid()

export async function POST(
  _request: Request,
  context: { params: { id: string } },
): Promise<Response> {
  return handleRoute<NotificationReadResult>(async () => {
    const session = await getSessionUser()
    if (!session) {
      return fail(API_ERROR_CODES.UNAUTHENTICATED, "Bildirimlerini okumak için giriş yap.", 401)
    }

    const parsedId = idSchema.safeParse(context.params.id)
    if (!parsedId.success) {
      return fail(API_ERROR_CODES.VALIDATION_FAILED, "Bu bildirim kimliği geçersiz.", 422)
    }
    const notificationId = parsedId.data

    const supabase = await createClient()
    const readAt = new Date().toISOString()

    const { data, error } = await supabase
      .from("notifications")
      .update({ read_at: readAt })
      .eq("id", notificationId)
      .eq("user_id", session.user.id)
      .is("read_at", null)
      .select("id, read_at")
      .maybeSingle()

    if (error) {
      console.error("[notifications] mark read failed", { code: error.code })
      return fail(API_ERROR_CODES.INTERNAL, "Bu bildirim güncellenemedi.", 500)
    }

    let effectiveReadAt = data?.read_at ?? null

    if (!data) {
      // Nothing matched: either it was already read, or it is not the caller's row. RLS makes
      // those indistinguishable from a single UPDATE, so ask.
      const existing = await supabase
        .from("notifications")
        .select("id, read_at")
        .eq("id", notificationId)
        .eq("user_id", session.user.id)
        .maybeSingle()

      if (existing.error) {
        console.error("[notifications] read-back failed", { code: existing.error.code })
        return fail(API_ERROR_CODES.INTERNAL, "Bu bildirim güncellenemedi.", 500)
      }
      if (!existing.data) {
        return fail(API_ERROR_CODES.NOT_FOUND, "Bu bildirim artık mevcut değil.", 404)
      }
      effectiveReadAt = existing.data.read_at
    }

    const unread = await supabase
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("user_id", session.user.id)
      .is("read_at", null)

    if (unread.error) {
      console.error("[notifications] unread count failed", { code: unread.error.code })
    }

    return ok<NotificationReadResult>({
      id: notificationId,
      readAt: effectiveReadAt ?? readAt,
      unreadCount: unread.count ?? 0,
    })
  })
}
