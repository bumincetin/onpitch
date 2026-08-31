/**
 * components/match/scoreboard.tsx
 *
 * The score, in two clearly separated lanes.
 *
 * THE OFFICIAL LANE is `matches.home_score` / `away_score`. Those columns are in no client UPDATE
 * grant (0002_rls.sql §4) — a result enters the system only through `score_reports` and the
 * corroboration pass that follows. So this lane is either a confirmed result or nothing.
 *
 * THE RUNNING COUNT is the broadcast tally: whatever somebody at the pitch last tapped. It is
 * fast, unofficial and lossy, it settles nothing, and it is rendered smaller, lower and labelled
 * so it can never be mistaken for the first lane. A scoreboard that showed one number would be
 * lying about which of the two it was.
 */

import * as React from 'react'
import { AccessibilityInfo, Platform, View } from 'react-native'

import { CONNECTION_LABEL, type RealtimeConnection } from '@halisaha/shared/channels'
import type { Enums } from '@halisaha/shared/database'

import { Badge, Text, type BadgeTone } from '@/components/ui'
import { formatRelative } from '@/lib/format'
import { useTheme } from '@/lib/theme'

import { MATCH_STATUS_META } from './match-card'

export interface ScoreboardProps {
  /** Team name, or "Home" when the fixture has no named teams. */
  homeLabel: string
  awayLabel: string
  /** The authoritative result. Null means no result exists yet — render a dash, never a zero. */
  homeScore: number | null
  awayScore: number | null
  status: Enums<'match_status'>
  /** The unofficial broadcast tally, when a live channel is attached. */
  tally?: { home: number; away: number } | null
  /** Live connection state. Omit on a static screen and no indicator is drawn. */
  connection?: RealtimeConnection
  /** When anything last arrived on the live channel. */
  lastEventAt?: Date | null
  /** Highlights whichever side the viewer is on. */
  yourSide?: 'home' | 'away' | null
}

const CONNECTION_TONE: Record<RealtimeConnection, BadgeTone> = {
  connecting: 'outline',
  connected: 'success',
  reconnecting: 'warning',
  offline: 'destructive',
  disabled: 'outline',
}

export function Scoreboard({
  homeLabel,
  awayLabel,
  homeScore,
  awayScore,
  status,
  tally = null,
  connection,
  lastEventAt = null,
  yourSide = null,
}: ScoreboardProps): React.ReactElement {
  const theme = useTheme()
  const meta = MATCH_STATUS_META[status]

  const settled = typeof homeScore === 'number' && typeof awayScore === 'number'
  const officialHome = settled ? String(homeScore) : '–'
  const officialAway = settled ? String(awayScore) : '–'

  // Only worth showing when it says something the official lane does not.
  const tallyDiffers =
    tally !== null && (!settled || tally.home !== homeScore || tally.away !== awayScore)

  // ONE label for the whole card. `accessible` on this container collapses everything inside it
  // into a single element on iOS, so a second `accessible` block nested within would never be
  // reachable — the running count has to be spoken from here or not at all.
  const label = [
    settled
      ? `${homeLabel} ${homeScore}, ${awayLabel} ${awayScore}.`
      : `${homeLabel} - ${awayLabel}. Henüz sonuç yok.`,
    tallyDiffers && tally ? `Anlık sayaç, resmi değil: ${tally.home} - ${tally.away}.` : null,
    `${meta.label}.`,
  ]
    .filter((part): part is string => part !== null)
    .join(' ')

  // A live region re-announces a changed score on Android. iOS ignores the prop entirely, so the
  // announcement is made explicitly there. The first render is skipped on both: arriving on the
  // screen already reads the card out, and repeating it would be noise.
  const announcedRef = React.useRef<string | null>(null)

  React.useEffect(() => {
    const previous = announcedRef.current
    announcedRef.current = label
    if (previous === null || previous === label || Platform.OS === 'android') return
    AccessibilityInfo.announceForAccessibility(label)
  }, [label])

  return (
    <View
      accessible
      accessibilityLiveRegion="polite"
      accessibilityLabel={label}
      style={{
        gap: theme.spacing.lg,
        padding: theme.spacing.lg,
        borderRadius: theme.radius.xl,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.card,
      }}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: theme.spacing.sm,
        }}
      >
        <Badge tone={meta.tone} size="sm">
          {meta.label}
        </Badge>
        {connection ? (
          <Badge tone={CONNECTION_TONE[connection]} size="sm">
            {CONNECTION_LABEL[connection]}
          </Badge>
        ) : null}
      </View>

      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <SideColumn label={homeLabel} value={officialHome} highlighted={yourSide === 'home'} />
        <Text variant="title" tone="muted" style={{ paddingHorizontal: theme.spacing.sm }}>
          –
        </Text>
        <SideColumn label={awayLabel} value={officialAway} highlighted={yourSide === 'away'} />
      </View>

      <Text variant="caption" tone="muted" align="center">
        {settled
          ? 'Confirmed result, from the reports both sides filed.'
          : 'No result yet. A score only exists once it has been reported and corroborated.'}
      </Text>

      {tallyDiffers && tally ? (
        <View
          style={{
            gap: theme.spacing.xs,
            paddingTop: theme.spacing.md,
            borderTopWidth: 1,
            borderTopColor: theme.colors.border,
          }}
        >
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'baseline',
              justifyContent: 'space-between',
            }}
          >
            <Text variant="label" tone="muted">
              Anlık sayaç
            </Text>
            <Text variant="heading" weight="700" style={{ fontVariant: ['tabular-nums'] }}>
              {tally.home} – {tally.away}
            </Text>
          </View>
          <Text variant="caption" tone="muted">
            Tapped in by people at the pitch. It is not the result and nothing is stored until
            somebody reports the score.
            {lastEventAt ? ` Last update ${formatRelative(lastEventAt.toISOString())}.` : ''}
          </Text>
        </View>
      ) : null}
    </View>
  )
}

function SideColumn({
  label,
  value,
  highlighted,
}: {
  label: string
  value: string
  highlighted: boolean
}): React.ReactElement {
  const theme = useTheme()

  return (
    <View style={{ flex: 1, alignItems: 'center', gap: theme.spacing.xs }}>
      <Text
        variant="display"
        weight="700"
        style={{ fontVariant: ['tabular-nums'], fontSize: 44, lineHeight: 50 }}
      >
        {value}
      </Text>
      <Text
        variant="label"
        tone={highlighted ? 'primary' : 'muted'}
        align="center"
        numberOfLines={2}
      >
        {label}
      </Text>
    </View>
  )
}
