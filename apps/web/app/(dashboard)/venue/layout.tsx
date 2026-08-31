/**
 * app/(dashboard)/venue/layout.tsx
 *
 * The venue-owner shell: the role gate, the multi-venue switcher, and the one banner an owner
 * must never be able to miss — "your venue cannot take money yet".
 *
 * ---------------------------------------------------------------------------
 * THE ROLE GATE
 * ---------------------------------------------------------------------------
 * `requireRole('venue_owner','admin')` sits here rather than being repeated in every page, so
 * there is exactly one place to audit and no way to add a page under `/venue` that forgets it. It
 * throws `ForbiddenError` for a signed-in player (rendered by the nearest error boundary) and
 * redirects an anonymous visitor to `/login?next=…`.
 *
 * This is defence in depth, not the boundary. `middleware.ts` already refused the wrong role on
 * the JWT claim, and RLS refuses the wrong rows in Postgres. What THIS layer adds is an
 * authoritative check against the profile row: a role changed after a token was minted is
 * reflected here immediately, while the JWT claim could still be stale.
 *
 * ---------------------------------------------------------------------------
 * THE PAYABILITY BANNER
 * ---------------------------------------------------------------------------
 * `venues.charges_enabled` is a service_role-written mirror of Stripe's verdict (see
 * `/api/stripe/connect/status`). An owner whose KYC is incomplete has a venue that renders
 * perfectly and can take no money at all, and the failure is silent from their side — nobody
 * books, and they never learn why. So an unpayable venue gets a persistent banner on every page
 * of the section, not a dismissible toast on one of them.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE SECTION NAV IS
 * ---------------------------------------------------------------------------
 * Deliberately not here: `components/nav/dashboard-nav.tsx`, rendered once by the `(dashboard)`
 * layout, already carries every `/venue/*` destination and highlights the active one. A second
 * tab strip in this layout would be two navigations for one set of links, and the two would drift.
 *
 * What this layout DOES own is the venue switcher, which the shared nav cannot express: the
 * middleware stamps `pathname + search` on every request (`PATHNAME_HEADER`), so the switcher can
 * keep you on the page you are already on and preserve the rest of the query state — the
 * overview's `range`, the bookings filter — instead of resetting it. Reading a header keeps the
 * whole shell in the server graph; a client component calling `usePathname()` would ship
 * JavaScript to compute an `href`.
 */

import { headers } from "next/headers"
import Link from "next/link"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { requireRole } from "@/lib/rbac"
import { createClient } from "@/lib/supabase/server"
import { PATHNAME_HEADER } from "@/lib/supabase/middleware"
import { cn } from "@/lib/utils"
import { listOwnedVenues, type OwnerVenue } from "@/lib/venue/metrics"

export const dynamic = "force-dynamic"

/**
 * Link-shaped buttons, written as classes rather than `<Button asChild>`.
 *
 * The shared contract guarantees `Button` takes `variant` and `size`; it does not promise Radix's
 * `asChild` slot, and a navigation control should be a real `<a>` anyway so it opens in a new tab,
 * shows a status-bar URL, and is announced as a link. Styling the anchor gets both.
 */
const LINK_BUTTON =
  "inline-flex h-9 shrink-0 items-center justify-center rounded-md bg-primary px-3 text-sm " +
  "font-medium text-primary-foreground transition-colors hover:bg-primary/90 " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"

const LINK_BUTTON_OUTLINE =
  "inline-flex h-9 shrink-0 items-center justify-center rounded-md border border-border " +
  "bg-background px-3 text-sm font-medium transition-colors hover:bg-accent " +
  "hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 " +
  "focus-visible:ring-ring focus-visible:ring-offset-2"

export default async function VenueLayout({ children }: { children: React.ReactNode }) {
  const { user, profile } = await requireRole("venue_owner", "admin")

  const supabase = await createClient()

  // A failure here must not blank the section — the page below does its own venue resolution
  // with its own error handling, and a missing switcher is far better than a missing dashboard.
  let venues: OwnerVenue[] = []
  try {
    venues = await listOwnedVenues(supabase, user.id)
  } catch (error) {
    console.error("[venue/layout] venue lookup failed", {
      code: (error as { code?: unknown }).code,
    })
  }

  // The middleware stamps `pathname + search`, so both halves are available: the path keeps the
  // switcher on the current page, the query says which venue is selected.
  const stamped = (await headers()).get(PATHNAME_HEADER) ?? "/venue"
  const queryIndex = stamped.indexOf("?")
  const pathname = queryIndex === -1 ? stamped : stamped.slice(0, queryIndex)
  const search = queryIndex === -1 ? "" : stamped.slice(queryIndex + 1)
  const selectedVenueId = new URLSearchParams(search).get("venue")
  const activeVenueId =
    venues.find((candidate) => candidate.id === selectedVenueId)?.id ?? venues[0]?.id ?? null

  const isAdmin = profile.role === "admin"
  const unpayable = venues.filter((venue) => !venue.charges_enabled)
  const hasVenue = venues.length > 0
  const soleVenue = venues.length === 1 ? venues[0] : undefined

  return (
    /*
      The pages in this segment are written in English while the document is `lang="tr"`.
      Declaring the switch on the segment root is what lets a screen reader change voice
      instead of reading English with Turkish phonetics (WCAG 3.1.2 Language of Parts).
      The player surface one level up is Turkish and carries no override.
    */
    <div lang="en" className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">İşletme paneli</h1>
          <p className="text-sm text-muted-foreground">
            {hasVenue
              ? soleVenue
                ? `${soleVenue.name}${soleVenue.city ? ` · ${soleVenue.city}` : ""}`
                : `${venues.length} venues`
              : "Set up your first venue to start taking bookings."}
            {isAdmin ? " · viewing as admin" : null}
          </p>
        </div>

        {venues.length > 1 ? (
          <nav aria-label="İşletme seç" className="flex flex-wrap gap-1">
            {venues.map((candidate) => {
              const active = candidate.id === activeVenueId
              const next = new URLSearchParams(search)
              next.set("venue", candidate.id)
              return (
                <Link
                  key={candidate.id}
                  href={`${pathname}?${next.toString()}`}
                  aria-current={active ? "true" : undefined}
                  className={cn(
                    "rounded-md border px-3 py-1.5 text-sm transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                    active
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                  )}
                >
                  {candidate.name}
                </Link>
              )
            })}
          </nav>
        ) : null}
      </div>

      {!hasVenue ? (
        <Alert>
          <AlertTitle>Henüz bir işletmen yok</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center gap-3">
            <span>
              İşletmeni oluştur ve bir hakediş hesabı bağla — ikisi de tamamlanmadan rezervasyon alınamaz.
            </span>
            <Link href="/venue/onboarding" className={LINK_BUTTON}>
              Kurulumu yap
            </Link>
          </AlertDescription>
        </Alert>
      ) : unpayable.length > 0 ? (
        <Alert variant="destructive">
          <AlertTitle>
            {unpayable.length === venues.length
              ? "Your venue cannot take payments yet"
              : `${unpayable.length} of your venues cannot take payments yet`}
          </AlertTitle>
          <AlertDescription className="flex flex-wrap items-center gap-3">
            <span>
              Stripe has not enabled charges on {unpayable.map((venue) => venue.name).join(", ")}.
              Players cannot book until verification is complete.
            </span>
            <Link href="/venue/onboarding" className={LINK_BUTTON_OUTLINE}>
              Doğrulamayı tamamla
            </Link>
          </AlertDescription>
        </Alert>
      ) : null}

      {children}
    </div>
  )
}
