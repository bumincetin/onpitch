"use client"

/**
 * components/venue/connect-onboarding-card.tsx
 *
 * Drives Stripe Connect **Express** onboarding: `POST /api/stripe/connect/onboard`, then hand the
 * browser straight to the single-use Account Link.
 *
 * ---------------------------------------------------------------------------
 * WHY window.location.assign AND NOT router.push
 * ---------------------------------------------------------------------------
 * The link points at `connect.stripe.com`. Next's router is for in-app navigation and would
 * either refuse it or try to fetch an RSC payload from a third-party origin. A full document
 * navigation is also what makes the browser's back button behave sensibly when the owner bails
 * out of KYC halfway.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS COMPONENT MUST NEVER DO
 * ---------------------------------------------------------------------------
 *   • Never hold a Stripe key. It calls our own route; the secret key lives on the server and the
 *     publishable key is not needed for Connect onboarding at all.
 *   • Never log, store, or render the Account Link. It is a bearer credential for completing
 *     somebody's identity verification — it goes into `location.assign` and nowhere else.
 *   • Never accept an `accountId` from props and pass it to the server. The route derives the
 *     connected account from the authenticated session, which is what stops one owner minting
 *     onboarding links against another's account.
 *
 * The requirement keys (`individual.id_number`, `external_account`, …) name WHAT is missing and
 * never its value, so rendering them is safe — and necessary, since an owner staring at
 * "verification incomplete" with no list has no idea what to do next.
 */

import { useCallback, useId, useState } from "react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"
import { isApiOk, type ApiResponse, type StripeOnboardingLink, type StripeOnboardingState } from "@halisaha/shared/domain"

export interface ConnectOnboardingCardProps {
  state: StripeOnboardingState
  /** Scopes onboarding to one venue. Omitted, the route uses the owner's first venue. */
  venueId?: string
  /** Same-origin path Stripe returns to. Must start with `/`. */
  returnPath?: string
  /** Same-origin path Stripe bounces to when the link expires. Must start with `/`. */
  refreshPath?: string
  className?: string
}

export function ConnectOnboardingCard({
  state,
  venueId,
  returnPath,
  refreshPath,
  className,
}: ConnectOnboardingCardProps) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const statusId = useId()

  const startOnboarding = useCallback(async () => {
    setPending(true)
    setError(null)

    try {
      const response = await fetch("/api/stripe/connect/onboard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Same-origin cookies carry the session; nothing sensitive is in this body.
        credentials: "same-origin",
        body: JSON.stringify({
          ...(venueId ? { venueId } : {}),
          ...(returnPath ? { returnPath } : {}),
          ...(refreshPath ? { refreshPath } : {}),
        }),
      })

      const payload = (await response.json()) as ApiResponse<StripeOnboardingLink>

      if (!isApiOk(payload)) {
        setError(payload.error.message)
        setPending(false)
        return
      }

      // Deliberately leave `pending` true: the document is about to be replaced, and flipping the
      // button back to "enabled" for the last few frames invites a second click that would burn a
      // second Account Link.
      window.location.assign(payload.data.url)
    } catch {
      setError("Could not reach the server. Check your connection and try again.")
      setPending(false)
    }
  }, [venueId, returnPath, refreshPath])

  const started = state.accountId !== null
  const blocked = state.disabledReason !== null
  const waitingOnStripe =
    started && !state.isComplete && !blocked && state.currentlyDue.length === 0 && state.pastDue.length === 0

  return (
    <Card className={className}>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>Hakediş hesabı</CardTitle>
            <CardDescription>
              Stripe kimliğini doğrular ve banka bilgilerini tutar. Halısaha&apos;da hassas hiçbir veri saklanmaz.
            </CardDescription>
          </div>
          <OnboardingBadge state={state} />
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="grid gap-2 sm:grid-cols-2">
          <CapabilityRow label="Ödeme alma" enabled={state.chargesEnabled} />
          <CapabilityRow label="Hakediş alma" enabled={state.payoutsEnabled} />
        </div>

        {blocked ? (
          <Alert variant="destructive">
            <AlertTitle>Stripe bu hesabı durdurdu</AlertTitle>
            <AlertDescription>
              Stripe&apos;ın bildirdiği gerekçe: <code className="font-mono">{state.disabledReason}</code>. Bu çözülene kadar işletmen rezerve edilemez. Stripe&apos;ın istediklerini vermek için aşağıdan devam et.
            </AlertDescription>
          </Alert>
        ) : null}

        {state.pastDue.length > 0 ? (
          <RequirementList
            id={`${statusId}-past-due`}
            title="Gecikmiş — bunlar verilene kadar hakedişler durdurulur"
            tone="destructive"
            keys={state.pastDue}
          />
        ) : null}

        {state.currentlyDue.length > 0 ? (
          <RequirementList
            id={`${statusId}-currently-due`}
            title="Doğrulamayı tamamlamak için hâlâ gerekenler"
            tone="default"
            keys={state.currentlyDue}
          />
        ) : null}

        {waitingOnStripe ? (
          <Alert>
            <AlertTitle>Stripe bilgilerini inceliyor</AlertTitle>
            <AlertDescription>
              Nothing is needed from you right now.
              {state.pendingVerification.length > 0
                ? ` Under review: ${state.pendingVerification.map(humaniseRequirement).join(", ")}.`
                : " Verification usually completes within a business day."}
            </AlertDescription>
          </Alert>
        ) : null}

        {state.isComplete && state.eventuallyDue.length > 0 ? (
          <>
            <Separator />
            <RequirementList
              id={`${statusId}-eventually-due`}
              title="Sonra gerekecek — yayındasın ama Stripe bunları isteyecek"
              tone="muted"
              keys={state.eventuallyDue}
            />
          </>
        ) : null}

        {error ? (
          <Alert variant="destructive" role="alert">
            <AlertTitle>Kurulum açılamadı</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
      </CardContent>

      <CardFooter className="flex flex-wrap items-center gap-3">
        <Button onClick={startOnboarding} disabled={pending} aria-describedby={statusId}>
          {pending ? <Spinner /> : null}
          {pending
            ? "Opening Stripe…"
            : state.isComplete
              ? "Update payout details"
              : started
                ? "Continue verification"
                : "Start verification"}
        </Button>
        <p id={statusId} className="text-xs text-muted-foreground" aria-live="polite">
          {pending
            ? "Redirecting you to Stripe."
            : "You will be taken to Stripe and returned here when you are done."}
        </p>
      </CardFooter>
    </Card>
  )
}

/* -------------------------------------------------------------------------- */
/*  Pieces                                                                    */
/* -------------------------------------------------------------------------- */

function OnboardingBadge({ state }: { state: StripeOnboardingState }) {
  if (state.isComplete) return <Badge className="gap-1.5">Doğrulandı</Badge>
  if (state.disabledReason !== null) return <Badge variant="destructive">Stripe tarafından durduruldu</Badge>
  if (state.accountId === null) return <Badge variant="outline">Başlamadı</Badge>
  return <Badge variant="secondary">Devam ediyor</Badge>
}

function CapabilityRow({ label, enabled }: { label: string; enabled: boolean }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm">
      <StatusIcon enabled={enabled} />
      <span className="font-medium">{label}</span>
      <span className={cn("ml-auto text-xs", enabled ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground")}>
        {enabled ? "Enabled" : "Not yet"}
      </span>
    </div>
  )
}

function RequirementList({
  id,
  title,
  keys,
  tone,
}: {
  id: string
  title: string
  keys: readonly string[]
  tone: "default" | "destructive" | "muted"
}) {
  return (
    <section aria-labelledby={id}>
      <h3
        id={id}
        className={cn(
          "text-sm font-medium",
          tone === "destructive" && "text-destructive",
          tone === "muted" && "text-muted-foreground",
        )}
      >
        {title}
      </h3>
      <ul className="mt-2 space-y-1.5">
        {keys.map((key) => (
          <li key={key} className="flex items-start gap-2 text-sm">
            <span
              aria-hidden="true"
              className={cn(
                "mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full",
                tone === "destructive" ? "bg-destructive" : "bg-muted-foreground",
              )}
            />
            <span>
              {humaniseRequirement(key)}
              {/* The raw key is kept visible: Stripe's own support articles are indexed by it. */}
              <code className="ml-2 font-mono text-xs text-muted-foreground">{key}</code>
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

function StatusIcon({ enabled }: { enabled: boolean }) {
  return enabled ? (
    <svg
      viewBox="0 0 16 16"
      className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M5 8.2l2 2 4-4.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ) : (
    <svg
      viewBox="0 0 16 16"
      className="h-4 w-4 shrink-0 text-muted-foreground"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2.5 2" />
    </svg>
  )
}

function Spinner() {
  return (
    <svg viewBox="0 0 16 16" className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.25" />
      <path d="M14.5 8a6.5 6.5 0 00-6.5-6.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

/* -------------------------------------------------------------------------- */
/*  Requirement copy                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Stripe's requirement keys are dotted paths against the Account object. The common ones get real
 * copy; anything unrecognised is prettified rather than hidden, because a requirement an owner
 * cannot see is a requirement they will never satisfy.
 */
const REQUIREMENT_COPY: Readonly<Record<string, string>> = {
  business_profile_mcc: "Business category",
  "business_profile.mcc": "Business category",
  "business_profile.url": "Business website",
  "business_profile.product_description": "Description of what you sell",
  "business_type": "Business type (individual or company)",
  external_account: "Bank account for payouts",
  "individual.first_name": "Your first name",
  "individual.last_name": "Your surname",
  "individual.dob.day": "Your date of birth",
  "individual.dob.month": "Your date of birth",
  "individual.dob.year": "Your date of birth",
  "individual.address.line1": "Your home address",
  "individual.address.city": "Your home address",
  "individual.address.postal_code": "Your postcode",
  "individual.email": "Your email address",
  "individual.phone": "Your phone number",
  "individual.id_number": "Your national identity number",
  "individual.verification.document": "A photo of your ID document",
  "individual.verification.additional_document": "A second identity document",
  "company.name": "Registered company name",
  "company.tax_id": "Company tax number",
  "company.address.line1": "Registered company address",
  "company.verification.document": "Company registration document",
  "owners.verification.document": "ID for each company owner",
  "representative.verification.document": "ID for the account representative",
  "settings.payouts.statement_descriptor": "The name that appears on bank statements",
  tos_acceptance: "Accept the Stripe Connected Account Agreement",
  "tos_acceptance.date": "Accept the Stripe Connected Account Agreement",
  "tos_acceptance.ip": "Accept the Stripe Connected Account Agreement",
}

export function humaniseRequirement(key: string): string {
  const known = REQUIREMENT_COPY[key]
  if (known) return known

  const leaf = key.split(".").slice(-2).join(" ")
  const words = leaf.replace(/[._]/g, " ").trim()
  if (words.length === 0) return key
  return words.charAt(0).toUpperCase() + words.slice(1)
}
