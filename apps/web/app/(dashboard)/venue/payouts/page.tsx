/**
 * app/(dashboard)/venue/payouts/page.tsx — when the money actually arrives.
 *
 * Three sources, deliberately kept distinct because they can disagree and the disagreement is
 * usually the thing the owner needs to see:
 *
 *   1. `venue_payouts` — our mirror of the `payout.*` webhooks, read through RLS
 *      (`venue_payouts_select_owner`). The RECORD of what Stripe has created.
 *   2. `GET /api/stripe/connect/status` — the onboarding state. Called over HTTP rather than by
 *      importing the handler, because that route also RECONCILES `venues.charges_enabled` /
 *      `payouts_enabled` with the service-role client as a side effect. Rendering this page is
 *      therefore also a reconciliation, and duplicating that logic here would be two
 *      implementations of one invariant.
 *   3. `stripe.accounts.retrieve(...).settings.payouts.schedule` — the forward-looking RULE
 *      (interval, delay days, anchor). Not part of `StripeOnboardingState`, so it is read
 *      directly here. Safe: this is a Server Component and the secret key never leaves the server.
 *
 * ---------------------------------------------------------------------------
 * WHY THE HTTP CALL IS DEFENSIVE
 * ---------------------------------------------------------------------------
 * A Server Component fetching its own origin is a real dependency on the server being able to
 * serve itself. It is given an explicit timeout and a fallback, so a slow or unreachable route
 * degrades this page to "schedule unavailable" instead of hanging the render. The payout LEDGER
 * comes straight from the database and is never blocked by it.
 *
 * The cookie header is forwarded because the route is session-scoped; without it the call is
 * anonymous and correctly 401s. Nothing else about the request is copied.
 */

import { headers } from "next/headers"
import Link from "next/link"

import {
  PayoutSchedule,
  type PayoutRow,
  type PayoutScheduleInfo,
} from "@/components/venue/payout-schedule"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { requireRole } from "@/lib/rbac"
import { createClient } from "@/lib/supabase/server"
import { describeStripeError, emptyOnboardingState, resolveSiteOrigin, stripe } from "@/lib/stripe"
import { loadNextPayout, resolveDashboardVenue, type OwnerVenue } from "@/lib/venue/metrics"
import { isApiOk, type ApiResponse, type StripeOnboardingState } from "@onpitch/shared/domain"

export const dynamic = "force-dynamic"

const STATUS_TIMEOUT_MS = 5_000
const PAYOUT_PAGE_SIZE = 50

const PRIMARY_LINK =
  "inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium " +
  "text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none " +
  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"

interface PageProps {
  searchParams: { venue?: string }
}

export default async function VenuePayoutsPage({ searchParams }: PageProps) {
  const { user, profile } = await requireRole("venue_owner", "admin")
  const supabase = await createClient()

  const { venue } = await resolveDashboardVenue(supabase, user.id, {
    requestedId: searchParams.venue,
    isAdmin: profile.role === "admin",
  })

  if (!venue) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Henüz işletme yok</CardTitle>
          <CardDescription>
            Hakedişler, işletmenin bağlı Stripe hesabına yapılır. Önce işletmeyi oluştur.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Link href="/venue/onboarding" className={PRIMARY_LINK}>
            İşletmeni kur
          </Link>
        </CardContent>
      </Card>
    )
  }

  const [ledger, onboarding, nextPayout] = await Promise.all([
    loadPayoutLedger(supabase, venue.id),
    fetchOnboardingState(venue.id),
    loadNextPayout(supabase, venue.id).catch(() => null),
  ])

  const schedule = await loadPayoutSchedule(onboarding.accountId ?? venue.stripe_account_id)
  const currency = ledger[0]?.currency ?? "try"

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Hakedişler</h2>
        <p className="text-sm text-muted-foreground">
          Stripe rezervasyonları bir takvime göre banka hesabına aktarır. Platform komisyonu her rezervasyon anında alınır; burada gördüğün tutar zaten senin paran.
        </p>
      </div>

      {!onboarding.payoutsEnabled ? (
        <Alert variant={onboarding.disabledReason ? "destructive" : "default"}>
          <AlertTitle>
            {onboarding.accountId === null
              ? "No payout account connected"
              : onboarding.disabledReason
                ? "Stripe has paused payouts on this account"
                : "Payouts are not enabled yet"}
          </AlertTitle>
          <AlertDescription className="flex flex-wrap items-center gap-3">
            <span>
              {onboarding.accountId === null
                ? "Connect a Stripe account and finish verification before you can be paid."
                : "Stripe needs a little more from you before it can send money to your bank."}
            </span>
            <Link href="/venue/onboarding" className={PRIMARY_LINK}>
              {onboarding.accountId === null ? "Connect an account" : "Finish verification"}
            </Link>
          </AlertDescription>
        </Alert>
      ) : null}

      <PayoutSchedule
        schedule={schedule}
        payouts={ledger}
        nextPayout={nextPayout}
        currency={currency}
        payoutsEnabled={onboarding.payoutsEnabled}
      />

      <VenueStripeFootnote venue={venue} accountId={onboarding.accountId} />
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Data                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The payout mirror. RLS (`venue_payouts_select_owner`) is the boundary; the `venue_id` predicate
 * uses `idx_venue_payouts_venue_id`. Sorted newest-first by arrival, then by creation for the
 * rows Stripe has not dated yet.
 */
async function loadPayoutLedger(
  supabase: Awaited<ReturnType<typeof createClient>>,
  venueId: string,
): Promise<PayoutRow[]> {
  const { data, error } = await supabase
    .from("venue_payouts")
    .select("id, stripe_payout_id, amount_minor, currency, status, arrival_date, created_at")
    .eq("venue_id", venueId)
    .order("arrival_date", { ascending: false, nullsFirst: true })
    .order("created_at", { ascending: false })
    .limit(PAYOUT_PAGE_SIZE)

  if (error) {
    console.error("[venue/payouts] ledger read failed", { code: error.code })
    return []
  }

  return (data ?? []).map((row) => ({
    id: row.id,
    stripePayoutId: row.stripe_payout_id,
    amountMinor: row.amount_minor,
    currency: row.currency,
    status: row.status,
    arrivalDate: row.arrival_date,
    createdAt: row.created_at,
  }))
}

/**
 * Ask our own status route, forwarding the session cookie. Times out rather than hanging the
 * render, and degrades to a zeroed state — the ledger below still renders from the database.
 */
async function fetchOnboardingState(venueId: string): Promise<StripeOnboardingState> {
  try {
    const cookie = (await headers()).get("cookie") ?? ""
    const url = `${resolveSiteOrigin()}/api/stripe/connect/status?venueId=${encodeURIComponent(venueId)}`

    const response = await fetch(url, {
      headers: cookie ? { cookie } : undefined,
      // This is a per-session read of live Stripe state; a cached copy replayed to another
      // session would be a data leak, and `no-store` is what the route itself declares.
      cache: "no-store",
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    })

    const payload = (await response.json()) as ApiResponse<StripeOnboardingState>
    if (!isApiOk(payload)) {
      console.warn("[venue/payouts] status route returned an error", { code: payload.error.code })
      return emptyOnboardingState()
    }
    return payload.data
  } catch (error) {
    console.error("[venue/payouts] status route unreachable", {
      name: (error as { name?: unknown }).name,
    })
    return emptyOnboardingState()
  }
}

/**
 * `settings.payouts.schedule` off the connected account. Not part of `StripeOnboardingState`, so
 * it is read directly. Any failure returns `null`; the component then explains the rule generally
 * instead of inventing a date.
 */
async function loadPayoutSchedule(accountId: string | null): Promise<PayoutScheduleInfo | null> {
  if (!accountId) return null

  try {
    const account = await stripe.accounts.retrieve(accountId)
    // Typed structurally rather than through the `Stripe.Account.Settings.Payouts.Schedule`
    // namespace path: this reads four scalars, and pinning a deep namespace makes the page break
    // on a stripe-node type reshuffle that changes nothing we actually use.
    const schedule = account.settings?.payouts?.schedule as
      | {
          interval?: string | null
          delay_days?: number | null
          weekly_anchor?: string | null
          monthly_anchor?: number | null
        }
      | undefined
    if (!schedule) return null

    return {
      interval: schedule.interval ?? "unknown",
      delayDays: typeof schedule.delay_days === "number" ? schedule.delay_days : null,
      weeklyAnchor: schedule.weekly_anchor ?? null,
      monthlyAnchor: typeof schedule.monthly_anchor === "number" ? schedule.monthly_anchor : null,
    }
  } catch (error) {
    console.error("[venue/payouts] schedule read failed", describeStripeError(error))
    return null
  }
}

/* -------------------------------------------------------------------------- */
/*  Footnote                                                                  */
/* -------------------------------------------------------------------------- */

function VenueStripeFootnote({
  venue,
  accountId,
}: {
  venue: OwnerVenue
  accountId: string | null
}) {
  return (
    <p className="text-xs text-muted-foreground">
      {accountId ? (
        <>
          {venue.name} için{" "}
          <code className="font-mono">{maskAccountId(accountId)}</code> bağlı hesabına ödenir.
          Banka bilgileri ve kimlik belgeleri Stripe&apos;ta durur, OnPitch&apos;da hiç saklanmaz.
        </>
      ) : (
        <>Banka bilgileri ve kimlik belgeleri Stripe&apos;ta durur, OnPitch&apos;da hiç saklanmaz.</>
      )}{" "}
      Ulaşma tarihleri Stripe tahminidir; bankalar zaman zaman bir gün önce ya da sonra
      hesaba geçirir.
    </p>
  )
}

/** `acct_1AbCdEfGhIjKlMn` → `acct_…KlMn`. Enough to match a Stripe dashboard row, no more. */
function maskAccountId(id: string): string {
  return id.length <= 12 ? id : `${id.slice(0, 5)}…${id.slice(-4)}`
}
