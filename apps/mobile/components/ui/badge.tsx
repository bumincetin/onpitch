/**
 * components/ui/badge.tsx
 *
 * A small status pill: booking status, match status, "ranked", a spots-remaining count.
 *
 * Tones carry meaning, so none of them is colour-only — the label always says what the colour is
 * hinting at. A red pill that reads "Cancelled" survives being seen by someone who cannot
 * distinguish it from the green one.
 */

import * as React from 'react'
import { View, type StyleProp, type ViewStyle } from 'react-native'

import { useTheme, type Theme } from '@/lib/theme'

import { Text } from './text'

export type BadgeTone =
  | 'neutral'
  | 'primary'
  | 'success'
  | 'warning'
  | 'destructive'
  /** Transparent fill, border only. For a count or a quiet label. */
  | 'outline'

export interface BadgeProps {
  children: React.ReactNode
  tone?: BadgeTone
  size?: 'sm' | 'md'
  style?: StyleProp<ViewStyle>
}

interface BadgePalette {
  background: string
  foreground: string
  border: string
}

function palette(theme: Theme, tone: BadgeTone): BadgePalette {
  const { colors } = theme
  switch (tone) {
    case 'primary':
      return { background: colors.primary, foreground: colors.primaryForeground, border: colors.primary }
    case 'success':
      return { background: colors.success, foreground: colors.successForeground, border: colors.success }
    case 'warning':
      return { background: colors.warning, foreground: colors.warningForeground, border: colors.warning }
    case 'destructive':
      return {
        background: colors.destructive,
        foreground: colors.destructiveForeground,
        border: colors.destructive,
      }
    case 'outline':
      return { background: 'transparent', foreground: colors.mutedForeground, border: colors.border }
    case 'neutral':
      return { background: colors.secondary, foreground: colors.secondaryForeground, border: colors.secondary }
  }
}

export function Badge({ children, tone = 'neutral', size = 'md', style }: BadgeProps): React.ReactElement {
  const theme = useTheme()
  const { background, foreground, border } = palette(theme, tone)
  const compact = size === 'sm'

  return (
    <View
      style={[
        {
          alignSelf: 'flex-start',
          flexDirection: 'row',
          alignItems: 'center',
          backgroundColor: background,
          borderColor: border,
          borderWidth: 1,
          borderRadius: theme.radius.full,
          paddingHorizontal: compact ? theme.spacing.sm : theme.spacing.md,
          paddingVertical: compact ? 2 : theme.spacing.xs,
        },
        style,
      ]}
    >
      {typeof children === 'string' || typeof children === 'number' ? (
        <Text variant={compact ? 'caption' : 'label'} weight="600" style={{ color: foreground }}>
          {children}
        </Text>
      ) : (
        children
      )}
    </View>
  )
}
