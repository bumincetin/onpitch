/**
 * app/(auth)/_layout.tsx
 *
 * The signed-out stack: sign in, the age gate, and the account form behind it.
 *
 * This layout deliberately does NOT redirect when a session appears. The obvious version —
 * "if signed in, go to the tabs" — fires the instant `signUp` returns a session, which throws
 * away the screen telling a 14-year-old that their guardian has been emailed and what happens
 * next. The entry redirect lives in `app/index.tsx`; the sign-in and sign-up screens navigate
 * onward themselves, when their own flow is actually finished.
 */

import { Stack } from 'expo-router'
import * as React from 'react'

import { useTheme } from '@/lib/theme'

export const unstable_settings = {
  initialRouteName: 'sign-in',
}

export default function AuthLayout(): React.ReactElement {
  const theme = useTheme()

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: theme.colors.background },
        headerTintColor: theme.colors.foreground,
        headerTitleStyle: { color: theme.colors.foreground, fontWeight: '600' },
        headerShadowVisible: false,
        headerBackTitle: 'Back',
        contentStyle: { backgroundColor: theme.colors.background },
      }}
    >
      <Stack.Screen name="sign-in" options={{ headerShown: false }} />
      <Stack.Screen name="age-gate" options={{ title: 'Hesap oluştur' }} />
      <Stack.Screen name="sign-up" options={{ title: 'Bilgilerin' }} />
    </Stack>
  )
}
