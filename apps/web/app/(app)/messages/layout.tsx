/**
 * app/(app)/messages/layout.tsx
 *
 * The inbox shell: the thread list on the left, whatever is open on the right. On a phone only
 * one of the two is on screen — the list at `/messages`, the thread at `/messages/[id]` — and
 * the thread's own back arrow returns to the list. On a laptop both are visible and the list
 * highlights the open thread.
 *
 * The list is read here, once, so every thread page shares it; `ConversationList` then keeps it
 * current from the `conversations` stream.
 */

import { headers } from "next/headers"

import { ConversationList } from "@/components/messaging/conversation-list"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { loadConversations } from "@/lib/messaging"
import { requireRole } from "@/lib/rbac"
import { PATHNAME_HEADER } from "@/lib/supabase/middleware"
import { createClient } from "@/lib/supabase/server"

export const dynamic = "force-dynamic"

export default async function MessagesLayout({ children }: { children: React.ReactNode }) {
  const { user } = await requireRole()
  const supabase = await createClient()
  const conversations = await loadConversations(supabase)

  // `/messages/with/[userId]` lands here with `?refused=` when a thread could not be opened. It is
  // read from the stamped header rather than page searchParams because the notice has to sit
  // ABOVE the two-pane grid: on a phone the empty pane is hidden, and a notice inside it would
  // never be seen. The reason is deliberately not surfaced — a block is the blocker's business.
  const stamped = (await headers()).get(PATHNAME_HEADER) ?? ""
  const refused = new URLSearchParams(stamped.slice(stamped.indexOf("?") + 1)).get("refused")

  return (
    <div className="-mt-4 space-y-4">
      {refused ? (
        <Alert>
          <AlertTitle>Sohbet açılamadı</AlertTitle>
          <AlertDescription>
            {refused === "rate"
              ? "Kısa sürede çok fazla yeni sohbet başlattın. Biraz sonra tekrar dene."
              : "Bu kişi şu an senden mesaj kabul etmiyor. Takım arkadaşların ve rezervasyon yaptığın işletmelerle her zaman yazışabilirsin."}
          </AlertDescription>
        </Alert>
      ) : null}

    <div className="grid min-h-[70vh] grid-cols-1 overflow-hidden rounded-md border border-foreground/12 bg-card/60 lg:grid-cols-[20rem_minmax(0,1fr)]">
      {/*
        Both columns are always rendered. Below `lg` the rules in globals.css show one at a
        time: the thread page marks its root `messages-thread-open`, which hides the list; the
        index page marks its root `messages-index`, which hides the (empty) pane.
      */}
      <aside className="messages-list min-h-0 border-foreground/12 lg:border-r">
        <div className="flex items-baseline justify-between border-b border-foreground/10 px-4 py-3">
          <h1 className="text-lg font-normal tracking-tight">Mesajlar</h1>
          <span className="label-eyebrow">{conversations.length}</span>
        </div>
        <div className="max-h-[70vh] overflow-y-auto">
          <ConversationList viewerId={user.id} initial={conversations} />
        </div>
      </aside>
      <section className="messages-pane min-h-0">{children}</section>
    </div>
    </div>
  )
}
