/**
 * components/profile/screen-header.tsx
 *
 * The title bar for a screen that sits directly in the root Stack.
 *
 * `app/_layout.tsx` sets `headerShown: false` on that navigator, so a route pushed onto it —
 * settings, a player's profile, the teams list — arrives with no native header and therefore no
 * back affordance. This supplies one. Screens inside `(tabs)` already have the Tabs header and
 * must not use it.
 *
 * `router.canGoBack()` is checked rather than assumed: these routes are also deep-link targets and
 * a cold launch straight into one has nothing on the stack to pop, at which point a back arrow
 * that does nothing is worse than no arrow. In that case it replaces with `fallbackHref`, so the
 * user lands somewhere real instead of on a dead end.
 */

import { useRouter } from 'expo-router'
import * as React from 'react'
import { Pressable, View } from 'react-native'

import { Text } from '@/components/ui'
import { useTheme } from '@/lib/theme'

export interface ScreenHeaderProps {
  title: string
  /** One line under the title. */
  subtitle?: string
  /** Where to go when there is nothing to pop. Defaults to the tab shell. */
  fallbackHref?: string
  /** An action on the trailing edge. */
  right?: React.ReactNode
}

export function ScreenHeader({
  title,
  subtitle,
  fallbackHref = '/(tabs)',
  right,
}: ScreenHeaderProps): React.ReactElement {
  const theme = useTheme()
  const router = useRouter()

  const goBack = React.useCallback((): void => {
    if (router.canGoBack()) {
      router.back()
      return
    }
    router.replace(fallbackHref)
  }, [fallbackHref, router])

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.md,
        paddingBottom: theme.spacing.sm,
      }}
    >
      <Pressable
        onPress={goBack}
        accessibilityRole="button"
        accessibilityLabel="Geri dön"
        hitSlop={8}
        style={({ pressed }) => ({
          width: 44,
          height: 44,
          marginLeft: -theme.spacing.md,
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: theme.radius.full,
          opacity: pressed ? 0.6 : 1,
        })}
      >
        {/* A chevron drawn from two borders on a rotated square: no icon font, tints with the
            theme, and stays crisp at any accessibility text size because it is not text. */}
        <View
          style={{
            width: 11,
            height: 11,
            borderLeftWidth: 2,
            borderBottomWidth: 2,
            borderColor: theme.colors.foreground,
            transform: [{ rotate: '45deg' }],
            marginLeft: 4,
          }}
        />
      </Pressable>

      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="title" accessibilityRole="header" numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text variant="caption" tone="muted" numberOfLines={2}>
            {subtitle}
          </Text>
        ) : null}
      </View>

      {right}
    </View>
  )
}
