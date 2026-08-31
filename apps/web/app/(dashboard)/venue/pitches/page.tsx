/**
 * app/(dashboard)/venue/pitches/page.tsx — the pitch catalogue.
 *
 * A pitch is where price, opening hours and slot length live, so this page is effectively the
 * venue's product configuration: change `hourly_rate_minor` here and every future quote, the
 * calendar's per-slot price and the occupancy denominator all move together.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS NO DELETE BUTTON
 * ---------------------------------------------------------------------------
 * `bookings.pitch_id` is `ON DELETE RESTRICT`: a pitch that has ever been booked cannot be
 * removed without destroying the financial record attached to it, and Postgres will refuse. The
 * honest control is therefore the `is_active` switch inside the edit dialog — it hides the pitch
 * from players, keeps its history intact, and is reversible. Offering a delete that fails for
 * every pitch anyone has actually used would be a worse experience than not offering it.
 *
 * Reads use the cookie-bound client; RLS (`pitches_select_visible`) is the boundary and the
 * `.eq('venue_id', …)` filter is an index hint. Writes go through `/api/pitches`, where the
 * column-level grants in 0002_rls.sql make `venue_id` physically unmovable on an UPDATE.
 */

import Link from "next/link"

import { PitchForm } from "@/components/venue/pitch-form"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { requireRole } from "@/lib/rbac"
import { createClient } from "@/lib/supabase/server"
import { resolveDashboardVenue } from "@/lib/venue/metrics"
import type { Enums, Tables } from "@halisaha/shared/database"
import { formatMinor } from "@halisaha/shared/domain"

export const dynamic = "force-dynamic"

const PRIMARY_LINK =
  "inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium " +
  "text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none " +
  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"

const FORMAT_LABELS: Readonly<Record<Enums<"match_format">, string>> = {
  five_a_side: "5 kişilik",
  six_a_side: "6 kişilik",
  seven_a_side: "7 kişilik",
  eight_a_side: "8 kişilik",
  eleven_a_side: "11 kişilik",
}

const SURFACE_LABELS: Readonly<Record<Enums<"pitch_surface">, string>> = {
  natural_grass: "Natural grass",
  artificial_turf: "Artificial turf",
  hybrid: "Hybrid",
  indoor_court: "Indoor court",
}

interface PageProps {
  searchParams: { venue?: string }
}

export default async function VenueSahalarPage({ searchParams }: PageProps) {
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
            Saha bir işletmeye bağlıdır, önce işletmeyi oluştur — yaklaşık bir dakika sürer.
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

  const { data, error } = await supabase
    .from("pitches")
    .select("*")
    .eq("venue_id", venue.id)
    .order("is_active", { ascending: false })
    .order("name", { ascending: true })

  if (error) {
    console.error("[venue/pitches] list failed", { code: error.code })
    return (
      <Alert variant="destructive">
        <AlertTitle>Sahaların yüklenemedi</AlertTitle>
        <AlertDescription>Sayfayı yenile ya da birazdan tekrar dene.</AlertDescription>
      </Alert>
    )
  }

  const pitches = (data ?? []) as Tables<"pitches">[]
  const activeCount = pitches.filter((pitch) => pitch.is_active).length

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Sahalar</h2>
          <p className="text-sm text-muted-foreground">
            {pitches.length === 0
              ? "No pitches yet."
              : `${activeCount} of ${pitches.length} bookable · hours are wall-clock in ${venue.timezone}.`}
          </p>
        </div>
        <PitchForm venueId={venue.id} />
      </div>

      {pitches.length === 0 ? (
        <EmptySahalar venueId={venue.id} />
      ) : (
        <>
          {activeCount === 0 ? (
            <Alert>
              <AlertTitle>Hiçbir sahan rezerve edilebilir değil</AlertTitle>
              <AlertDescription>
                Bütün sahalar kapalı, oyuncular rezerve edecek bir şey görmüyor. Birini açıp &ldquo;Rezerve edilebilir&rdquo; seçeneğini geri aç.
              </AlertDescription>
            </Alert>
          ) : null}

          <div className="w-full overflow-x-auto rounded-md border border-border">
            <Table>
              <TableCaption className="sr-only">
                Every pitch at {venue.name}, with its format, surface, price and opening hours
              </TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Saha</TableHead>
                  <TableHead scope="col">Format</TableHead>
                  <TableHead scope="col">Saatler</TableHead>
                  <TableHead scope="col" className="text-right">
                    Saat başı
                  </TableHead>
                  <TableHead scope="col" className="text-right">
                    Saat dilimi başı
                  </TableHead>
                  <TableHead scope="col">Durum</TableHead>
                  <TableHead scope="col">
                    <span className="sr-only">İşlemler</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pitches.map((pitch) => (
                  <TableRow key={pitch.id}>
                    <TableCell className="align-top">
                      <div className="font-medium">{pitch.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {SURFACE_LABELS[pitch.surface]}
                        {pitch.is_indoor ? " · indoor" : ""}
                        {pitch.capacity ? ` · up to ${pitch.capacity} players` : ""}
                      </div>
                    </TableCell>

                    <TableCell className="align-top">{FORMAT_LABELS[pitch.format]}</TableCell>

                    <TableCell className="whitespace-nowrap align-top tabular-nums">
                      {trimSeconds(pitch.opening_time)}–{trimSeconds(pitch.closing_time)}
                      <div className="text-xs text-muted-foreground">
                        {pitch.slot_minutes} min slots
                      </div>
                    </TableCell>

                    <TableCell className="whitespace-nowrap text-right align-top tabular-nums">
                      {formatMinor(pitch.hourly_rate_minor, pitch.currency)}
                    </TableCell>

                    <TableCell className="whitespace-nowrap text-right align-top tabular-nums">
                      {formatMinor(
                        slotPriceMinor(pitch.hourly_rate_minor, pitch.slot_minutes),
                        pitch.currency,
                      )}
                    </TableCell>

                    <TableCell className="align-top">
                      {pitch.is_active ? (
                        <Badge className="gap-1.5">
                          <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                          Rezerve edilebilir
                        </Badge>
                      ) : (
                        <Badge variant="secondary" className="gap-1.5">
                          <span
                            aria-hidden="true"
                            className="h-1.5 w-1.5 rounded-full bg-muted-foreground"
                          />
                          Gizli
                        </Badge>
                      )}
                    </TableCell>

                    <TableCell className="align-top text-right">
                      <PitchForm venueId={venue.id} pitch={pitch} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <p className="text-xs text-muted-foreground">
            Sahalar asla silinmez — rezervasyonlar onlara bağlıdır ve o geçmişin kalması gerekir. Satıştan kaldırmak için sahayı &ldquo;Gizli&rdquo; yap.
          </p>
        </>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Pieces                                                                    */
/* -------------------------------------------------------------------------- */

function EmptySahalar({ venueId }: { venueId: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-md border border-dashed border-border px-6 py-16 text-center">
      <svg
        viewBox="0 0 24 24"
        className="h-9 w-9 text-muted-foreground"
        aria-hidden="true"
        focusable="false"
      >
        <rect x="2.5" y="5" width="19" height="14" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M12 5v14" stroke="currentColor" strokeWidth="1.5" />
        <circle cx="12" cy="12" r="2.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      </svg>
      <div>
        <p className="text-sm font-medium">İlk sahanı ekle</p>
        <p className="mt-1 max-w-md text-xs text-muted-foreground">
          Saha; fiyatı, çalışma saatlerini ve saat dilimi uzunluğunu taşır. Geri kalan her şey — takvim, müsaitlik, doluluk — bundan türetilir.
        </p>
      </div>
      <PitchForm venueId={venueId} />
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Price of one slot. Mirrors `slotPriceMinor` in `lib/payments.ts`; that module is not imported
 * because it pulls in the server-only Stripe client and this page is already a Server Component
 * whose output must stay cheap. Identical integer arithmetic, so the number shown here is the
 * number checkout charges.
 */
function slotPriceMinor(hourlyRateMinor: number, slotMinutes: number): number {
  if (slotMinutes <= 0) return 0
  return Math.floor((hourlyRateMinor * slotMinutes + 30) / 60)
}

/** `"08:00:00"` → `"08:00"`. */
function trimSeconds(value: string): string {
  return value.length >= 5 ? value.slice(0, 5) : value
}
