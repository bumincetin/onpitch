"use client"

/**
 * components/notifications/notification-list.tsx
 *
 * The feed at `/notifications`.
 *
 * The first page arrives from the server as `initialPage`, so there is content on first paint
 * and no spinner on the common path. Everything after that — the unread filter, "load more",
 * marking read — goes through `/api/notifications`, which is the only place that knows how to
 * turn a row into an href.
 *
 * A realtime INSERT refetches the newest page rather than rendering the row it was handed. The
 * payload carries `type` and a raw `data` blob, and turning those into a link is server work —
 * doing it here would mean a second, drifting copy of `resolveNotificationHref` in the browser.
 * The channel name differs from `notification-bell.tsx`'s on purpose: Phoenix permits one
 * channel per topic per socket, and both components can be mounted at the same time.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { CheckCheck, Inbox } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { createClient } from "@/lib/supabase/client"
import {
  formatNotificationDay,
  formatNotificationTime,
  type NotificationPage,
  type NotificationReadAllResult,
  type NotificationReadResult,
  type NotificationTone,
  type NotificationView,
} from "@/lib/notifications/format"
import { toast } from "@/lib/use-toast"
import { cn } from "@/lib/utils"
import { isApiOk, type ApiResponse } from "@onpitch/shared/domain"

type Filter = "all" | "unread"

export interface NotificationListProps {
  userId: string
  initialPage: NotificationPage
  className?: string
}

const TONE_ACCENT: Readonly<Record<NotificationTone, string>> = {
  neutral: "bg-muted-foreground/40",
  positive: "bg-success",
  attention: "bg-warning",
  critical: "bg-destructive",
}

const TONE_LABEL: Readonly<Record<NotificationTone, string>> = {
  neutral: "Update",
  positive: "Good news",
  attention: "Needs a look",
  critical: "Urgent",
}

function mergeById(existing: NotificationView[], incoming: NotificationView[]): NotificationView[] {
  const seen = new Set(existing.map((item) => item.id))
  return [...existing, ...incoming.filter((item) => !seen.has(item.id))]
}

export function NotificationList({ userId, initialPage, className }: NotificationListProps) {
  const router = useRouter()

  const [filter, setFilter] = useState<Filter>("all")
  const [items, setItems] = useState<NotificationView[]>(initialPage.items)
  const [unreadCount, setUnreadCount] = useState(initialPage.unreadCount)
  const [cursor, setCursor] = useState<string | null>(initialPage.nextCursor)
  const [loading, setLoading] = useState<"page" | "more" | null>(null)
  const [markingAll, setMarkingAll] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /** Guards against a slow response for an abandoned filter overwriting a newer one. */
  const requestSeq = useRef(0)
  /**
   * The realtime callback needs the current filter, but reading it from the closure would make
   * the subscription effect depend on it — and every filter switch would then tear the channel
   * down and rejoin the topic for nothing.
   */
  const filterRef = useRef<Filter>(filter)
  filterRef.current = filter

  const fetchPage = useCallback(
    async (nextFilter: Filter, before: string | null): Promise<void> => {
      const seq = ++requestSeq.current
      setError(null)
      setLoading(before ? "more" : "page")

      try {
        const params = new URLSearchParams({ filter: nextFilter, limit: "20" })
        if (before) params.set("before", before)

        const response = await fetch(`/api/notifications?${params.toString()}`, {
          credentials: "same-origin",
          cache: "no-store",
        })
        const payload = (await response.json()) as ApiResponse<NotificationPage>

        if (seq !== requestSeq.current) return

        if (!isApiOk(payload)) {
          setError(payload.error.message)
          return
        }

        setUnreadCount(payload.data.unreadCount)
        setCursor(payload.data.nextCursor)
        setItems((previous) =>
          before ? mergeById(previous, payload.data.items) : payload.data.items,
        )
      } catch {
        if (seq === requestSeq.current) {
          setError("Could not reach the server. Check your connection and try again.")
        }
      } finally {
        if (seq === requestSeq.current) setLoading(null)
      }
    },
    [],
  )

  const changeFilter = useCallback(
    (next: Filter) => {
      if (next === filter) return
      setFilter(next)
      setItems([])
      setCursor(null)
      void fetchPage(next, null)
    },
    [fetchPage, filter],
  )

  const markRead = useCallback(
    async (id: string): Promise<void> => {
      // Optimistic: the row greys out immediately and is put back if the route refuses.
      const before = items
      setItems((previous) =>
        previous.map((item) =>
          item.id === id && !item.readAt
            ? { ...item, readAt: new Date().toISOString() }
            : item,
        ),
      )
      setUnreadCount((count) => Math.max(0, count - 1))

      try {
        const response = await fetch(`/api/notifications/${id}/read`, {
          method: "POST",
          credentials: "same-origin",
        })
        const payload = (await response.json()) as ApiResponse<NotificationReadResult>

        if (!isApiOk(payload)) {
          setItems(before)
          setError(payload.error.message)
          return
        }

        setUnreadCount(payload.data.unreadCount)
        setItems((previous) =>
          previous.map((item) =>
            item.id === id ? { ...item, readAt: payload.data.readAt } : item,
          ),
        )
        // The bell in the page chrome is server-rendered from its own count.
        router.refresh()
      } catch {
        setItems(before)
        setError("Could not reach the server. Check your connection and try again.")
      }
    },
    [items, router],
  )

  const markAllRead = useCallback(async () => {
    setError(null)
    setMarkingAll(true)
    try {
      const response = await fetch("/api/notifications/read-all", {
        method: "POST",
        credentials: "same-origin",
      })
      const payload = (await response.json()) as ApiResponse<NotificationReadAllResult>

      if (!isApiOk(payload)) {
        setError(payload.error.message)
        return
      }

      setUnreadCount(payload.data.unreadCount)
      toast({
        title:
          payload.data.markedRead === 0
            ? "Nothing was unread"
            : `${payload.data.markedRead} marked as read`,
        variant: "success",
      })
      // The unread view empties, so refetch rather than patching state in two directions.
      await fetchPage(filter, null)
      router.refresh()
    } catch {
      setError("Sunucuya ulaşılamadı. Hiçbir şey değişmedi.")
    } finally {
      setMarkingAll(false)
    }
  }, [fetchPage, filter, router])

  /* ---- realtime -------------------------------------------------------- */

  useEffect(() => {
    if (!userId) return

    const supabase = createClient()
    let cancelled = false

    const start = async () => {
      const { data } = await supabase.auth.getSession()
      if (cancelled) return

      try {
        const result: unknown = supabase.realtime.setAuth(data.session?.access_token ?? undefined)
        if (result && typeof (result as Promise<void>).then === "function") {
          await (result as Promise<void>)
        }
      } catch (cause) {
        console.warn("[realtime] setAuth failed", cause)
      }
      if (cancelled) return

      const channel = supabase
        .channel(`notifications-list:${userId}`)
        .on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table: "notifications",
            filter: `user_id=eq.${userId}`,
          },
          () => {
            if (cancelled) return
            // Refetch the newest page rather than rendering the raw row: only the server knows
            // how to turn `type` + `data` into an href.
            void fetchPage(filterRef.current, null)
          },
        )
        .subscribe()

      return channel
    }

    const pending = start()

    return () => {
      cancelled = true
      void pending
        .then(async (channel) => {
          if (channel) await supabase.removeChannel(channel)
        })
        .catch((cause: unknown) => {
          console.warn("[realtime] notification list teardown failed", cause)
        })
    }
  }, [fetchPage, userId])

  /* ---- render ---------------------------------------------------------- */

  const showSkeleton = loading === "page" && items.length === 0

  return (
    <div className={cn("space-y-4", className)}>
      <div className="flex flex-wrap items-center gap-2">
        <div
          role="group"
          aria-label="Bildirimleri filtrele"
          className="inline-flex rounded-md border p-0.5"
        >
          {(["all", "unread"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={filter === value}
              onClick={() => changeFilter(value)}
              className={cn(
                "rounded-sm px-3 py-1.5 text-sm font-medium transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                filter === value
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {value === "all" ? "All" : "Unread"}
              {value === "unread" && unreadCount > 0 ? (
                <Badge variant="secondary" className="ml-2">
                  {unreadCount}
                </Badge>
              ) : null}
            </button>
          ))}
        </div>

        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          disabled={markingAll || unreadCount === 0}
          onClick={() => void markAllRead()}
        >
          <CheckCheck aria-hidden="true" />
          {markingAll ? "Marking…" : "Mark all read"}
        </Button>
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Bir şeyler ters gitti</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>{error}</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void fetchPage(filter, null)}
              disabled={loading !== null}
            >
              Tekrar dene
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {showSkeleton ? (
        <ul className="space-y-2" aria-busy="true" aria-label="Bildirimler yükleniyor">
          {[0, 1, 2, 3].map((index) => (
            <li key={index} className="rounded-lg border p-4">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="mt-2 h-3 w-2/3" />
            </li>
          ))}
        </ul>
      ) : items.length === 0 ? (
        <div className="rounded-lg border border-dashed p-10 text-center">
          <Inbox aria-hidden="true" className="mx-auto size-8 text-muted-foreground" />
          <p className="mt-3 text-sm font-medium">
            {filter === "unread" ? "Nothing unread" : "No notifications yet"}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {filter === "unread"
              ? "You are caught up. Switch to All to see what you have already read."
              : "Booking confirmations, results that need your vote and payout alerts land here."}
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {items.map((item) => (
            <li
              key={item.id}
              className={cn(
                "relative overflow-hidden rounded-lg border p-4 pl-5 transition-colors",
                item.readAt ? "bg-background" : "bg-accent/40",
              )}
            >
              <span
                aria-hidden="true"
                className={cn("absolute inset-y-0 left-0 w-1", TONE_ACCENT[item.tone])}
              />

              <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    {/* h4: the enclosing CardTitle is an h3, so this keeps the outline flat
                        rather than restarting the heading levels inside a card. */}
                    <h4 className="text-sm font-semibold">
                      {item.href ? (
                        <Link
                          href={item.href}
                          className="underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          onClick={() => {
                            if (!item.readAt) void markRead(item.id)
                          }}
                        >
                          {item.title}
                        </Link>
                      ) : (
                        item.title
                      )}
                    </h4>
                    {item.readAt ? null : (
                      <Badge variant="outline" className="border-current text-[10px]">
                        Yeni
                      </Badge>
                    )}
                    <span className="sr-only">{TONE_LABEL[item.tone]}</span>
                  </div>

                  {item.body ? (
                    <p className="text-sm text-muted-foreground">{item.body}</p>
                  ) : null}

                  <p className="text-xs text-muted-foreground">
                    {/* "Today" is relative to the moment of render, so a page served a few
                        milliseconds before midnight would hydrate as "Yesterday". The stamp
                        itself is timezone-pinned; only this one boundary can drift. */}
                    <time
                      dateTime={item.createdAt}
                      title={formatNotificationTime(item.createdAt)}
                      suppressHydrationWarning
                    >
                      {formatNotificationDay(item.createdAt)}
                    </time>
                  </p>
                </div>

                {item.readAt ? null : (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="shrink-0"
                    onClick={() => void markRead(item.id)}
                  >
                    Okundu işaretle
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {cursor ? (
        <div className="flex justify-center">
          <Button
            variant="outline"
            disabled={loading !== null}
            onClick={() => void fetchPage(filter, cursor)}
          >
            {loading === "more" ? "Loading…" : "Load older"}
          </Button>
        </div>
      ) : null}

      <p aria-live="polite" className="sr-only">
        {loading ? "Loading notifications" : `${items.length} notifications shown, ${unreadCount} unread`}
      </p>
    </div>
  )
}
