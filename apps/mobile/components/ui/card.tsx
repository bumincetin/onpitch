/**
 * components/ui/card.tsx
 *
 * A raised surface: a fixture row, a booking summary, a settings group.
 *
 * Elevation comes from a border plus a very soft shadow rather than a heavy drop shadow, because
 * the dark palette's card sits only two steps above the background and a strong shadow under it
 * looks like a rendering artefact.
 */

import * as React from 'react'
import { Pressable, View, type StyleProp, type ViewStyle } from 'react-native'

import { useTheme } from '@/lib/theme'

import { Text } from './text'

export interface CardProps {
  children?: React.ReactNode
  /** Rendered as a heading above the content. */
  title?: string
  /** One line under the title. */
  subtitle?: string
  /** Rendered below the content, separated by the card's own padding. */
  footer?: React.ReactNode
  /** Makes the whole card a single tap target. Give it an `accessibilityLabel` when it is one. */
  onPress?: () => void
  accessibilityLabel?: string
  /** Removes the inner padding, for a card that hosts its own list or image. */
  flush?: boolean
  style?: StyleProp<ViewStyle>
  contentStyle?: StyleProp<ViewStyle>
}

export function Card({
  children,
  title,
  subtitle,
  footer,
  onPress,
  accessibilityLabel,
  flush = false,
  style,
  contentStyle,
}: CardProps): React.ReactElement {
  const theme = useTheme()

  const surface: ViewStyle = {
    backgroundColor: theme.colors.card,
    borderRadius: theme.radius.xl,
    borderWidth: 1,
    borderColor: theme.colors.border,
    overflow: 'hidden',
  }

  const body = (
    <View
      style={[
        {
          padding: flush ? 0 : theme.spacing.lg,
          gap: theme.spacing.md,
        },
        contentStyle,
      ]}
    >
      {title || subtitle ? (
        <View style={{ gap: theme.spacing.xs, paddingHorizontal: flush ? theme.spacing.lg : 0, paddingTop: flush ? theme.spacing.lg : 0 }}>
          {title ? (
            <Text variant="heading" accessibilityRole="header">
              {title}
            </Text>
          ) : null}
          {subtitle ? (
            <Text variant="label" tone="muted">
              {subtitle}
            </Text>
          ) : null}
        </View>
      ) : null}

      {children}

      {footer ? <View style={{ paddingHorizontal: flush ? theme.spacing.lg : 0, paddingBottom: flush ? theme.spacing.lg : 0 }}>{footer}</View> : null}
    </View>
  )

  if (!onPress) {
    return <View style={[surface, style]}>{body}</View>
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      onPress={onPress}
      style={({ pressed }) => [surface, { opacity: pressed ? 0.9 : 1 }, style]}
    >
      {body}
    </Pressable>
  )
}
