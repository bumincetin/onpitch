"use client"

/**
 * components/profile/profile-actions.tsx
 *
 * What one person can do to another from their profile: write to them, or stop them writing.
 *
 * The message button is only rendered when the server already asked `can_message()`; the block
 * control is always there for a stranger, because being able to shut somebody out must not
 * depend on whether they could reach you in the first place.
 */

import { useState } from "react"
import { useRouter } from "next/navigation"
import { ShieldBan, ShieldCheck } from "lucide-react"

import { MessageButton } from "@/components/messaging/message-button"
import { Button } from "@/components/ui/button"
import { toast } from "@/lib/use-toast"
import { isApiOk, type ApiResponse } from "@onpitch/shared/domain"

export interface ProfileActionsProps {
  userId: string
  name: string
  canMessage: boolean
  blocked: boolean
  className?: string
}

export function ProfileActions({ userId, name, canMessage, blocked: initialBlocked, className }: ProfileActionsProps) {
  const router = useRouter()
  const [blocked, setBlocked] = useState(initialBlocked)
  const [busy, setBusy] = useState(false)

  async function toggle() {
    if (!blocked && !window.confirm(`${name} engellensin mi? Sana yazamaz, sen de ona yazamazsın. İstediğin zaman kaldırabilirsin.`)) return
    setBusy(true)
    try {
      const response = await fetch(`/api/users/${userId}/block`, { method: blocked ? "DELETE" : "POST", credentials: "same-origin" })
      const payload = (await response.json()) as ApiResponse<{ blocked: boolean }>
      if (isApiOk(payload)) {
        setBlocked(payload.data.blocked)
        toast({ description: payload.data.blocked ? `${name} engellendi.` : "Engel kaldırıldı." })
        router.refresh()
      } else {
        toast({ variant: "destructive", description: payload.error.message })
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={className}>
      <div className="flex flex-wrap gap-2">
        {canMessage && !blocked ? <MessageButton userId={userId} variant="primary" /> : null}
        <Button type="button" variant={blocked ? "outline" : "ghost"} className="h-11" onClick={toggle} disabled={busy}>
          {blocked ? <ShieldCheck /> : <ShieldBan />}
          {blocked ? "Engeli kaldır" : "Engelle"}
        </Button>
      </div>
      {!canMessage && !blocked ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Bu kişi tanımadığı üyelerden mesaj almıyor. Aynı takımda oynadığınızda yazabilirsin.
        </p>
      ) : null}
    </div>
  )
}
