"use client"

/**
 * components/auth/update-password-form.tsx
 *
 * The client island behind `/account/password`.
 *
 * It is reached from a password-recovery link: `/auth/callback` verifies the OTP, which writes a
 * real session cookie, and then redirects here. So `supabase.auth.updateUser()` has a session to
 * act on even though the user never typed their old password — that is the whole point of the
 * recovery flow, and it is why this page must NOT be behind a role gate in `middleware.ts`: a
 * recovery token's JWT may carry no `user_role` claim at all.
 *
 * The length rule quotes `MINIMUM_PASSWORD_LENGTH`, which mirrors `supabase/config.toml`, so the
 * form cannot advertise a rule GoTrue will not apply. The character-class rule has no client
 * mirror, so GoTrue's own message is shown verbatim rather than replaced with a guess.
 */

import * as React from "react"
import Link from "next/link"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { createClient } from "@/lib/supabase/client"
import { MINIMUM_PASSWORD_LENGTH } from "@/lib/gdpr"
import { cn } from "@/lib/utils"

export function UpdatePasswordForm({ className }: { className?: string }) {
  const [password, setPassword] = React.useState("")
  const [confirmation, setConfirmation] = React.useState("")
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [done, setDone] = React.useState(false)

  const canSubmit = !submitting && password.length >= MINIMUM_PASSWORD_LENGTH && password === confirmation

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)

    if (password !== confirmation) {
      setError("Those two passwords don't match.")
      return
    }
    if (password.length < MINIMUM_PASSWORD_LENGTH) {
      setError(`Your new password needs to be at least ${MINIMUM_PASSWORD_LENGTH} characters.`)
      return
    }

    setSubmitting(true)
    try {
      const supabase = createClient()
      const { error: updateError } = await supabase.auth.updateUser({ password })

      if (updateError) {
        setError(humaniseUpdateError(updateError.message))
        return
      }

      setDone(true)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Bir şeyler ters gitti. Lütfen tekrar dene.")
    } finally {
      setSubmitting(false)
    }
  }

  if (done) {
    return (
      <div className={cn("space-y-4", className)}>
        <Alert>
          <AlertTitle>Şifre güncellendi</AlertTitle>
          <AlertDescription>
            Bu cihazda yeni şifrenle giriş yaptın.
          </AlertDescription>
        </Alert>
        <Button asChild className="w-full">
          <Link href="/dashboard">Devam</Link>
        </Button>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className={cn("space-y-6", className)} noValidate>
      {error && (
        <Alert variant="destructive">
          <AlertTitle>Şifreni değiştiremedik</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <fieldset className="space-y-4" disabled={submitting}>
        <div className="space-y-2">
          <Label htmlFor="new-password">Yeni şifre</Label>
          <Input
            id="new-password"
            name="password"
            type="password"
            required
            minLength={MINIMUM_PASSWORD_LENGTH}
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-describedby="new-password-hint"
          />
          <p id="new-password-hint" className="text-xs text-muted-foreground">
            At least {MINIMUM_PASSWORD_LENGTH} characters, with upper case, lower case and a digit.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="confirm-password">Yeni şifreyi doğrula</Label>
          <Input
            id="confirm-password"
            name="confirmation"
            type="password"
            required
            minLength={MINIMUM_PASSWORD_LENGTH}
            autoComplete="new-password"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
          />
        </div>
      </fieldset>

      <Button type="submit" className="w-full" disabled={!canSubmit}>
        {submitting ? "Saving…" : "Save new password"}
      </Button>

      <p className="text-center text-sm text-muted-foreground">
        <Link href="/login" className="font-medium underline underline-offset-4">
          Girişe dön
        </Link>
      </p>
    </form>
  )
}

/** Only the cases worth rewording. Everything else is GoTrue's own text, which is user-safe. */
function humaniseUpdateError(message: string): string {
  const normalised = message.toLowerCase()

  if (normalised.includes("auth session missing") || normalised.includes("session_not_found")) {
    return "This reset link has expired or has already been used. Ask for a new one from the sign-in page."
  }
  if (normalised.includes("should be at least")) {
    return `That password is too short: it needs to be at least ${MINIMUM_PASSWORD_LENGTH} characters.`
  }
  if (normalised.includes("rate limit") || normalised.includes("too many")) {
    return "Too many attempts from here. Please wait a minute and try again."
  }
  return message
}
