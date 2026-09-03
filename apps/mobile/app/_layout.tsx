/**
 * app/_layout.tsx
 *
 * Root layout. Mounts the providers, holds the app on a splash state until the stored session has
 * resolved, and then hands over to expo-router.
 *
 * ORDER MATTERS HERE. SafeAreaProvider has to be outermost so every screen can read insets.
 * SessionProvider sits above the navigator so a screen can read the session during its first
 * render rather than after a flash. StripeProvider wraps both because Stripe's native SDK is
 * initialised once per process, not per payment.
 *
 * The navigator is not mounted at all while the session is loading. That is the whole reason the
 * signed-in UI never appears for a frame before the redirect: there is nothing to appear.
 */

// Must be the first import in the entry graph. Gesture Handler patches the native view hierarchy
// on load, and a screen mounted before that patch never receives touches on Android.
import 'react-native-gesture-handler'

import { StripeProvider } from '@stripe/stripe-react-native'
import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import * as React from 'react'
import { View } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'

import { Button, Screen, Text } from '@/components/ui'
import { AccentProvider } from '@/lib/accent'
import { env } from '@/lib/env'
import { SessionProvider, useSession } from '@/lib/supabase'
import { useIsDark, useTheme } from '@/lib/theme'

export const unstable_settings = {
  initialRouteName: 'index',
}

export default function RootLayout(): React.ReactElement {
  return (
    <SafeAreaProvider>
      <PaymentsProvider>
        <SessionProvider>
          <AccentProvider>
            <AppShell />
          </AccentProvider>
        </SessionProvider>
      </PaymentsProvider>
    </SafeAreaProvider>
  )
}

/**
 * Mounts Stripe when a publishable key is configured at build time.
 *
 * `EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY` is optional: `POST /api/bookings/checkout` returns
 * `publishableKey` alongside the client secret, so a payment screen can always initialise Stripe
 * with the key the server just handed it. Mounting early only matters for the Apple Pay and
 * Google Pay availability checks, which run before the user reaches checkout.
 *
 * `urlScheme` is what a 3-D Secure challenge redirects back to. It has to match `scheme` in
 * app.json or the customer lands in a browser tab that cannot return them to the app.
 */
function PaymentsProvider({ children }: React.PropsWithChildren): React.ReactElement {
  const key = env.stripePublishableKey

  if (!key) return <>{children}</>

  return (
    <StripeProvider
      publishableKey={key}
      merchantIdentifier="merchant.com.onpitch.app"
      urlScheme="onpitch"
    >
      <>{children}</>
    </StripeProvider>
  )
}

function AppShell(): React.ReactElement {
  const { loading } = useSession()
  const theme = useTheme()
  const isDark = useIsDark()

  const statusBar = <StatusBar style={isDark ? 'light' : 'dark'} />

  if (loading) {
    return (
      <>
        {statusBar}
        <Splash />
      </>
    )
  }

  return (
    <>
      {statusBar}
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: theme.colors.background },
          // The default is a white flash between screens, which is glaring in dark mode.
          animation: 'fade',
        }}
      >
        <Stack.Screen name="index" />
        <Stack.Screen name="(auth)" />
        <Stack.Screen name="(tabs)" />
      </Stack>
    </>
  )
}

/** Shown while the stored session is read from AsyncStorage. Usually one or two frames. */
function Splash(): React.ReactElement {
  const theme = useTheme()

  return (
    <Screen edges={['top', 'left', 'right', 'bottom']} padded={false}>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: theme.spacing.sm }}>
        <Text variant="display" tone="primary">
          OnPitch
        </Text>
        <Text variant="label" tone="muted">
          Hesabın yükleniyor
        </Text>
      </View>
    </Screen>
  )
}

/**
 * expo-router renders this instead of a white screen when a route throws while rendering.
 *
 * It deliberately does not try to be clever: a render error means the component tree below is
 * untrustworthy, so the only offer is to re-mount the route.
 */
export function ErrorBoundary({
  error,
  retry,
}: {
  error: Error
  retry: () => Promise<void>
}): React.ReactElement {
  return (
    <SafeAreaProvider>
      <Screen edges={['top', 'left', 'right', 'bottom']}>
        <View style={{ flex: 1, justifyContent: 'center', gap: 16 }}>
          <Text variant="title">Bu ekran çöktü</Text>
          <Text variant="body" tone="muted">
            {error.message || 'No further detail was reported.'}
          </Text>
          <Button title="Ekranı yeniden yükle" onPress={() => void retry()} />
        </View>
      </Screen>
    </SafeAreaProvider>
  )
}
