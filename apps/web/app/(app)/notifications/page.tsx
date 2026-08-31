/**
 * app/(app)/notifications/page.tsx
 *
 * The in-app feed.
 *
 * The first page is read here, on the server, through the cookie-bound client — so
 * `notifications_select_own` scopes it and the list has content in the HTML rather than after a
 * round trip. `<NotificationList />` takes over from there for filtering, paging and marking
 * read, all through `/api/notifications`, which is the only place that turns a row's `type` and
 * `data` into an href.
 *
 * The read fetches one row more than the page size. That extra row is not rendered; it is how
 * the server knows whether to hand the client a cursor, without a second `count` query on a
 * table that is written on every booking, payout and score report.
 */

import type { Metadata } from "next"
import Link from "next/link"

import { NotificationList } from "@/components/notifications/notification-list"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  formatNotifications,
  type NotificationPage,
  type NotificationRow,
} from "@/lib/notifications/format"
import { requireRole } from "@/lib/rbac"
import { createClient } from "@/lib/supabase/server"

export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "Bildirimler",
  description: "Rezervasyon onayları, oyunu bekleyen sonuçlar ve hakediş uyarıları.",
}

const COLUMNS = "id, type, title, body, data, read_at, created_at"
const PAGE_SIZE = 20

export default async function NotificationsPage() {
  const { user, profile } = await requireRole()
  const supabase = await createClient()

  const [feed, unread] = await Promise.all([
    supabase
      .from("notifications")
      .select(COLUMNS)
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(PAGE_SIZE + 1),
    supabase
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .is("read_at", null),
  ])

  if (feed.error) {
    console.error("[notifications] initial page failed", { code: feed.error.code })
    return (
      <div className="space-y-6">
        <NotificationsHeading />
        <Alert variant="destructive">
          <AlertTitle>Bildirimlerin yüklenemedi</AlertTitle>
          <AlertDescription>
            Bizim tarafımızda bir şeyler ters gitti. Sayfayı yenile; devam ederse{" "}
            <Link href="/dashboard" className="underline underline-offset-4">
              panel
            </Link>{" "}
            still shows everything that needs you.
          </AlertDescription>
        </Alert>
      </div>
    )
  }

  const rows: NotificationRow[] = feed.data ?? []
  const hasMore = rows.length > PAGE_SIZE
  const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows
  const last = page.at(-1)

  const initialPage: NotificationPage = {
    items: formatNotifications(page, profile.role),
    unreadCount: unread.count ?? 0,
    nextCursor: hasMore && last ? last.created_at : null,
  }

  return (
    <div className="space-y-6">
      <NotificationsHeading />

      <Card>
        <CardHeader>
          <CardTitle>Akışın</CardTitle>
          <CardDescription>
            Hesap durdukça saklanır, hesap silindiğinde tamamen kaldırılır.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <NotificationList userId={user.id} initialPage={initialPage} />
        </CardContent>
      </Card>
    </div>
  )
}

function NotificationsHeading() {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Bildirimler</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Rezervasyon onayları, oyunu bekleyen sonuçlar ve hakediş uyarıları.
        </p>
      </div>
      <Link
        href="/account"
        className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
      >
        Hesap ayarları
      </Link>
    </div>
  )
}
