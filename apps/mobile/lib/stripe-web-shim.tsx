/**
 * Web-only stand-in for @stripe/stripe-react-native.
 *
 * The real package is native-only: it imports
 * react-native/Libraries/Utilities/codegenNativeComponent, which has no web implementation, so
 * a web bundle fails at import time. Metro swaps this file in for platform === 'web' (see
 * metro.config.js). It exists so the app can be opened in a browser for design review, and it
 * is never reached on iOS or Android.
 *
 * Payment entry points reject rather than pretending to succeed, so a web preview cannot be
 * mistaken for a working checkout.
 */
import * as React from 'react'

const WEB_UNSUPPORTED =
  'Payments run through the native Stripe SDK. Open the app on iOS or Android to pay.'

export function StripeProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  return <>{children}</>
}

export function initStripe(): Promise<void> {
  return Promise.resolve()
}

export interface PaymentSheetError {
  code: string
  message: string
}

export function useStripe(): {
  initPaymentSheet: () => Promise<{ error: PaymentSheetError }>
  presentPaymentSheet: () => Promise<{ error: PaymentSheetError }>
} {
  return {
    initPaymentSheet: async () => ({ error: { code: 'WebUnsupported', message: WEB_UNSUPPORTED } }),
    presentPaymentSheet: async () => ({ error: { code: 'WebUnsupported', message: WEB_UNSUPPORTED } }),
  }
}
