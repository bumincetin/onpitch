import * as React from 'react'
import { Pressable, View } from 'react-native'

import { Text } from '@/components/ui'
import { useTheme } from '@/lib/theme'
import {
  formatXp,
  rankForLevel,
  type LeaderboardEntry,
  type LeaderboardScope,
} from '@halisaha/shared/gamification'

/**
 * One line of the ranking.
 *
 * The measure column follows the scope. A table sorted by streak that still shows XP as its
 * headline number is a table nobody can read, so the value and the heading move together.
 *
 * The viewer's own row is tinted rather than pinned to the top: where you actually stand is the
 * information, and moving the row destroys it.
 */

export function measureFor(entry: LeaderboardEntry, scope: LeaderboardScope): string {
  if (scope === 'rating') return entry.conservativeRating.toFixed(1)
  if (scope === 'streak') return `${entry.currentStreakWeeks} hf`
  return formatXp(entry.xp)
}

export interface LeaderboardRowProps {
  entry: LeaderboardEntry
  scope: LeaderboardScope
  isViewer: boolean
  onPress?: (playerId: string) => void
}

export function LeaderboardRow({
  entry,
  scope,
  isViewer,
  onPress,
}: LeaderboardRowProps): React.ReactElement {
  const theme = useTheme()
  const rank = rankForLevel(entry.level)

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${entry.rank}. ${entry.displayName}, seviye ${entry.level}${
        isViewer ? ', sen' : ''
      }`}
      onPress={() => onPress?.(entry.playerId)}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.md,
        paddingVertical: theme.spacing.md,
        paddingHorizontal: isViewer ? theme.spacing.sm : 0,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
        // A tint rather than a border: the row has to be findable while scrolling without
        // becoming a second kind of row.
        backgroundColor: isViewer ? `${theme.colors.gold}1A` : 'transparent',
      }}
    >
      <Text
        variant="caption"
        tone="muted"
        style={{ width: 26, fontVariant: ['tabular-nums'] }}
      >
        {String(entry.rank).padStart(2, '0')}
      </Text>

      <View style={{ flex: 1, minWidth: 0 }}>
        <Text variant="body" weight="500" numberOfLines={1}>
          {entry.displayName}
        </Text>
        <Text
          variant="caption"
          tone="muted"
          style={{ marginTop: 2, letterSpacing: 1, textTransform: 'uppercase', fontSize: 10 }}
        >
          {rank.tr} · {entry.level}
          {entry.city ? ` · ${entry.city}` : ''}
        </Text>
      </View>

      <Text
        variant="body"
        weight="500"
        style={{ fontVariant: ['tabular-nums'], color: theme.colors.foreground }}
      >
        {measureFor(entry, scope)}
      </Text>
    </Pressable>
  )
}
