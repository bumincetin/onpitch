/**
 * components/ui/spinner.tsx
 *
 * The loading state for anything that has not arrived yet.
 */

import * as React from 'react'
import { ActivityIndicator, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'

import { useTheme } from '@/lib/theme'

import { Text } from './text'

export interface SpinnerProps {
  size?: 'small' | 'large'
  /** Read out by the screen reader, and shown under the spinner when `centred`. */
  label?: string
  /** Fills its parent and centres itself. Use for a whole-screen or whole-card load. */
  centred?: boolean
  color?: string
  style?: StyleProp<ViewStyle>
}

export function Spinner({
  size = 'small',
  label,
  centred = false,
  color,
  style,
}: SpinnerProps): React.ReactElement {
  const theme = useTheme()

  const indicator = (
    <ActivityIndicator
      size={size}
      color={color ?? theme.colors.primary}
      accessibilityRole="progressbar"
      accessibilityLabel={label ?? 'Loading'}
    />
  )

  if (!centred) {
    return <View style={style}>{indicator}</View>
  }

  return (
    <View style={[styles.centred, { gap: theme.spacing.md }, style]}>
      {indicator}
      {label ? (
        <Text variant="label" tone="muted" align="center">
          {label}
        </Text>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  centred: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
})
