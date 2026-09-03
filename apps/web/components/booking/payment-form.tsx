"use client"

/**
 * components/booking/payment-form.tsx
 *
 * The card step: Stripe's Payment Element, mounted against the PaymentIntent the checkout route
 * created for this booking.
 *
 * ---------------------------------------------------------------------------
 * WHY THE ELEMENT, AND NOT A FORM OF OUR OWN
 * ---------------------------------------------------------------------------
 * Card details are entered in an iframe served by Stripe, so the PAN never touches this origin,
 * never enters our DOM, and never appears in a stack trace. That is what keeps the platform in
 * SAQ-A scope rather than SAQ-D (see the note at the top of `lib/stripe.ts`). It is also why
 * `automatic_payment_methods` is on server-side: the Element renders whatever the Stripe
 * dashboard has enabled — cards, wallets, local methods — without this file knowing about any of
 * them.
 *
 * ---------------------------------------------------------------------------
 * WHAT `redirect: "if_required"` MEANS HERE
 * ---------------------------------------------------------------------------
 * Most card payments finish in place, and 3-D Secure runs in Stripe's own modal. Those return a
 * `paymentIntent` to this function and the customer never leaves the page. Methods that MUST
 * bounce through a bank (and 3-D Secure flows that cannot be modalled) redirect to `return_url`
 * instead, and this code never resumes — which is why the booking page, not this component, is
 * the place that reconciles the final state.
 *
 * Either way the source of truth is the `payment_intent.succeeded` webhook, not this browser.
 * The confirmation below decides what to SHOW; `app/api/stripe/webhook` decides what the booking
 * IS. A customer who closes the tab mid-3DS still gets a confirmed booking if the charge landed.
 */

import { useCallback, useMemo, useState, type FormEvent } from "react"
import { useRouter } from "next/navigation"
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js"
import { loadStripe, type Stripe } from "@stripe/stripe-js"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { formatMinor } from "@onpitch/shared/domain"

/**
 * `loadStripe` injects a script tag and must not run per render. One promise per publishable
 * key, kept at module scope so remounts (a route change, Strict Mode's double effect) reuse it.
 */
const stripeLoaders = new Map<string, Promise<Stripe | null>>()

function stripeFor(publishableKey: string): Promise<Stripe | null> {
  const existing = stripeLoaders.get(publishableKey)
  if (existing) return existing
  const created = loadStripe(publishableKey)
  stripeLoaders.set(publishableKey, created)
  return created
}

export interface PaymentFormProps {
  bookingId: string
  /** PaymentIntent client secret. Scoped to this one intent; it authorises nothing else. */
  clientSecret: string
  publishableKey: string
  amountMinor: number
  currency: string
  /** Where Stripe sends the customer back after a redirect-based method. Same-origin path. */
  returnPath: string
}

export function PaymentForm({
  bookingId,
  clientSecret,
  publishableKey,
  amountMinor,
  currency,
  returnPath,
}: PaymentFormProps) {
  const stripePromise = useMemo(() => stripeFor(publishableKey), [publishableKey])

  return (
    <Elements
      stripe={stripePromise}
      options={{
        clientSecret,
        appearance: { theme: "stripe", variables: { borderRadius: "6px" } },
      }}
    >
      <PaymentFields
        bookingId={bookingId}
        amountMinor={amountMinor}
        currency={currency}
        returnPath={returnPath}
      />
    </Elements>
  )
}

interface PaymentFieldsProps {
  bookingId: string
  amountMinor: number
  currency: string
  returnPath: string
}

function PaymentFields({ bookingId, amountMinor, currency, returnPath }: PaymentFieldsProps) {
  const stripe = useStripe()
  const elements = useElements()
  const router = useRouter()

  const [ready, setReady] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState<{ tone: "error" | "info"; title: string; body: string } | null>(
    null,
  )

  const onSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>): Promise<void> => {
      event.preventDefault()
      if (!stripe || !elements || submitting) return

      setSubmitting(true)
      setMessage(null)

      const { error, paymentIntent } = await stripe.confirmPayment({
        elements,
        confirmParams: { return_url: new URL(returnPath, window.location.origin).toString() },
        // Stay on the page when Stripe can finish without a full-page bounce.
        redirect: "if_required",
      })

      if (error) {
        // `card_error` and `validation_error` carry copy written for the cardholder — a declined
        // card, an expired one, a wrong postcode. Everything else is an integration or network
        // fault whose message would only confuse.
        const showable = error.type === "card_error" || error.type === "validation_error"
        setMessage({
          tone: "error",
          title: showable ? "Your payment was not completed" : "Something went wrong",
          body:
            showable && error.message
              ? error.message
              : "Ödemeyi tamamlayamadık. Hiçbir tutar çekilmedi — tekrar dene ya da başka bir kart kullan.",
        })
        setSubmitting(false)
        return
      }

      switch (paymentIntent?.status) {
        case "succeeded":
          router.push(`/bookings/${bookingId}?payment=complete`)
          return
        case "processing":
          router.push(`/bookings/${bookingId}?payment=processing`)
          return
        case "requires_action":
          setMessage({
            tone: "info",
            title: "Bir adım daha",
            body: "Bankanın bu ödemeyi onaylaması gerekiyor. Açtığı doğrulamayı tamamla, sonra tekrar dene.",
          })
          break
        case "requires_payment_method":
          setMessage({
            tone: "error",
            title: "Bu ödeme yöntemi reddedildi",
            body: "Hiçbir tutar çekilmedi. Başka bir kart dene.",
          })
          break
        default:
          // No intent and no error means the customer was redirected away; nothing to do.
          break
      }
      setSubmitting(false)
    },
    [bookingId, elements, returnPath, router, stripe, submitting],
  )

  return (
    <form onSubmit={(event) => void onSubmit(event)} className="space-y-4" aria-busy={submitting}>
      {!ready && (
        <div className="space-y-2" aria-hidden="true">
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-2/3" />
        </div>
      )}

      <PaymentElement
        onReady={() => setReady(true)}
        onLoadError={() =>
          setMessage({
            tone: "error",
            title: "Ödeme formu yüklenemedi",
            body: "Bağlantını kontrol et ve sayfayı yenile. Saatin hâlâ tutuluyor.",
          })
        }
        options={{ layout: "tabs" }}
      />

      {message && (
        <Alert variant={message.tone === "error" ? "destructive" : "default"}>
          <AlertTitle>{message.title}</AlertTitle>
          <AlertDescription>{message.body}</AlertDescription>
        </Alert>
      )}

      <Button type="submit" className="w-full" disabled={!stripe || !ready || submitting}>
        {submitting ? "Paying…" : `Pay ${formatMinor(amountMinor, currency)}`}
      </Button>

      <p className="text-center text-xs text-muted-foreground">
        Ödemeler Stripe üzerinden alınır. Kart bilgilerin Stripe&apos;ın kendi formuna girilir ve OnPitch&apos;ya hiç ulaşmaz.
      </p>
    </form>
  )
}
