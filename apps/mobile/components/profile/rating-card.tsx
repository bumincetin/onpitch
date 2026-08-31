/**
 * components/profile/rating-card.tsx
 *
 * A player's standing: the ranked number, the two parameters behind it, and the band the model
 * still considers plausible.
 *
 * Three numbers are on screen because hiding two of them is what generates support tickets. The
 * headline is `mu - 3σ` because that is what the leaderboard sorts on; `mu` is shown because it is
 * the actual skill estimate and is always higher; the band from `mu - 3σ` to `mu + 3σ` is shown
 * because it is the thing that shrinks as you play, and watching it shrink is the only intuitive
 * explanation of why the headline climbs even after a defeat.
 */

import * as React from 'react'
import { View, type StyleProp, type ViewStyle } from 'react-native'

import { Badge, Card, Separator, Text } from '@/components/ui'
import { formatRelative } from '@/lib/format'
import { useTheme } from '@/lib/theme'

import {
  MU_PRIOR,
  SIGMA_PRIOR,
  UncertaintyBar,
  conservativeRating,
  formatRating,
  formatSigma,
} from './uncertainty-bar'

/** The `player_ratings` columns this card reads. */
export interface PlayerRating {
  mu: number
  sigma: number
  /** The generated column. Recomputed locally when a projection left it out. */
  conservative_rating: number | null
  matches_played: number
  wins: number
  draws: number
  losses: number
  last_match_at: string | null
}

export interface RatingCardProps {
  /** Null when the player has no `player_ratings` row yet — nobody has rated them. */
  rating: PlayerRating | null
  /** Whose rating this is. Omit for the signed-in player and the copy switches to "you". */
  playerName?: string | null
  style?: StyleProp<ViewStyle>
}

/** The scale the band is drawn against. Ratings live well inside it in practice. */
const SCALE_MIN = 0
const SCALE_MAX = 50

export function RatingCard({
  rating,
  playerName = null,
  style,
}: RatingCardProps): React.ReactElement {
  const theme = useTheme()

  if (!rating) {
    return (
      <Card title="Henüz reyting yok" style={style}>
        <Text variant="body" tone="muted">
          {playerName
            ? `${playerName} has not finished a ranked match, so there is no rating to show yet.`
            : 'Play a ranked match and a rating appears here.'}
        </Text>
        <Text variant="body" tone="muted">
          Everyone starts at mu {formatRating(MU_PRIOR)} with a sigma of {formatSigma(SIGMA_PRIOR)},
          which puts the ranked number at{' '}
          {formatRating(conservativeRating(MU_PRIOR, SIGMA_PRIOR))}.
        </Text>
      </Card>
    )
  }

  const { mu, sigma, matches_played: played } = rating
  const ranked = rating.conservative_rating ?? conservativeRating(mu, sigma)
  const subject = playerName ?? 'you'
  const possessive = playerName ? `${playerName}'s` : 'your'

  return (
    <Card style={style}>
      {/* Headline: the number the leaderboard sorts on. */}
      <View style={{ gap: theme.spacing.xs }}>
        <Text variant="label" tone="muted">
          Reytingli puan
        </Text>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'flex-end',
            flexWrap: 'wrap',
            gap: theme.spacing.sm,
          }}
        >
          <Text variant="display" style={{ fontSize: 40, lineHeight: 44 }}>
            {formatRating(ranked)}
          </Text>
          <Text variant="label" tone="muted" style={{ paddingBottom: 6 }}>
            mu − 3σ
          </Text>
        </View>
        <Text variant="caption" tone="muted">
          {played === 0
            ? 'No ranked matches have counted yet.'
            : `From ${played} ranked ${played === 1 ? 'match' : 'matches'}${
                rating.last_match_at ? `, last played ${formatRelative(rating.last_match_at)}` : ''
              }.`}
        </Text>
      </View>

      <Separator />

      {/* The two parameters, side by side. */}
      <View style={{ flexDirection: 'row', gap: theme.spacing.lg }}>
        <View style={{ flex: 1, gap: theme.spacing.xs }}>
          <Text variant="caption" tone="muted">
            Beceri tahmini (mu)
          </Text>
          <Text variant="title">{formatRating(mu)}</Text>
        </View>
        <View style={{ flex: 1, gap: theme.spacing.xs }}>
          <Text variant="caption" tone="muted">
            Uncertainty (σ)
          </Text>
          <Text variant="title">{formatSigma(sigma)}</Text>
        </View>
      </View>

      <SkillBand mu={mu} sigma={sigma} />

      <UncertaintyBar sigma={sigma} />

      <Separator />

      {/*
        The sentence that heads off "why did my rating jump, and why has it stopped moving".
        Concrete on purpose: named starting values, a named match count, a named magnitude.
      */}
      <Text variant="caption" tone="muted">
        A new player starts at mu {formatRating(MU_PRIOR)} with a sigma of{' '}
        {formatSigma(SIGMA_PRIOR)}, so the ranked number opens at{' '}
        {formatRating(conservativeRating(MU_PRIOR, SIGMA_PRIOR))} and swings by whole points a match
        while sigma is that wide — sigma falls fastest over the first handful of games and then
        flattens out, so by a dozen matches the same result moves the ranked number by a fraction of
        a point.
      </Text>

      <Text variant="caption" tone="muted">
        Playing narrows σ whatever the result, and a narrower σ raises mu − 3σ on its own. That is
        why {possessive} rating can climb after a defeat: the model became more certain about{' '}
        {subject} and stopped discounting so heavily.
      </Text>
    </Card>
  )
}

interface SkillBandProps {
  mu: number
  sigma: number
}

/**
 * The plausible range, drawn to scale: `mu - 3σ` to `mu + 3σ`, with a tick at mu.
 *
 * Widths are flex ratios rather than percentage strings. `DimensionValue` accepts only the
 * `${number}%` template literal type, and an interpolated number does not satisfy it.
 */
function SkillBand({ mu, sigma }: SkillBandProps): React.ReactElement {
  const theme = useTheme()

  const span = SCALE_MAX - SCALE_MIN
  const clamp = (value: number): number => Math.min(SCALE_MAX, Math.max(SCALE_MIN, value))

  const low = clamp(conservativeRating(mu, sigma))
  const high = clamp(mu + 3 * sigma)
  const centre = clamp(mu)

  const leadRatio = Math.max((low - SCALE_MIN) / span, 0)
  const bandRatio = Math.max((high - low) / span, 0.01)
  const tailRatio = Math.max((SCALE_MAX - high) / span, 0)
  const muRatio = Math.min(Math.max((centre - low) / Math.max(high - low, 0.0001), 0), 1)

  return (
    <View style={{ gap: theme.spacing.sm }}>
      <Text variant="caption" tone="muted">
        Modelin gerçek becerinin nerede olduğunu düşündüğü yer
      </Text>

      <View
        accessible
        accessibilityRole="image"
        accessibilityLabel={`Plausible skill range, ${formatRating(low)} to ${formatRating(
          high,
        )}, centred on ${formatRating(mu)}.`}
        style={{ flexDirection: 'row', height: 14, alignItems: 'center' }}
      >
        <View style={{ flex: leadRatio }} />
        <View
          style={{
            flex: bandRatio,
            height: 14,
            flexDirection: 'row',
            borderRadius: theme.radius.full,
            backgroundColor: theme.colors.secondary,
            borderWidth: 1,
            borderColor: theme.colors.border,
            overflow: 'hidden',
          }}
        >
          <View style={{ flex: muRatio }} />
          <View style={{ width: 2, backgroundColor: theme.colors.primary }} />
          <View style={{ flex: 1 - muRatio }} />
        </View>
        <View style={{ flex: tailRatio }} />
      </View>

      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: theme.spacing.sm }}>
        <Badge tone="outline" size="sm">{`${formatRating(low)} ranked`}</Badge>
        <Badge tone="outline" size="sm">{`${formatRating(high)} ceiling`}</Badge>
      </View>
    </View>
  )
}
