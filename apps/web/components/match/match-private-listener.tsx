"use client"

/**
 * components/match/match-private-listener.tsx
 *
 * The one subscriber to `match:<uuid>:private`.
 *
 * `public.broadcast_match_event()` (0006_realtime.sql §6) sends every score and status change
 * twice: a minimal object to the wide `match:<id>` topic, and a richer one — carrying
 * `requires_consensus`, `consensus_deadline`, `score_confirmed_at`, `is_ranked` and
 * `rating_applied_at` — to `match:<id>:private`, which only participants and admins may read.
 * Without this island nothing in the app ever joins that topic, so the private fan-out has a
 * fully provisioned ACL and zero listeners.
 *
 * It renders nothing and applies nothing itself. The gates it exists to trip — the consensus
 * panel, the dispute banner, the reporting window — are all server-rendered on the match page,
 * so the only thing that can make them appear is `router.refresh()`. Reading fields off the
 * payload here would just produce a second, divergent copy of state the server already owns.
 *
 * `private: true` is mandatory: without it Realtime never consults `realtime.messages` and the
 * join is neither authorised nor delivered (see the note at the top of channels.ts).
 *
 * The topic is distinct from `matchTopic(id)`, so mounting this alongside a component that uses
 * `useMatchChannel` does not trip the one-channel-per-topic rule Phoenix enforces.
 */

import { useEffect } from "react"
import { useRouter } from "next/navigation"

import { createClient } from "@/lib/supabase/client"
import { SERVER_MATCH_EVENT, isUuid, matchPrivateTopic } from "@halisaha/shared/channels"

export interface MatchPrivateListenerProps {
  matchId: string
}

export function MatchPrivateListener({ matchId }: MatchPrivateListenerProps) {
  const router = useRouter()

  useEffect(() => {
    // matchPrivateTopic() throws on a malformed id by design. A bad route param should leave the
    // page rendered and static, not throw out of an effect.
    if (!isUuid(matchId)) return

    const supabase = createClient()
    const topic = matchPrivateTopic(matchId)
    let cancelled = false

    const refresh = () => {
      if (cancelled) return
      router.refresh()
    }

    // Realtime authorises a private channel with whatever token the socket last held, so the
    // access token has to be handed over before the join, not after.
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

      const channel = supabase.channel(topic, { config: { private: true } })
      channel
        .on("broadcast", { event: SERVER_MATCH_EVENT.SCORE }, refresh)
        .on("broadcast", { event: SERVER_MATCH_EVENT.STATUS }, refresh)
        .subscribe()

      return channel
    }

    const pending = start()

    return () => {
      cancelled = true
      void pending
        .then(async (channel) => {
          // removeChannel() unsubscribes AND drops the registry entry; skipping the second half
          // is how a long-lived SPA ends up rejoining a topic it "already joined".
          if (channel) await supabase.removeChannel(channel)
        })
        .catch((cause: unknown) => {
          console.warn("[realtime] private match channel teardown failed", cause)
        })
    }
  }, [matchId, router])

  return null
}
