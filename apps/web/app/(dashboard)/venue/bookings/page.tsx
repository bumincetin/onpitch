/**
 * app/(dashboard)/venue/bookings/page.tsx — the booking ledger.
 *
 * ---------------------------------------------------------------------------
 * WHY "UPCOMING" AND "PAST" ARE SEPARATE VIEWS, NOT ONE INFINITE LIST
 * ---------------------------------------------------------------------------
 * They answer different questions. Upcoming is operational — who is turning up, has everyone
 * paid, what needs chasing — and reads best ascending. Past is financial — what did we take, what
 * was refunded — and reads best descending. One merged list is worse at both, and it forces the
 * database to sort a range column across the whole history on every page load.
 *
 * Each view is bounded to a year in its direction so the query rides `idx_bookings_pitch_range`
 * (GiST) via `.overlaps()` instead of scanning. A venue with more than a year of future bookings
 * has other problems.
 *
 * ---------------------------------------------------------------------------
 * FILTERS ARE LINKS
 * ---------------------------------------------------------------------------
 * Every control on this page is an `<a>` that changes the query string, so the whole view stays a
 * Server Component: no client bundle, every state is a shareable URL, the browser's back button
 * works, and the filter survives a reload. A `<Select>` here would ship JavaScript to do worse.
 *
 * RLS (`bookings_select_stakeholders` via `private.owns_pitch`) is what limits these rows to the
 * caller's own venue; `.in('pitch_id', …)` and `.overlaps(...)` are index hints that narrow the
 * question, not the permission.
 */

import Link from "next/link"

import {
  BookingsTable,
  toVenueBookingRows,
  type VenueBookingRow,
} from "@/components/venue/bookings-table"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { requireRole } from "@/lib/rbac"
import { createClient } from "@/lib/supabase/server"
import { cn } from "@/lib/utils"
import { resolveDashboardVenue, toRangeLiteral } from "@/lib/venue/metrics"
import { Constants, type Enums } from "@onpitch/shared/database"
import { formatMinor } from "@onpitch/shared/domain"

export const dynamic = "force-dynamic"

const PAGE_SIZE = 25
const YEAR_MS = 365 * 86_400_000

const PRIMARY_LINK =
  "inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium " +
  "text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none " +
  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"

const BOOKING_COLUMNS =
  "id, pitch_id, team_id, time_range, status, payment_status, total_minor, platform_fee_minor, " +
  "refunded_amount_minor, currency, notes, created_at, " +
  "profiles:profiles!bookings_booked_by_fkey(display_name, full_name), teams(name)"

const STATUS_LABELS: Readonly<Record<Enums<"booking_status">, string>> = {
  pending: "Pending",
  awaiting_payment: "Awaiting payment",
  confirmed: "Confirmed",
  completed: "Completed",
  cancelled: "Cancelled",
  refunded: "Refunded",
  disputed: "Disputed",
}

type View = "upcoming" | "past"

interface PageProps {
  searchParams: { venue?: string; view?: string; status?: string; page?: string }
}

export default async function VenueBookingsPage({ searchParams }: PageProps) {
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
            En az bir rezerve edilebilir sahası olan bir işletmen olunca rezervasyonlar burada görünür.
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

  const view: View = searchParams.view === "past" ? "past" : "upcoming"
  const status = normaliseStatus(searchParams.status)
  const page = normalisePage(searchParams.page)

  const { data: pitchRows, error: pitchError } = await supabase
    .from("pitches")
    .select("id, name")
    .eq("venue_id", venue.id)

  if (pitchError) {
    console.error("[venue/bookings] pitch lookup failed", { code: pitchError.code })
    return (
      <Alert variant="destructive">
        <AlertTitle>Rezervasyonların yüklenemedi</AlertTitle>
        <AlertDescription>Sayfayı yenile ya da birazdan tekrar dene.</AlertDescription>
      </Alert>
    )
  }

  const pitchNames = new Map((pitchRows ?? []).map((pitch) => [pitch.id, pitch.name]))

  if (pitchNames.size === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Henüz saha yok</CardTitle>
          <CardDescription>
            Bu işletmenin en az bir sahası olmadan rezervasyon alınamaz.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Link href="/venue/pitches" className={PRIMARY_LINK}>
            Saha ekle
          </Link>
        </CardContent>
      </Card>
    )
  }

  const now = new Date()
  const literal =
    view === "upcoming"
      ? toRangeLiteral(now, new Date(now.getTime() + YEAR_MS))
      : toRangeLiteral(new Date(now.getTime() - YEAR_MS), now)

  // Filters first, transforms last: `.order()` / `.range()` are transform steps, and applying a
  // filter after them reads as though it could be evaluated post-pagination even though it is not.
  let query = supabase
    .from("bookings")
    .select(BOOKING_COLUMNS, { count: "exact" })
    .in("pitch_id", [...pitchNames.keys()])
    .overlaps("time_range", literal)

  // `.overlaps()` is symmetric, so on its own it puts a booking that is in progress RIGHT NOW in
  // BOTH windows — listed and counted twice. The year-wide literal above is the index hint; this
  // degenerate `[now,now]` pivot is what actually partitions, matching app/(app)/bookings.
  // `time_range << [now,now]` is "ended before now"; its negation keeps an in-progress booking
  // in Upcoming instead of dropping it out of both.
  const pivot = `["${now.toISOString()}","${now.toISOString()}"]`
  query =
    view === "past" ? query.filter("time_range", "sl", pivot) : query.not("time_range", "sl", pivot)

  if (status) query = query.eq("status", status)

  const { data, error, count } = await query
    .order("time_range", { ascending: view === "upcoming" })
    .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1)

  if (error) {
    console.error("[venue/bookings] list failed", { code: error.code })
    return (
      <Alert variant="destructive">
        <AlertTitle>Rezervasyonların yüklenemedi</AlertTitle>
        <AlertDescription>Sayfayı yenile ya da birazdan tekrar dene.</AlertDescription>
      </Alert>
    )
  }

  // `as unknown[]`: BOOKING_COLUMNS is a shared const rather than a string literal, so
  // postgrest-js infers an opaque result type. `toVenueBookingRows` re-reads every field it uses.
  const rows = toVenueBookingRows((data ?? []) as unknown[], pitchNames)
  const total = count ?? rows.length
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const totals = sumRows(rows)

  const baseParams = new URLSearchParams()
  if (searchParams.venue) baseParams.set("venue", searchParams.venue)

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Rezervasyonlar</h2>
        <p className="text-sm text-muted-foreground">
          {total === 0
            ? "Nothing to show for this filter."
            : `${total} ${view === "upcoming" ? "upcoming" : "past"} booking${total === 1 ? "" : "s"}${status ? ` · ${STATUS_LABELS[status].toLowerCase()}` : ""} · times in ${venue.timezone}`}
        </p>
      </div>

      {/* View + status filters */}
      <div className="space-y-2">
        <nav aria-label="Zaman aralığı" className="flex gap-1">
          {(["upcoming", "past"] as const).map((candidate) => (
            <FilterLink
              key={candidate}
              href={buildHref(baseParams, { view: candidate, status: status ?? undefined })}
              active={candidate === view}
            >
              {candidate === "upcoming" ? "Upcoming" : "Past"}
            </FilterLink>
          ))}
        </nav>

        <nav aria-label="Rezervasyon durumu" className="flex flex-wrap gap-1">
          <FilterLink href={buildHref(baseParams, { view })} active={status === null}>
            Bütün durumlar
          </FilterLink>
          {Constants.public.Enums.booking_status.map((candidate) => (
            <FilterLink
              key={candidate}
              href={buildHref(baseParams, { view, status: candidate })}
              active={status === candidate}
            >
              {STATUS_LABELS[candidate]}
            </FilterLink>
          ))}
        </nav>
      </div>

      {rows.length > 0 ? (
        <>
          <div className="rounded-md border border-border">
            <BookingsTable
              rows={rows}
              timezone={venue.timezone}
              caption={`${view === "upcoming" ? "Upcoming" : "Past"} bookings at ${venue.name}`}
            />
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
            <p className="text-muted-foreground">
              This page: {formatMinor(totals.total, totals.currency)} charged ·{" "}
              <span className="font-medium text-foreground">
                {formatMinor(totals.net, totals.currency)}
              </span>{" "}
              yours after fees
              {totals.refunded > 0
                ? ` · ${formatMinor(totals.refunded, totals.currency)} refunded`
                : ""}
            </p>

            {pageCount > 1 ? (
              <nav aria-label="Sayfalama" className="flex items-center gap-2">
                <PageLink
                  href={buildHref(baseParams, { view, status: status ?? undefined, page: page - 1 })}
                  disabled={page === 0}
                >
                  Önceki
                </PageLink>
                <span className="text-muted-foreground tabular-nums" aria-current="page">
                  Page {page + 1} of {pageCount}
                </span>
                <PageLink
                  href={buildHref(baseParams, { view, status: status ?? undefined, page: page + 1 })}
                  disabled={page + 1 >= pageCount}
                >
                  Sonraki
                </PageLink>
              </nav>
            ) : null}
          </div>

          <Separator />
          <p className="text-xs text-muted-foreground">
            &ldquo;Your share&rdquo; is the customer total less the platform fee and any refund.
            Money reaches your bank on the payout schedule, not at the moment of booking — see{" "}
            <Link href="/venue/payouts" className="underline underline-offset-2">
              Hakedişler
            </Link>
            .
          </p>
        </>
      ) : (
        <BookingsTable
          rows={[]}
          timezone={venue.timezone}
          emptyTitle={status ? "No bookings match this filter" : "No bookings in this period"}
          emptyBody={
            status
              ? "Clear the status filter to see everything in this period."
              : view === "upcoming"
                ? "Nothing is booked in the next year. Share your venue page to start taking reservations."
                : "No bookings in the past year."
          }
        />
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Pieces                                                                    */
/* -------------------------------------------------------------------------- */

function FilterLink({
  href,
  active,
  children,
}: {
  href: string
  active: boolean
  children: React.ReactNode
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "true" : undefined}
      className={cn(
        "rounded-md border px-2.5 py-1 text-xs transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground",
      )}
    >
      {children}
    </Link>
  )
}

function PageLink({
  href,
  disabled,
  children,
}: {
  href: string
  disabled: boolean
  children: React.ReactNode
}) {
  if (disabled) {
    // Rendered as plain text rather than a disabled link: an `<a>` with no destination is a
    // keyboard trap and is announced as a link that does nothing.
    return <span className="px-2.5 py-1 text-xs text-muted-foreground opacity-50">{children}</span>
  }
  return (
    <Link
      href={href}
      className="rounded-md border border-border px-2.5 py-1 text-xs transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      {children}
    </Link>
  )
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function buildHref(
  base: URLSearchParams,
  patch: { view?: View; status?: Enums<"booking_status">; page?: number },
): string {
  const params = new URLSearchParams(base)
  if (patch.view) params.set("view", patch.view)
  if (patch.status) params.set("status", patch.status)
  // Any filter change resets to page 1 — page 4 of an unfiltered list is meaningless once the
  // list changes underneath it.
  if (patch.page !== undefined && patch.page > 0) params.set("page", String(patch.page))
  const query = params.toString()
  return query ? `/venue/bookings?${query}` : "/venue/bookings"
}

function normaliseStatus(value: string | undefined): Enums<"booking_status"> | null {
  if (!value) return null
  return Constants.public.Enums.booking_status.includes(value as Enums<"booking_status">)
    ? (value as Enums<"booking_status">)
    : null
}

function normalisePage(value: string | undefined): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) return 0
  // Hard cap: a hand-typed `?page=999999` would otherwise ask Postgres for a very deep OFFSET.
  return Math.min(parsed - 1, 400)
}

function sumRows(rows: readonly VenueBookingRow[]): {
  total: number
  net: number
  refunded: number
  currency: string
} {
  let total = 0
  let net = 0
  let refunded = 0

  for (const row of rows) {
    // Only money that actually moved. A booking is born `awaiting_payment` with its full
    // `total_minor` already set, and an abandoned checkout keeps that total with
    // `payment_status = 'failed'`; counting either would report an unpaid reservation to the
    // owner as revenue. Same predicate as `isCharged` in lib/venue/metrics.ts, so /venue and
    // /venue/bookings cannot disagree about the same bookings.
    if (
      row.paymentStatus !== "succeeded" &&
      row.paymentStatus !== "refunded" &&
      row.paymentStatus !== "partially_refunded"
    ) {
      continue
    }

    total += row.totalMinor
    refunded += row.refundedAmountMinor
    net += Math.max(0, row.totalMinor - row.platformFeeMinor - row.refundedAmountMinor)
  }

  return { total, net, refunded, currency: rows[0]?.currency ?? "try" }
}
