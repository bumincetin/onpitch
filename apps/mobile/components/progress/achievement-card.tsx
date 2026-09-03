import * as React from 'react'
import { View } from 'react-native'

import { Text } from '@/components/ui'
import { useTheme } from '@/lib/theme'
import {
  TIER_COLORS,
  TIER_LABELS,
  formatXp,
  type AchievementState,
} from '@onpitch/shared/gamification'

import { Eyebrow, HairlineBar } from './primitives'

/**
 * One badge.
 *
 * Locked badges render at reduced opacity rather than being hidden, and the criterion is always
 * on the card. A badge you cannot work out how to earn is a badge nobody chases, and this
 * product has no reason to run a treasure hunt.
 *
 * The tier is a small rotated square and a word, not a filled tile. At list density a wall of
 * coloured blocks reads as noise; the rest of the app speaks in rules and marks.
 */

export function AchievementCard({
  achievement,
}: {
  achievement: AchievementState
}): React.ReactElement {
  const theme = useTheme()
  const unlocked = achievement.unlockedAt !== null
  const tint = TIER_COLORS[achievement.tier]
  const ratio = achievement.target > 0 ? achievement.progress / achievement.target : 0

  return (
    <View
      style={{
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
        paddingVertical: theme.spacing.lg,
        opacity: unlocked ? 1 : 0.65,
      }}
    >
      <View
        style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}
      >
        <View
          style={{
            width: 10,
            height: 10,
            borderWidth: 1,
            borderColor: tint,
            backgroundColor: unlocked ? tint : 'transparent',
            transform: [{ rotate: '45deg' }],
          }}
        />
        <Text variant="body" weight="500" style={{ flex: 1 }}>
          {achievement.name}
        </Text>
        <Text
          variant="caption"
          weight="600"
          style={{ color: tint, letterSpacing: 1.2, textTransform: 'uppercase', fontSize: 10 }}
        >
          {TIER_LABELS[achievement.tier]}
        </Text>
      </View>

      <Text variant="caption" tone="muted" style={{ marginTop: 6 }}>
        {achievement.description}
      </Text>

      {unlocked ? (
        <Eyebrow tone="gold" style={{ marginTop: theme.spacing.md }}>
          Kazanıldı · +{formatXp(achievement.xpReward)} XP
        </Eyebrow>
      ) : (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.spacing.md,
            marginTop: theme.spacing.md,
          }}
        >
          <HairlineBar ratio={ratio} color={tint} style={{ flex: 1 }} />
          <Text variant="caption" tone="muted" style={{ fontVariant: ['tabular-nums'] }}>
            {achievement.progress} / {achievement.target}
          </Text>
        </View>
      )}
    </View>
  )
}
