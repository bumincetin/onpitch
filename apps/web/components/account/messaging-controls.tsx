"use client"

/**
 * components/account/messaging-controls.tsx
 *
 * Who may write to you, and who you have shut out.
 *
 * The policy saves on its own, immediately, like the privacy switches beside it: a consent
 * setting that looks changed while it is not is the one gap this page cannot have. For a minor
 * the "Herkes" option is rendered disabled with the reason, never hidden — the same Art. 12
 * stance `privacy-controls.tsx` takes.
 */

import { useState } from "react"
import { useRouter } from "next/navigation"
import { ShieldBan } from "lucide-react"

import { Avatar } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { toast } from "@/lib/use-toast"
import { cn } from "@/lib/utils"
import { isApiOk, type ApiResponse } from "@onpitch/shared/domain"
import type { BlockedUser } from "@onpitch/shared/messaging"
import { MESSAGING_POLICIES, MESSAGING_POLICY_LABEL, type MessagingPolicy } from "@onpitch/shared/profile"

export interface MessagingControlsProps {
  policy: MessagingPolicy
  /** True for an under-16 account: "everyone" is locked. */
  minor: boolean
  blocked: BlockedUser[]
  className?: string
}

export function MessagingControls({ policy: initialPolicy, minor, blocked: initialBlocked, className }: MessagingControlsProps) {
  const router = useRouter()
  const [policy, setPolicy] = useState(initialPolicy)
  const [blocked, setBlocked] = useState(initialBlocked)
  const [busy, setBusy] = useState<string | null>(null)

  async function choose(next: MessagingPolicy) {
    if (next === policy || busy) return
    const previous = policy
    setPolicy(next)
    setBusy("policy")
    try {
      const response = await fetch("/api/account", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ messagingPolicy: next }),
      })
      const payload = (await response.json()) as ApiResponse<unknown>
      if (!isApiOk(payload)) {
        setPolicy(previous)
        toast({ variant: "destructive", description: payload.error.message })
        return
      }
      toast({ description: `Mesaj ayarı: ${MESSAGING_POLICY_LABEL[next].title}.` })
      router.refresh()
    } catch {
      setPolicy(previous)
      toast({ variant: "destructive", description: "Sunucuya ulaşılamadı." })
    } finally {
      setBusy(null)
    }
  }

  async function unblock(user: BlockedUser) {
    setBusy(user.id)
    try {
      const response = await fetch(`/api/users/${user.id}/block`, { method: "DELETE", credentials: "same-origin" })
      const payload = (await response.json()) as ApiResponse<unknown>
      if (isApiOk(payload)) {
        setBlocked((current) => current.filter((entry) => entry.id !== user.id))
        toast({ description: `${user.displayName ?? "Kişi"} artık sana yazabilir.` })
      } else {
        toast({ variant: "destructive", description: payload.error.message })
      }
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className={cn("space-y-6", className)}>
      <div role="radiogroup" aria-label="Kim sana mesaj gönderebilir" className="grid gap-2">
        {MESSAGING_POLICIES.map((option) => {
          const locked = minor && option === "everyone"
          const on = policy === option
          return (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={on}
              aria-disabled={locked}
              disabled={locked || busy === "policy"}
              onClick={() => choose(option)}
              className={cn(
                "flex min-h-11 items-start gap-3 rounded-md border p-3 text-left transition-colors",
                on ? "border-user bg-user/10" : "border-foreground/15 hover:bg-accent",
                locked && "cursor-not-allowed opacity-60",
              )}
            >
              <span
                aria-hidden="true"
                className={cn("mt-1 size-3 shrink-0 rounded-full border", on ? "border-user bg-user" : "border-foreground/40")}
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium">{MESSAGING_POLICY_LABEL[option].title}</span>
                <span className="block text-xs text-muted-foreground">
                  {locked
                    ? "16 yaşından küçük hesaplarda kapalı. O yaşa kadar yalnızca takım arkadaşların ve rezervasyon yaptığın işletmeler yazabilir."
                    : MESSAGING_POLICY_LABEL[option].hint}
                </span>
              </span>
            </button>
          )
        })}
      </div>

      <div className="space-y-2">
        <p className="flex items-center gap-2 text-sm font-medium">
          <ShieldBan className="size-4 text-muted-foreground" aria-hidden="true" />
          Engellediklerin
          <span className="label-eyebrow">{blocked.length}</span>
        </p>
        {blocked.length === 0 ? (
          <p className="text-xs text-muted-foreground">Kimseyi engellemedin. Bir sohbetin menüsünden engelleyebilirsin.</p>
        ) : (
          <ul className="divide-y rounded-md border border-foreground/15">
            {blocked.map((user) => (
              <li key={user.id} className="flex items-center gap-3 p-2">
                <Avatar name={user.displayName} src={user.avatarUrl} accent={user.accentColor} size="sm" />
                <span className="min-w-0 flex-1 truncate text-sm">{user.displayName ?? "Oyuncu"}</span>
                <Button type="button" variant="outline" size="sm" className="h-11" disabled={busy === user.id} onClick={() => unblock(user)}>
                  Engeli kaldır
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
