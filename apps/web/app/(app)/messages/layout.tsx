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

import { ConversationList } from "@/components/messaging/conversation-list"
import { loadConversations } from "@/lib/messaging"
import { requireRole } from "@/lib/rbac"
import { createClient } from "@/lib/supabase/server"

export const dynamic = "force-dynamic"

export default async function MessagesLayout({ children }: { children: React.ReactNode }) {
  const { user } = await requireRole()
  const supabase = await createClient()
  const conversations = await loadConversations(supabase)

  return (
    <div className="-mt-4 grid min-h-[70vh] grid-cols-1 overflow-hidden rounded-md border border-foreground/12 bg-card/60 lg:grid-cols-[20rem_minmax(0,1fr)]">
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
  )
}
