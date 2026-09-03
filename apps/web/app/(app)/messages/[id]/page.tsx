/**
 * app/(app)/messages/[id]/page.tsx
 *
 * One thread. The first page of messages and the counterpart are read on the server; the
 * client component owns the socket, the composer and the read mark from there.
 *
 * A thread the viewer is not in reads as empty under RLS, and `my_conversations()` will not
 * list it — which together mean a 404, and the same 404 a made-up id gets.
 */

import type { Metadata } from "next"
import { notFound } from "next/navigation"

import { ChatThread } from "@/components/messaging/chat-thread"
import { loadConversations, loadMessagePage } from "@/lib/messaging"
import { requireRole } from "@/lib/rbac"
import { createClient } from "@/lib/supabase/server"
import { isUuid } from "@onpitch/shared/channels"

export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "Sohbet",
}

export default async function ThreadPage({ params }: { params: { id: string } }) {
  if (!isUuid(params.id)) notFound()
  const { user } = await requireRole()
  const supabase = await createClient()

  const [conversations, page, blocks] = await Promise.all([
    loadConversations(supabase),
    loadMessagePage(supabase, params.id),
    supabase.from("user_blocks").select("blocked_id").eq("blocker_id", user.id),
  ])

  const summary = conversations.find((entry) => entry.id === params.id)
  if (!summary) notFound()

  const blocked = Boolean(
    summary.counterpart && (blocks.data ?? []).some((row) => row.blocked_id === summary.counterpart?.id),
  )

  return (
    <div className="messages-thread-open h-full min-h-[70vh]">
      <ChatThread
        conversationId={summary.id}
        viewerId={user.id}
        counterpart={summary.counterpart}
        initialMessages={page.messages}
        initialNextBefore={page.nextBefore}
        muted={summary.mutedAt !== null}
        blocked={blocked}
      />
    </div>
  )
}
