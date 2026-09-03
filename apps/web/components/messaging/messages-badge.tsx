"use client"

/**
 * components/messaging/messages-badge.tsx
 *
 * The inbox link in the header, with a live count of threads that have something unread.
 *
 * `messages` is in the `supabase_realtime` publication (0011 §7) and `messages_select_member`
 * is evaluated per event, so this socket only ever hears about threads the viewer is in. Any
 * insert re-asks `/api/messages/unread` rather than trying to count locally: the server already
 * knows about read marks made on another device, and one small GET per incoming message is
 * cheaper than being wrong.
 */

import { useEffect, useState } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { MessageCircle } from "lucide-react"

import { createClient } from "@/lib/supabase/client"
import { cn } from "@/lib/utils"
import { isApiOk, type ApiResponse } from "@onpitch/shared/domain"

export interface MessagesBadgeProps {
  userId: string
  initialUnread: number
  /** "link" for the desktop header, "row" for the mobile sheet. */
  variant?: "link" | "row"
  className?: string
}

const CEILING = 9

export function MessagesBadge({ userId, initialUnread, variant = "link", className }: MessagesBadgeProps) {
  const [unread, setUnread] = useState(initialUnread)
  const pathname = usePathname()
  const active = pathname === "/messages" || pathname.startsWith("/messages/")

  useEffect(() => {
    setUnread(initialUnread)
  }, [initialUnread])

  useEffect(() => {
    if (!userId) return
    const supabase = createClient()
    let cancelled = false

    async function refresh() {
      try {
        const response = await fetch("/api/messages/unread", { credentials: "same-origin" })
        const payload = (await response.json()) as ApiResponse<{ unreadConversations: number }>
        if (!cancelled && isApiOk(payload)) setUnread(payload.data.unreadConversations)
      } catch {
        /* keep the last known count */
      }
    }

    const start = async () => {
      const { data } = await supabase.auth.getSession()
      if (cancelled) return
      try {
        const result: unknown = supabase.realtime.setAuth(data.session?.access_token ?? undefined)
        if (result && typeof (result as Promise<void>).then === "function") await (result as Promise<void>)
      } catch {
        /* the join may still succeed with the token the socket already holds */
      }
      if (cancelled) return

      const channel = supabase
        .channel(`messages-badge:${userId}`)
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, () => void refresh())
        .on("postgres_changes", { event: "UPDATE", schema: "public", table: "conversation_members", filter: `user_id=eq.${userId}` }, () => void refresh())
        .subscribe()

      return () => {
        void supabase.removeChannel(channel)
      }
    }

    const teardown = start()
    return () => {
      cancelled = true
      void teardown.then((stop) => stop?.())
    }
  }, [userId])

  const shown = unread > CEILING ? `${CEILING}+` : String(unread)
  const label = unread > 0 ? `Mesajlar, ${unread} okunmamış sohbet` : "Mesajlar"

  if (variant === "row") {
    return (
      <Link
        href="/messages"
        aria-label={label}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex items-center justify-between rounded-md px-3 py-2 text-sm font-medium transition-colors",
          active ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
          className,
        )}
      >
        <span className="flex items-center gap-2">
          <MessageCircle className="size-4" aria-hidden="true" />
          Mesajlar
        </span>
        {unread > 0 ? (
          <span className="rounded-sm bg-user px-1.5 font-mono text-[11px] font-semibold text-primary-foreground">
            {shown}
          </span>
        ) : null}
      </Link>
    )
  }

  return (
    <Link
      href="/messages"
      aria-label={label}
      aria-current={active ? "page" : undefined}
      className={cn(
        "relative inline-flex size-10 items-center justify-center rounded-md transition-colors",
        active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
        className,
      )}
    >
      <MessageCircle className="size-5" aria-hidden="true" />
      {unread > 0 ? (
        <span
          aria-hidden="true"
          className="absolute -right-0.5 -top-0.5 min-w-[1.1rem] rounded-sm bg-user px-1 text-center font-mono text-[10px] font-semibold leading-[1.1rem] text-primary-foreground shadow-[0_0_0_2px_hsl(var(--background))]"
        >
          {shown}
        </span>
      ) : null}
    </Link>
  )
}
