/**
 * app/(app)/bookings/page.tsx
 *
 * Everything this person has booked, split into what is still to come and what has happened.
 *
 * ---------------------------------------------------------------------------
 * WHOSE BOOKINGS
 * ---------------------------------------------------------------------------
 * `bookings_select_stakeholders` lets a signed-in user see four kinds of row: their own, their
 * team's, the ones on a pitch they own, and — for an admin — all of them. A venue owner's own
 * takings belong on the venue dashboard, not here, so this page asks explicitly for
 * `booked_by = me OR team_id IN (my teams)`. RLS still decides what is readable; the filter
 * decides what is RELEVANT.
 *
 * ---------------------------------------------------------------------------
 * UPCOMING vs PAST, WITHOUT A CLIENT-SIDE SPLIT
 * ---------------------------------------------------------------------------
 * `bookings.time_range` is a `tstzrange`, so the split is a range comparison rather than a
 * timestamp one. `time_range << [now,now]` is "ended before now"; its negation is "still to
 * come", which correctly keeps a match that is being played RIGHT NOW in the upcoming list
 * instead of dropping it out of both. Doing this in Postgres also means paging works: a
 * fetch-then-filter-in-JS approach silently loses rows past the page size.
 */

import type { ReactNode } from "react"
import type { Metadata } from "next"
import Link from "next/link"

import { BookingStatusBadge, PaymentStatusBadge } from "@/components/booking/booking-status-badge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { getSessionUser } from "@/lib/rbac"
import { createClient } from "@/lib/supabase/server"
import { parseRange } from "@/lib/venue/metrics"
import { cn } from "@/lib/utils"
import { DEFAULT_CURRENCY, formatMinor } from "@halisaha/shared/domain"

export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "Rezervasyonlarım",
  description: "Yaklaşan ve geçmiş saha rezervasyonların.",
}

const PAGE_SIZE = 40

type ViewKey = "upcoming" | "past"

const VIEWS: Readonly<Record<ViewKey, { label: string; empty: string }>> = {
  upcoming: {
    label: "Yaklaşan",
    empty: "Henüz rezervasyon yok. Bir saha ve saat seç; ödeme yaparken saat sana ayrılır.",
  },
  past: {
    label: "Geçmiş",
    empty: "Henüz tamamlanmış rezervasyon yok. Oynanan maçlar makbuzlarıyla birlikte burada görünür.",
  },
}

function resolveView(raw: string | undefined): ViewKey {
  return raw === "past" ? "past" : "upcoming"
}

/** A degenerate `[now,now]` range: the pivot both comparisons are made against. */
function nowRangeLiteral(now: Date): string {
  const iso = now.toISOString()
  return `["${iso}","${iso}"]`
}

export default async function BookingsPage({ searchParams }: { searchParams?: { view?: string } }) {
  const session = await getSessionUser()
  if (!session) return null // the (app) layout has already redirected

  const view = resolveView(searchParams?.view)
  const supabase = await createClient()

  /* ---- which rows are "mine" ------------------------------------------ */
  const { data: memberships } = await supabase
    .from("team_members")
    .select("team_id")
    .eq("player_id", session.user.id)
    .is("left_at", null)

  const teamIds = (memberships ?? []).map((row) => row.team_id)

  let builder = supabase
    .from("bookings")
    .select(
      "id, pitch_id, team_id, status, payment_status, time_range, total_minor, currency",
    )

  builder =
    teamIds.length > 0
      ? builder.or(`booked_by.eq.${session.user.id},team_id.in.(${teamIds.join(",")})`)
      : builder.eq("booked_by", session.user.id)

  const pivot = nowRangeLiteral(new Date())
  builder =
    view === "past"
      ? builder.filter("time_range", "sl", pivot)
      : builder.not("time_range", "sl", pivot)

  const { data: bookingRows, error } = await builder
    .order("time_range", { ascending: view === "upcoming" })
    .limit(PAGE_SIZE)

  if (error) {
    console.error("[bookings] list failed", { code: error.code })
    return (
      <PageFrame view={view}>
        <Alert variant="destructive">
          <AlertTitle>Rezervasyonların yüklenemedi</AlertTitle>
          <AlertDescription>
            Okunurken bir şeyler ters gitti. Sayfayı yenile; devam ederse bize haber ver.
          </AlertDescription>
        </Alert>
      </PageFrame>
    )
  }

  const bookings = bookingRows ?? []

  if (bookings.length === 0) {
    return (
      <PageFrame view={view}>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Burada bir şey yok</CardTitle>
            <CardDescription>{VIEWS[view].empty}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild>
              <Link href="/venues">Saha bul</Link>
            </Button>
          </CardContent>
        </Card>
      </PageFrame>
    )
  }

  /* ---- one round trip per entity kind --------------------------------- */
  const pitchIds = unique(bookings.map((booking) => booking.pitch_id))
  const bookingIds = bookings.map((booking) => booking.id)

  const { data: pitchRows } = await supabase
    .from("pitches")
    .select("id, name, venue_id")
    .in("id", pitchIds)

  const venueIds = unique((pitchRows ?? []).map((row) => row.venue_id))

  const [{ data: venueRows }, { data: matchRows }] = await Promise.all([
    supabase.from("venues").select("id, name, slug, timezone").in("id", orSentinel(venueIds)),
    supabase.from("matches").select("id, booking_id").in("booking_id", bookingIds),
  ])

  const pitches = new Map((pitchRows ?? []).map((row) => [row.id, row]))
  const venues = new Map((venueRows ?? []).map((row) => [row.id, row]))
  /** booking id -> match id, for the "open the match" link. */
  const matches = new Map<string, string>()
  for (const match of matchRows ?? []) {
    if (match.booking_id) matches.set(match.booking_id, match.id)
  }

  return (
    <PageFrame view={view}>
      <ul className="space-y-3">
        {bookings.map((booking) => {
          const pitch = pitches.get(booking.pitch_id)
          const venue = pitch ? venues.get(pitch.venue_id) : undefined
          const timezone = venue?.timezone ?? "Europe/Istanbul"
          const range = parseRange(booking.time_range)
          const matchId = matches.get(booking.id)
          const unpaid = booking.status === "awaiting_payment" || booking.status === "pending"

          return (
            <li key={booking.id}>
              <Card>
                <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0 space-y-1">
                    <p className="font-medium">
                      {range ? formatWhen(range.start, timezone) : "Unknown time"}
                    </p>
                    <p className="truncate text-sm text-muted-foreground">
                      {pitch?.name ?? "Pitch"} · {venue?.name ?? "Venue"}
                    </p>
                    <div className="flex flex-wrap items-center gap-1.5 pt-1">
                      <BookingStatusBadge status={booking.status} />
                      <PaymentStatusBadge status={booking.payment_status} />
                      {booking.team_id && <span className="text-xs text-muted-foreground">Takım rezervasyonu</span>}
                    </div>
                  </div>

                  <div className="flex shrink-0 flex-wrap items-center gap-2 sm:flex-col sm:items-end">
                    <p className="text-sm font-semibold tabular-nums">
                      {formatMinor(booking.total_minor, booking.currency || DEFAULT_CURRENCY)}
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {matchId && (
                        <Button asChild variant="ghost" size="sm">
                          <Link href={`/matches/${matchId}`}>Maç</Link>
                        </Button>
                      )}
                      {unpaid && (
                        <Button asChild size="sm">
                          <Link href={`/checkout/${booking.id}`}>Şimdi öde</Link>
                        </Button>
                      )}
                      <Button asChild variant="outline" size="sm">
                        <Link href={`/bookings/${booking.id}`}>Ayrıntılar</Link>
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </li>
          )
        })}
      </ul>

      {bookings.length === PAGE_SIZE && (
        <p className="text-sm text-muted-foreground">
          Showing the {PAGE_SIZE} nearest bookings. Older ones stay on your account.
        </p>
      )}
    </PageFrame>
  )
}

/* -------------------------------------------------------------------------- */

function PageFrame({ view, children }: { view: ViewKey; children: ReactNode }) {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Rezervasyonlarım</h1>
          <p className="text-sm text-muted-foreground">
            Senin yaptığın ve takımların için yapılan rezervasyonlar.
          </p>
        </div>
        <Button asChild>
          <Link href="/venues">Saha bul</Link>
        </Button>
      </div>

      <nav aria-label="Rezervasyon görünümleri">
        <ul className="inline-flex items-center gap-1 rounded-md bg-muted p-1 text-sm">
          {(Object.keys(VIEWS) as ViewKey[]).map((key) => (
            <li key={key}>
              <Link
                href={key === "upcoming" ? "/bookings" : `/bookings?view=${key}`}
                aria-current={view === key ? "page" : undefined}
                className={cn(
                  "inline-flex h-8 items-center rounded-sm px-3 transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  view === key
                    ? "bg-background font-medium text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {VIEWS[key].label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      {children}
    </div>
  )
}

/* -------------------------------------------------------------------------- */

function unique(values: readonly string[]): string[] {
  return Array.from(new Set(values))
}

/**
 * `.in('id', [])` renders as `id=in.()`, which PostgREST rejects rather than treating as an
 * empty set. The all-zeroes uuid is a valid uuid that matches nothing.
 */
const NIL_UUID = "00000000-0000-0000-0000-000000000000"

function orSentinel(ids: readonly string[]): string[] {
  return ids.length > 0 ? [...ids] : [NIL_UUID]
}

/** Kickoff in the VENUE's zone — a booking is a place and a time, and the place owns the clock. */
function formatWhen(epochMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat("tr-TR", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(epochMs))
}
