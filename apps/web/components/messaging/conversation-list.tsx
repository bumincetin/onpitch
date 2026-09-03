"use client"

/**
 * components/messaging/conversation-list.tsx
 *
 * The inbox column. Server-rendered with the first list, then kept current from the
 * `conversations` stream: a `last_message_at` bump (any member wrote) re-fetches the list, which
 * is what reorders it and moves the unread dot. One GET per event, and only for threads this
 * socket is allowed to hear about.
 */

import { useEffect, useState } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { BellOff } from "lucide-react"

import { Avatar } from "@/components/ui/avatar"
import { createClient } from "@/lib/supabase/client"
import { cn } from "@/lib/utils"
import { isApiOk, type ApiResponse } from "@onpitch/shared/domain"
import type { ConversationListResult, ConversationSummary } from "@onpitch/shared/messaging"

export interface ConversationListProps {
  viewerId: string
  initial: ConversationSummary[]
  className?: string
}

const TIME = new Intl.DateTimeFormat("tr-TR", { timeZone: "Europe/Istanbul", hour: "2-digit", minute: "2-digit" })
const DAY = new Intl.DateTimeFormat("tr-TR", { timeZone: "Europe/Istanbul", day: "numeric", month: "short" })

function whenLabel(iso: string | null): string {
  if (!iso) return ""
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ""
  const now = new Date()
  const sameDay = DAY.format(date) === DAY.format(now)
  return sameDay ? TIME.format(date) : DAY.format(date)
}

export function ConversationList({ viewerId, initial, className }: ConversationListProps) {
  const [items, setItems] = useState(initial)
  const pathname = usePathname()

  useEffect(() => {
    setItems(initial)
  }, [initial])

  useEffect(() => {
    const supabase = createClient()
    let cancelled = false

    async function refresh() {
      try {
        const response = await fetch("/api/messages", { credentials: "same-origin" })
        const payload = (await response.json()) as ApiResponse<ConversationListResult>
        if (!cancelled && isApiOk(payload)) setItems(payload.data.conversations)
      } catch {
        /* keep what we have */
      }
    }

    const start = async () => {
      const { data } = await supabase.auth.getSession()
      if (cancelled) return
      try {
        const result: unknown = supabase.realtime.setAuth(data.session?.access_token ?? undefined)
        if (result && typeof (result as Promise<void>).then === "function") await (result as Promise<void>)
      } catch {
        /* proceed with the token the socket holds */
      }
      if (cancelled) return
      const channel = supabase
        .channel(`inbox:${viewerId}`)
        .on("postgres_changes", { event: "UPDATE", schema: "public", table: "conversations" }, () => void refresh())
        .on("postgres_changes", { event: "UPDATE", schema: "public", table: "conversation_members", filter: `user_id=eq.${viewerId}` }, () => void refresh())
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
  }, [viewerId])

  if (items.length === 0) {
    return (
      <div className={cn("px-4 py-10 text-center", className)}>
        <p className="text-sm text-muted-foreground">Henüz sohbet yok.</p>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          Bir oyuncunun profilinden ya da rezervasyon sayfasından &quot;Mesaj gönder&quot; ile başla.
        </p>
      </div>
    )
  }

  return (
    <ul className={cn("flex flex-col", className)} aria-label="Sohbetler">
      {items.map((item) => {
        const active = pathname === `/messages/${item.id}`
        const unread = item.unreadCount > 0
        const name = item.counterpart?.erased ? "Silinmiş hesap" : (item.counterpart?.displayName ?? "Oyuncu")
        const preview = item.lastMessage
          ? item.lastMessage.removed
            ? "Mesaj kaldırıldı"
            : `${item.lastMessage.senderId === viewerId ? "Sen: " : ""}${item.lastMessage.body}`
          : "Sohbet açıldı"
        return (
          <li key={item.id}>
            <Link
              href={`/messages/${item.id}`}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center gap-3 border-l-2 px-4 py-3 transition-colors",
                active
                  ? "border-user bg-secondary/60"
                  : "border-transparent hover:bg-secondary/40",
              )}
            >
              <Avatar
                name={name}
                src={item.counterpart?.avatarUrl}
                accent={item.counterpart?.accentColor}
                size="md"
                dot={unread ? "unread" : null}
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-2">
                  <span className={cn("truncate text-sm", unread ? "font-medium text-foreground" : "text-foreground/90")}>
                    {name}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                    {whenLabel(item.lastMessageAt)}
                  </span>
                </span>
                <span className="mt-0.5 flex items-center gap-1.5">
                  <span className={cn("truncate text-xs", unread ? "text-foreground/80" : "text-muted-foreground")}>
                    {preview}
                  </span>
                  {item.mutedAt ? <BellOff className="size-3 shrink-0 text-muted-foreground" aria-label="Sessiz" /> : null}
                </span>
              </span>
              {unread ? (
                <span className="shrink-0 rounded-sm bg-user px-1.5 font-mono text-[10px] font-semibold text-primary-foreground">
                  {item.unreadCount > 9 ? "9+" : item.unreadCount}
                </span>
              ) : null}
            </Link>
          </li>
        )
      })}
    </ul>
  )
}
