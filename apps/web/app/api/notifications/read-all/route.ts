/**
 * POST /api/notifications/read-all — clear the whole unread badge in one statement.
 *
 * Same grants as the single-row route: `update (read_at)` on the column, and
 * `notifications_update_own` on the row. `.eq('user_id', …)` is both an index-backed narrowing
 * (idx_notifications_user_unread) and the thing that stops PostgREST refusing an UPDATE with no
 * filter; RLS is still what decides which rows are writable.
 *
 * `.is('read_at', null)` keeps the original timestamp on rows that were already read, so this is
 * safe to press twice. The response carries the number of rows it actually changed, which is
 * what the button reports back.
 */

import { fail, handleRoute, ok } from "@/lib/api-response"
import { getSessionUser } from "@/lib/rbac"
import { createClient } from "@/lib/supabase/server"
import type { NotificationReadAllResult } from "@/lib/notifications/format"
import { API_ERROR_CODES } from "@halisaha/shared/domain"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(): Promise<Response> {
  return handleRoute<NotificationReadAllResult>(async () => {
    const session = await getSessionUser()
    if (!session) {
      return fail(API_ERROR_CODES.UNAUTHENTICATED, "Bildirimlerini okumak için giriş yap.", 401)
    }

    const supabase = await createClient()

    const { data, error } = await supabase
      .from("notifications")
      .update({ read_at: new Date().toISOString() })
      .eq("user_id", session.user.id)
      .is("read_at", null)
      .select("id")

    if (error) {
      console.error("[notifications] mark all read failed", { code: error.code })
      return fail(API_ERROR_CODES.INTERNAL, "Bildirimlerin güncellenemedi.", 500)
    }

    const markedRead = data?.length ?? 0

    // Read the count back rather than assuming zero: a notification can arrive between the
    // UPDATE committing and this line, and reporting a stale zero would leave the bell wrong
    // until the next page load.
    const unread = await supabase
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("user_id", session.user.id)
      .is("read_at", null)

    if (unread.error) {
      console.error("[notifications] unread count failed", { code: unread.error.code })
    }

    return ok<NotificationReadAllResult>({ markedRead, unreadCount: unread.count ?? 0 })
  })
}
