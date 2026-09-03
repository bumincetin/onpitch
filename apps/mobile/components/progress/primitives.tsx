import * as React from 'react'
import { View, type StyleProp, type ViewStyle } from 'react-native'
import Animated, { ReduceMotion, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated'

import { EASE_OUT } from '@/lib/motion'

import { Text } from '@/components/ui'
import { useTheme } from '@/lib/theme'

/**
 * The editorial primitives, ported from the web app's dashboard.
 *
 * Three shapes carry the whole design: a hairline rule, a numbered section head, and a measure
 * (label above, number below, rule on top). Everything on the progress screens is built from
 * these, which is what keeps the phone and the browser recognisably the same product without
 * sharing a single line of layout code.
 *
 * `Eyebrow` is the mono uppercase label the web calls `.label-eyebrow`. React Native has no
 * `letter-spacing` shorthand in a class, so it is a component rather than a style constant —
 * and having it as a component means the tracking is set in one place instead of copied into
 * thirty `<Text>` props.
 */

export function Eyebrow({
  children,
  tone = 'muted',
  style,
}: {
  children: React.ReactNode
  tone?: 'muted' | 'gold' | 'default'
  style?: StyleProp<ViewStyle>
}): React.ReactElement {
  const theme = useTheme()
  const color =
    tone === 'gold'
      ? theme.colors.gold
      : tone === 'default'
        ? theme.colors.foreground
        : theme.colors.mutedForeground

  return (
    <View style={style}>
      <Text
        variant="caption"
        weight="600"
        style={{ color, letterSpacing: 1.4, textTransform: 'uppercase', fontSize: 11 }}
      >
        {children}
      </Text>
    </View>
  )
}

/** A hairline at the ink's own colour, faint enough to structure without dividing. */
export function Rule({ style }: { style?: StyleProp<ViewStyle> }): React.ReactElement {
  const theme = useTheme()
  return <View style={[{ height: 1, backgroundColor: theme.colors.border }, style]} />
}

/** Section head: gold number, title, and a rule running to the edge. */
export function SectionHead({
  n,
  title,
  aside,
  style,
}: {
  n: string
  title: string
  aside?: React.ReactNode
  style?: StyleProp<ViewStyle>
}): React.ReactElement {
  const theme = useTheme()
  return (
    <View
      style={[
        { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md },
        style,
      ]}
    >
      <Text variant="caption" weight="600" style={{ color: theme.colors.gold, letterSpacing: 1.4 }}>
        {n}
      </Text>
      <Text variant="heading" weight="500">
        {title}
      </Text>
      <View style={{ flex: 1, height: 1, backgroundColor: theme.colors.border }} />
      {aside}
    </View>
  )
}

/** Label above, value below, rule on top. The way every number on these screens is stated. */
export function Measure({
  label,
  value,
  hint,
  tone = 'default',
  style,
}: {
  label: string
  value: React.ReactNode
  hint?: string
  tone?: 'default' | 'gold' | 'teal' | 'vermilion'
  style?: StyleProp<ViewStyle>
}): React.ReactElement {
  const theme = useTheme()
  const color =
    tone === 'gold'
      ? theme.colors.gold
      : tone === 'teal'
        ? theme.colors.teal
        : tone === 'vermilion'
          ? theme.colors.vermilion
          : theme.colors.foreground

  return (
    <View style={[{ borderTopWidth: 1, borderTopColor: theme.colors.border, paddingTop: 8 }, style]}>
      <Eyebrow>{label}</Eyebrow>
      <Text variant="title" weight="300" style={{ color, marginTop: 4, fontVariant: ['tabular-nums'] }}>
        {value}
      </Text>
      {hint ? (
        <Text variant="caption" tone="muted" style={{ marginTop: 4 }}>
          {hint}
        </Text>
      ) : null}
    </View>
  )
}

/**
 * A hairline that fills. The progress vocabulary everywhere in this product: a rule with a
 * coloured segment, never a rounded pill.
 */
export function HairlineBar({
  ratio,
  color,
  style,
}: {
  ratio: number
  color?: string
  style?: StyleProp<ViewStyle>
}): React.ReactElement {
  const theme = useTheme()
  const clamped = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0))

  // The fill draws itself in from zero, the way the web's `scroll-tick` draws a rule. Width is
  // measured once and animated as pixels; the UI thread never sees a percentage string.
  const width = useSharedValue(0)
  const fill = useSharedValue(0)
  React.useEffect(() => {
    fill.value = withTiming(clamped, { duration: 900, easing: EASE_OUT, reduceMotion: ReduceMotion.System })
  }, [clamped, fill])
  const animated = useAnimatedStyle(() => ({ width: width.value * fill.value }))

  return (
    <View
      accessible={false}
      onLayout={(event) => {
        width.value = event.nativeEvent.layout.width
      }}
      style={[{ height: 1, backgroundColor: theme.colors.border, overflow: 'hidden' }, style]}
    >
      <Animated.View style={[{ height: 1, backgroundColor: color ?? theme.colors.user }, animated]} />
    </View>
  )
}
