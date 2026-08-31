/**
 * app/(dashboard)/venue/calendar/page.tsx — the live availability calendar.
 *
 * The server renders the first week so the grid is populated on first paint (and readable with
 * JavaScript disabled up to the point of interaction); `<BookingCalendar>` then takes over,
 * subscribes to `bookings` changes over Realtime, and fetches any other week on demand.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SERVER PICKS THE WEEK
 * ---------------------------------------------------------------------------
 * "This week" is a question about the VENUE's timezone, not the viewer's. An owner in London
 * looking at an Istanbul pitch must see the Istanbul week, or the grid and the bookings drawn on
 * it disagree by an hour or a whole day. So `startOfLocalWeek(now, venue.timezone)` resolves it
 * here, server-side, and the client component is handed a plain `YYYY-MM-DD` it never has to
 * second-guess.
 *
 * ---------------------------------------------------------------------------
 * DATA ACCESS
 * ---------------------------------------------------------------------------
 * Read with the cookie-bound client, so RLS is the boundary: `bookings_select_stakeholders`
 * (through `private.owns_pitch`) and `pitch_blocks_select_bookable` decide which rows exist for
 * this user. The `.eq('pitch_id', …)` and `.overlaps(...)` predicates are query optimisations that
 * put the GiST indexes to work — they narrow the QUESTION, never the permission.
 */

import Link from "next/link"

import {
  BookingCalendar,
  type CalendarBlock,
  type CalendarBooking,
  type CalendarPitch,
} from "@/components/venue/booking-calendar"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { requireRole } from "@/lib/rbac"
import { createClient } from "@/lib/supabase/server"
import {
  addDaysToDateKey,
  parseDateKey,
  resolveDashboardVenue,
  startOfLocalWeek,
  timeToMinutes,
  toRangeLiteral,
  zonedWallClockToUtc,
} from "@/lib/venue/metrics"

export const dynamic = "force-dynamic"

const PRIMARY_LINK =
  "inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium " +
  "text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none " +
  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"

interface PageProps {
  searchParams: { venue?: string; pitch?: string; week?: string }
}

export default async function VenueCalendarPage({ searchParams }: PageProps) {
  const { user, profile } = await requireRole("venue_owner", "admin")
  const supabase = await createClient()

  const { venue } = await resolveDashboardVenue(supabase, user.id, {
    requestedId: searchParams.venue,
    isAdmin: profile.role === "admin",
  })

  if (!venue) {
    return (
      <EmptyCard
        title="Henüz işletme yok"
        body="Önce işletmeni oluştur — takvim, işletmenin sahalarının müsaitliğini gösterir."
        href="/venue/onboarding"
        cta="İşletmeni kur"
      />
    )
  }

  const { data: pitchRows, error: pitchError } = await supabase
    .from("pitches")
    .select(
      "id, name, opening_time, closing_time, slot_minutes, hourly_rate_minor, currency, is_active",
    )
    .eq("venue_id", venue.id)
    .order("name", { ascending: true })

  if (pitchError) {
    console.error("[venue/calendar] pitch lookup failed", { code: pitchError.code })
    return (
      <Alert variant="destructive">
        <AlertTitle>Sahaların yüklenemedi</AlertTitle>
        <AlertDescription>Sayfayı yenile ya da birazdan tekrar dene.</AlertDescription>
      </Alert>
    )
  }

  const pitches: CalendarPitch[] = (pitchRows ?? []).map((pitch) => ({
    id: pitch.id,
    name: pitch.name,
    openingTime: pitch.opening_time,
    closingTime: pitch.closing_time,
    slotMinutes: pitch.slot_minutes,
    hourlyRateMinor: pitch.hourly_rate_minor,
    currency: pitch.currency,
    isActive: pitch.is_active,
  }))

  if (pitches.length === 0) {
    return (
      <EmptyCard
        title="Henüz saha yok"
        body="Çalışma saatleri ve saat dilimi olan bir saha ekle; haftalık müsaitliği burada görünür."
        href="/venue/pitches"
        cta="Saha ekle"
      />
    )
  }

  // Prefer an ACTIVE pitch as the default view: an inactive one is a legitimate thing to inspect,
  // but it is never the thing an owner opens the calendar to look at.
  const requestedPitch = pitches.find((candidate) => candidate.id === searchParams.pitch)
  const pitch = requestedPitch ?? pitches.find((candidate) => candidate.isActive) ?? pitches[0]

  // Unreachable given the length check above, but `noUncheckedIndexedAccess` types `pitches[0]`
  // as possibly undefined and an assertion here would be a lie waiting to be believed.
  if (!pitch) {
    return (
      <EmptyCard
        title="Henüz saha yok"
        body="Çalışma saatleri ve saat dilimi olan bir saha ekle; haftalık müsaitliği burada görünür."
        href="/venue/pitches"
        cta="Saha ekle"
      />
    )
  }

  const weekStart = normaliseWeekStart(searchParams.week, venue.timezone)
  const window = weekWindow(weekStart, pitch, venue.timezone)
  const literal = toRangeLiteral(window.from, window.to)

  const [bookingsResponse, blocksResponse] = await Promise.all([
    supabase
      .from("bookings")
      .select("id, pitch_id, time_range, status, payment_status, total_minor, currency")
      .eq("pitch_id", pitch.id)
      .overlaps("time_range", literal),
    supabase
      .from("pitch_availability_blocks")
      .select("id, pitch_id, block_range, reason")
      .eq("pitch_id", pitch.id)
      .overlaps("block_range", literal),
  ])

  if (bookingsResponse.error || blocksResponse.error) {
    console.error("[venue/calendar] schedule read failed", {
      bookings: bookingsResponse.error?.code,
      blocks: blocksResponse.error?.code,
    })
  }

  const initialBookings = (bookingsResponse.data ?? []) as CalendarBooking[]
  const initialBlocks = (blocksResponse.data ?? []) as CalendarBlock[]

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Müsaitlik</h2>
        <p className="text-sm text-muted-foreground">
          Rezervasyon akışından canlı. Bakım ya da özel etkinlik için saat kapatmak üzere boş saatlerin üzerinde sürükle.
        </p>
      </div>

      {!pitch.isActive ? (
        <Alert>
          <AlertTitle>{pitch.name} is not bookable</AlertTitle>
          <AlertDescription>
            This pitch is switched off, so nothing on this grid can be reserved.{" "}
            <Link href="/venue/pitches" className="underline underline-offset-2">
              Yeniden aç
            </Link>{" "}
            when you are ready.
          </AlertDescription>
        </Alert>
      ) : null}

      <BookingCalendar
        venueId={venue.id}
        timezone={venue.timezone}
        pitches={pitches}
        initialPitchId={pitch.id}
        initialWeekStart={weekStart}
        initialBookings={initialBookings}
        initialBlocks={initialBlocks}
        canEdit
      />
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function normaliseWeekStart(requested: string | undefined, timezone: string): string {
  if (requested && /^\d{4}-\d{2}-\d{2}$/.test(requested)) {
    const { year, month, day } = parseDateKey(requested)
    // Snap whatever was asked for to the Monday of that week, so a hand-typed URL cannot produce
    // a grid whose columns start mid-week and quietly disagree with every other view.
    const offset = (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7
    return addDaysToDateKey(requested, -offset)
  }
  return startOfLocalWeek(new Date(), timezone)
}

/**
 * The exact instants the grid covers: the first day's opening time to the last day's closing
 * time, resolved through the venue zone. Asking for precisely what is drawn keeps the payload
 * small and means the client's own refetch uses an identical window.
 */
function weekWindow(
  weekStart: string,
  pitch: CalendarPitch,
  timezone: string,
): { from: Date; to: Date } {
  const open = timeToMinutes(pitch.openingTime)
  const rawClose = timeToMinutes(pitch.closingTime)
  // An overnight session (closing at or before opening) runs into the next local day. The grid
  // projects it onto [open, close + 24h), so the window this fetch asks for has to cover the
  // same post-midnight tail or the last rows would render empty.
  const close = rawClose <= open ? rawClose + 24 * 60 : Math.max(open + 1, rawClose)

  const first = parseDateKey(weekStart)
  const last = parseDateKey(addDaysToDateKey(weekStart, 6))

  return {
    from: zonedWallClockToUtc(
      first.year,
      first.month,
      first.day,
      Math.floor(open / 60),
      open % 60,
      timezone,
    ),
    to: zonedWallClockToUtc(
      last.year,
      last.month,
      last.day,
      Math.floor(close / 60),
      close % 60,
      timezone,
    ),
  }
}

function EmptyCard({
  title,
  body,
  href,
  cta,
}: {
  title: string
  body: string
  href: string
  cta: string
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{body}</CardDescription>
      </CardHeader>
      <CardContent>
        <Link href={href} className={PRIMARY_LINK}>
          {cta}
        </Link>
      </CardContent>
    </Card>
  )
}
