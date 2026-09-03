/**
 * app/(app)/bookings/[id]/page.tsx
 *
 * One booking: the receipt, where and when, and the two actions that still apply.
 *
 * ---------------------------------------------------------------------------
 * WHO SEES WHAT
 * ---------------------------------------------------------------------------
 * The row is read with the caller's own client, so `bookings_select_stakeholders` decides
 * visibility: the booker, their team-mates on a team booking, and the owner of the pitch. What
 * each of them may DO differs, and that is decided here rather than in the component:
 *
 *   pay      — only the person who booked it. The card, the receipt and any dispute are theirs.
 *   cancel   — the booker or the venue owner, and only from a live status. The route re-checks
 *              both, so this is UI honesty and not the enforcement.
 *
 * ---------------------------------------------------------------------------
 * COMING BACK FROM STRIPE
 * ---------------------------------------------------------------------------
 * `?payment=complete` means the browser saw a successful confirmation; it does NOT mean the
 * booking is confirmed. `payment_intent.succeeded` does that, asynchronously, in
 * `app/api/stripe/webhook`. Until the row catches up the page says "confirming" and refreshes
 * itself a few times. The alternative — trusting the query parameter and drawing a confirmed
 * booking — would be a lie that a refresh exposes.
 */

import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"

import { BookingSummary, type RefundPreview } from "@/components/booking/booking-summary"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { reservationExpiresAt } from "@/lib/booking/availability"
import {
  CANCELLATION_WINDOW_HOURS,
  LATE_CANCELLATION_REFUND_BPS,
  parseTstzRange,
  resolveCancellationPolicy,
} from "@/lib/payments"
import { getSessionUser } from "@/lib/rbac"
import { createClient } from "@/lib/supabase/server"
import type { Enums } from "@onpitch/shared/database"
import { DEFAULT_CURRENCY } from "@onpitch/shared/domain"

export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "Rezervasyon",
  description: "Rezervasyonun, makbuzu ve iptal seçenekleri.",
}

/** Statuses `POST /api/bookings/[id]/cancel` still accepts. Mirrors that route's own list. */
const CANCELLABLE: readonly Enums<"booking_status">[] = ["pending", "awaiting_payment", "confirmed"]

interface PageProps {
  params: { id: string }
  searchParams?: { payment?: string }
}

export default async function BookingDetailPage({ params, searchParams }: PageProps) {
  const session = await getSessionUser()
  if (!session) return null // the (app) layout has already redirected

  const supabase = await createClient()

  const { data: booking, error } = await supabase
    .from("bookings")
    .select(
      "id, pitch_id, booked_by, team_id, status, payment_status, time_range, subtotal_minor, platform_fee_minor, total_minor, refunded_amount_minor, currency, notes, cancellation_reason, created_at",
    )
    .eq("id", params.id)
    .maybeSingle()

  if (error) {
    console.error("[bookings/detail] lookup failed", { code: error.code })
    return (
      <Alert variant="destructive">
        <AlertTitle>Bu rezervasyon yüklenemedi</AlertTitle>
        <AlertDescription>Sayfayı yenile ya da birazdan tekrar dene.</AlertDescription>
      </Alert>
    )
  }
  if (!booking) notFound()

  /* ---- context -------------------------------------------------------- */
  const { data: pitch } = await supabase
    .from("pitches")
    .select("id, name, venue_id")
    .eq("id", booking.pitch_id)
    .maybeSingle()

  const venueResult = pitch
    ? await supabase
        .from("venues")
        .select("id, name, slug, owner_id, timezone, address_line1, city, district, phone")
        .eq("id", pitch.venue_id)
        .maybeSingle()
    : null
  const venue = venueResult?.data ?? null

  const { data: match } = await supabase
    .from("matches")
    .select("id")
    .eq("booking_id", booking.id)
    .maybeSingle()

  let range: { startsAt: Date; endsAt: Date }
  try {
    range = parseTstzRange(booking.time_range)
  } catch {
    console.error("[bookings/detail] unreadable time range", { bookingId: booking.id })
    return (
      <Alert variant="destructive">
        <AlertTitle>Bu rezervasyon okunamıyor</AlertTitle>
        <AlertDescription>
          Kayıtlı saat aralığı bozuk. İşletmeyle ya da bizimle iletişime geç, düzeltelim.
        </AlertDescription>
      </Alert>
    )
  }

  /* ---- what this viewer may do ---------------------------------------- */
  const isBooker = booking.booked_by === session.user.id
  const isVenueOwner = venue?.owner_id === session.user.id
  const isAdmin = session.profile.role === "admin"
  const cancellable = CANCELLABLE.includes(booking.status)
  const canCancel = cancellable && (isBooker || isVenueOwner || isAdmin)

  const unpaid = booking.status === "pending" || booking.status === "awaiting_payment"
  const holdExpiresAt = unpaid ? reservationExpiresAt(booking.created_at) : null
  const holdLapsed = holdExpiresAt !== null && holdExpiresAt.getTime() <= Date.now()

  // Only a paid booking has money to give back, so an unpaid one shows the plain "the slot goes
  // back on sale" copy instead of a refund of zero.
  const paid =
    booking.payment_status === "succeeded" || booking.payment_status === "partially_refunded"
  const refundPreview: RefundPreview | null = paid
    ? toRefundPreview(booking.total_minor, booking.refunded_amount_minor, range.startsAt)
    : null

  const paymentParam = searchParams?.payment
  const awaitingConfirmation =
    (paymentParam === "complete" || paymentParam === "processing") &&
    booking.payment_status !== "succeeded" &&
    booking.status !== "confirmed"

  const currency = (booking.currency || DEFAULT_CURRENCY).toLowerCase()
  const timezone = venue?.timezone ?? "Europe/Istanbul"
  const address = [venue?.address_line1, venue?.district, venue?.city]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join(", ")

  return (
    <div className="space-y-6">
      <nav aria-label="Sayfa yolu" className="text-sm">
        <Link href="/bookings" className="text-muted-foreground underline-offset-4 hover:underline">
          ← Rezervasyonlarım
        </Link>
      </nav>

      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Rezervasyonun</h1>
        <p className="text-sm text-muted-foreground">
          Reference {booking.id.slice(0, 8).toUpperCase()}
        </p>
      </header>

      {paymentParam === "complete" && !awaitingConfirmation && booking.status === "confirmed" && (
        <Alert role="status">
          <AlertTitle>Ödendi ve onaylandı</AlertTitle>
          <AlertDescription>
            Saha senin. Makbuz hesabındaki e-posta adresine gönderildi.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <BookingSummary
          booking={{
            id: booking.id,
            status: booking.status,
            paymentStatus: booking.payment_status,
            startsAt: range.startsAt.toISOString(),
            endsAt: range.endsAt.toISOString(),
            subtotalMinor: booking.subtotal_minor,
            platformFeeMinor: booking.platform_fee_minor,
            totalMinor: booking.total_minor,
            refundedAmountMinor: booking.refunded_amount_minor,
            currency,
            cancellationReason: booking.cancellation_reason,
          }}
          venueName={venue?.name ?? "This venue"}
          pitchName={pitch?.name ?? "Pitch"}
          timezone={timezone}
          holdExpiresAt={holdExpiresAt ? holdExpiresAt.toISOString() : null}
          refundPreview={refundPreview}
          payHref={isBooker && unpaid && !holdLapsed ? `/checkout/${booking.id}` : null}
          canCancel={canCancel}
          awaitingConfirmation={awaitingConfirmation}
        />

        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Nerede</CardTitle>
              <CardDescription>{venue?.name ?? "Venue"}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {address && <p>{address}</p>}
              {venue?.phone && (
                <p>
                  <a
                    className="underline underline-offset-4"
                    href={`tel:${venue.phone.replace(/[^\d+]/g, "")}`}
                  >
                    {venue.phone}
                  </a>
                </p>
              )}
              <p className="text-muted-foreground">
                All times are {timezone.replace(/_/g, " ")} local time.
              </p>
              {venue && (
                <Button asChild variant="outline" size="sm">
                  <Link href={`/venues/${encodeURIComponent(venue.slug)}`}>İşletmeyi gör</Link>
                </Button>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Maç</CardTitle>
              <CardDescription>
                {match
                  ? "This booking has a fixture attached."
                  : "No fixture is attached to this booking yet."}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {match ? (
                <Button asChild variant="outline" size="sm">
                  <Link href={`/matches/${match.id}`}>Maçı aç</Link>
                </Button>
              ) : (
                <p className="text-muted-foreground">
                  Kimin oynayacağını bildiğinde maçlar ekranından oluştur — reytingler yalnızca maçta değişir, rezervasyonda değil.
                </p>
              )}
            </CardContent>
          </Card>

          {booking.notes && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">İşletmeye notun</CardTitle>
              </CardHeader>
              <CardContent className="text-sm">{booking.notes}</CardContent>
            </Card>
          )}

          <p className="text-xs text-muted-foreground">
            Cancel more than {CANCELLATION_WINDOW_HOURS} hours before kickoff for a full refund;
            inside that window {LATE_CANCELLATION_REFUND_BPS / 100}% of the price comes back.
            Refunds go to the card that paid and usually take a few working days to appear.
          </p>
        </div>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */

/**
 * What cancelling right now would be worth.
 *
 * Computed with the SAME `resolveCancellationPolicy()` the cancel route uses, so the number on
 * screen is the number that would actually be refunded — as of this render. It is a preview: the
 * route recomputes at the moment of cancellation, and waiting past the window changes it.
 */
function toRefundPreview(
  totalMinor: number,
  alreadyRefundedMinor: number,
  kickoffAt: Date,
): RefundPreview {
  const policy = resolveCancellationPolicy({
    kickoffAt,
    totalMinor,
    alreadyRefundedMinor,
  })
  return {
    refundMinor: policy.refundMinor,
    fullRefund: policy.fullRefund,
    windowHours: policy.windowHours,
    lateRefundBps: LATE_CANCELLATION_REFUND_BPS,
    reasonCode: policy.reasonCode,
  }
}
