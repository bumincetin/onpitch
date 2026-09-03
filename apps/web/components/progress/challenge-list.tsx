"use client"

import * as React from "react"
import { useRouter } from "next/navigation"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { toast } from "@/lib/use-toast"
import { formatXp, type ChallengeState } from "@onpitch/shared/gamification"

/**
 * This week's objectives, with the claim button.
 *
 * The claim is a deliberate tap rather than an automatic payout. Handing the XP over silently
 * the moment a challenge completes turns the reward into a number that changed while nobody
 * was looking; making the player collect it is the whole point of the mechanic, and it costs
 * one request.
 *
 * The optimistic path is narrow on purpose. The button disables and the row shows as claimed
 * as soon as the server says so — not before — because the server is the only thing that knows
 * whether this tap or the previous one won the race. What IS optimistic is the ordering: the
 * row moves to "collected" before `router.refresh()` finishes re-rendering the page.
 */

export interface ChallengeListProps {
  challenges: readonly ChallengeState[]
  className?: string
}

export function ChallengeList({ challenges, className }: ChallengeListProps) {
  const router = useRouter()
  // `toast` is imported directly rather than taken from useToast(): this component fires
  // toasts but never renders the list, so subscribing to the store would only cost renders.
  const [pending, setPending] = React.useState<string | null>(null)
  const [claimed, setClaimed] = React.useState<ReadonlySet<string>>(new Set())

  const claim = React.useCallback(
    async (challenge: ChallengeState) => {
      setPending(challenge.id)
      try {
        const response = await fetch(`/api/challenges/${challenge.id}/claim`, { method: "POST" })
        const body: unknown = await response.json()

        const okBody =
          typeof body === "object" && body !== null && "ok" in body
            ? (body as { ok: boolean; data?: { claimed: boolean; xp: number } })
            : null

        if (!response.ok || !okBody?.ok) {
          toast({
            variant: "destructive",
            title: "Ödül alınamadı",
            description: "Tekrar dene; puanın kaybolmaz.",
          })
          return
        }

        if (okBody.data?.claimed) {
          setClaimed((current) => new Set(current).add(challenge.id))
          toast({
            title: `+${formatXp(okBody.data.xp)} XP`,
            description: challenge.title,
          })
        } else {
          // Not an error: somebody already collected it, most likely this person on another
          // device. Reconciling is the honest response.
          toast({ title: "Bu ödül zaten alınmış" })
        }

        router.refresh()
      } catch {
        toast({
          variant: "destructive",
          title: "Bağlantı kurulamadı",
          description: "İnternet bağlantını kontrol edip tekrar dene.",
        })
      } finally {
        setPending(null)
      }
    },
    [router],
  )

  if (challenges.length === 0) {
    return (
      <p className={cn("text-sm text-muted-foreground", className)}>
        Bu hafta için görev açılmamış. Pazartesi yenileri gelir.
      </p>
    )
  }

  return (
    <ol className={className}>
      {challenges.map((challenge, index) => {
        const isClaimed = challenge.claimedAt !== null || claimed.has(challenge.id)
        const isComplete = challenge.completedAt !== null
        const ratio = Math.min(1, challenge.progress / challenge.target)

        return (
          <li key={challenge.id} className="ruled-row">
            <div className="flex items-start gap-4">
              <span className="section-number mt-1 w-6 shrink-0">
                {String(index + 1).padStart(2, "0")}
              </span>

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <h3 className="text-base font-normal">{challenge.title}</h3>
                  <span className="label-eyebrow nums shrink-0">
                    +{formatXp(challenge.xpReward)} XP
                  </span>
                </div>

                <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                  {challenge.description}
                </p>

                {/* The bar is a hairline that fills, not a pill. Same vocabulary as the rest
                    of the page: rules, not rounded chrome. */}
                <div className="mt-3 flex items-center gap-3">
                  <div
                    className="h-px flex-1 bg-foreground/15"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={challenge.target}
                    aria-valuenow={challenge.progress}
                    aria-label={challenge.title}
                  >
                    <div
                      className={cn("h-px", isComplete ? "bg-teal" : "bg-gold")}
                      style={{ width: `${ratio * 100}%` }}
                    />
                  </div>
                  <span className="label-eyebrow nums shrink-0">
                    {challenge.progress} / {challenge.target}
                  </span>
                </div>
              </div>

              <div className="shrink-0 self-center">
                {isClaimed ? (
                  <span className="label-eyebrow text-teal">Alındı</span>
                ) : isComplete ? (
                  <Button
                    size="sm"
                    variant="accent"
                    disabled={pending === challenge.id}
                    onClick={() => void claim(challenge)}
                  >
                    {pending === challenge.id ? "Alınıyor…" : "Ödülü al"}
                  </Button>
                ) : (
                  <span className="label-eyebrow text-muted-foreground">Devam</span>
                )}
              </div>
            </div>
          </li>
        )
      })}
    </ol>
  )
}
