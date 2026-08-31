"use client"

/**
 * components/booking/booking-summary.tsx
 *
 * The receipt panel: what this booking costs, where it stands, and the two things a customer can
 * do about it — pay for it, or cancel it.
 *
 * ---------------------------------------------------------------------------
 * HOW THE MONEY IS PRESENTED
 * ---------------------------------------------------------------------------
 * The platform fee comes OUT of the venue's cut, so `total_minor == subtotal_minor` and the
 * customer pays exactly the advertised price (see the fee model at the top of `lib/payments.ts`).
 * The fee is therefore shown as an inclusive line, not as an addition — printing it as a separate
 * charge would imply money that is never taken. Every figure is an integer count of minor units
 * straight off the `bookings` row and goes through `formatMinor()`; nothing here divides.
 *
 * ---------------------------------------------------------------------------
 * THE COUNTDOWN
 * ---------------------------------------------------------------------------
 * A booking exists BEFORE it is paid for — that is what holds the slot against the
 * `bookings_no_double_booking` constraint — and the sweeper in
 * `app/api/internal/bookings/expire-reservations` releases it if payment never lands. The
 * deadline is computed on the server from `created_at` plus the same TTL that sweeper uses, and
 * shown here so the hold is never a surprise. When it lapses the panel says so and stops
 * offering a payment link, because the slot may already have been re-sold.
 *
 * The clock starts on mount, not during render: a server-rendered "14:59" that hydrates into
 * "14:58" is a hydration mismatch, and React is right to complain about it.
 */

import { useCallback, useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { z } from "zod"

import { BookingStatusBadge, PaymentStatusBadge } from "@/components/booking/booking-status-badge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { Textarea } from "@/components/ui/textarea"
import { toast } from "@/lib/use-toast"
import { cn } from "@/lib/utils"
import type { Enums } from "@halisaha/shared/database"
import { formatMinor } from "@halisaha/shared/domain"

/* ========================================================================== */
/*  Props                                                                     */
/* ========================================================================== */

export interface BookingSummaryBooking {
  id: string
  status: Enums<"booking_status">
  paymentStatus: Enums<"payment_status">
  /** Lower bound of `bookings.time_range`, ISO. */
  startsAt: string
  endsAt: string
  subtotalMinor: number
  platformFeeMinor: number
  totalMinor: number
  refundedAmountMinor: number
  currency: string
  cancellationReason: string | null
}

/** The cancellation policy, resolved server-side by `resolveCancellationPolicy()`. */
export interface RefundPreview {
  refundMinor: number
  fullRefund: boolean
  windowHours: number
  /** Basis points of the original total refunded for a late cancellation. */
  lateRefundBps: number
  reasonCode: "outside_window" | "inside_window" | "already_started"
}

export interface BookingSummaryProps {
  booking: BookingSummaryBooking
  venueName: string
  pitchName: string
  /** IANA zone of the venue. Kickoff is rendered in it, never in the browser's. */
  timezone: string
  /** When an unpaid hold lapses, ISO. Null when the booking is not holding a slot unpaid. */
  holdExpiresAt?: string | null
  refundPreview?: RefundPreview | null
  /** Rendered as the primary action while the booking is unpaid. */
  payHref?: string | null
  /** Show the cancel control. The server decides; this only draws it. */
  canCancel?: boolean
  /**
   * True right after a payment returns, while the Stripe webhook is still in flight. The panel
   * refreshes itself a few times rather than making the customer reload.
   */
  awaitingConfirmation?: boolean
  className?: string
}

const cancellationResultSchema = z.object({
  status: z.string(),
  refundedAmountMinor: z.number().int().nonnegative(),
  currency: z.string(),
  fullRefund: z.boolean(),
})

const apiErrorSchema = z.object({ code: z.string(), message: z.string() })

/** How many times the panel re-reads itself while waiting for the payment webhook. */
const CONFIRMATION_POLLS = 6
const CONFIRMATION_POLL_MS = 4_000

/* ========================================================================== */

export function BookingSummary({
  booking,
  venueName,
  pitchName,
  timezone,
  holdExpiresAt,
  refundPreview,
  payHref,
  canCancel = false,
  awaitingConfirmation = false,
  className,
}: BookingSummaryProps) {
  const router = useRouter()
  const [nowMs, setNowMs] = useState<number | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [reason, setReason] = useState("")
  const [cancelling, setCancelling] = useState(false)
  const [cancelError, setCancelError] = useState<string | null>(null)

  /* ---- the clock, started after hydration ---- */
  useEffect(() => {
    if (!holdExpiresAt) return
    setNowMs(Date.now())
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [holdExpiresAt])

  /* ---- wait for the webhook, then stop ---- */
  useEffect(() => {
    if (!awaitingConfirmation) return
    let polls = 0
    const timer = window.setInterval(() => {
      polls += 1
      router.refresh()
      if (polls >= CONFIRMATION_POLLS) window.clearInterval(timer)
    }, CONFIRMATION_POLL_MS)
    return () => window.clearInterval(timer)
  }, [awaitingConfirmation, router])

  const expiresMs = holdExpiresAt ? Date.parse(holdExpiresAt) : null
  const remainingMs =
    expiresMs !== null && nowMs !== null ? Math.max(0, expiresMs - nowMs) : null
  const expired = remainingMs !== null && remainingMs === 0

  // The absolute deadline, formatted once from a prop so it is stable across every tick. The
  // ticking countdown is hidden from assistive technology (see the hold alert below), so this is
  // the form of the deadline a screen reader is actually given.
  const holdExpiryAt = expiresMs !== null && Number.isFinite(expiresMs) ? new Date(expiresMs) : null
  const holdExpiryLabel = holdExpiryAt
    ? new Intl.DateTimeFormat("tr-TR", {
        timeZone: timezone,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(holdExpiryAt)
    : null

  const cancel = useCallback(async (): Promise<void> => {
    setCancelling(true)
    setCancelError(null)
    try {
      const trimmed = reason.trim()
      const response = await fetch(`/api/bookings/${encodeURIComponent(booking.id)}/cancel`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        // The schema wants at least 3 characters or nothing at all.
        body: JSON.stringify(trimmed.length >= 3 ? { reason: trimmed.slice(0, 500) } : {}),
      })
      const body: unknown = await response.json()

      if (!isEnvelopeOk(body)) {
        const parsed = apiErrorSchema.safeParse((body as { error?: unknown }).error)
        setCancelError(
          parsed.success ? parsed.data.message : "Bu rezervasyonu iptal edemedik. Tekrar dene.",
        )
        return
      }

      const parsed = cancellationResultSchema.safeParse(body.data)
      const refunded = parsed.success ? parsed.data.refundedAmountMinor : 0
      setDialogOpen(false)
      toast({
        variant: "success",
        title: "Rezervasyon iptal edildi",
        description:
          refunded > 0
            ? `${formatMinor(refunded, booking.currency)} is on its way back to your card. Refunds usually take a few working days.`
            : "The slot has been released. Nothing was refunded under the cancellation policy.",
      })
      router.refresh()
    } catch {
      setCancelError("We could not reach the server. The booking has not been cancelled.")
    } finally {
      setCancelling(false)
    }
  }, [booking.id, booking.currency, reason, router])

  const kickoff = new Intl.DateTimeFormat("tr-TR", {
    timeZone: timezone,
    dateStyle: "full",
    timeStyle: "short",
  }).format(new Date(booking.startsAt))

  const endTime = new Intl.DateTimeFormat("tr-TR", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(booking.endsAt))

  return (
    <Card className={cn(className)}>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base">{pitchName}</CardTitle>
            <CardDescription>{venueName}</CardDescription>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <BookingStatusBadge status={booking.status} />
            <PaymentStatusBadge status={booking.paymentStatus} />
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        <div>
          <p className="font-medium">{kickoff}</p>
          <p className="text-sm text-muted-foreground">Until {endTime}, venue local time.</p>
        </div>

        {/* ---- hold countdown ---- */}
        {expiresMs !== null && !expired && (
          <Alert role="status">
            <AlertTitle>
              Slot held
              {/* The countdown re-renders every second. A live region whose text changes every
                  second is unusable with a screen reader — it re-reads the whole alert on every
                  tick — so the ticking value is hidden from assistive technology and the same
                  deadline is given below as one stable absolute time. What the live region
                  announces is the state change: the hold appearing, and then expiring. */}
              {remainingMs !== null && (
                <span aria-hidden="true" className="font-normal tabular-nums">
                  {" "}
                  for {formatCountdown(remainingMs)}
                </span>
              )}
            </AlertTitle>
            <AlertDescription>
              Nobody else can book this time while the hold lasts
              {holdExpiryAt && holdExpiryLabel ? (
                <>
                  , until <time dateTime={holdExpiryAt.toISOString()}>{holdExpiryLabel}</time> işletmenin yerel saati
                </>
              ) : null}
              . It is released automatically if the payment is not finished.
            </AlertDescription>
          </Alert>
        )}

        {expired && (
          <Alert variant="destructive">
            <AlertTitle>Tutma süresi doldu</AlertTitle>
            <AlertDescription>
              Bu rezervasyonun ödemesi zamanında yapılmadı, saat yeniden satışa çıktı. Yeni bir saat seçip baştan başla — hiçbir tutar çekilmedi.
            </AlertDescription>
          </Alert>
        )}

        {awaitingConfirmation && (
          <Alert role="status">
            <AlertTitle>Ödemen onaylanıyor</AlertTitle>
            <AlertDescription>
              Bankan ödemeyi onayladı, son onayı bekliyoruz. Bu sayfa kendini günceller; tekrar ödeme yapmana gerek yok.
            </AlertDescription>
          </Alert>
        )}

        {/* ---- money ---- */}
        <Separator />
        <dl className="space-y-1.5 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Saha ücreti</dt>
            <dd className="tabular-nums">{formatMinor(booking.subtotalMinor, booking.currency)}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">
              Platform hizmet bedeli
              <span className="block text-xs">Fiyata dâhil, işletme tarafından ödenir</span>
            </dt>
            <dd className="tabular-nums text-muted-foreground">
              {formatMinor(booking.platformFeeMinor, booking.currency)}
            </dd>
          </div>
          <Separator className="my-2" />
          <div className="flex justify-between gap-4 text-base font-semibold">
            <dt>Toplam</dt>
            <dd className="tabular-nums">{formatMinor(booking.totalMinor, booking.currency)}</dd>
          </div>
          {booking.refundedAmountMinor > 0 && (
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">İade edildi</dt>
              <dd className="tabular-nums">
                −{formatMinor(booking.refundedAmountMinor, booking.currency)}
              </dd>
            </div>
          )}
        </dl>

        {booking.cancellationReason && (
          <p className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
            Cancelled: {booking.cancellationReason}
          </p>
        )}

        {/* ---- actions ---- */}
        <div className="flex flex-wrap gap-2">
          {payHref && !expired && (
            <Button asChild>
              <Link href={payHref}>Şimdi öde</Link>
            </Button>
          )}
          {canCancel && (
            <Button variant="outline" onClick={() => setDialogOpen(true)}>
              Rezervasyonu iptal et
            </Button>
          )}
        </div>

        {refundPreview && canCancel && (
          <p className="text-xs text-muted-foreground">
            {describePolicy(refundPreview, booking.currency)}
          </p>
        )}
      </CardContent>

      <Dialog open={dialogOpen} onOpenChange={(open) => !cancelling && setDialogOpen(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Bu rezervasyonu iptal edelim mi?</DialogTitle>
            <DialogDescription>
              {refundPreview
                ? describePolicy(refundPreview, booking.currency)
                : "The slot goes back on sale immediately and cannot be reclaimed."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <Label htmlFor={`cancel-reason-${booking.id}`}>Gerekçe (isteğe bağlı)</Label>
            <Textarea
              id={`cancel-reason-${booking.id}`}
              value={reason}
              maxLength={500}
              rows={3}
              placeholder="İşletmenin sahanın neden boşaldığını anlamasına yardım eder."
              onChange={(event) => setReason(event.target.value)}
            />
          </div>

          {cancelError && (
            <Alert variant="destructive">
              <AlertTitle>İptal edilmedi</AlertTitle>
              <AlertDescription>{cancelError}</AlertDescription>
            </Alert>
          )}

          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialogOpen(false)} disabled={cancelling}>
              Rezervasyonu tut
            </Button>
            <Button variant="destructive" onClick={() => void cancel()} disabled={cancelling}>
              {cancelling ? "Cancelling…" : "Cancel booking"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

/* ========================================================================== */
/*  Helpers                                                                   */
/* ========================================================================== */

function isEnvelopeOk(body: unknown): body is { ok: true; data: unknown } {
  return typeof body === "object" && body !== null && (body as { ok?: unknown }).ok === true
}

/** `mm:ss` under an hour, `h m` above it. */
function formatCountdown(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
}

/** The cancellation policy in one sentence, with the amount this booking would get back. */
function describePolicy(preview: RefundPreview, currency: string): string {
  const amount = formatMinor(preview.refundMinor, currency)
  switch (preview.reasonCode) {
    case "outside_window":
      return `Şimdi iptal edersen ${amount} kartına tam olarak geri döner. Başlama saatine ${preview.windowHours} saatten az kalınca yalnızca %${preview.lateRefundBps / 100} iade edilir.`
    case "inside_window":
      return `Başlama saatine ${preview.windowHours} saatten az kaldı, geç iptal politikası geçerli: ${amount} iade edilir.`
    case "already_started":
      return `Bu rezervasyon başladı. Şimdi iptal edersen ${amount} iade edilir.`
    default:
      return `Şimdi iptal edersen ${amount} iade edilir.`
  }
}
