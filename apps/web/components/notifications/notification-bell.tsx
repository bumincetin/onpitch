"use client"

/**
 * components/notifications/notification-bell.tsx
 *
 * The unread badge, live.
 *
 * `notifications` is in the `supabase_realtime` publication (0006_realtime.sql §1), so this
 * subscribes to `postgres_changes` on the table rather than polling. The filter is
 * `user_id=eq.<uuid>` — server-side, on the replication stream, so rows for other people are
 * never even sent to this socket. It is a bandwidth filter, not the security boundary:
 * `notifications_select_own` is evaluated by Realtime for every change event and is what
 * actually decides whether this client may see a row. Both are in place; neither is redundant.
 *
 * Realtime authorises the stream with whatever token the socket last held, so `setAuth` has to
 * run BEFORE the join, which makes setup async and the teardown a promise chain. `removeChannel`
 * unsubscribes AND drops the registry entry; skipping the second half is how a long-lived SPA
 * ends up unable to rejoin a topic it "already joined".
 *
 * It is a link, not a popover. The feed lives at `/notifications`, which is server-rendered,
 * paginated and keyboard-navigable for free; a bespoke dropdown would be a second, worse copy of
 * it with its own focus-management bugs.
 */

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { Bell } from "lucide-react"
import { z } from "zod"

import { createClient } from "@/lib/supabase/client"
import { cn } from "@/lib/utils"

export interface NotificationBellProps {
  /** `auth.users.id` of the person viewing. The realtime filter is built from it. */
  userId: string
  /** Server-rendered count, so the badge is correct on first paint. */
  initialUnreadCount?: number
  className?: string
}

/** Realtime hands rows through as loose JSON; only the two fields that move the count matter. */
const rowSchema = z
  .object({
    id: z.string(),
    read_at: z.string().nullable().optional(),
  })
  .passthrough()

/** More than this and the badge shows "9+" rather than growing the header. */
const BADGE_CEILING = 9

export function NotificationBell({
  userId,
  initialUnreadCount = 0,
  className,
}: NotificationBellProps) {
  const [unread, setUnread] = useState(initialUnreadCount)

  // A server-rendered page can hand down a fresher count than the one this component was
  // mounted with; adopt it rather than letting a stale badge outlive a navigation.
  useEffect(() => {
    setUnread(initialUnreadCount)
  }, [initialUnreadCount])

  const applyChange = useCallback((event: string, newRow: unknown, oldRow: unknown) => {
    const next = rowSchema.safeParse(newRow)
    const previous = rowSchema.safeParse(oldRow)

    if (event === "INSERT") {
      if (next.success && !next.data.read_at) setUnread((count) => count + 1)
      return
    }

    if (event === "UPDATE") {
      // REPLICA IDENTITY DEFAULT means `old` carries the primary key only, so the previous
      // read state is unknowable from the payload. Treat any update that lands on a read row as
      // "one fewer unread" and floor at zero; the next page load reconciles exactly.
      if (next.success && next.data.read_at) setUnread((count) => Math.max(0, count - 1))
      return
    }

    if (event === "DELETE") {
      if (previous.success) setUnread((count) => Math.max(0, count - 1))
    }
  }, [])

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
        // The socket keeps whatever token it had; the join may still succeed. Never throw here.
        console.warn("[realtime] setAuth failed", cause)
      }
      if (cancelled) return

      // A topic name distinct from the one `notification-list.tsx` uses: Phoenix allows one
      // channel per topic per socket, and both can be on screen at the same time.
      const channel = supabase
        .channel(`notifications-bell:${userId}`)
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "notifications",
            filter: `user_id=eq.${userId}`,
          },
          (payload) => {
            applyChange(payload.eventType, payload.new, payload.old)
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
          console.warn("[realtime] notification bell teardown failed", cause)
        })
    }
  }, [applyChange, userId])

  const label =
    unread === 0
      ? "Notifications, none unread"
      : `Notifications, ${unread} unread`

  return (
    <Link
      href="/notifications"
      aria-label={label}
      className={cn(
        "relative inline-flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors",
        "hover:bg-accent hover:text-accent-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        className,
      )}
    >
      <Bell aria-hidden="true" className="size-5" />

      {unread > 0 ? (
        <span
          aria-hidden="true"
          className="absolute -right-0.5 -top-0.5 grid min-w-5 place-items-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-4 text-destructive-foreground"
        >
          {unread > BADGE_CEILING ? `${BADGE_CEILING}+` : unread}
        </span>
      ) : null}

      {/* The badge itself is aria-hidden so the count is announced once, as a change, rather
          than twice on every re-render. */}
      <span aria-live="polite" className="sr-only">
        {label}
      </span>
    </Link>
  )
}
