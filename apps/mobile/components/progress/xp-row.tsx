import * as React from 'react'
import { View } from 'react-native'

import { Text } from '@/components/ui'
import { useTheme } from '@/lib/theme'
import { XP_EVENT_LABELS, formatXp, type XpEvent } from '@halisaha/shared/gamification'

/**
 * One line of the XP ledger.
 *
 * A points system that cannot answer "where did that come from" is a slot machine. This is the
 * receipt, straight off the `xp_events` table that the running total is the sum of.
 *
 * The timestamp is formatted in a FIXED zone. A ledger entry earned at a 22:00 kick-off in
 * Istanbul should read 22:00 for a player checking it from anywhere.
 */

const STAMP = new Intl.DateTimeFormat('tr-TR', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Europe/Istanbul',
})

export function XpRow({ event }: { event: XpEvent }): React.ReactElement {
  const theme = useTheme()
  const at = Date.parse(event.createdAt)
  const stamp = Number.isNaN(at) ? null : STAMP.format(new Date(at))
  const positive = event.points >= 0

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'baseline',
        gap: theme.spacing.md,
        paddingVertical: theme.spacing.md,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
      }}
    >
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text variant="body" numberOfLines={1}>
          {XP_EVENT_LABELS[event.kind]}
        </Text>
        {stamp ? (
          <Text
            variant="caption"
            tone="muted"
            style={{ marginTop: 2, letterSpacing: 1, textTransform: 'uppercase', fontSize: 10 }}
          >
            {stamp}
          </Text>
        ) : null}
      </View>

      <Text
        variant="body"
        weight="500"
        style={{
          fontVariant: ['tabular-nums'],
          color: positive ? theme.colors.gold : theme.colors.vermilion,
        }}
      >
        {positive ? '+' : '−'}
        {formatXp(Math.abs(event.points))}
      </Text>
    </View>
  )
}
