/**
 * components/match/match-card.tsx
 *
 * One match as a row in a list, plus the vocabulary every match screen talks in.
 *
 * {@link MATCH_STATUS_META}, {@link MATCH_FORMAT_LABEL} and {@link teamSizeFor} live here rather
 * than in five separate screens because those strings must not drift between the list, the detail
 * screen and the live board. They mirror `apps/web/components/match/match-card.tsx` — same words,
 * same meanings, different rendering layer.
 *
 * Purely presentational: no queries, no hooks beyond the theme. Whoever renders it owns the data.
 */

import * as React from 'react'
import { View } from 'react-native'

import { FORMAT_TEAM_SIZE } from '@onpitch/shared/balance'
import type { Enums } from '@onpitch/shared/database'

import { Badge, Card, Text, type BadgeTone } from '@/components/ui'
import { formatKickoff, formatRelative } from '@/lib/format'
import { useTheme } from '@/lib/theme'

/* ========================================================================== */
/*  Shared vocabulary                                                         */
/* ========================================================================== */

export interface MatchStatusMeta {
  /** Two or three words, sentence case. Goes on the badge. */
  label: string
  /** One sentence a player can act on. Goes under a heading, never in a badge. */
  description: string
  tone: BadgeTone
}

/**
 * `public.match_status` in human terms.
 *
 * The copy is about what happens next, not about internal state. "requires_consensus" is a
 * database word; "the line-up has to agree which score stands" is what the player needs.
 */
export const MATCH_STATUS_META: Record<Enums<'match_status'>, MatchStatusMeta> = {
  scheduled: {
    label: 'Planlandı',
    description: 'Henüz başlamadı.',
    tone: 'neutral',
  },
  live: {
    label: 'Canlı',
    description: 'Şu anda oynanıyor.',
    tone: 'destructive',
  },
  awaiting_report: {
    label: 'Skor bekleniyor',
    description: 'Maç bitti. Her iki taraftan birinin skoru bildirmesi gerekiyor.',
    tone: 'warning',
  },
  requires_consensus: {
    label: 'Uzlaşma gerekiyor',
    description:
      'Bildirilen skorlar çelişiyor; sayılması için kadronun birini onaylaması gerekiyor.',
    tone: 'warning',
  },
  disputed: {
    label: 'İtirazlı',
    description: 'Karara bağlanmak üzere yöneticiye gönderildi. O zamana kadar reytingler beklemede.',
    tone: 'destructive',
  },
  finalized: {
    label: 'Kesin',
    description: 'Sonuç onaylandı ve reytingler işlendi.',
    tone: 'success',
  },
  cancelled: {
    label: 'İptal edildi',
    description: 'Bu maç oynanmayacak.',
    tone: 'outline',
  },
}

/** `public.match_format` as people say it out loud. */
export const MATCH_FORMAT_LABEL: Record<Enums<'match_format'>, string> = {
  five_a_side: '5-a-side',
  six_a_side: '6-a-side',
  seven_a_side: '7-a-side',
  eight_a_side: '8-a-side',
  eleven_a_side: '11-a-side',
}

/**
 * Players per side for a format.
 *
 * Delegates to `FORMAT_TEAM_SIZE` in @onpitch/shared/balance — the same table the balancer and
 * `POST /api/matches` use — so a capacity shown here can never disagree with the capacity the
 * server enforces.
 */
export function teamSizeFor(format: Enums<'match_format'>): number {
  return FORMAT_TEAM_SIZE[format]
}

/** True once a result exists on the row. */
export function hasScore(homeScore: number | null, awayScore: number | null): boolean {
  return typeof homeScore === 'number' && typeof awayScore === 'number'
}

/* ========================================================================== */
/*  The card                                                                  */
/* ========================================================================== */

/**
 * Everything a card needs, whichever query produced it.
 *
 * The discovery list (`GET /api/matches`) and the "my matches" read are different shapes with
 * different visibility rules — discovery is deliberately identity-free — so both map into this
 * one view model rather than the card learning about either.
 */
export interface MatchCardMatch {
  id: string
  kickoffAt: string
  durationMinutes: number
  format: Enums<'match_format'>
  status: Enums<'match_status'>
  isRanked: boolean
  venueName: string | null
  city: string | null
  /**
   * `venues.timezone`, the IANA zone the kick-off is quoted in. Null when the query that built
   * this row could not reach the venue — the discovery feed is deliberately identity-free and
   * carries no venue id — in which case the card falls back to the device zone AND SAYS SO.
   *
   * Rendering with the viewer's locale but the venue's zone is what stops a player in Berlin
   * reading a 21:00 Istanbul kick-off as 19:00 and turning up two hours late. The match detail
   * screen has always done this; a card that quietly disagreed with it was the worse half of the
   * same bug.
   */
  timezone: string | null
  homeScore: number | null
  awayScore: number | null
  /** Players on each side right now. */
  homeCount: number
  awayCount: number
  /** `matches.match_quality`, in [0,1]. Null before the fixture has been assessed. */
  matchQuality: number | null
  /** The viewer's own side, when they are in the line-up. Null on a discovery row. */
  yourSide: 'home' | 'away' | null
  /** Whether the viewer has checked in. Null when they are not in the line-up. */
  isConfirmed: boolean | null
}

export interface MatchCardProps {
  match: MatchCardMatch
  onPress?: (matchId: string) => void
  /** Rendered under the meta lines — a "Report score" button, a deadline, a vote prompt. */
  footer?: React.ReactNode
}

export function MatchCard({ match, onPress, footer }: MatchCardProps): React.ReactElement {
  const theme = useTheme()

  const status = MATCH_STATUS_META[match.status]
  const teamSize = teamSizeFor(match.format)
  const capacity = teamSize * 2
  const filled = match.homeCount + match.awayCount
  const spotsRemaining = Math.max(0, capacity - filled)
  const showScore = hasScore(match.homeScore, match.awayScore)

  const place = [match.venueName, match.city].filter((part): part is string => Boolean(part))

  const kickoff = formatKickoff(match.kickoffAt, match.timezone ?? undefined)
  const zoneNote = match.timezone ? `venue time (${match.timezone})` : "your device's time"

  // One string for the screen reader instead of eight fragments read in layout order.
  const summary = [
    `${MATCH_FORMAT_LABEL[match.format]} match`,
    place.length > 0 ? `at ${place.join(', ')}` : null,
    `${kickoff}, ${zoneNote}`,
    status.label,
    showScore ? `Score ${match.homeScore} to ${match.awayScore}` : `${filled} of ${capacity} in`,
    match.yourSide ? `You are on the ${match.yourSide} side` : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join('. ')

  return (
    <Card
      onPress={onPress ? () => onPress(match.id) : undefined}
      accessibilityLabel={summary}
      contentStyle={{ gap: theme.spacing.md }}
    >
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm }}>
        <Badge tone={status.tone} size="sm">
          {status.label}
        </Badge>
        <Badge tone="outline" size="sm">
          {MATCH_FORMAT_LABEL[match.format]}
        </Badge>
        {match.isRanked ? (
          <Badge tone="outline" size="sm">
            Reytingli
          </Badge>
        ) : null}
        {match.yourSide ? (
          <Badge tone="primary" size="sm">
            {match.yourSide === 'home' ? 'You: home' : 'You: away'}
          </Badge>
        ) : null}
      </View>

      <View style={{ gap: theme.spacing.xs }}>
        <Text variant="heading">{kickoff}</Text>
        <Text variant="label" tone="muted">
          {formatRelative(match.kickoffAt)}
          {' · '}
          {match.durationMinutes} min
          {' · '}
          {zoneNote}
        </Text>
      </View>

      <Text variant="body" tone="muted" numberOfLines={2}>
        {place.length > 0 ? place.join(' · ') : 'Venue to be confirmed'}
      </Text>

      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: theme.spacing.md,
        }}
      >
        {showScore ? (
          <Text variant="title" weight="700" style={{ fontVariant: ['tabular-nums'] }}>
            {match.homeScore} – {match.awayScore}
          </Text>
        ) : (
          <Text variant="label" tone="muted">
            {filled} of {capacity} in
            {spotsRemaining > 0
              ? ` · ${spotsRemaining} ${spotsRemaining === 1 ? 'spot' : 'spots'} left`
              : ' · full'}
          </Text>
        )}

        {typeof match.matchQuality === 'number' ? (
          <Text variant="caption" tone="muted">
            Balance {Math.round(match.matchQuality * 100)}%
          </Text>
        ) : null}
      </View>

      {match.isConfirmed === false ? (
        <Text variant="caption" tone="warning">
          Henüz sahaya gelmedin.
        </Text>
      ) : null}

      {footer}
    </Card>
  )
}
