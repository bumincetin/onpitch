/**
 * GET /api/notifications — one page of the caller's feed, plus the unread count.
 *
 * `notifications_select_own` in 0002_rls.sql is the boundary: `user_id = auth.uid()`, with no
 * admin escape hatch. The `.eq('user_id', …)` below rides `idx_notifications_user_id` and is a
 * query optimisation on top of that, not the access check.
 *
 * Rows never reach the client raw. `formatNotification()` resolves the deep link against the
 * caller's role and against the routes that actually exist in this app, so the browser is handed
 * an href it can trust rather than a `data` blob it would have to interpret itself. That also
 * keeps the payload keys — `matchId` from SQL, `booking_id` from the Stripe webhook — a
 * server-side detail.
 *
 * Pagination is a keyset on `created_at`, which is what `idx_notifications_created_at` is for.
 * An offset would re-read every skipped row and would also shift under the reader whenever a new
 * notification arrives mid-scroll, which on this table it does.
 */

import { z } from "zod"

import { fail, handleRoute, ok } from "@/lib/api-response"
import { getSessionUser } from "@/lib/rbac"
import { createClient } from "@/lib/supabase/server"
import {
  formatNotifications,
  type NotificationPage,
  type NotificationRow,
} from "@/lib/notifications/format"
import { API_ERROR_CODES } from "@halisaha/shared/domain"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const COLUMNS = "id, type, title, body, data, read_at, created_at"

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50

const querySchema = z.object({
  filter: z.enum(["all", "unread"]).default("all"),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  /** Exclusive keyset cursor: the `created_at` of the last row the client already has. */
  before: z.string().datetime({ offset: true }).optional(),
})

export async function GET(request: Request): Promise<Response> {
  return handleRoute<NotificationPage>(async () => {
    const session = await getSessionUser()
    if (!session) {
      return fail(API_ERROR_CODES.UNAUTHENTICATED, "Bildirimlerini görmek için giriş yap.", 401)
    }

    const url = new URL(request.url)
    const parsed = querySchema.safeParse({
      filter: url.searchParams.get("filter") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
      before: url.searchParams.get("before") ?? undefined,
    })

    if (!parsed.success) {
      return fail(
        API_ERROR_CODES.VALIDATION_FAILED,
        `filter must be all or unread, limit 1-${MAX_LIMIT}, before an ISO timestamp.`,
        422,
      )
    }

    const { filter, limit, before } = parsed.data
    const supabase = await createClient()

    // One extra row is the "is there more" probe; it is trimmed before the response is built.
    let query = supabase
      .from("notifications")
      .select(COLUMNS)
      .eq("user_id", session.user.id)

    if (filter === "unread") query = query.is("read_at", null)
    if (before) query = query.lt("created_at", before)

    const [feed, unread] = await Promise.all([
      query.order("created_at", { ascending: false }).limit(limit + 1),
      supabase
        .from("notifications")
        .select("id", { count: "exact", head: true })
        .eq("user_id", session.user.id)
        .is("read_at", null),
    ])

    if (feed.error) {
      console.error("[notifications] list failed", { code: feed.error.code })
      return fail(API_ERROR_CODES.INTERNAL, "Bildirimlerin yüklenemedi.", 500)
    }
    if (unread.error) {
      console.error("[notifications] unread count failed", { code: unread.error.code })
      return fail(API_ERROR_CODES.INTERNAL, "Bildirimlerin yüklenemedi.", 500)
    }

    const rows: NotificationRow[] = feed.data ?? []
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const last = page.at(-1)

    return ok<NotificationPage>({
      items: formatNotifications(page, session.profile.role),
      unreadCount: unread.count ?? 0,
      nextCursor: hasMore && last ? last.created_at : null,
    })
  })
}
