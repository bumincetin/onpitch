/**
 * components/ui/notice.tsx
 *
 * An inline message block — the mobile counterpart of the web app's Alert.
 *
 * Used for the things a screen has to say before the user acts: why a control is locked, what a
 * guardian is about to receive, why a booking failed. The tint is a hint, not the message; the
 * title always states the situation in words.
 */

import * as React from 'react'
import { AccessibilityInfo, Platform, View, type StyleProp, type ViewStyle } from 'react-native'

import { useTheme, type Theme } from '@/lib/theme'

import { Text } from './text'

export type NoticeTone = 'info' | 'success' | 'warning' | 'destructive'

export interface NoticeProps {
  title: string
  /** The body. Pass `children` instead when the message needs a list or a link. */
  description?: string
  children?: React.ReactNode
  tone?: NoticeTone
  /**
   * Announces the notice when it appears, for a validation or result message.
   *
   * `accessibilityLiveRegion` is Android-only, so iOS is served by an explicit
   * `announceForAccessibility` call instead. Both paths are wired below.
   */
  live?: boolean
  style?: StyleProp<ViewStyle>
}

function accentOf(theme: Theme, tone: NoticeTone): string {
  switch (tone) {
    case 'success':
      return theme.colors.success
    case 'warning':
      return theme.colors.warning
    case 'destructive':
      return theme.colors.destructive
    case 'info':
      return theme.colors.primary
  }
}

export function Notice({
  title,
  description,
  children,
  tone = 'info',
  live = false,
  style,
}: NoticeProps): React.ReactElement {
  const theme = useTheme()
  const accent = accentOf(theme, tone)

  // `accessibilityLiveRegion` is documented `@platform android` and React Native does nothing with
  // it on iOS, which would leave every validation and result message silent under VoiceOver. The
  // effect is keyed on the announcement text, so a message that changes is announced again and one
  // that merely re-renders is not.
  const announcement = live ? [title, description].filter(Boolean).join('. ') : null

  React.useEffect(() => {
    if (announcement === null || Platform.OS === 'android') return
    AccessibilityInfo.announceForAccessibility(announcement)
  }, [announcement])

  return (
    <View
      accessibilityLiveRegion={live ? 'polite' : 'none'}
      style={[
        {
          gap: theme.spacing.sm,
          padding: theme.spacing.lg,
          borderRadius: theme.radius.lg,
          backgroundColor: theme.colors.muted,
          // A 3pt leading rule rather than a tinted fill: the tint that reads correctly on the
          // light background is invisible on the dark one, and this reads on both.
          borderLeftWidth: 3,
          borderLeftColor: accent,
        },
        style,
      ]}
    >
      <Text variant="label" weight="600" style={{ color: accent }}>
        {title}
      </Text>
      {description ? (
        <Text variant="body" tone="muted">
          {description}
        </Text>
      ) : null}
      {children}
    </View>
  )
}

/** A bulleted line inside a Notice. */
export function NoticeBullet({ children }: { children: string }): React.ReactElement {
  const theme = useTheme()

  return (
    <View style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
      <Text variant="body" tone="muted" accessibilityElementsHidden>
        {'•'}
      </Text>
      <Text variant="body" tone="muted" style={{ flex: 1 }}>
        {children}
      </Text>
    </View>
  )
}
