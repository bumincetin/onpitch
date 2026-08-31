/**
 * app/(app)/venues/[slug]/page.tsx
 *
 * One venue: where it is, what it has, and which pitches it sells.
 *
 * The venue and its pitches are read through the cookie-bound client, so an unpublished venue is
 * invisible to everyone except its owner and an admin — `venues_select_active_or_own` decides
 * that, not this file. A missing row and a hidden row therefore look identical here, and both
 * answer 404. That is deliberate: a distinct "you may not see this" response would confirm the
 * slug belongs to something real.
 *
 * A venue whose Stripe onboarding is unfinished is shown, but its pitches are not linkable —
 * `POST /api/bookings/checkout` refuses a venue that cannot accept a charge, and sending someone
 * into a slot picker that can only end in `VENUE_NOT_PAYABLE` wastes their time.
 */

import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"

import { PitchCard, type PitchCardPitch } from "@/components/booking/pitch-card"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { getSessionUser } from "@/lib/rbac"
import { createClient } from "@/lib/supabase/server"
import { DEFAULT_CURRENCY } from "@halisaha/shared/domain"

export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "İşletme",
  description: "Bu işletmenin sahaları, çalışma saatleri ve fiyatları.",
}

const NOT_PAYABLE_REASON =
  "This venue has not finished its payout setup, so bookings are not open yet."

export default async function VenuePage({ params }: { params: { slug: string } }) {
  const session = await getSessionUser()
  if (!session) return null // the (app) layout has already redirected

  const supabase = await createClient()

  const { data: venue, error } = await supabase
    .from("venues")
    .select(
      "id, name, slug, description, address_line1, address_line2, city, district, postal_code, latitude, longitude, amenities, phone, timezone, is_active, charges_enabled",
    )
    .eq("slug", params.slug)
    .maybeSingle()

  if (error) {
    console.error("[venues/slug] venue lookup failed", { code: error.code })
    return (
      <Alert variant="destructive">
        <AlertTitle>Bu işletme yüklenemedi</AlertTitle>
        <AlertDescription>Sayfayı yenile ya da birazdan tekrar dene.</AlertDescription>
      </Alert>
    )
  }
  if (!venue) notFound()

  const { data: pitchRows, error: pitchError } = await supabase
    .from("pitches")
    .select(
      "id, name, format, surface, is_indoor, capacity, hourly_rate_minor, currency, slot_minutes, opening_time, closing_time, is_active",
    )
    .eq("venue_id", venue.id)
    .eq("is_active", true)
    .order("name", { ascending: true })

  if (pitchError) {
    console.error("[venues/slug] pitch list failed", { code: pitchError.code })
  }

  const pitches: PitchCardPitch[] = (pitchRows ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    format: row.format,
    surface: row.surface,
    isIndoor: row.is_indoor,
    capacity: row.capacity,
    hourlyRateMinor: row.hourly_rate_minor,
    currency: (row.currency || DEFAULT_CURRENCY).toLowerCase(),
    slotMinutes: row.slot_minutes,
    openingTime: row.opening_time,
    closingTime: row.closing_time,
  }))

  const payable = venue.is_active && venue.charges_enabled
  const address = [venue.address_line1, venue.address_line2, venue.district, venue.city, venue.postal_code]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join(", ")

  const mapsHref =
    venue.latitude !== null && venue.longitude !== null
      ? `https://www.google.com/maps/search/?api=1&query=${venue.latitude},${venue.longitude}`
      : null

  return (
    <div className="space-y-6">
      <nav aria-label="Sayfa yolu" className="text-sm">
        <Link href="/venues" className="text-muted-foreground underline-offset-4 hover:underline">
          ← All venues
        </Link>
      </nav>

      <header className="space-y-3">
        <h1 className="text-2xl font-semibold tracking-tight">{venue.name}</h1>
        {address && <p className="text-sm text-muted-foreground">{address}</p>}
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {mapsHref && (
            <Button asChild variant="outline" size="sm">
              <a href={mapsHref} target="_blank" rel="noreferrer noopener">
                Haritada aç
              </a>
            </Button>
          )}
          {venue.phone && (
            <Button asChild variant="ghost" size="sm">
              <a href={`tel:${venue.phone.replace(/[^\d+]/g, "")}`}>{venue.phone}</a>
            </Button>
          )}
        </div>
        {venue.description && <p className="max-w-2xl text-sm">{venue.description}</p>}
        {venue.amenities.length > 0 && (
          <ul className="flex flex-wrap gap-1.5" aria-label="Olanaklar">
            {venue.amenities.map((amenity) => (
              <li key={amenity}>
                <Badge variant="outline">{amenity}</Badge>
              </li>
            ))}
          </ul>
        )}
      </header>

      {!payable && (
        <Alert role="status">
          <AlertTitle>Henüz rezervasyon almıyor</AlertTitle>
          <AlertDescription>{NOT_PAYABLE_REASON}</AlertDescription>
        </Alert>
      )}

      <section aria-labelledby="pitches-heading" className="space-y-3">
        <div className="flex items-baseline justify-between gap-3">
          <h2 id="pitches-heading" className="text-lg font-semibold tracking-tight">
            Sahalar
          </h2>
          <p className="text-xs text-muted-foreground">
            Times shown in {venue.timezone.replace(/_/g, " ")}
          </p>
        </div>

        {pitches.length === 0 ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Kayıtlı saha yok</CardTitle>
              <CardDescription>
                Bu işletme henüz rezerve edilebilir bir saha yayınlamamış. Yakındaki başka bir işletmeyi dene.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button asChild variant="outline">
                <Link href="/venues">Aramaya dön</Link>
              </Button>
            </CardContent>
          </Card>
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2">
            {pitches.map((pitch) => (
              <li key={pitch.id} className="h-full">
                <PitchCard
                  pitch={pitch}
                  venueSlug={venue.slug}
                  timezone={venue.timezone}
                  unavailableReason={payable ? null : NOT_PAYABLE_REASON}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
