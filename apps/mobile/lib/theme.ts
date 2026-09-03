/**
 * lib/theme.ts
 *
 * Design tokens, ported from the web app's shadcn palette in apps/web/app/globals.css.
 *
 * The web stores bare `H S% L%` triples so Tailwind can wrap them in `hsl()` and apply opacity
 * modifiers. React Native has no such indirection, so the same colours are pre-resolved to hex
 * here. Keep the two files in step; a token defined in one and not the other leaves the two
 * clients rendering the same screen in different colours.
 *
 * Brand hue is 142 — pitch green.
 */

import * as React from 'react'
import { useColorScheme } from 'react-native'

import { ACCENT_HEX, useAccent } from '@/lib/accent'

export interface ThemeColors {
  /** Page background. */
  background: string
  /** Default text on `background`. */
  foreground: string
  /** Raised surface: cards, list rows, sheets. */
  card: string
  cardForeground: string
  /** Floating surface: menus, popovers. */
  popover: string
  popoverForeground: string
  /** Brand green. Primary actions, active tab, focus ring. */
  primary: string
  primaryForeground: string
  /** Quiet fill for secondary buttons and chips. */
  secondary: string
  secondaryForeground: string
  /** Background for de-emphasised blocks. */
  muted: string
  /** Secondary text. Meets 4.5:1 on `background` in both schemes. */
  mutedForeground: string
  accent: string
  accentForeground: string
  destructive: string
  destructiveForeground: string
  success: string
  successForeground: string
  warning: string
  warningForeground: string
  /**
   * Named accents, for the places that mean the COLOUR rather than the role: gold on a level
   * number, teal on a completed objective, vermilion on a loss. The web app carries the same
   * four as CSS variables, and a screen that reached for `warning` when it meant "gold" would
   * be one rename away from saying something it does not mean.
   */
  gold: string
  teal: string
  vermilion: string
  azure: string
  /**
   * The signed-in person's chosen accent (profiles.accent_color), resolved for this scheme by
   * `useTheme()` from the `AccentProvider`. Gold until a profile has loaded. The web's
   * `--accent-user`: the tab tint, the avatar ring, the number on the card, own message bubbles.
   */
  user: string
  /** Hairline borders and dividers. */
  border: string
  /** Border of a text input at rest. */
  input: string
  /** Focus ring. */
  ring: string
  /** Scrim behind a modal sheet. */
  overlay: string
}

const lightColors: ThemeColors = {
  // Editorial paper palette, shared with the web app. Warm ground, navy ink, gold accent.
  // Primary is ink rather than gold: buttons read as set type and gold stays an accent.
  background: '#F6F1E7',
  foreground: '#1B2230',
  card: '#FDFAF3',
  cardForeground: '#1B2230',
  popover: '#FDFAF3',
  popoverForeground: '#1B2230',
  primary: '#1B2230',
  primaryForeground: '#F6F1E7',
  secondary: '#ECE4D3',
  secondaryForeground: '#1B2230',
  muted: '#ECE4D3',
  mutedForeground: '#6B7160',
  accent: '#E3DCCB',
  accentForeground: '#1B2230',
  destructive: '#CF2734',
  destructiveForeground: '#F6F1E7',
  success: '#178F9A',
  successForeground: '#F6F1E7',
  // Gold is both the brand accent and the caution state, because here they are the same
  // thing: a yellow card.
  warning: '#B8902E',
  warningForeground: '#F6F1E7',
  gold: '#B8902E',
  teal: '#178F9A',
  vermilion: '#CF2734',
  azure: '#1F5FA8',
  user: '#B8902E',
  border: '#D3D0CA',
  input: '#D3D0CA',
  ring: '#B8902E',
  overlay: 'rgba(27, 34, 48, 0.45)',
}

const darkColors: ThemeColors = {
  background: '#1B2230',
  foreground: '#F6F1E7',
  card: '#232C3D',
  cardForeground: '#F6F1E7',
  popover: '#232C3D',
  popoverForeground: '#F6F1E7',
  primary: '#F6F1E7',
  primaryForeground: '#1B2230',
  secondary: '#2B3446',
  secondaryForeground: '#F6F1E7',
  muted: '#2B3446',
  mutedForeground: '#9AA2B1',
  accent: '#2B3446',
  accentForeground: '#F6F1E7',
  destructive: '#E04B56',
  destructiveForeground: '#1B2230',
  success: '#2AB3BE',
  successForeground: '#1B2230',
  warning: '#D4A838',
  warningForeground: '#1B2230',
  // Lifted so they survive on the near-black ground, matching the web's `.night` scope.
  gold: '#E0B352',
  teal: '#2FB8BF',
  vermilion: '#E8483F',
  azure: '#4D8FD6',
  user: '#E0B352',
  border: '#3D4453',
  input: '#3D4453',
  ring: '#D4A838',
  overlay: 'rgba(0, 0, 0, 0.65)',
}

/**
 * A 4pt scale. `md` is the default gap inside a component, `lg` the gutter between components,
 * `xl` the screen padding.
 */
const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
} as const

/** `--radius` on the web is 0.625rem = 10px; `md` and `sm` step down from it as Tailwind does. */
const radius = {
  sm: 1,
  md: 2,
  lg: 2,
  xl: 2,
  full: 999,
} as const

/**
 * Type ramp. Sizes are absolute rather than scaled, so `allowFontScaling` (on by default) still
 * grows them for a user who has enlarged text in OS settings.
 *
 * `fontWeight` values are string literals so they satisfy `TextStyle['fontWeight']` without a
 * cast at every call site.
 */
const type = {
  display: { fontSize: 28, lineHeight: 34, fontWeight: '700' },
  title: { fontSize: 20, lineHeight: 26, fontWeight: '600' },
  heading: { fontSize: 17, lineHeight: 22, fontWeight: '600' },
  body: { fontSize: 15, lineHeight: 21, fontWeight: '400' },
  label: { fontSize: 13, lineHeight: 18, fontWeight: '500' },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: '400' },
} as const

/**
 * The light theme, and the type every themed value is measured against.
 *
 * Exported as a plain object so non-React code (a StyleSheet at module scope, a formatter) can
 * reach the scale. Anything that renders should call `useTheme()` instead, or it will keep the
 * light palette when the OS is in dark mode.
 */
export const theme = {
  colors: lightColors,
  spacing,
  radius,
  type,
}

export type Theme = typeof theme
export type Spacing = keyof typeof spacing
export type Radius = keyof typeof radius
export type TypeVariant = keyof typeof type

/** Same shape, dark palette. */
export const darkTheme: Theme = {
  colors: darkColors,
  spacing,
  radius,
  type,
}

/**
 * The themed tokens for the current OS colour scheme.
 *
 * `useColorScheme()` returns null while the platform is still reporting — treat that as light
 * rather than flipping to dark for a frame.
 */
export function useTheme(): Theme {
  const scheme = useColorScheme()
  const { accent } = useAccent()
  const dark = scheme === 'dark'
  // Memoised so a screen that puts the theme in a dependency list does not re-run on every
  // render; the object only changes when the scheme or the person's accent does.
  return React.useMemo(() => {
    const base = dark ? darkTheme : theme
    const user = ACCENT_HEX[accent][dark ? 'dark' : 'light']
    return user === base.colors.user ? base : { ...base, colors: { ...base.colors, user } }
  }, [accent, dark])
}

/** True when the OS is in dark mode. For the status bar and for `KeyboardAvoidingView` styling. */
export function useIsDark(): boolean {
  return useColorScheme() === 'dark'
}
