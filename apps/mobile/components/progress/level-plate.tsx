import * as React from 'react'
import { View } from 'react-native'

import { Text } from '@/components/ui'
import { useTheme } from '@/lib/theme'
import { formatXp, levelProgress, rankForLevel } from '@onpitch/shared/gamification'

import { Eyebrow, HairlineBar, Measure } from './primitives'

/**
 * The level readout.
 *
 * The web draws a ring; this draws a plate. That is a deliberate divergence rather than a
 * shortfall: an SVG arc on React Native means adding `react-native-svg`, a native module, to a
 * dependency set that is pinned to Expo SDK 57 and was hard-won — for one decorative circle.
 * The plate says exactly the same three things (which level, how far into it, what is left) in
 * the same vocabulary of rules and mono labels the rest of the product uses, and it costs
 * nothing.
 */

export interface LevelPlateProps {
  xp: number
  /** The database's stored level. It is GENERATED from xp, so it wins over the local curve. */
  level: number
}

export function LevelPlate({ xp, level }: LevelPlateProps): React.ReactElement {
  const theme = useTheme()
  const progress = levelProgress(xp)
  const rank = rankForLevel(level)

  return (
    <View
      accessible
      accessibilityLabel={`Seviye ${level}, ${rank.tr}. ${formatXp(progress.into)} bölü ${formatXp(
        progress.span,
      )} tecrübe puanı.`}
    >
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: theme.spacing.md }}>
        <View>
          <Eyebrow>Seviye</Eyebrow>
          <Text
            weight="300"
            style={{
              fontSize: 56,
              lineHeight: 60,
              marginTop: 2,
              fontVariant: ['tabular-nums'],
              color: theme.colors.foreground,
            }}
          >
            {level}
          </Text>
        </View>

        <View style={{ paddingBottom: 10 }}>
          <Text
            variant="caption"
            weight="600"
            style={{ color: theme.colors.gold, letterSpacing: 1.4, textTransform: 'uppercase' }}
          >
            {rank.tr}
          </Text>
          <Text variant="body" tone="muted" style={{ marginTop: 2 }}>
            {formatXp(xp)} XP
          </Text>
        </View>
      </View>

      <HairlineBar ratio={progress.ratio} style={{ marginTop: theme.spacing.lg }} />

      <View
        style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          marginTop: theme.spacing.sm,
        }}
      >
        <Text variant="caption" tone="muted" style={{ fontVariant: ['tabular-nums'] }}>
          {formatXp(progress.into)} / {formatXp(progress.span)}
        </Text>
        <Text variant="caption" style={{ color: theme.colors.gold, fontVariant: ['tabular-nums'] }}>
          {formatXp(progress.remaining)} XP kaldı
        </Text>
      </View>
    </View>
  )
}

/** The four counters worth putting under the plate. */
export function CounterRow({
  matches,
  wins,
  goals,
  assists,
}: {
  matches: number
  wins: number
  goals: number
  assists: number
}): React.ReactElement {
  const theme = useTheme()
  return (
    <View style={{ flexDirection: 'row', gap: theme.spacing.lg }}>
      <Measure label="Maç" value={matches} style={{ flex: 1 }} />
      <Measure label="Galibiyet" value={wins} tone="teal" style={{ flex: 1 }} />
      <Measure label="Gol" value={goals} tone="gold" style={{ flex: 1 }} />
      <Measure label="Asist" value={assists} style={{ flex: 1 }} />
    </View>
  )
}
