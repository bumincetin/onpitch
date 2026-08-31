/**
 * app/(dashboard)/venue/page.tsx — the venue owner's overview.
 *
 * Four headline numbers, the daily occupancy chart, and what is coming up next.
 *
 * ---------------------------------------------------------------------------
 * DATA ACCESS
 * ---------------------------------------------------------------------------
 * Everything is read with the COOKIE-BOUND server client, so RLS is the access boundary:
 * `bookings_select_stakeholders` (via `private.owns_pitch`) and `venue_payouts_select_owner` are
 * what stop one owner seeing another's revenue. The `.eq('venue_id', …)` and `.in('pitch_id', …)`
 * predicates below are QUERY OPTIMISATIONS — they let Postgres use `idx_pitches_venue_id` and the
 * `idx_bookings_pitch_range` GiST index instead of filtering after the fact. Removing them would
 * make the page slower and would NOT make it leak.
 *
 * The one exception is documented in `lib/venue/metrics.ts`: on `venues` the owner filter is
 * semantic, because that table has a deliberately public "browse active venues" policy.
 *
 * ---------------------------------------------------------------------------
 * STREAMING
 * ---------------------------------------------------------------------------
 * The metrics fold is four round trips and the "what's next" list is two more, so they sit behind
 * separate `<Suspense>` boundaries with skeletons that match their final geometry. The nav, the
 * range picker and the venue switcher paint immediately; the numbers arrive when they arrive.
 */

import { Suspense } from "react"
import Link from "next/link"

import {
  BookingsTable,
  BookingsTableSkeleton,
  toVenueBookingRows,
} from "@/components/venue/bookings-table"
import {
  MetricCard,
  MetricCardGridSkeleton,
  directionOf,
} from "@/components/venue/metric-card"
import { OccupancyChart, OccupancyChartSkeleton } from "@/components/venue/occupancy-chart"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { requireRole } from "@/lib/rbac"
import { VenueScorecardSection } from "@/components/venue/scorecard"
import { createClient } from "@/lib/supabase/server"
import { cn } from "@/lib/utils"
import {
  computeVenueMetrics,
  formatRate,
  formatSignedPoints,
  formatSignedRatio,
  resolveDashboardVenue,
  toRangeLiteral,
  type OwnerVenue,
} from "@/lib/venue/metrics"
import { formatMinor } from "@halisaha/shared/domain"

export const dynamic = "force-dynamic"

const DAY_MS = 86_400_000

/** Preset windows. Anything else can still be requested with explicit `?from=&to=`. */
const RANGES = [
  { key: "7d", days: 7, label: "7 days" },
  { key: "30d", days: 30, label: "30 days" },
  { key: "90d", days: 90, label: "90 days" },
] as const

type RangeKey = (typeof RANGES)[number]["key"]

interface PageProps {
  searchParams: { venue?: string; range?: string; from?: string; to?: string }
}

export default async function VenueOverviewPage({ searchParams }: PageProps) {
  const { user, profile } = await requireRole("venue_owner", "admin")
  const supabase = await createClient()

  const { venue } = await resolveDashboardVenue(supabase, user.id, {
    requestedId: searchParams.venue,
    isAdmin: profile.role === "admin",
  })

  if (!venue) return <NoVenueState />

  const rangeKey = normaliseRange(searchParams.range)
  const rangeDays = RANGES.find((range) => range.key === rangeKey)?.days ?? 7
  // `?to=` is arbitrary user input. `Date.parse('abc')` is NaN and `new Date(NaN).toISOString()`
  // throws a RangeError synchronously inside this Server Component -- before any Suspense
  // boundary -- which 500s the whole route. Fall back to "now" instead, the way `resolveWindow`
  // in lib/venue/metrics.ts already does for the bounds that reach it.
  const toMs = Date.parse(searchParams.to ?? "")
  const toDate = Number.isFinite(toMs) ? new Date(toMs) : new Date()
  const to = toDate.toISOString()
  const from = searchParams.from ?? new Date(toDate.getTime() - rangeDays * DAY_MS).toISOString()

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-end gap-3">
        <RangePicker venueId={venue.id} current={rangeKey} custom={Boolean(searchParams.from)} />
      </div>

      <Suspense key={`metrics-${venue.id}-${from}-${to}`} fallback={<MetricsFallback />}>
        <MetricsSection venue={venue} from={from} to={to} rangeDays={rangeDays} />
      </Suspense>

      <Suspense key={`upcoming-${venue.id}`} fallback={<UpcomingFallback />}>
        <UpcomingSection venue={venue} />
      </Suspense>

      {/*
        The standing sits below the operational numbers because it is the slower signal: the
        metrics above answer "how was this week", this answers "how is this venue doing". Its
        own Suspense boundary means one extra aggregate never delays the figures an owner
        opened the page for.
      */}
      <Suspense key={`standing-${venue.id}`} fallback={null}>
        <VenueScorecardSection venueId={venue.id} />
      </Suspense>
    </div>
  )
}

/* ========================================================================== */
/*  Metrics                                                                   */
/* ========================================================================== */

async function MetricsSection({
  venue,
  from,
  to,
  rangeDays,
}: {
  venue: OwnerVenue
  from: string
  to: string
  rangeDays: number
}) {
  const supabase = await createClient()
  const result = await computeVenueMetrics({
    supabase,
    venue: { id: venue.id, timezone: venue.timezone },
    from,
    to,
  })

  const { metrics, current, deltas } = result
  const comparison = `vs previous ${rangeDays} days`

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Doluluk"
          value={formatRate(metrics.occupancyRate)}
          hint={`${formatHours(current.bookedMinutes)} booked of ${formatHours(current.bookableMinutes)} bookable`}
          delta={formatSignedPoints(deltas.occupancyRatePoints)}
          deltaDirection={directionOf(deltas.occupancyRatePoints)}
          deltaLabel={comparison}
          goodDirection="up"
        />

        <MetricCard
          label="Ciro"
          value={formatMinor(metrics.revenueMinor, result.currency)}
          hint={
            <>
              {formatMinor(current.netMinor, result.currency)} yours after{" "}
              {formatMinor(current.platformFeeMinor, result.currency)} platform fee
              {current.refundedMinor > 0
                ? ` · ${formatMinor(current.refundedMinor, result.currency)} refunded`
                : ""}
            </>
          }
          delta={formatSignedRatio(deltas.revenueRatio)}
          deltaDirection={directionOf(deltas.revenueRatio)}
          deltaLabel={comparison}
          goodDirection="up"
        />

        <MetricCard
          label="Rezervasyonlar"
          value={String(current.bookingCount)}
          hint={
            current.bookingCount > 0
              ? `${formatMinor(current.averageBookingValueMinor, result.currency)} average · ${formatRate(current.cancellationRate)} cancelled`
              : "No bookings in this period"
          }
          delta={formatSignedRatio(deltas.bookingCountRatio)}
          deltaDirection={directionOf(deltas.bookingCountRatio)}
          deltaLabel={comparison}
          goodDirection="up"
        />

        <MetricCard
          label="Sıradaki hakediş"
          value={
            metrics.nextPayout
              ? formatMinor(metrics.nextPayout.amountMinor, metrics.nextPayout.currency)
              : "—"
          }
          hint={
            metrics.nextPayout ? (
              <>
                {metrics.nextPayout.status === "in_transit" ? "In transit" : "Pending"}
                {metrics.nextPayout.arrivalDate
                  ? ` · expected ${formatDateKey(metrics.nextPayout.arrivalDate)}`
                  : " · Stripe has not set an arrival date"}
                {" · "}
                <Link href="/venue/payouts" className="underline underline-offset-2">
                  Hakedişler
                </Link>
              </>
            ) : (
              <>
                Nothing in flight.{" "}
                <Link href="/venue/payouts" className="underline underline-offset-2">
                  Takvimi gör
                </Link>
              </>
            )
          }
          deltaLabel={metrics.nextPayout ? undefined : "No payout scheduled"}
        />
      </div>

      <OccupancyChart
        points={result.series}
        currency={result.currency}
        timezone={result.timezone}
        description={
          result.activePitchCount === 0
            ? "No active pitches — occupancy cannot be computed until one is bookable."
            : `${result.activePitchCount} active ${result.activePitchCount === 1 ? "pitch" : "pitches"} · ${formatHours(current.bookedMinutes)} booked of ${formatHours(current.bookableMinutes)} bookable · times in ${result.timezone}`
        }
      />
    </div>
  )
}

function MetricsFallback() {
  return (
    <div className="space-y-6">
      <MetricCardGridSkeleton />
      <OccupancyChartSkeleton />
    </div>
  )
}

/* ========================================================================== */
/*  Upcoming bookings                                                         */
/* ========================================================================== */

async function UpcomingSection({ venue }: { venue: OwnerVenue }) {
  const supabase = await createClient()
  const now = new Date()

  // Pitch ids first, so the booking read is one indexed `.in(...)` rather than an embedded
  // filter — and so the pitch NAME is available without a join whose shape varies by
  // postgrest-js version.
  const { data: pitchRows } = await supabase
    .from("pitches")
    .select("id, name")
    .eq("venue_id", venue.id)

  const pitchNames = new Map((pitchRows ?? []).map((pitch) => [pitch.id, pitch.name]))
  if (pitchNames.size === 0) {
    return (
      <UpcomingCard>
        <BookingsTable
          rows={[]}
          timezone={venue.timezone}
          emptyTitle="No pitches yet"
          emptyBody="Add a pitch and its bookings will appear here."
        />
      </UpcomingCard>
    )
  }

  // RLS authorises this read. The pitch and range predicates ride idx_bookings_pitch_range.
  const { data, error } = await supabase
    .from("bookings")
    .select(
      "id, pitch_id, team_id, time_range, status, payment_status, total_minor, platform_fee_minor, " +
        "refunded_amount_minor, currency, notes, created_at, " +
        "profiles:profiles!bookings_booked_by_fkey(display_name, full_name), teams(name)",
    )
    .in("pitch_id", [...pitchNames.keys()])
    .overlaps("time_range", toRangeLiteral(now, new Date(now.getTime() + 30 * DAY_MS)))

  if (error) {
    console.error("[venue/overview] upcoming bookings failed", { code: error.code })
    return (
      <UpcomingCard>
        <p className="text-sm text-muted-foreground">
          Yaklaşan rezervasyonlar şu an yüklenemedi. Sayfadaki diğer her şey etkilenmedi.
        </p>
      </UpcomingCard>
    )
  }

  // `as unknown[]`: the select is a concatenated string rather than a literal, so postgrest-js
  // infers an opaque result type. `toVenueBookingRows` re-reads every field it uses.
  const rows = toVenueBookingRows((data ?? []) as unknown[], pitchNames)
    .filter((row) => Date.parse(row.startsAt) > now.getTime() && row.status !== "cancelled")
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
    .slice(0, 6)

  return (
    <UpcomingCard>
      <BookingsTable
        rows={rows}
        timezone={venue.timezone}
        compact
        caption="Bu işletmedeki sıradaki rezervasyonlar"
        emptyTitle="Nothing booked in the next 30 days"
        emptyBody="Once players reserve a slot it will show up here, and live on the calendar."
      />
    </UpcomingCard>
  )
}

function UpcomingCard({ children }: { children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div>
          <CardTitle>Yaklaşanlar</CardTitle>
          <CardDescription>Bu işletmedeki sıradaki onaylı ve tutulan saatler.</CardDescription>
        </div>
        <Link
          href="/venue/bookings"
          className="shrink-0 text-sm text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          Bütün rezervasyonlar
        </Link>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

function UpcomingFallback() {
  return (
    <UpcomingCard>
      <BookingsTableSkeleton rows={4} />
    </UpcomingCard>
  )
}

/* ========================================================================== */
/*  Chrome                                                                    */
/* ========================================================================== */

function RangePicker({
  venueId,
  current,
  custom,
}: {
  venueId: string
  current: RangeKey
  custom: boolean
}) {
  return (
    <nav aria-label="Rapor dönemi" className="flex items-center gap-1">
      {RANGES.map((range) => {
        const active = !custom && range.key === current
        return (
          <Link
            key={range.key}
            href={`/venue?venue=${venueId}&range=${range.key}`}
            aria-current={active ? "true" : undefined}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
              active
                ? "bg-secondary font-medium text-secondary-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
            )}
          >
            {range.label}
          </Link>
        )
      })}
    </nav>
  )
}

function NoVenueState() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Hadi işletmeni yayına alalım</CardTitle>
        <CardDescription>
          Üç adım: işletmeyi tanımla, en az bir saha ekle ve bir Stripe hakediş hesabı bağla. Üçü de tamamlandığı anda oyuncular rezervasyon yapabilir.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Link
          href="/venue/onboarding"
          className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          Kuruluma başla
        </Link>
      </CardContent>
    </Card>
  )
}

/* ========================================================================== */
/*  Small helpers                                                             */
/* ========================================================================== */

function normaliseRange(value: string | undefined): RangeKey {
  return RANGES.some((range) => range.key === value) ? (value as RangeKey) : "7d"
}

function formatHours(minutes: number): string {
  if (minutes <= 0) return "0h"
  const hours = minutes / 60
  return hours >= 10 ? `${Math.round(hours)}h` : `${hours.toFixed(1)}h`
}

function formatDateKey(dateKey: string): string {
  const date = new Date(`${dateKey}T12:00:00.000Z`)
  if (!Number.isFinite(date.getTime())) return dateKey
  return new Intl.DateTimeFormat("tr-TR", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
  }).format(date)
}
