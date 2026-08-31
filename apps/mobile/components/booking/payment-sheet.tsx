/**
 * components/booking/payment-sheet.tsx
 *
 * The native Payment Sheet, wrapped once.
 *
 * Two screens take money — the slot picker, and "pay now" on a reservation that is still
 * awaiting payment — and both must classify the outcome the same way. In particular both must
 * treat a dismissed sheet as a decision rather than a failure, because the caller's next move
 * depends on it: a cancelled payment releases the reservation, a failed one leaves it open so
 * the customer can retry.
 *
 * The sheet is mounted on the `clientSecret` the server returned. No amount is passed to Stripe
 * from here; the PaymentIntent already carries the figure `quoteBooking()` computed.
 */

import { initStripe, useStripe } from '@stripe/stripe-react-native'
import * as React from 'react'

import { env } from '@/lib/env'
import { useTheme } from '@/lib/theme'
import type { CheckoutResult } from '@halisaha/shared/domain'

/** What happened in the sheet. `cancelled` is a normal outcome, not an error. */
export type CheckoutOutcome =
  | { kind: 'paid' }
  /** The customer dismissed the sheet. Nothing was charged; the reservation is still held. */
  | { kind: 'cancelled' }
  /** The sheet could not open, or the payment was refused. */
  | { kind: 'failed'; message: string }

/** Billing details prefilled into the sheet, so the customer retypes as little as possible. */
export interface CheckoutCustomer {
  email?: string | null
  name?: string | null
}

export interface CheckoutSheet {
  present: (checkout: CheckoutResult, customer?: CheckoutCustomer) => Promise<CheckoutOutcome>
}

export function useCheckoutSheet(): CheckoutSheet {
  const { initPaymentSheet, presentPaymentSheet } = useStripe()
  const theme = useTheme()
  const primary = theme.colors.primary

  const present = React.useCallback(
    async (checkout: CheckoutResult, customer?: CheckoutCustomer): Promise<CheckoutOutcome> => {
      // `StripeProvider` in app/_layout.tsx mounts the SDK when a publishable key is baked into
      // the build. When it is not, the key the server just returned is used instead — which is
      // the whole reason `CheckoutResult` carries one.
      if (!env.stripePublishableKey) {
        await initStripe({
          publishableKey: checkout.publishableKey,
          // Must match `scheme` in app.json, or a 3-D Secure challenge cannot come back here.
          urlScheme: 'halisaha',
          merchantIdentifier: 'merchant.com.halisaha.app',
        })
      }

      const prepared = await initPaymentSheet({
        merchantDisplayName: 'Halisaha',
        paymentIntentClientSecret: checkout.clientSecret,
        // A pitch is used at a fixed time. A method that settles in three days cannot confirm a
        // booking for tonight, so the sheet does not offer one.
        allowsDelayedPaymentMethods: false,
        defaultBillingDetails: {
          email: customer?.email ?? undefined,
          name: customer?.name ?? undefined,
        },
        appearance: { colors: { primary } },
      })

      if (prepared.error) {
        return { kind: 'failed', message: prepared.error.message }
      }

      const presented = await presentPaymentSheet()

      if (presented.error) {
        // The dismissal code is a native enum. It is compared as a string rather than against an
        // imported member so that a package upgrade renaming the export cannot turn "the
        // customer changed their mind" into "the payment failed" without anyone noticing.
        if (String(presented.error.code) === 'Canceled') return { kind: 'cancelled' }
        return { kind: 'failed', message: presented.error.message }
      }

      return { kind: 'paid' }
    },
    [initPaymentSheet, presentPaymentSheet, primary],
  )

  // Memoised so a caller can list the sheet in a `useCallback` dependency array without that
  // callback being rebuilt on every render.
  return React.useMemo(() => ({ present }), [present])
}
