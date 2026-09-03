import * as React from 'react'
import { View, type StyleProp, type ViewStyle } from 'react-native'

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

  return (
    <View
      accessible={false}
      style={[{ height: 1, backgroundColor: theme.colors.border, overflow: 'hidden' }, style]}
    >
      <View
        style={{
          height: 1,
          // `flex` cannot express "this fraction of the parent", and a measured pixel width
          // would need an onLayout round trip on every row. A percentage string is the one
          // thing React Native accepts here that survives rotation for free.
          width: `${clamped * 100}%`,
          backgroundColor: color ?? theme.colors.user,
        }}
      />
    </View>
  )
}
