/**
 * components/profile/match-history.tsx
 *
 * Recent matches, and the form strip above them.
 *
 * One row is one `player_stats` row joined to its `matches` row. Both halves can be missing and
 * the row still has to render: `player_stats` is written when the score is filed, `mu_after` and
 * `rating_delta` only once the result is final and `apply_match_rating` has run, and
 * `matches_select_*` may hide a match this viewer cannot see even though the stat row is theirs.
 * Every field is therefore nullable and every gap renders as a dash with a reason, never as a
 * missing row.
 */

import { useRouter } from 'expo-router'
import * as React from 'react'
import { View, type StyleProp, type ViewStyle } from 'react-native'

import type { Enums } from '@halisaha/shared/database'
import type { TeamSide } from '@halisaha/shared/domain'

import { Badge, Card, EmptyState, Separator, Spinner, Text, type BadgeTone } from '@/components/ui'
import { formatKickoff } from '@/lib/format'
import { useTheme } from '@/lib/theme'

import { directionOf, formatSigned } from './uncertainty-bar'

/** One match as it appears in a player's history. */
export interface MatchHistoryEntry {
  /** `player_stats.id` — the row key. Two stat rows can point at one match in a replay. */
  statId: string
  matchId: string
  kickoffAt: string | null
  /**
   * `venues.timezone` for the fixture, when the venue was readable. The kick-off is quoted in the
   * venue's zone so a row here reads the same as the match screen it opens.
   */
  timezone: string | null
  status: Enums<'match_status'> | null
  homeScore: number | null
  awayScore: number | null
  teamSide: TeamSide | null
  isRanked: boolean
  /** `player_stats.rating_delta` — the change in mu, not in the ranked number. */
  ratingDelta: number | null
  goals: number
  assists: number
}

export type MatchResult = 'win' | 'draw' | 'loss'

/**
 * Which way the match went for this player.
 *
 * Null when the score has not been agreed yet, or when the stat row carries no side — both are
 * real states, and guessing at either would put a fabricated W on someone's form strip.
 */
export function resultOf(entry: MatchHistoryEntry): MatchResult | null {
  const { homeScore, awayScore, teamSide } = entry
  if (typeof homeScore !== 'number' || typeof awayScore !== 'number' || teamSide === null) {
    return null
  }
  if (homeScore === awayScore) return 'draw'
  const homeWon = homeScore > awayScore
  return (teamSide === 'home') === homeWon ? 'win' : 'loss'
}

const RESULT_META: Readonly<Record<MatchResult, { label: string; short: string; tone: BadgeTone }>> =
  {
    win: { label: 'Galibiyet', short: 'W', tone: 'success' },
    draw: { label: 'Beraberlik', short: 'D', tone: 'neutral' },
    loss: { label: 'Mağlubiyet', short: 'L', tone: 'destructive' },
  }

const STATUS_META: Readonly<Record<Enums<'match_status'>, { label: string; tone: BadgeTone }>> = {
  scheduled: { label: 'Planlandı', tone: 'outline' },
  live: { label: 'Canlı', tone: 'primary' },
  awaiting_report: { label: 'Skor bekleniyor', tone: 'warning' },
  requires_consensus: { label: 'Uzlaşma gerekiyor', tone: 'warning' },
  disputed: { label: 'İtirazlı', tone: 'destructive' },
  finalized: { label: 'Kesin', tone: 'success' },
  cancelled: { label: 'İptal edildi', tone: 'outline' },
}

/* -------------------------------------------------------------------------- */
/*  Form strip                                                                 */
/* -------------------------------------------------------------------------- */

export interface FormStripProps {
  /** Most recent first. Only settled matches are drawn; the rest are skipped, not faked. */
  entries: readonly MatchHistoryEntry[]
  /** How many chips to draw. */
  limit?: number
  style?: StyleProp<ViewStyle>
}

/** The last few results as W/D/L chips, newest on the left. */
export function FormStrip({ entries, limit = 5, style }: FormStripProps): React.ReactElement {
  const theme = useTheme()

  const settled: Array<{ key: string; result: MatchResult }> = []
  for (const entry of entries) {
    const result = resultOf(entry)
    if (result === null) continue
    settled.push({ key: entry.statId, result })
    if (settled.length === limit) break
  }

  if (settled.length === 0) {
    return (
      <View style={style}>
        <Text variant="caption" tone="muted">
          Henüz kesinleşmiş sonuç yok, gösterilecek form da yok.
        </Text>
      </View>
    )
  }

  const spoken = settled.map((item) => RESULT_META[item.result].label.toLowerCase()).join(', ')

  return (
    <View
      accessible
      accessibilityLabel={`Recent form, newest first: ${spoken}.`}
      style={[{ flexDirection: 'row', gap: theme.spacing.sm }, style]}
    >
      {settled.map((item) => (
        <Badge key={item.key} tone={RESULT_META[item.result].tone} size="sm">
          {RESULT_META[item.result].short}
        </Badge>
      ))}
    </View>
  )
}

/* -------------------------------------------------------------------------- */
/*  History list                                                               */
/* -------------------------------------------------------------------------- */

export interface MatchHistoryProps {
  entries: readonly MatchHistoryEntry[]
  title?: string
  /** Shown while the first page is in flight. */
  loading?: boolean
  /** Replaces the list with a failure state. */
  error?: string | null
  onRetry?: () => void
  /** Copy for the no-rows case. Say what would put a row here. */
  emptyTitle?: string
  emptyDescription?: string
  style?: StyleProp<ViewStyle>
}

/**
 * The list itself. Rendered inside a Card, so it must never be wrapped in its own ScrollView —
 * a screen scrolls, a history does not.
 */
export function MatchHistory({
  entries,
  title = 'Son maçlar',
  loading = false,
  error = null,
  onRetry,
  emptyTitle = 'No matches yet',
  emptyDescription = 'Join a match and it shows up here with the rating it moved.',
  style,
}: MatchHistoryProps): React.ReactElement {
  const theme = useTheme()

  let body: React.ReactNode

  if (error) {
    body = (
      <EmptyState
        tone="destructive"
        title="Geçmiş yüklenemedi"
        description={error}
        action={onRetry ? { label: 'Tekrar dene', onPress: onRetry } : undefined}
      />
    )
  } else if (loading) {
    body = <Spinner centred label="Maçlar yükleniyor" />
  } else if (entries.length === 0) {
    body = <EmptyState title={emptyTitle} description={emptyDescription} />
  } else {
    body = (
      <View>
        {entries.map((entry, index) => (
          <React.Fragment key={entry.statId}>
            {index > 0 ? <Separator style={{ marginVertical: theme.spacing.sm }} /> : null}
            <HistoryRow entry={entry} />
          </React.Fragment>
        ))}
      </View>
    )
  }

  return (
    <Card title={title} style={style}>
      {body}
    </Card>
  )
}

function HistoryRow({ entry }: { entry: MatchHistoryEntry }): React.ReactElement {
  const theme = useTheme()
  const router = useRouter()

  const result = resultOf(entry)
  const status = entry.status ? STATUS_META[entry.status] : null
  const scoreline =
    typeof entry.homeScore === 'number' && typeof entry.awayScore === 'number'
      ? `${entry.homeScore} – ${entry.awayScore}`
      : '— · —'

  const contributions: string[] = []
  if (entry.goals > 0) contributions.push(`${entry.goals} ${entry.goals === 1 ? 'goal' : 'goals'}`)
  if (entry.assists > 0) {
    contributions.push(`${entry.assists} ${entry.assists === 1 ? 'assist' : 'assists'}`)
  }

  const delta = entry.ratingDelta
  const direction = directionOf(delta, 0.005)
  const deltaTone = direction === 'up' ? 'success' : direction === 'down' ? 'destructive' : 'muted'

  const spokenResult = result ? RESULT_META[result].label : (status?.label ?? 'Result pending')

  const kickoff = formatKickoff(entry.kickoffAt, entry.timezone ?? undefined)
  const zoneNote = entry.timezone ? `venue time (${entry.timezone})` : "your device's time"

  return (
    <Card
      flush
      onPress={() => router.push(`/match/${entry.matchId}`)}
      accessibilityLabel={`${spokenResult} ${scoreline}, ${kickoff}, ${zoneNote}. Open the match.`}
      style={{ borderWidth: 0, borderRadius: theme.radius.md, backgroundColor: 'transparent' }}
      contentStyle={{ paddingVertical: theme.spacing.sm, gap: theme.spacing.xs }}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.spacing.md,
        }}
      >
        <View style={{ width: 34, alignItems: 'flex-start' }}>
          {result ? (
            <Badge tone={RESULT_META[result].tone} size="sm">
              {RESULT_META[result].short}
            </Badge>
          ) : (
            <Badge tone="outline" size="sm">
              ?
            </Badge>
          )}
        </View>

        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="body" weight="600">
            {scoreline}
          </Text>
          <Text variant="caption" tone="muted">
            {kickoff}
            {` · ${zoneNote}`}
            {entry.teamSide ? ` · ${entry.teamSide === 'home' ? 'Home' : 'Away'}` : ''}
          </Text>
          {contributions.length > 0 ? (
            <Text variant="caption" tone="muted">
              {contributions.join(' · ')}
            </Text>
          ) : null}
        </View>

        <View style={{ alignItems: 'flex-end', gap: theme.spacing.xs }}>
          {typeof delta === 'number' ? (
            <Text variant="label" tone={deltaTone} weight="600">
              {`${formatSigned(delta)} mu`}
            </Text>
          ) : (
            <Text variant="caption" tone="muted">
              {entry.isRanked ? 'Rating pending' : 'Friendly'}
            </Text>
          )}
          {status && entry.status !== 'finalized' ? (
            <Badge tone={status.tone} size="sm">
              {status.label}
            </Badge>
          ) : null}
        </View>
      </View>
    </Card>
  )
}
