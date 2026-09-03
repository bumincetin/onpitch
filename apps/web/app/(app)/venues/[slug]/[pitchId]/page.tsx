/**
 * app/(app)/venues/[slug]/[pitchId]/page.tsx
 *
 * One pitch, with the slot picker that turns a time into a held reservation.
 *
 * The page itself renders no availability. It resolves the pitch (RLS-scoped), works out which
 * local days to offer IN THE VENUE'S TIMEZONE, and hands that to the picker, which fetches
 * `GET /api/pitches/[id]/slots` for the day on screen. Availability is the most perishable data
 * in the product — a server-rendered grid would be stale before it finished streaming, and would
 * need refetching on the first date change anyway.
 *
 * The `slug` in the URL is verified against the pitch's own `venue_id`. Without that check,
 * `/venues/some-other-venue/<pitchId>` would render a real pitch under the wrong venue's name
 * and timezone, which is a booking made an hour late.
 */

import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"

import { SlotPicker, type SlotPickerTeam } from "@/components/booking/slot-picker"
import {
  PITCH_FORMAT_LABELS,
  PITCH_SURFACE_LABELS,
  shortTime,
  slotLengthLabel,
} from "@/components/booking/pitch-card"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { dateKeysFrom, isDateKey, todayKey } from "@/lib/booking/availability"
import { CANCELLATION_WINDOW_HOURS, LATE_CANCELLATION_REFUND_BPS } from "@/lib/payments"
import { getSessionUser } from "@/lib/rbac"
import { createClient } from "@/lib/supabase/server"
import { DEFAULT_CURRENCY, formatMinor } from "@onpitch/shared/domain"

export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "Saha rezerve et",
  description: "Bir saat seç ve ayır.",
}

/** How many days ahead the picker offers. */
const DAYS_AHEAD = 7

interface PageProps {
  params: { slug: string; pitchId: string }
  searchParams?: { date?: string }
}

export default async function PitchPage({ params, searchParams }: PageProps) {
  const session = await getSessionUser()
  if (!session) return null // the (app) layout has already redirected

  const supabase = await createClient()

  const [{ data: venue, error: venueError }, { data: pitch, error: pitchError }] = await Promise.all([
    supabase
      .from("venues")
      .select("id, name, slug, city, district, timezone, is_active, charges_enabled")
      .eq("slug", params.slug)
      .maybeSingle(),
    supabase
      .from("pitches")
      .select(
        "id, venue_id, name, format, surface, is_indoor, capacity, hourly_rate_minor, currency, slot_minutes, opening_time, closing_time, is_active",
      )
      .eq("id", params.pitchId)
      .maybeSingle(),
  ])

  if (venueError || pitchError) {
    console.error("[venues/pitch] lookup failed", {
      venue: venueError?.code,
      pitch: pitchError?.code,
    })
    return (
      <Alert variant="destructive">
        <AlertTitle>Bu saha yüklenemedi</AlertTitle>
        <AlertDescription>Sayfayı yenile ya da birazdan tekrar dene.</AlertDescription>
      </Alert>
    )
  }

  // A pitch reached through the wrong venue's slug is a 404, not a redirect: the URL is wrong,
  // and quietly rendering it under the wrong venue would put the wrong timezone on every label.
  if (!venue || !pitch || pitch.venue_id !== venue.id) notFound()

  const payable = venue.is_active && venue.charges_enabled
  const currency = (pitch.currency || DEFAULT_CURRENCY).toLowerCase()

  const startKey =
    searchParams?.date && isDateKey(searchParams.date)
      ? searchParams.date
      : todayKey(venue.timezone)
  const dates = dateKeysFrom(startKey, DAYS_AHEAD)

  /* ---- teams this user could book for -------------------------------- */
  const { data: membershipRows } = await supabase
    .from("team_members")
    .select("team_id, teams(id, name)")
    .eq("player_id", session.user.id)
    .is("left_at", null)
    .returns<Array<{ team_id: string; teams: { id: string; name: string } | null }>>()

  const teams: SlotPickerTeam[] = []
  for (const row of membershipRows ?? []) {
    if (row.teams) teams.push({ id: row.teams.id, name: row.teams.name })
  }

  const lateRefundPercent = LATE_CANCELLATION_REFUND_BPS / 100

  return (
    <div className="space-y-6">
      <nav aria-label="Sayfa yolu" className="text-sm">
        <Link
          href={`/venues/${encodeURIComponent(venue.slug)}`}
          className="text-muted-foreground underline-offset-4 hover:underline"
        >
          ← {venue.name}
        </Link>
      </nav>

      <header className="space-y-3">
        <h1 className="text-2xl font-semibold tracking-tight">{pitch.name}</h1>
        <p className="text-sm text-muted-foreground">
          {[venue.name, venue.district, venue.city].filter(Boolean).join(" · ")}
        </p>
        <ul className="flex flex-wrap gap-1.5" aria-label="Saha ayrıntıları">
          <li>
            <Badge variant="secondary">{PITCH_FORMAT_LABELS[pitch.format]}</Badge>
          </li>
          <li>
            <Badge variant="outline">{PITCH_SURFACE_LABELS[pitch.surface]}</Badge>
          </li>
          <li>
            <Badge variant="outline">{pitch.is_indoor ? "Indoor" : "Outdoor"}</Badge>
          </li>
          {pitch.capacity !== null && (
            <li>
              <Badge variant="outline">{pitch.capacity} players</Badge>
            </li>
          )}
          <li>
            <Badge variant="outline">{slotLengthLabel(pitch.slot_minutes)}</Badge>
          </li>
        </ul>
        <p className="text-sm">
          <span className="font-semibold">{formatMinor(pitch.hourly_rate_minor, currency)}</span>
          <span className="text-muted-foreground"> per hour · open </span>
          <span className="tabular-nums">
            {shortTime(pitch.opening_time)}–{shortTime(pitch.closing_time)}
          </span>
          <span className="text-muted-foreground">, {venue.timezone.replace(/_/g, " ")} time</span>
        </p>
      </header>

      {!pitch.is_active && (
        <Alert role="status">
          <AlertTitle>Bu saha satışta değil</AlertTitle>
          <AlertDescription>
            İşletme sahayı takvimden çıkarmış. Buradaki başka bir sahayı dene ya da yeniden ara.
          </AlertDescription>
        </Alert>
      )}

      {!payable && (
        <Alert role="status">
          <AlertTitle>Henüz rezervasyon almıyor</AlertTitle>
          <AlertDescription>
            Bu işletme hakediş kurulumunu tamamlamamış; burada henüz rezervasyon yapılamıyor.
          </AlertDescription>
        </Alert>
      )}

      <SlotPicker
        pitchId={pitch.id}
        pitchName={pitch.name}
        timezone={venue.timezone}
        dates={dates}
        initialDate={startKey}
        teams={teams}
      />

      <section aria-labelledby="policy-heading" className="rounded-lg border bg-muted/40 p-4 text-sm">
        <h2 id="policy-heading" className="font-medium">
          Rezervasyondan önce
        </h2>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
          <li>
            Gördüğün fiyat, ödeyeceğin fiyattır. Platform komisyonu senin ödemenin üstüne eklenmez, işletmenin payından düşer.
          </li>
          <li>
            Cancel more than {CANCELLATION_WINDOW_HOURS} hours before kickoff for a full refund.
            Inside that window {lateRefundPercent}% comes back.
          </li>
          <li>
            Ödeme yaparken saat tutulur; ödeme tamamlanmazsa kendiliğinden serbest bırakılır.
          </li>
        </ul>
      </section>
    </div>
  )
}
