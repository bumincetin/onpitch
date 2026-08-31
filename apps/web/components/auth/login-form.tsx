"use client"

/**
 * components/auth/login-form.tsx
 *
 * Password sign-in with a magic-link fallback.
 *
 * On success we `router.replace(next)` followed by `router.refresh()`. Both are needed:
 * `replace` moves the browser (and keeps `/login` out of the history stack, so Back doesn't
 * bounce the user through an auth page they are no longer allowed on), while `refresh`
 * re-renders the Server Components with the cookie the Supabase client just wrote. Without the
 * refresh, the destination renders from the cached logged-out RSC payload and looks broken.
 *
 * `next` arrives from the middleware as a query parameter, so it is re-validated here as a
 * same-origin PATH before being used. An attacker who can put `?next=https://…` in front of a
 * user gets a genuine login on the real site followed by a drop onto their page — an open
 * redirect out of an auth flow is a phishing primitive, not a cosmetic bug.
 */

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { createClient } from "@/lib/supabase/client"
import { cn } from "@/lib/utils"

interface LoginFormProps {
  /** Same-origin path to return to. Validated again here; never trusted as given. */
  nextPath?: string
  className?: string
}

/** Same rule as `middleware.ts`: a path, never a URL, and never protocol-relative. */
function safeNextPath(candidate: string | undefined | null, fallback = "/dashboard"): string {
  if (!candidate || !candidate.startsWith("/")) return fallback
  if (candidate.length > 1 && (candidate[1] === "/" || candidate[1] === "\\")) return fallback
  return candidate
}

export function LoginForm({ nextPath, className }: LoginFormProps) {
  const router = useRouter()
  const destination = safeNextPath(nextPath)

  const [email, setEmail] = React.useState("")
  const [password, setPassword] = React.useState("")
  const [submitting, setSubmitting] = React.useState(false)
  const [magicLinkSubmitting, setMagicLinkSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)

  async function handlePasswordSignIn(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setNotice(null)
    setSubmitting(true)

    try {
      const supabase = createClient()
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      })

      if (signInError) {
        setError(humaniseSignInError(signInError.message))
        return
      }

      router.replace(destination)
      router.refresh()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Bir şeyler ters gitti. Lütfen tekrar dene.")
    } finally {
      setSubmitting(false)
    }
  }

  async function handleMagicLink() {
    setError(null)
    setNotice(null)

    if (!email.trim()) {
      setError("Enter your email address first, then we'll send you a link.")
      return
    }

    setMagicLinkSubmitting(true)
    try {
      const supabase = createClient()
      const { error: otpError } = await supabase.auth.signInWithOtp({
        email: email.trim(),
        options: {
          // Must land on the route handler — that is where the code is exchanged for cookies.
          emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(destination)}`,
          // Sign-in only. A magic link must never create an account, because that would bypass
          // the age gate entirely and produce a profile with no date of birth.
          shouldCreateUser: false,
        },
      })

      if (otpError) {
        setError(humaniseSignInError(otpError.message))
        return
      }

      setNotice(
        `If ${email.trim()} has an account, a sign-in link is on its way. It expires in an hour.`,
      )
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Bir şeyler ters gitti. Lütfen tekrar dene.")
    } finally {
      setMagicLinkSubmitting(false)
    }
  }

  const busy = submitting || magicLinkSubmitting

  return (
    <div className={cn("space-y-6", className)}>
      {error && (
        <Alert variant="destructive">
          <AlertTitle>Girişini yapamadık</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {notice && (
        <Alert>
          <AlertTitle>E-postanı kontrol et</AlertTitle>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}

      <form onSubmit={handlePasswordSignIn} className="space-y-4" noValidate>
        <fieldset className="space-y-4" disabled={busy}>
          <div className="space-y-2">
            <Label htmlFor="login-email">E-posta</Label>
            <Input
              id="login-email"
              name="email"
              type="email"
              required
              maxLength={254}
              autoComplete="email"
              inputMode="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="login-password">Şifre</Label>
            <Input
              id="login-password"
              name="password"
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>
        </fieldset>

        <Button type="submit" className="w-full" disabled={busy || !email.trim() || !password}>
          {submitting ? "Signing in…" : "Sign in"}
        </Button>
      </form>

      <div className="relative">
        <Separator />
        <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-background px-2 text-xs uppercase tracking-wider text-muted-foreground">
          or
        </span>
      </div>

      <Button
        type="button"
        variant="outline"
        className="w-full"
        disabled={busy}
        onClick={handleMagicLink}
      >
        {magicLinkSubmitting ? "Sending…" : "Email me a sign-in link"}
      </Button>

      <p className="text-center text-sm text-muted-foreground">
        New here?{" "}
        <Link href="/signup" className="font-medium underline underline-offset-4">
          Hesap oluştur
        </Link>
      </p>
    </div>
  )
}

/**
 * GoTrue returns "Invalid login credentials" for both a wrong password and an unknown address,
 * which is correct — distinguishing them would turn the login form into an account-enumeration
 * oracle. The message is reworded, not narrowed.
 */
function humaniseSignInError(message: string): string {
  const normalised = message.toLowerCase()

  if (normalised.includes("invalid login credentials")) {
    return "That email and password don't match an account."
  }
  if (normalised.includes("email not confirmed")) {
    return "Confirm your email address first — check your inbox for the link we sent."
  }
  if (normalised.includes("rate limit") || normalised.includes("too many")) {
    return "Too many attempts from here. Please wait a minute and try again."
  }
  if (normalised.includes("signups not allowed") || normalised.includes("user not found")) {
    return "If that address has an account, a link is on its way."
  }
  return message
}
