/**
 * components/ui/button.tsx
 *
 * The only tappable action in the app.
 *
 * Two things it enforces that are easy to lose when a screen rolls its own Pressable: a 44pt
 * minimum target on every size, and a busy state that blocks the second tap. Double-submitting
 * `POST /api/bookings/checkout` creates two PaymentIntents, and the second one is a support
 * ticket rather than a bug report.
 */

import * as React from 'react'
import {
  ActivityIndicator,
  Pressable,
  View,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native'

import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated'

import { useTheme, type Theme } from '@/lib/theme'

import { Text } from './text'

export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'destructive'
export type ButtonSize = 'sm' | 'md' | 'lg'

export interface ButtonProps extends Omit<PressableProps, 'children' | 'style'> {
  /** The label. Also the accessibility name unless `accessibilityLabel` overrides it. */
  title: string
  variant?: ButtonVariant
  size?: ButtonSize
  /** Shows a spinner in place of the label and blocks presses. */
  loading?: boolean
  disabled?: boolean
  fullWidth?: boolean
  /** Rendered before the label — an icon, a small badge. */
  left?: React.ReactNode
  right?: React.ReactNode
  style?: StyleProp<ViewStyle>
}

interface ButtonPalette {
  background: string
  foreground: string
  border: string
}

function palette(theme: Theme, variant: ButtonVariant): ButtonPalette {
  const { colors } = theme
  switch (variant) {
    case 'primary':
      return { background: colors.primary, foreground: colors.primaryForeground, border: colors.primary }
    case 'secondary':
      return {
        background: colors.secondary,
        foreground: colors.secondaryForeground,
        border: colors.secondary,
      }
    case 'outline':
      return { background: 'transparent', foreground: colors.foreground, border: colors.border }
    case 'ghost':
      return { background: 'transparent', foreground: colors.foreground, border: 'transparent' }
    case 'destructive':
      return {
        background: colors.destructive,
        foreground: colors.destructiveForeground,
        border: colors.destructive,
      }
  }
}

/** Heights are all at or above the 44pt Apple / 48dp Android minimum target. */
const HEIGHT: Record<ButtonSize, number> = { sm: 44, md: 48, lg: 54 }

const AnimatedPressable = Animated.createAnimatedComponent(Pressable)

export function Button({
  title,
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled = false,
  fullWidth = false,
  left,
  right,
  style,
  accessibilityLabel,
  ...rest
}: ButtonProps): React.ReactElement {
  const theme = useTheme()
  const { background, foreground, border } = palette(theme, variant)
  const inactive = disabled || loading

  // Press feedback on the UI thread: a small settle, not a bounce. Composes with the opacity.
  const press = useSharedValue(0)
  const pressedStyle = useAnimatedStyle(() => ({ transform: [{ scale: 1 - press.value * 0.03 }] }))

  return (
    <AnimatedPressable
      onPressIn={(event) => {
        press.value = withSpring(1, { damping: 20, stiffness: 300 })
        rest.onPressIn?.(event)
      }}
      onPressOut={(event) => {
        press.value = withSpring(0, { damping: 20, stiffness: 300 })
        rest.onPressOut?.(event)
      }}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      // `busy` is what makes VoiceOver say "in progress" instead of re-announcing the label as
      // if the button were still waiting for a first tap.
      accessibilityState={{ disabled: inactive, busy: loading }}
      disabled={inactive}
      style={({ pressed }: { pressed: boolean }) => [
        {
          minHeight: HEIGHT[size],
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: theme.spacing.sm,
          paddingHorizontal: size === 'sm' ? theme.spacing.md : theme.spacing.xl,
          borderRadius: theme.radius.lg,
          borderWidth: 1,
          borderColor: border,
          backgroundColor: background,
          alignSelf: fullWidth ? 'stretch' : 'flex-start',
          // Opacity rather than a second palette: it composes with every variant, including the
          // transparent ones, without inventing five more colours.
          opacity: inactive ? 0.5 : pressed ? 0.85 : 1,
        },
        pressedStyle,
        style,
      ]}
      {...rest}
    >
      {loading ? (
        <ActivityIndicator size="small" color={foreground} />
      ) : (
        <>
          {left ? <View>{left}</View> : null}
          <Text
            variant={size === 'lg' ? 'heading' : 'body'}
            weight="600"
            numberOfLines={1}
            style={{ color: foreground }}
          >
            {title}
          </Text>
          {right ? <View>{right}</View> : null}
        </>
      )}
    </AnimatedPressable>
  )
}
