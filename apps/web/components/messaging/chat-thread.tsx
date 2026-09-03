"use client"

/**
 * components/messaging/chat-thread.tsx
 *
 * One conversation: the messages, the composer, and the few things a person can do to a thread.
 *
 * ---------------------------------------------------------------------------------------------
 * HOW A MESSAGE ARRIVES
 * ---------------------------------------------------------------------------------------------
 * Sending is optimistic. The bubble appears at once with a client-minted id, `POST` carries the
 * same id as `clientId`, and the row the server returns replaces the pending one. If the socket
 * delivers the INSERT first (it usually does — the server writes, Realtime streams, the POST
 * response is still in flight), the row is matched on `client_id` and the pending bubble is
 * replaced the same way. Either order, one bubble.
 *
 * Realtime is Postgres Changes on `messages` filtered to this thread. RLS
 * (`messages_select_member`) is evaluated per event, so the filter is bandwidth, not security.
 * UPDATE events carry an unsend (`deleted_at`) or a redaction (`redacted_at`) and rewrite the
 * bubble in place.
 *
 * ---------------------------------------------------------------------------------------------
 * READ MARKS
 * ---------------------------------------------------------------------------------------------
 * The thread is marked read when it is opened and again whenever a message lands while the tab
 * is visible. A hidden tab does not count as reading — the mark waits for `visibilitychange`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { ArrowLeft, BellOff, Bell, Flag, LogOut, MoreHorizontal, Send, ShieldBan, Trash2 } from "lucide-react"

import { Avatar } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { createClient } from "@/lib/supabase/client"
import { toast } from "@/lib/use-toast"
import { cn } from "@/lib/utils"
import { isApiOk, type ApiResponse } from "@onpitch/shared/domain"
import {
  MESSAGE_BODY_MAX,
  REPORT_REASONS,
  REPORT_REASON_LABEL,
  groupMessages,
  messageRowSchema,
  removedMessageLabel,
  toMessageView,
  type ConversationCounterpart,
  type MessagePageResult,
  type MessageView,
  type ReportReason,
  type SendMessageResult,
} from "@onpitch/shared/messaging"

export interface ChatThreadProps {
  conversationId: string
  viewerId: string
  counterpart: ConversationCounterpart | null
  initialMessages: MessageView[]
  initialNextBefore: string | null
  muted: boolean
  /** Whether the viewer has blocked the counterpart. */
  blocked: boolean
  className?: string
}

const TIME = new Intl.DateTimeFormat("tr-TR", { timeZone: "Europe/Istanbul", hour: "2-digit", minute: "2-digit" })
const DAY = new Intl.DateTimeFormat("tr-TR", { timeZone: "Europe/Istanbul", weekday: "long", day: "numeric", month: "long" })

function newClientId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

async function callApi<T>(input: string, init?: RequestInit): Promise<ApiResponse<T>> {
  const response = await fetch(input, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  })
  return (await response.json()) as ApiResponse<T>
}

export function ChatThread({
  conversationId,
  viewerId,
  counterpart,
  initialMessages,
  initialNextBefore,
  muted: initialMuted,
  blocked: initialBlocked,
  className,
}: ChatThreadProps) {
  const router = useRouter()
  const [messages, setMessages] = useState<MessageView[]>(initialMessages)
  const [nextBefore, setNextBefore] = useState(initialNextBefore)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [draft, setDraft] = useState("")
  const [sending, setSending] = useState(false)
  const [muted, setMuted] = useState(initialMuted)
  const [blocked, setBlocked] = useState(initialBlocked)
  const [menuOpen, setMenuOpen] = useState(false)
  const [reporting, setReporting] = useState<MessageView | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)

  const name = counterpart?.erased ? "Silinmiş hesap" : (counterpart?.displayName ?? "Oyuncu")
  const canWrite = !counterpart?.erased && !blocked

  /* ---- merge helpers ---------------------------------------------------- */

  const upsert = useCallback((incoming: MessageView) => {
    setMessages((current) => {
      const byId = current.findIndex((m) => m.id === incoming.id)
      if (byId !== -1) {
        const next = [...current]
        next[byId] = { ...incoming, pending: false }
        return next
      }
      const byClient = incoming.clientId ? current.findIndex((m) => m.pending && m.clientId === incoming.clientId) : -1
      if (byClient !== -1) {
        const next = [...current]
        next[byClient] = { ...incoming, pending: false }
        return next
      }
      return [...current, incoming].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    })
  }, [])

  const markRead = useCallback(() => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return
    void callApi(`/api/messages/${conversationId}/read`, { method: "POST" }).catch(() => undefined)
  }, [conversationId])

  /* ---- realtime --------------------------------------------------------- */

  useEffect(() => {
    const supabase = createClient()
    let cancelled = false

    const start = async () => {
      const { data } = await supabase.auth.getSession()
      if (cancelled) return
      try {
        const result: unknown = supabase.realtime.setAuth(data.session?.access_token ?? undefined)
        if (result && typeof (result as Promise<void>).then === "function") await (result as Promise<void>)
      } catch {
        /* proceed */
      }
      if (cancelled) return

      const channel = supabase
        .channel(`thread:${conversationId}`)
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table: "messages", filter: `conversation_id=eq.${conversationId}` },
          (payload) => {
            const parsed = messageRowSchema.safeParse(payload.new)
            if (!parsed.success) return
            const view = toMessageView(parsed.data)
            upsert(view)
            if (view.senderId !== viewerId && payload.eventType === "INSERT") markRead()
          },
        )
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
  }, [conversationId, viewerId, upsert, markRead])

  // Opening the thread reads it; coming back to the tab reads what arrived meanwhile.
  useEffect(() => {
    markRead()
    const onVisible = () => {
      if (document.visibilityState === "visible") markRead()
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => document.removeEventListener("visibilitychange", onVisible)
  }, [markRead])

  // Stay pinned to the bottom when something new lands and we were already there.
  const lastId = messages[messages.length - 1]?.id
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" })
  }, [lastId])

  /* ---- actions ---------------------------------------------------------- */

  const send = useCallback(async () => {
    const body = draft.trim()
    if (!body || sending || !canWrite) return
    const clientId = newClientId()
    const optimistic: MessageView = {
      id: `pending-${clientId}`,
      conversationId,
      senderId: viewerId,
      body,
      createdAt: new Date().toISOString(),
      deleted: false,
      redacted: false,
      pending: true,
      clientId,
    }
    setMessages((current) => [...current, optimistic])
    setDraft("")
    setSending(true)
    try {
      const payload = await callApi<SendMessageResult>(`/api/messages/${conversationId}`, {
        method: "POST",
        body: JSON.stringify({ body, clientId }),
      })
      if (!isApiOk(payload)) {
        setMessages((current) => current.filter((m) => m.id !== optimistic.id))
        setDraft(body)
        toast({ variant: "destructive", title: "Gönderilemedi", description: payload.error.message })
        return
      }
      upsert(payload.data.message)
    } catch {
      setMessages((current) => current.filter((m) => m.id !== optimistic.id))
      setDraft(body)
      toast({ variant: "destructive", description: "Sunucuya ulaşılamadı." })
    } finally {
      setSending(false)
      composerRef.current?.focus()
    }
  }, [draft, sending, canWrite, conversationId, viewerId, upsert])

  const loadOlder = useCallback(async () => {
    if (!nextBefore || loadingOlder) return
    setLoadingOlder(true)
    const scroller = scrollRef.current
    const previousHeight = scroller?.scrollHeight ?? 0
    try {
      const payload = await callApi<MessagePageResult>(
        `/api/messages/${conversationId}?before=${encodeURIComponent(nextBefore)}`,
      )
      if (isApiOk(payload)) {
        setMessages((current) => {
          const known = new Set(current.map((m) => m.id))
          return [...payload.data.messages.filter((m) => !known.has(m.id)), ...current]
        })
        setNextBefore(payload.data.nextBefore)
        requestAnimationFrame(() => {
          if (scroller) scroller.scrollTop = scroller.scrollHeight - previousHeight
        })
      }
    } finally {
      setLoadingOlder(false)
    }
  }, [conversationId, nextBefore, loadingOlder])

  async function unsend(message: MessageView) {
    const payload = await callApi<{ deleted: boolean }>(`/api/messages/items/${message.id}`, { method: "DELETE" })
    if (!isApiOk(payload)) {
      toast({ variant: "destructive", description: payload.error.message })
      return
    }
    upsert({ ...message, body: "", deleted: true })
  }

  async function toggleMute() {
    const payload = await callApi<{ muted: boolean }>(`/api/messages/${conversationId}/mute`, {
      method: "POST",
      body: JSON.stringify({ muted: !muted }),
    })
    if (isApiOk(payload)) {
      setMuted(payload.data.muted)
      toast({ description: payload.data.muted ? "Bu sohbet sessize alındı." : "Bildirimler açıldı." })
    }
    setMenuOpen(false)
  }

  async function toggleBlock() {
    if (!counterpart) return
    const payload = await callApi<{ blocked: boolean }>(`/api/users/${counterpart.id}/block`, {
      method: blocked ? "DELETE" : "POST",
    })
    if (isApiOk(payload)) {
      setBlocked(payload.data.blocked)
      toast({ description: payload.data.blocked ? `${name} engellendi.` : "Engel kaldırıldı." })
    } else {
      toast({ variant: "destructive", description: payload.error.message })
    }
    setMenuOpen(false)
  }

  async function leave() {
    const payload = await callApi<{ left: boolean }>(`/api/messages/${conversationId}`, { method: "DELETE" })
    if (isApiOk(payload)) {
      toast({ description: "Sohbet listenden kaldırıldı." })
      router.push("/messages")
      router.refresh()
    }
    setMenuOpen(false)
  }

  const days = useMemo(() => groupMessages(messages), [messages])

  /* ---------------------------------------------------------------------- */

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      {/* ---- header ---- */}
      <header className="flex items-center gap-3 border-b border-foreground/10 px-3 py-2 sm:px-4">
        <Link
          href="/messages"
          className="inline-flex size-11 items-center justify-center rounded-md text-muted-foreground hover:text-foreground lg:hidden"
          aria-label="Sohbetlere dön"
        >
          <ArrowLeft className="size-5" />
        </Link>
        {counterpart && !counterpart.erased ? (
          <Link href={`/players/${counterpart.id}`} className="flex min-w-0 items-center gap-3">
            <Avatar name={name} src={counterpart.avatarUrl} accent={counterpart.accentColor} size="md" />
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{name}</span>
              <span className="label-eyebrow block">
                {counterpart.role === "venue_owner" ? "İşletme" : "Oyuncu"}
                {muted ? " · sessiz" : ""}
                {blocked ? " · engelli" : ""}
              </span>
            </span>
          </Link>
        ) : (
          <div className="flex min-w-0 items-center gap-3">
            <Avatar name={name} size="md" ring={false} />
            <span className="truncate text-sm font-medium text-muted-foreground">{name}</span>
          </div>
        )}

        <div className="relative ml-auto">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label="Sohbet seçenekleri"
            className="size-11"
            onClick={() => setMenuOpen((open) => !open)}
          >
            <MoreHorizontal />
          </Button>
          {menuOpen ? (
            <div
              role="menu"
              className="absolute right-0 top-12 z-20 w-56 rounded-md border bg-popover p-1 text-popover-foreground shadow-lg"
            >
              <MenuItem onClick={toggleMute} icon={muted ? <Bell /> : <BellOff />}>
                {muted ? "Bildirimleri aç" : "Sessize al"}
              </MenuItem>
              {counterpart && !counterpart.erased ? (
                <MenuItem onClick={toggleBlock} icon={<ShieldBan />} tone={blocked ? "default" : "danger"}>
                  {blocked ? "Engeli kaldır" : "Engelle"}
                </MenuItem>
              ) : null}
              <MenuItem onClick={leave} icon={<LogOut />}>
                Sohbeti listeden kaldır
              </MenuItem>
            </div>
          ) : null}
        </div>
      </header>

      {/* ---- messages ---- */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-4" role="log" aria-live="polite" aria-label="Mesajlar">
        {nextBefore ? (
          <div className="mb-4 flex justify-center">
            <Button type="button" variant="ghost" size="sm" onClick={() => void loadOlder()} disabled={loadingOlder}>
              {loadingOlder ? "Yükleniyor…" : "Daha eski mesajlar"}
            </Button>
          </div>
        ) : null}

        {messages.length === 0 ? (
          <p className="py-16 text-center text-sm text-muted-foreground">
            İlk mesajı sen yaz. {counterpart?.role === "venue_owner" ? "Saha, saat, fiyat — burada konuşun." : "Maç günü, saat, kadro — burada konuşun."}
          </p>
        ) : null}

        <ol className="space-y-6">
          {days.map((day) => (
            <li key={day.dayKey}>
              <p className="label-eyebrow mb-4 text-center">{DAY.format(new Date(day.at))}</p>
              <ol className="space-y-3">
                {day.runs.map((run, runIndex) => {
                  const mine = run.senderId === viewerId
                  return (
                    <li key={`${day.dayKey}-${runIndex}`} className={cn("flex gap-2", mine ? "justify-end" : "justify-start")}>
                      {!mine ? (
                        <Avatar name={name} src={counterpart?.avatarUrl} accent={counterpart?.accentColor} size="sm" className="mt-auto" />
                      ) : null}
                      <ol className={cn("flex max-w-[78%] flex-col gap-1", mine ? "items-end" : "items-start")}>
                        {run.messages.map((message) => {
                          const removed = removedMessageLabel(message)
                          return (
                            <li
                              key={message.id}
                              className={cn(
                                "group relative max-w-full animate-in fade-in duration-300",
                                mine ? "slide-in-from-right-2" : "slide-in-from-left-2",
                              )}
                            >
                              <div
                                className={cn(
                                  "rounded-md px-3 py-2 text-sm leading-relaxed",
                                  mine
                                    ? "bg-user/90 text-primary-foreground [border-bottom-right-radius:2px]"
                                    : "bg-secondary text-foreground [border-bottom-left-radius:2px]",
                                  message.pending && "opacity-60",
                                  removed && "italic text-muted-foreground",
                                  removed && mine && "bg-secondary",
                                )}
                              >
                                {removed ?? <span className="whitespace-pre-wrap break-words">{message.body}</span>}
                              </div>
                              <div
                                className={cn(
                                  "mt-0.5 flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground",
                                  mine ? "justify-end" : "justify-start",
                                )}
                              >
                                <time dateTime={message.createdAt}>{TIME.format(new Date(message.createdAt))}</time>
                                {message.pending ? <span>gönderiliyor</span> : null}
                                {!removed && !message.pending ? (
                                  mine ? (
                                    <button
                                      type="button"
                                      onClick={() => void unsend(message)}
                                      className="inline-flex min-h-6 items-center gap-1 opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                                      aria-label="Mesajı geri al"
                                    >
                                      <Trash2 className="size-3" /> geri al
                                    </button>
                                  ) : (
                                    <button
                                      type="button"
                                      onClick={() => setReporting(message)}
                                      className="inline-flex min-h-6 items-center gap-1 opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                                      aria-label="Mesajı bildir"
                                    >
                                      <Flag className="size-3" /> bildir
                                    </button>
                                  )
                                ) : null}
                              </div>
                            </li>
                          )
                        })}
                      </ol>
                    </li>
                  )
                })}
              </ol>
            </li>
          ))}
        </ol>
        <div ref={bottomRef} />
      </div>

      {/* ---- composer ---- */}
      <form
        className="border-t border-foreground/10 p-3 sm:p-4"
        onSubmit={(event) => {
          event.preventDefault()
          void send()
        }}
      >
        {canWrite ? (
          <div className="flex items-end gap-2">
            <Textarea
              ref={composerRef}
              value={draft}
              maxLength={MESSAGE_BODY_MAX}
              rows={1}
              placeholder="Mesaj yaz…"
              aria-label="Mesaj"
              className="max-h-40 min-h-11 resize-none"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault()
                  void send()
                }
              }}
            />
            <Button type="submit" size="icon" className="size-11 shrink-0 bg-user text-primary-foreground hover:bg-user/90" disabled={!draft.trim() || sending} aria-label="Gönder">
              <Send />
            </Button>
          </div>
        ) : (
          <p className="text-center text-sm text-muted-foreground">
            {blocked ? "Bu kişiyi engelledin. Yazmak için engeli kaldır." : "Bu hesap silinmiş; sohbet yalnızca okunabilir."}
          </p>
        )}
        <p className="mt-2 text-[11px] text-muted-foreground">
          Enter gönderir, Shift+Enter satır atlar. Mesajlar bir yıl sonra silinir; hesabını silersen yazdıkların anında kaldırılır.
        </p>
      </form>

      <ReportDialog message={reporting} onClose={() => setReporting(null)} />
    </div>
  )
}

/* -------------------------------------------------------------------------- */

function MenuItem({
  onClick,
  icon,
  children,
  tone = "default",
}: {
  onClick: () => void
  icon: React.ReactNode
  children: React.ReactNode
  tone?: "default" | "danger"
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        "flex min-h-11 w-full items-center gap-2 rounded-sm px-2 text-left text-sm hover:bg-accent [&_svg]:size-4",
        tone === "danger" && "text-vermilion",
      )}
    >
      {icon}
      {children}
    </button>
  )
}

function ReportDialog({ message, onClose }: { message: MessageView | null; onClose: () => void }) {
  const [reason, setReason] = useState<ReportReason>("harassment")
  const [details, setDetails] = useState("")
  const [busy, setBusy] = useState(false)

  async function submit() {
    if (!message) return
    setBusy(true)
    try {
      const payload = await callApi<{ reportId: string }>(`/api/messages/items/${message.id}/report`, {
        method: "POST",
        body: JSON.stringify({ reason, details: details.trim() || undefined }),
      })
      if (isApiOk(payload)) {
        toast({ title: "Bildirim alındı", description: "Bir yönetici mesajın alıntısını inceleyecek; sohbetin kendisi açılmaz." })
        setDetails("")
        onClose()
      } else {
        toast({ variant: "destructive", description: payload.error.message })
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={message !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Mesajı bildir</DialogTitle>
          <DialogDescription>
            Yalnızca bu mesajın alıntısı yöneticilere gider. Gönderen kişiye bildirim yapılmaz.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div role="radiogroup" aria-label="Sebep" className="grid gap-1">
            {REPORT_REASONS.map((option) => (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={reason === option}
                onClick={() => setReason(option)}
                className={cn(
                  "min-h-11 rounded-md border px-3 text-left text-sm transition-colors",
                  reason === option ? "border-user bg-user/10" : "hover:bg-accent",
                )}
              >
                {REPORT_REASON_LABEL[option]}
              </button>
            ))}
          </div>
          <Textarea
            value={details}
            maxLength={1000}
            rows={3}
            placeholder="İstersen kısaca açıkla (isteğe bağlı)"
            aria-label="Açıklama"
            onChange={(event) => setDetails(event.target.value)}
          />
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            Vazgeç
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={busy}>
            {busy ? "Gönderiliyor…" : "Bildir"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
