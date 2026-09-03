/**
 * app/(dashboard)/venue/onboarding/complete/page.tsx
 *
 * Where Stripe sends the owner back — `CONNECT_RETURN_PATH` in `lib/stripe.ts` hard-codes this
 * path, so the route must exist at exactly `/venue/onboarding/complete`.
 *
 * ---------------------------------------------------------------------------
 * ARRIVING HERE DOES NOT MEAN VERIFIED
 * ---------------------------------------------------------------------------
 * Stripe redirects to `return_url` when the owner LEAVES the hosted flow, whether they finished
 * it, abandoned it halfway, or submitted documents that are still under review. The redirect
 * carries no signed outcome and nothing in the query string is trustworthy. So this page ignores
 * the fact of the redirect entirely and asks `GET /api/stripe/connect/status`, which retrieves
 * the account from Stripe and reconciles `venues.charges_enabled` / `payouts_enabled` /
 * `is_active` with the service-role client.
 *
 * That is why the page renders three genuinely different outcomes — done, under review, still
 * missing things — instead of a "Success!" banner that would be a lie for two of them.
 *
 * The verdict itself is written by the status route and by the `account.updated` webhook, never
 * by this page: a page that could set its own `charges_enabled` would be a path to taking money
 * through an unverified account.
 */

import Link from "next/link"
import { headers } from "next/headers"

import { ConnectOnboardingCard } from "@/components/venue/connect-onboarding-card"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { requireRole } from "@/lib/rbac"
import { createClient } from "@/lib/supabase/server"
import { emptyOnboardingState, resolveSiteOrigin } from "@/lib/stripe"
import { resolveDashboardVenue } from "@/lib/venue/metrics"
import { isApiOk, type ApiResponse, type StripeOnboardingState } from "@onpitch/shared/domain"

export const dynamic = "force-dynamic"

const STATUS_TIMEOUT_MS = 8_000

const PRIMARY_LINK =
  "inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium " +
  "text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none " +
  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"

const OUTLINE_LINK =
  "inline-flex h-9 items-center justify-center rounded-md border border-border bg-background px-4 " +
  "text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"

interface PageProps {
  /** `venueId` is appended by `buildSiteUrl` when the Account Link is minted. */
  searchParams: { venueId?: string; venue?: string }
}

export default async function ConnectOnboardingCompletePage({ searchParams }: PageProps) {
  const { user, profile } = await requireRole("venue_owner", "admin")
  const supabase = await createClient()

  const { venue } = await resolveDashboardVenue(supabase, user.id, {
    requestedId: searchParams.venueId ?? searchParams.venue,
    isAdmin: profile.role === "admin",
  })

  const state = await fetchOnboardingState(venue?.id)

  const outcome: "complete" | "reviewing" | "incomplete" | "blocked" = state.disabledReason
    ? "blocked"
    : state.isComplete
      ? "complete"
      : state.currentlyDue.length === 0 && state.pastDue.length === 0 && state.detailsSubmitted
        ? "reviewing"
        : "incomplete"

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-start gap-3">
            <OutcomeMark outcome={outcome} />
            <div>
              <CardTitle>{TITLES[outcome]}</CardTitle>
              <CardDescription>{DESCRIPTIONS[outcome]}</CardDescription>
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          {venue ? (
            <dl className="grid gap-2 text-sm sm:grid-cols-2">
              <Row label="İşletme" value={venue.name} />
              <Row
                label="Rezerve edilebilir"
                value={venue.is_active ? "Published" : "Not published yet"}
              />
              <Row label="Ödeme alma" value={state.chargesEnabled ? "Enabled" : "Not yet"} />
              <Row label="Hakediş alma" value={state.payoutsEnabled ? "Enabled" : "Not yet"} />
            </dl>
          ) : (
            <Alert>
              <AlertTitle>Henüz bağlı işletme yok</AlertTitle>
              <AlertDescription>
                Stripe hesabın profiline bağlı. Bir işletme oluştur; bu hesabı otomatik kullanır.
              </AlertDescription>
            </Alert>
          )}

          <div className="flex flex-wrap gap-3">
            <Link href="/venue" className={PRIMARY_LINK}>
              Panele git
            </Link>
            <Link href="/venue/onboarding" className={OUTLINE_LINK}>
              Kuruluma dön
            </Link>
            {outcome === "complete" ? (
              <Link href="/venue/pitches" className={OUTLINE_LINK}>
                Saha ekle
              </Link>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {/*
        Shown for every outcome except "complete": the card renders the outstanding requirements
        and mints a fresh Account Link. Account Links are single-use and expire in minutes, so an
        owner who bounced out of the flow needs a new one, not the one that brought them here.
      */}
      {outcome !== "complete" ? (
        <ConnectOnboardingCard
          state={state}
          venueId={venue?.id}
          returnPath="/venue/onboarding/complete"
        />
      ) : null}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Copy                                                                      */
/* -------------------------------------------------------------------------- */

const TITLES: Readonly<Record<"complete" | "reviewing" | "incomplete" | "blocked", string>> = {
  complete: "You are verified",
  reviewing: "Stripe is reviewing your details",
  incomplete: "Not quite finished",
  blocked: "Stripe has paused this account",
}

const DESCRIPTIONS: Readonly<Record<"complete" | "reviewing" | "incomplete" | "blocked", string>> = {
  complete:
    "Charges and payouts are both enabled, and your venue has been published automatically. Add a pitch and you are taking bookings.",
  reviewing:
    "Everything Stripe asked for has been submitted. Nothing is needed from you — verification usually completes within a business day, and your venue goes live the moment it does.",
  incomplete:
    "Stripe still needs a few things before it can verify you. Nothing has been lost; pick up exactly where you left off.",
  blocked:
    "Stripe has disabled this connected account, so the venue cannot take bookings. Supply what is listed below to lift it.",
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 rounded-md border border-border px-3 py-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium">{value}</dd>
    </div>
  )
}

function OutcomeMark({
  outcome,
}: {
  outcome: "complete" | "reviewing" | "incomplete" | "blocked"
}) {
  if (outcome === "complete") {
    return (
      <span
        className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white dark:bg-emerald-500"
        aria-hidden="true"
      >
        <svg viewBox="0 0 20 20" className="h-4 w-4" focusable="false">
          <path
            d="M5 10.5l3.2 3.2L15 6.8"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    )
  }

  const destructive = outcome === "blocked"
  return (
    <span
      className={
        destructive
          ? "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-destructive text-destructive-foreground"
          : "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border text-muted-foreground"
      }
      aria-hidden="true"
    >
      <svg viewBox="0 0 20 20" className="h-4 w-4" focusable="false">
        {destructive ? (
          <path
            d="M10 5.5v5M10 14h.01"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
          />
        ) : (
          <>
            <circle cx="10" cy="10" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <path
              d="M10 6.5V10l2.5 1.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </>
        )}
      </svg>
    </span>
  )
}

/* -------------------------------------------------------------------------- */
/*  Data                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The status route is the single place that talks to Stripe AND reconciles our mirror, so this
 * page calls it over HTTP with the session cookie forwarded rather than duplicating either half.
 * A longer timeout than elsewhere: this is the one render where an owner is actively waiting for
 * a verdict, and a stale "not finished" would send them back through KYC they already completed.
 */
async function fetchOnboardingState(venueId: string | undefined): Promise<StripeOnboardingState> {
  try {
    const cookie = (await headers()).get("cookie") ?? ""
    const query = venueId ? `?venueId=${encodeURIComponent(venueId)}` : ""

    const response = await fetch(`${resolveSiteOrigin()}/api/stripe/connect/status${query}`, {
      headers: cookie ? { cookie } : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    })

    const payload = (await response.json()) as ApiResponse<StripeOnboardingState>
    return isApiOk(payload) ? payload.data : emptyOnboardingState()
  } catch (error) {
    console.error("[venue/onboarding/complete] status route unreachable", {
      name: (error as { name?: unknown }).name,
    })
    return emptyOnboardingState()
  }
}
