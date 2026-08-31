/**
 * components/profile/stats-grid.tsx
 *
 * The counting stats, in tiles.
 *
 * Two sources feed this and they are not interchangeable, so the labels say which is which.
 * Matches, wins, draws and losses come from `player_ratings`, which the rating engine maintains
 * for a player's whole career. Goals and assists are summed from whatever slice of `player_stats`
 * the screen loaded, and `windowLabel` names that slice — claiming a career total from twenty rows
 * would be wrong for anyone who has played twenty-one matches.
 */

import * as React from 'react'
import { View, type StyleProp, type ViewStyle } from 'react-native'

import { Card, Text } from '@/components/ui'
import { useTheme } from '@/lib/theme'

export interface StatsGridProps {
  matchesPlayed: number
  wins: number
  draws: number
  losses: number
  /** Summed over the loaded history slice. Omit when no history was loaded. */
  goals?: number | null
  assists?: number | null
  /** What the goals and assists were counted over, e.g. "last 20 matches". */
  windowLabel?: string
  style?: StyleProp<ViewStyle>
}

interface Tile {
  key: string
  label: string
  value: string
  /** Extra line under the value, for the qualifier on a windowed stat. */
  note?: string
}

export function StatsGrid({
  matchesPlayed,
  wins,
  draws,
  losses,
  goals = null,
  assists = null,
  windowLabel,
  style,
}: StatsGridProps): React.ReactElement {
  const theme = useTheme()

  const winRate = matchesPlayed > 0 ? Math.round((wins / matchesPlayed) * 100) : null

  const tiles: Tile[] = [
    { key: 'played', label: 'Maç', value: String(matchesPlayed) },
    { key: 'record', label: 'G / B / M', value: `${wins} / ${draws} / ${losses}` },
    {
      key: 'winrate',
      label: 'Galibiyet oranı',
      value: winRate === null ? '—' : `${winRate}%`,
      note: winRate === null ? 'No ranked matches yet' : undefined,
    },
  ]

  if (typeof goals === 'number') {
    tiles.push({ key: 'goals', label: 'Gol', value: String(goals), note: windowLabel })
  }
  if (typeof assists === 'number') {
    tiles.push({ key: 'assists', label: 'Asist', value: String(assists), note: windowLabel })
  }

  return (
    <Card title="Karne" style={style}>
      <View
        style={{
          flexDirection: 'row',
          flexWrap: 'wrap',
          // A row of two on a narrow phone, three when the text is not scaled up. `minWidth`
          // rather than a fixed column count keeps it honest at 200% font size.
          gap: theme.spacing.md,
        }}
      >
        {tiles.map((tile) => (
          <View
            key={tile.key}
            accessible
            accessibilityLabel={`${tile.label}: ${tile.value}${tile.note ? `, ${tile.note}` : ''}`}
            style={{
              flexGrow: 1,
              flexBasis: 120,
              minWidth: 100,
              gap: theme.spacing.xs,
              padding: theme.spacing.md,
              borderRadius: theme.radius.lg,
              backgroundColor: theme.colors.muted,
            }}
          >
            <Text variant="caption" tone="muted">
              {tile.label}
            </Text>
            <Text variant="title">{tile.value}</Text>
            {tile.note ? (
              <Text variant="caption" tone="muted">
                {tile.note}
              </Text>
            ) : null}
          </View>
        ))}
      </View>
    </Card>
  )
}
