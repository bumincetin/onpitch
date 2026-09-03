/**
 * GET /messages/with/[userId]
 *
 * The one link every "Mesaj gönder" button points at. Finds or creates the pair's thread through
 * `open_conversation()` and redirects into it, so a plain anchor — on a profile, a roster, a
 * booking, a venue page — is enough to start a conversation. No JavaScript, no modal.
 *
 * A refusal (blocked, policy, Art. 8) lands on the inbox with `?refused=1`, which the inbox
 * renders as one sentence. The reason itself is deliberately not surfaced: "this person has
 * blocked you" is information the blocker did not consent to share.
 */

import { NextResponse } from "next/server"

import { getSessionUser } from "@/lib/rbac"
import { createClient } from "@/lib/supabase/server"
import { isUuid } from "@onpitch/shared/channels"

export const dynamic = "force-dynamic"

export async function GET(request: Request, { params }: { params: { userId: string } }): Promise<Response> {
  const url = new URL(request.url)
  const inbox = new URL("/messages", url.origin)

  const session = await getSessionUser()
  if (!session) {
    const login = new URL("/login", url.origin)
    login.searchParams.set("next", url.pathname)
    return NextResponse.redirect(login)
  }
  if (!isUuid(params.userId) || params.userId.toLowerCase() === session.user.id.toLowerCase()) {
    return NextResponse.redirect(inbox)
  }

  const supabase = await createClient()
  const { data, error } = await supabase.rpc("open_conversation", { p_recipient: params.userId })
  if (error || typeof data !== "string") {
    inbox.searchParams.set("refused", error?.code === "PT429" ? "rate" : "1")
    return NextResponse.redirect(inbox)
  }

  return NextResponse.redirect(new URL(`/messages/${data}`, url.origin))
}
