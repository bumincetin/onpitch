/**
 * app/(app)/checkout/[bookingId]/page.tsx
 *
 * Pay for a held slot.
 *
 * ---------------------------------------------------------------------------
 * WHY THE CLIENT SECRET IS FETCHED HERE RATHER THAN CARRIED FROM THE PICKER
 * ---------------------------------------------------------------------------
 * `POST /api/bookings/checkout` returns a client secret once. Passing it through client state
 * would work exactly until the customer refreshes, opens the link on their phone, or comes back
 * from a 3-D Secure redirect — and then the page would have a booking it cannot pay for. So this
 * page re-reads the PaymentIntent server-side from `bookings.stripe_payment_intent_id`. The
 * booking row is fetched with the caller's own client, so `bookings_select_stakeholders` decides
 * whether it exists at all, and only the person who made the booking is allowed to pay for it.
 *
 * The idempotency key on `paymentIntents.create` (`booking_pi_<id>`) means there is exactly ONE
 * intent per booking, forever. Retrieving it is therefore always the same intent the picker
 * created, never a second charge.
 *
 * ---------------------------------------------------------------------------
 * EVERY WAY THIS CAN GO WRONG, AND WHAT THE CUSTOMER SEES
 * ---------------------------------------------------------------------------
 *   already paid            -> straight to the booking, no second charge offered
 *   cancelled / refunded    -> "this reservation is gone", with a way back to the pitch
 *   hold lapsed             -> same, plus the reassurance that nothing was charged
 *   intent cancelled        -> same; the sweeper cancels the intent before it frees the slot
 *   no intent on the row    -> an honest error and a route back, never a blank Stripe form
 *   Stripe unreachable      -> an honest error; the slot is still held until the TTL runs out
 */

import type { Metadata } from "next"
import Link from "next/link"
import { notFound, redirect } from "next/navigation"

import { BookingSummary } from "@/components/booking/booking-summary"
import { PaymentForm } from "@/components/booking/payment-form"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { reservationExpiresAt, reservationTtlMinutes } from "@/lib/booking/availability"
import { parseTstzRange } from "@/lib/payments"
import { getSessionUser } from "@/lib/rbac"
import { describeStripeError, stripe } from "@/lib/stripe"
import { createClient } from "@/lib/supabase/server"
import { DEFAULT_CURRENCY } from "@halisaha/shared/domain"

export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "Ödeme",
  description: "Saha rezervasyonunu onayla ve öde.",
}

export default async function CheckoutPage({ params }: { params: { bookingId: string } }) {
  const session = await getSessionUser()
  if (!session) return null // the (app) layout has already redirected

  const supabase = await createClient()

  const { data: booking, error } = await supabase
    .from("bookings")
    .select(
      "id, pitch_id, booked_by, status, payment_status, time_range, subtotal_minor, platform_fee_minor, total_minor, currency, refunded_amount_minor, cancellation_reason, stripe_payment_intent_id, created_at",
    )
    .eq("id", params.bookingId)
    .maybeSingle()

  if (error) {
    console.error("[checkout] booking lookup failed", { code: error.code })
    return (
      <Alert variant="destructive">
        <AlertTitle>Bu rezervasyon yüklenemedi</AlertTitle>
        <AlertDescription>Sayfayı yenile ya da Rezervasyonlarım üzerinden tekrar aç.</AlertDescription>
      </Alert>
    )
  }
  if (!booking) notFound()

  // A venue owner or a team-mate may be able to SEE this booking, but paying is the booker's job:
  // the receipt, the refund and the dispute all attach to them.
  if (booking.booked_by !== session.user.id) {
    redirect(`/bookings/${booking.id}`)
  }

  if (booking.payment_status === "succeeded" || booking.status === "confirmed") {
    redirect(`/bookings/${booking.id}?payment=complete`)
  }

  /* ---- context for the receipt ---------------------------------------- */
  const { data: pitch } = await supabase
    .from("pitches")
    .select("id, name, venue_id")
    .eq("id", booking.pitch_id)
    .maybeSingle()

  const venueResult = pitch
    ? await supabase
        .from("venues")
        .select("id, name, slug, timezone")
        .eq("id", pitch.venue_id)
        .maybeSingle()
    : null
  const venue = venueResult?.data ?? null

  const timezone = venue?.timezone ?? "Europe/Istanbul"
  const currency = (booking.currency || DEFAULT_CURRENCY).toLowerCase()
  const pitchHref = venue && pitch ? `/venues/${encodeURIComponent(venue.slug)}/${pitch.id}` : "/venues"

  let range: { startsAt: Date; endsAt: Date }
  try {
    range = parseTstzRange(booking.time_range)
  } catch {
    console.error("[checkout] unreadable time range", { bookingId: booking.id })
    return (
      <Alert variant="destructive">
        <AlertTitle>Bu rezervasyon okunamıyor</AlertTitle>
        <AlertDescription>
          Kayıtlı saat aralığında bir sorun var. Kartından çekim yapılmadı — lütfen saati yeniden seç.
        </AlertDescription>
      </Alert>
    )
  }

  const summaryBooking = {
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
  }

  /* ---- terminal states ------------------------------------------------ */
  if (booking.status === "cancelled" || booking.status === "refunded") {
    return (
      <DeadReservation
        title="Bu rezervasyon artık tutulmuyor"
        body={
          booking.cancellation_reason ??
          "It was cancelled, so the slot has gone back on sale. Nothing was charged."
        }
        pitchHref={pitchHref}
      />
    )
  }

  const expiresAt = reservationExpiresAt(booking.created_at)
  if (expiresAt && expiresAt.getTime() <= Date.now()) {
    return (
      <DeadReservation
        title="Bu saatin tutma süresi doldu"
        body={`An unpaid reservation is released after ${reservationTtlMinutes()} minutes so the pitch does not sit idle. Nothing was charged — pick the time again and it is yours if it is still free.`}
        pitchHref={pitchHref}
      />
    )
  }

  /* ---- the PaymentIntent ---------------------------------------------- */
  const publishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
  if (!publishableKey) {
    console.error("[checkout] NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY is not set")
    return (
      <PaymentUnavailable
        body="Bu kurulumda ödeme yapılandırılmamış; bu rezervasyonun ödemesi henüz alınamıyor."
        pitchHref={pitchHref}
      />
    )
  }

  if (!booking.stripe_payment_intent_id) {
    return (
      <PaymentUnavailable
        body="Bu rezervasyon için ödeme başlatılamadı. Kartından hiçbir şey çekilmedi. Saati yeniden seç, senin için tutulur."
        pitchHref={pitchHref}
      />
    )
  }

  let clientSecret: string | null = null
  let intentStatus: string | null = null
  try {
    const intent = await stripe.paymentIntents.retrieve(booking.stripe_payment_intent_id)
    clientSecret = intent.client_secret
    intentStatus = intent.status
  } catch (unknownError) {
    console.error("[checkout] paymentIntents.retrieve failed", describeStripeError(unknownError))
    return (
      <PaymentUnavailable
        body="Ödeme sağlayıcısına ulaşamadık. Saatin hâlâ tutuluyor — birazdan tekrar dene."
        pitchHref={pitchHref}
      />
    )
  }

  if (intentStatus === "succeeded" || intentStatus === "processing") {
    // The webhook has not landed yet, but the money has. Send them to the booking, which is where
    // the confirmation is reconciled.
    redirect(`/bookings/${booking.id}?payment=${intentStatus === "succeeded" ? "complete" : "processing"}`)
  }

  if (intentStatus === "canceled" || !clientSecret) {
    return (
      <DeadReservation
        title="Bu ödeme artık tamamlanamaz"
        body="Ödeme tamamlanmadan iptal edildi, bu yüzden saat serbest bırakıldı. Hiçbir şey çekilmedi."
        pitchHref={pitchHref}
      />
    )
  }

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Onayla ve öde</h1>
        <p className="text-sm text-muted-foreground">
          İşlemi bitirene kadar saat sana ayrılmış durumda. Buradan ücretsiz iptal edebilirsin.
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Ödeme bilgileri</CardTitle>
            <CardDescription>
              Ödeme Stripe üzerinden alınır. Kart bilgilerin Halısaha&apos;ya hiç ulaşmaz.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <PaymentForm
              bookingId={booking.id}
              clientSecret={clientSecret}
              publishableKey={publishableKey}
              amountMinor={booking.total_minor}
              currency={currency}
              returnPath={`/bookings/${booking.id}?payment=complete`}
            />
          </CardContent>
        </Card>

        <BookingSummary
          booking={summaryBooking}
          venueName={venue?.name ?? "This venue"}
          pitchName={pitch?.name ?? "Pitch"}
          timezone={timezone}
          holdExpiresAt={expiresAt ? expiresAt.toISOString() : null}
          canCancel
        />
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */

function DeadReservation({
  title,
  body,
  pitchHref,
}: {
  title: string
  body: string
  pitchHref: string
}) {
  return (
    <Card className="mx-auto max-w-xl">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{body}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        <Button asChild>
          <Link href={pitchHref}>Başka bir saat seç</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/bookings">Rezervasyonlarım</Link>
        </Button>
      </CardContent>
    </Card>
  )
}

function PaymentUnavailable({ body, pitchHref }: { body: string; pitchHref: string }) {
  return (
    <Card className="mx-auto max-w-xl">
      <CardHeader>
        <CardTitle>Ödeme başlatılamıyor</CardTitle>
        <CardDescription>{body}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        <Button asChild>
          <Link href={pitchHref}>Sahaya dön</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/bookings">Rezervasyonlarım</Link>
        </Button>
      </CardContent>
    </Card>
  )
}
