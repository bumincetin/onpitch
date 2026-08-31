"use client"

import * as React from "react"
import { useRouter } from "next/navigation"

import { Button } from "@/components/ui/button"
import { toast } from "@/lib/use-toast"
import { cn } from "@/lib/utils"

/**
 * The one-tap way onto the leaderboard.
 *
 * `profiles.profile_visibility` defaults to `private`, and `leaderboard_page()` only publishes
 * public profiles. Without this the ranking is empty for almost everybody and there is nothing
 * on screen explaining why — the feature would look broken rather than opt-in.
 *
 * It is a real consent decision, so it is a button and a sentence rather than a toggle buried
 * in settings: turning it on publishes a display name, city, level and match count to anyone
 * who opens the page, including signed-out visitors. Under-16 accounts cannot reach this at
 * all — `profiles_minor_privacy_locked_check` refuses the write in Postgres, and the caller is
 * not rendered this component in the first place.
 */

export interface LeaderboardOptInProps {
  className?: string
}

export function LeaderboardOptIn({ className }: LeaderboardOptInProps) {
  const router = useRouter()
  const [pending, setPending] = React.useState(false)

  const publish = React.useCallback(async () => {
    setPending(true)
    try {
      const response = await fetch("/api/account", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profileVisibility: "public" }),
      })

      if (!response.ok) {
        toast({
          variant: "destructive",
          title: "Ayar kaydedilemedi",
          description: "Gizlilik ayarlarından da değiştirebilirsin.",
        })
        return
      }

      toast({ title: "Sıralamadasın", description: "Profilin artık herkese açık." })
      router.refresh()
    } catch {
      toast({ variant: "destructive", title: "Bağlantı kurulamadı" })
    } finally {
      setPending(false)
    }
  }, [router])

  return (
    <div className={cn("border-t border-foreground/15 pt-4", className)}>
      <p className="label-eyebrow">Sıralamada yoksun</p>
      <p className="mt-2.5 max-w-xl text-pretty text-sm leading-relaxed text-muted-foreground">
        Profilin gizli olduğu için sıralamada görünmüyorsun. Herkese açık yaparsan görünen adın,
        şehrin, seviyen ve maç sayın sıralamada yer alır. İstediğin an gizlilik ayarlarından geri
        alabilirsin.
      </p>
      <div className="mt-4 flex flex-wrap gap-3">
        <Button size="sm" variant="accent" disabled={pending} onClick={() => void publish()}>
          {pending ? "Kaydediliyor…" : "Sıralamada görün"}
        </Button>
        <Button size="sm" variant="ghost" asChild>
          <a href="/account/privacy">Gizlilik ayarları</a>
        </Button>
      </div>
    </div>
  )
}
