"use client"

/**
 * components/auth/signup-form.tsx
 *
 * The one place an account is created.
 *
 * The `options.data` payload is read by `public.handle_new_user()` (0003_auth_rbac_gdpr.sql),
 * which provisions `public.profiles` from it. Two things about that are worth knowing before
 * changing this file:
 *
 *   * The role is a REQUEST, not an assignment. The trigger allow-lists it down to
 *     `player | venue_owner`; `admin` sent from here is silently coerced to `player`, and the
 *     `profiles_insert_role_not_admin` RESTRICTIVE policy is the second lock. So this select is
 *     honest UI, not a privilege.
 *   * `date_of_birth` drives `profiles.is_minor`, which drives the privacy lock and the consent
 *     gate. Omitting it does not make a young user an adult — it makes them an account that
 *     cannot be gated, which is why the age gate requires it.
 *
 * After a minor signs up we kick off the Art. 8 consent email. That happens over the API route
 * rather than in the browser because the raw consent token must never touch a client: the route
 * receives it from Postgres, puts it in an email, and returns nothing but a masked address.
 */

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"

import { AgeGate, EMPTY_AGE_GATE_VALUE, validateAgeGate, type AgeGateValue } from "@/components/auth/age-gate"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { createClient } from "@/lib/supabase/client"
import { DIGITAL_CONSENT_AGE, MINIMUM_PASSWORD_LENGTH, MINOR_PRIVACY_EXPLANATIONS } from "@/lib/gdpr"
import { cn } from "@/lib/utils"

type RequestedRole = "player" | "venue_owner"

const ROLE_OPTIONS: ReadonlyArray<{ value: RequestedRole; label: string; blurb: string }> = [
  { value: "player", label: "Oynamak istiyorum", blurb: "Saha tut, maçlara katıl, reyting biriktir." },
  { value: "venue_owner", label: "Saha işletiyorum", blurb: "Tesisini listele ve rezervasyon al." },
]

interface SignupFormProps {
  /** Same-origin path to land on after the email is confirmed. */
  nextPath?: string
  className?: string
}

type Phase =
  | { kind: "form" }
  /** Account created, email confirmation pending. */
  | { kind: "confirm_email"; email: string; guardianPending: boolean }
  /** Account created AND signed in (email confirmation disabled in the project). */
  | { kind: "signed_in"; guardianEmailMasked: string | null; guardianDelivered: boolean | null }

/**
 * Same rule as `middleware.ts`, `login-form.tsx` and `/auth/callback`: a same-origin PATH, never
 * a URL, and never protocol-relative. `signup/page.tsx` forwards `?next=` straight from the query
 * string, and `router.replace()` happily leaves the origin for an absolute URL — which on an auth
 * page is a phishing primitive, because the victim really did sign up on the real site.
 */
function safeNextPath(candidate: string | undefined | null, fallback = "/dashboard"): string {
  if (!candidate || !candidate.startsWith("/")) return fallback
  if (candidate.length > 1 && (candidate[1] === "/" || candidate[1] === "\\")) return fallback
  return candidate
}

export function SignupForm({ nextPath, className }: SignupFormProps) {
  const router = useRouter()
  const destination = safeNextPath(nextPath)

  const [fullName, setFullName] = React.useState("")
  const [email, setEmail] = React.useState("")
  const [password, setPassword] = React.useState("")
  const [role, setRole] = React.useState<RequestedRole>("player")
  const [marketingOptIn, setMarketingOptIn] = React.useState(false)
  const [ageGate, setAgeGate] = React.useState<AgeGateValue>(EMPTY_AGE_GATE_VALUE)

  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [phase, setPhase] = React.useState<Phase>({ kind: "form" })

  const gate = React.useMemo(() => validateAgeGate(ageGate), [ageGate])
  const isMinorSignup = gate.assessment.requiresGuardianConsent

  // The marketing switch is DISABLED, not hidden, for minors — the reasoning is documented on
  // `enforcePrivacyDefaults` in lib/gdpr.ts. Force the value off as soon as the band flips so a
  // box ticked before the birth date was entered cannot survive.
  React.useEffect(() => {
    if (isMinorSignup && marketingOptIn) setMarketingOptIn(false)
  }, [isMinorSignup, marketingOptIn])

  const canSubmit =
    !submitting &&
    fullName.trim().length >= 2 &&
    email.trim().length > 3 &&
    password.length >= MINIMUM_PASSWORD_LENGTH &&
    gate.ok

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)

    const validation = validateAgeGate(ageGate)
    if (!validation.ok) {
      setError(validation.error)
      return
    }

    setSubmitting(true)
    try {
      const supabase = createClient()
      const origin = window.location.origin

      const { data, error: signUpError } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: {
          // Read by public.handle_new_user(). Anything not in its allow-list is ignored.
          data: {
            full_name: fullName.trim(),
            display_name: fullName.trim(),
            role,
            date_of_birth: ageGate.dateOfBirth,
            marketing_opt_in: validation.assessment.requiresGuardianConsent ? false : marketingOptIn,
            // Carried so `/auth/callback` can start the consent email once the address is
            // confirmed, when no session exists at this point to do it from here.
            guardian_name: validation.assessment.requiresGuardianConsent
              ? ageGate.guardianName.trim()
              : null,
            guardian_email: validation.assessment.requiresGuardianConsent
              ? ageGate.guardianEmail.trim().toLowerCase()
              : null,
          },
          emailRedirectTo: `${origin}/auth/callback?next=${encodeURIComponent(destination)}`,
        },
      })

      if (signUpError) {
        setError(humaniseSignUpError(signUpError.message))
        return
      }

      // No session means the project requires email confirmation. `request_parental_consent`
      // needs `auth.uid()`, so the consent email is deferred to the callback route.
      if (!data.session) {
        setPhase({
          kind: "confirm_email",
          email: email.trim(),
          guardianPending: validation.assessment.requiresGuardianConsent,
        })
        return
      }

      let guardianEmailMasked: string | null = null
      let guardianDelivered: boolean | null = null

      if (validation.assessment.requiresGuardianConsent) {
        const consent = await requestGuardianConsent({
          guardianName: ageGate.guardianName.trim(),
          guardianEmail: ageGate.guardianEmail.trim(),
        })
        guardianEmailMasked = consent.guardianEmailMasked
        guardianDelivered = consent.delivered
      }

      setPhase({ kind: "signed_in", guardianEmailMasked, guardianDelivered })
      router.refresh()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Bir şeyler ters gitti. Lütfen tekrar dene.")
    } finally {
      setSubmitting(false)
    }
  }

  if (phase.kind === "confirm_email") {
    return (
      <div className={cn("space-y-4", className)}>
        <Alert>
          <AlertTitle>E-postanı kontrol et</AlertTitle>
          <AlertDescription>
            Doğrulama bağlantısını şuraya gönderdik: <strong>{phase.email}</strong>. Hesabını oluşturmayı tamamlamak için aç.
          </AlertDescription>
        </Alert>
        {phase.guardianPending && (
          <Alert>
            <AlertTitle>Sonrası velinde</AlertTitle>
            <AlertDescription>
              As soon as you confirm your address we&apos;ll email{" "}
              <strong>{ageGate.guardianEmail.trim()}</strong> onay bağlantısını. Bu arada gezinebilirsin — saha tutma ve maça katılma, o tıkladığında açılır.
            </AlertDescription>
          </Alert>
        )}
        <p className="text-sm text-muted-foreground">
          Wrong address?{" "}
          <button
            type="button"
            className="underline underline-offset-4"
            onClick={() => setPhase({ kind: "form" })}
          >
            Geri dön ve değiştir
          </button>
          .
        </p>
      </div>
    )
  }

  if (phase.kind === "signed_in") {
    return (
      <div className={cn("space-y-4", className)}>
        <Alert>
          <AlertTitle>İçeridesin</AlertTitle>
          <AlertDescription>Hesabın hazır.</AlertDescription>
        </Alert>

        {phase.guardianEmailMasked && (
          <Alert variant={phase.guardianDelivered === false ? "destructive" : "default"}>
            <AlertTitle>
              {phase.guardianDelivered === false
                ? "We couldn't send the approval email"
                : "We've emailed your guardian"}
            </AlertTitle>
            <AlertDescription>
              {phase.guardianDelivered === false ? (
                <>
                  Your account exists and the approval link is still valid for seven days, but the
                  email to {phase.guardianEmailMasked} didn&apos;t go out. You can resend it from
                  your account settings.
                </>
              ) : (
                <>
                  {phase.guardianEmailMasked} has a link to approve your account. It expires in
                  seven days. Until they use it you can look around, but you can&apos;t book a
                  pitch or join a match.
                </>
              )}
            </AlertDescription>
          </Alert>
        )}

        <Button type="button" className="w-full" onClick={() => router.replace(destination)}>
          Devam
        </Button>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className={cn("space-y-6", className)} noValidate>
      {error && (
        <Alert variant="destructive">
          <AlertTitle>Hesabını oluşturamadık</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <fieldset className="space-y-4" disabled={submitting}>
        <div className="space-y-2">
          <Label htmlFor="signup-full-name">Ad soyad</Label>
          <Input
            id="signup-full-name"
            name="fullName"
            type="text"
            required
            minLength={2}
            maxLength={120}
            autoComplete="name"
            value={fullName}
            onChange={(event) => setFullName(event.target.value)}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="signup-email">E-posta</Label>
          <Input
            id="signup-email"
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
          <Label htmlFor="signup-password">Şifre</Label>
          <Input
            id="signup-password"
            name="password"
            type="password"
            required
            minLength={MINIMUM_PASSWORD_LENGTH}
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            aria-describedby="signup-password-hint"
          />
          <p id="signup-password-hint" className="text-xs text-muted-foreground">
            At least {MINIMUM_PASSWORD_LENGTH} characters, with upper case, lower case and a digit.
          </p>
        </div>

        {/*
          Real radios, not buttons carrying `role="radio"`. The ARIA radio-group pattern owes a
          roving tabindex and arrow-key selection; this control had neither, so it announced as a
          radio group but put both options in the tab order and did nothing on an arrow press.
          Native inputs get grouping, keyboard behaviour, "1 of 2" position and form semantics for
          free. The input is `sr-only` — visually hidden but still focusable and still in the tab
          order — and the styled label is the hit target.
        */}
        <fieldset className="min-w-0 space-y-2">
          <legend className="text-sm font-medium leading-none">Buraya niye geldin?</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {ROLE_OPTIONS.map((option) => (
              <label
                key={option.value}
                className={cn(
                  "block cursor-pointer rounded-lg border p-3 text-left transition-colors",
                  "hover:bg-accent hover:text-accent-foreground",
                  "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-2",
                  role === option.value ? "border-primary bg-accent" : "border-input",
                )}
              >
                <input
                  type="radio"
                  name="requestedRole"
                  value={option.value}
                  checked={role === option.value}
                  onChange={() => setRole(option.value)}
                  className="sr-only"
                />
                <span className="block text-sm font-medium">{option.label}</span>
                <span className="block text-xs text-muted-foreground">{option.blurb}</span>
              </label>
            ))}
          </div>
        </fieldset>
      </fieldset>

      <Separator />

      <AgeGate value={ageGate} onChange={setAgeGate} disabled={submitting} idPrefix="signup" />

      <Separator />

      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <Label htmlFor="signup-marketing" className={cn(isMinorSignup && "text-muted-foreground")}>
            Ara sıra Halısaha e-postası gönderin
          </Label>
          <p className="text-xs text-muted-foreground">
            {isMinorSignup
              ? MINOR_PRIVACY_EXPLANATIONS.marketing_opt_in
              : "New pitches near you and product news. You can turn this off any time."}
          </p>
        </div>
        <Switch
          id="signup-marketing"
          checked={isMinorSignup ? false : marketingOptIn}
          onCheckedChange={setMarketingOptIn}
          disabled={submitting || isMinorSignup}
          aria-describedby={isMinorSignup ? "signup-marketing-locked" : undefined}
        />
      </div>
      {isMinorSignup && (
        <p id="signup-marketing-locked" className="sr-only">
          Disabled because you are under {DIGITAL_CONSENT_AGE}.
        </p>
      )}

      <Button type="submit" className="w-full" disabled={!canSubmit}>
        {submitting ? "Creating your account…" : "Create account"}
      </Button>

      {!gate.ok && gate.assessment.band !== "unknown" && gate.error && (
        <p className="text-sm text-muted-foreground">{gate.error}</p>
      )}

      <p className="text-center text-sm text-muted-foreground">
        Already have an account?{" "}
        <Link href="/login" className="font-medium underline underline-offset-4">
          Giriş yap
        </Link>
      </p>
    </form>
  )
}

/* -------------------------------------------------------------------------- */

/**
 * Asks the server to mint and email a guardian consent token.
 *
 * The response deliberately carries only a MASKED address and a delivery flag — the raw token
 * exists for exactly one hop, from Postgres to the mail provider, and never enters this bundle.
 */
async function requestGuardianConsent(input: {
  guardianName: string
  guardianEmail: string
}): Promise<{ guardianEmailMasked: string | null; delivered: boolean | null }> {
  try {
    const response = await fetch("/api/auth/parental-consent/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    })

    const payload = (await response.json().catch(() => null)) as
      | { ok: true; data: { guardianEmailMasked: string; delivered: boolean } }
      | { ok: false; error: { message: string } }
      | null

    if (!payload || payload.ok !== true) {
      return { guardianEmailMasked: input.guardianEmail, delivered: false }
    }

    return {
      guardianEmailMasked: payload.data.guardianEmailMasked,
      delivered: payload.data.delivered,
    }
  } catch {
    // The account exists either way; consent can be resent. Never block the success screen.
    return { guardianEmailMasked: input.guardianEmail, delivered: false }
  }
}

/** GoTrue's messages are terse and occasionally leaky. Translate the ones users actually hit. */
function humaniseSignUpError(message: string): string {
  const normalised = message.toLowerCase()

  if (normalised.includes("already registered") || normalised.includes("already been registered")) {
    return "That email already has an account. Try signing in instead."
  }
  // Only the LENGTH rejection is reworded, and it quotes the number GoTrue actually enforces.
  // A blanket `includes("password")` here would also swallow the `password_requirements`
  // (lower/upper/digit) rejection and answer it with a length rule the user already satisfies,
  // so every other password message falls through and is shown as GoTrue wrote it.
  if (normalised.includes("password") && normalised.includes("should be at least")) {
    return `That password is too short: it needs to be at least ${MINIMUM_PASSWORD_LENGTH} characters.`
  }
  if (normalised.includes("rate limit") || normalised.includes("too many")) {
    return "Too many attempts from here. Please wait a minute and try again."
  }
  if (normalised.includes("invalid") && normalised.includes("email")) {
    return "That email address doesn't look right."
  }
  return message
}
