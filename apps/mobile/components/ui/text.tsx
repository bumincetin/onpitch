/**
 * components/ui/text.tsx
 *
 * Every string on screen goes through this. React Native's own `Text` inherits nothing from a
 * parent theme, so an unstyled `<Text>` renders black on the dark background — legible in the
 * simulator, invisible on a real phone at night.
 */

import * as React from 'react'
import { Text as RNText, type StyleProp, type TextProps as RNTextProps, type TextStyle } from 'react-native'

import { useTheme, type Theme, type TypeVariant } from '@/lib/theme'

export type TextTone =
  | 'default'
  | 'muted'
  | 'primary'
  | 'destructive'
  | 'success'
  | 'warning'
  /** For text sitting on a filled primary surface. */
  | 'inverse'

export interface TextProps extends RNTextProps {
  /** Type ramp step. Defaults to `body`. */
  variant?: TypeVariant
  /** Semantic colour. Defaults to `default`. */
  tone?: TextTone
  /** Overrides the variant's weight without leaving the ramp. */
  weight?: TextStyle['fontWeight']
  align?: TextStyle['textAlign']
  style?: StyleProp<TextStyle>
}

export function toneColor(theme: Theme, tone: TextTone): string {
  switch (tone) {
    case 'muted':
      return theme.colors.mutedForeground
    case 'primary':
      return theme.colors.primary
    case 'destructive':
      return theme.colors.destructive
    case 'success':
      return theme.colors.success
    case 'warning':
      return theme.colors.warning
    case 'inverse':
      return theme.colors.primaryForeground
    case 'default':
      return theme.colors.foreground
  }
}

export function Text({
  variant = 'body',
  tone = 'default',
  weight,
  align,
  style,
  ...rest
}: TextProps): React.ReactElement {
  const theme = useTheme()
  const ramp = theme.type[variant]

  return (
    <RNText
      {...rest}
      style={[
        {
          fontSize: ramp.fontSize,
          lineHeight: ramp.lineHeight,
          fontWeight: weight ?? ramp.fontWeight,
          color: toneColor(theme, tone),
          textAlign: align,
        },
        style,
      ]}
    />
  )
}

/**
 * A screen or section title. Announced as a heading to VoiceOver and TalkBack, which is how a
 * screen-reader user skims a long page.
 *
 * `level` picks the size from the ramp. React Native has no heading-depth attribute — the role is
 * the whole of what assistive technology gets — so it is visual weight, not semantics.
 */
export function Heading({
  level = 2,
  variant,
  ...rest
}: TextProps & { level?: 1 | 2 | 3 }): React.ReactElement {
  const fallback: TypeVariant = level === 1 ? 'display' : level === 2 ? 'title' : 'heading'
  return <Text accessibilityRole="header" variant={variant ?? fallback} {...rest} />
}
