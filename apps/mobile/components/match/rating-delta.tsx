/**
 * components/match/rating-delta.tsx
 *
 * What a match did — or would do — to your rating.
 *
 * ---------------------------------------------------------------------------------------------
 * THE MODEL, IN ONE PARAGRAPH
 * ---------------------------------------------------------------------------------------------
 *
 * TrueSkill keeps a Gaussian belief about each player: a mean μ ("how good we think you are") and
 * a standard deviation σ ("how sure we are"). A new player starts at μ 25.0, σ 25/3 — the column
 * defaults in `0001_schema.sql`, read here from `RATING_CONFIG` so the two can never drift. The
 * number on a leaderboard is neither of those: it is μ − 3σ, a pessimistic floor the model is
 * about 99.7% confident you are above.
 *
 * That is why a brand-new player shows 0 (25 − 3 × 8.333) and why simply PLAYING raises your
 * number even after a defeat — every match shrinks σ, and shrinking σ raises μ − 3σ on its own.
 * Players find that baffling unless it is said out loud, so this component says it.
 *
 * ---------------------------------------------------------------------------------------------
 * APPLIED VERSUS PREVIEW
 * ---------------------------------------------------------------------------------------------
 *
 * `variant="applied"` renders values that are in the database: `player_stats.mu_before` /
 * `mu_after`, written by `public.apply_match_rating`.
 *
 * `variant="preview"` renders the same arithmetic run locally by `rate()` from
 * @halisaha/shared/trueskill, which is a line-for-line mirror of `public.trueskill2_update`. It is
 * a forecast of one scoreline, computed on the device, and nothing about it is stored — the copy
 * has to keep that plain, because a preview that reads like a result is a promise the server has
 * not made.
 */

import * as React from 'react'
import { View } from 'react-native'

import { RATING_CONFIG, conservativeRating } from '@halisaha/shared/trueskill'

import { Text } from '@/components/ui'
import { useTheme } from '@/lib/theme'

/** A Gaussian belief at one point in time. */
export interface RatingPoint {
  mu: number
  sigma: number
}

export interface RatingDeltaProps {
  /** Where the rating stood before. `player_stats.mu_before` / `sigma_before`, or the live row. */
  before: RatingPoint
  /** Where it ended up, or would end up. Null renders the standing on its own. */
  after?: RatingPoint | null
  /** `applied` means it is stored; `preview` means it is a local forecast of one scoreline. */
  variant?: 'applied' | 'preview'
  title?: string
  /** Replaces the default sentence under the title. */
  description?: string
}

/**
 * σ expressed as "how well we know you", in [0,1].
 *
 * Linear between the prior (a total stranger, 0%) and the floor `0004_trueskill.sql` never lets σ
 * fall below (as certain as the model gets, 100%). A presentation device, not a statistic — the
 * honest number is σ itself, which is printed next to the bar.
 */
export function certaintyFromSigma(sigma: number): number {
  const span = RATING_CONFIG.sigma0 - RATING_CONFIG.sigmaFloor
  if (!(span > 0)) return 0
  const value = 1 - (sigma - RATING_CONFIG.sigmaFloor) / span
  return Math.min(1, Math.max(0, value))
}

function signed(value: number, digits = 1): string {
  if (Math.abs(value) < 0.05) return '±0.0'
  return `${value > 0 ? '+' : '−'}${Math.abs(value).toFixed(digits)}`
}

export function RatingDelta({
  before,
  after = null,
  variant = 'applied',
  title,
  description,
}: RatingDeltaProps): React.ReactElement {
  const theme = useTheme()

  const beforeConservative = conservativeRating(before)
  const afterConservative = after ? conservativeRating(after) : null

  const muDelta = after ? after.mu - before.mu : 0
  const sigmaDelta = after ? after.sigma - before.sigma : 0
  const conservativeDelta = afterConservative !== null ? afterConservative - beforeConservative : 0

  const heading =
    title ?? (variant === 'preview' ? 'What this scoreline would do' : 'What this match did')

  const blurb =
    description ??
    (variant === 'preview'
      ? 'Worked out on this device from the current line-up. Nothing is stored until the score is reported and both sides agree.'
      : 'Applied when the result was confirmed.')

  const headlineTone = conservativeDelta > 0.05 ? 'success' : conservativeDelta < -0.05 ? 'destructive' : 'muted'

  return (
    <View
      style={{
        gap: theme.spacing.lg,
        padding: theme.spacing.lg,
        borderRadius: theme.radius.xl,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.card,
      }}
    >
      <View style={{ gap: theme.spacing.xs }}>
        <Text variant="heading" accessibilityRole="header">
          {heading}
        </Text>
        <Text variant="caption" tone="muted">
          {blurb}
        </Text>
      </View>

      {/* The headline: the number that appears on a leaderboard. */}
      <View
        accessible
        accessibilityLabel={
          afterConservative === null
            ? `Rating ${beforeConservative.toFixed(1)}.`
            : `Rating ${beforeConservative.toFixed(1)} to ${afterConservative.toFixed(1)}, a change of ${signed(conservativeDelta)}.`
        }
        style={{ gap: theme.spacing.xs }}
      >
        <Text variant="label" tone="muted">
          Rating (μ − 3σ)
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: theme.spacing.sm }}>
          <Text variant="display" weight="700" style={{ fontVariant: ['tabular-nums'] }}>
            {(afterConservative ?? beforeConservative).toFixed(1)}
          </Text>
          {afterConservative !== null ? (
            <Text variant="heading" tone={headlineTone} style={{ fontVariant: ['tabular-nums'] }}>
              {signed(conservativeDelta)}
            </Text>
          ) : null}
        </View>
        {afterConservative !== null ? (
          <Text variant="caption" tone="muted">
            Was {beforeConservative.toFixed(1)}
          </Text>
        ) : null}
      </View>

      <View style={{ flexDirection: 'row', gap: theme.spacing.lg }}>
        <Figure
          label="Skill μ"
          value={(after?.mu ?? before.mu).toFixed(2)}
          delta={after ? signed(muDelta, 2) : null}
          hint="Modelin seni ne kadar iyi bulduğu."
        />
        <Figure
          label="Uncertainty σ"
          value={(after?.sigma ?? before.sigma).toFixed(2)}
          delta={after ? signed(sigmaDelta, 2) : null}
          hint="Hâlâ ne kadar emin olmadığı. Düşük olan daha kesindir."
        />
      </View>

      <UncertaintyBar
        sigma={after?.sigma ?? before.sigma}
        previousSigma={after ? before.sigma : null}
      />

      <Text variant="caption" tone="muted">
        σ shrinks every time you play, whatever the result, so your rating can rise after a defeat:
        μ − 3σ subtracts three times an uncertainty that just got smaller. A new player starts at μ{' '}
        {RATING_CONFIG.mu0.toFixed(1)}, σ {RATING_CONFIG.sigma0.toFixed(2)}, which is a rating of
        exactly 0.
      </Text>
    </View>
  )
}

function Figure({
  label,
  value,
  delta,
  hint,
}: {
  label: string
  value: string
  delta: string | null
  hint: string
}): React.ReactElement {
  const theme = useTheme()

  return (
    <View
      accessible
      accessibilityLabel={`${label} ${value}${delta ? `, change ${delta}` : ''}. ${hint}`}
      style={{ flex: 1, gap: theme.spacing.xs }}
    >
      <Text variant="label" tone="muted">
        {label}
      </Text>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: theme.spacing.xs }}>
        <Text variant="heading" weight="600" style={{ fontVariant: ['tabular-nums'] }}>
          {value}
        </Text>
        {delta ? (
          <Text variant="caption" tone="muted" style={{ fontVariant: ['tabular-nums'] }}>
            {delta}
          </Text>
        ) : null}
      </View>
      <Text variant="caption" tone="muted">
        {hint}
      </Text>
    </View>
  )
}

export interface UncertaintyBarProps {
  sigma: number
  /** Draws a marker where σ used to be, so the narrowing is visible. */
  previousSigma?: number | null
  label?: string
}

export function UncertaintyBar({
  sigma,
  previousSigma = null,
  label = 'Reyting güveni',
}: UncertaintyBarProps): React.ReactElement {
  const theme = useTheme()

  const certainty = certaintyFromSigma(sigma)
  const percent = Math.round(certainty * 100)
  const previousPercent =
    typeof previousSigma === 'number' ? Math.round(certaintyFromSigma(previousSigma) * 100) : null

  return (
    <View style={{ gap: theme.spacing.sm }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: theme.spacing.sm,
        }}
      >
        <Text variant="caption" tone="muted">
          {label}
        </Text>
        <Text variant="caption" style={{ fontVariant: ['tabular-nums'] }}>
          {percent}%
        </Text>
      </View>

      <View
        // `progressbar` is the role React Native maps to a determinate meter on both platforms;
        // there is no `meter` role, and the value is what a screen reader announces.
        accessibilityRole="progressbar"
        accessibilityValue={{ min: 0, max: 100, now: percent }}
        accessibilityLabel={`${label}: ${percent} per cent, sigma ${sigma.toFixed(2)}`}
        style={{
          height: 8,
          borderRadius: theme.radius.full,
          backgroundColor: theme.colors.muted,
          overflow: 'hidden',
        }}
      >
        <View
          style={{
            width: `${percent}%`,
            height: '100%',
            borderRadius: theme.radius.full,
            backgroundColor: theme.colors.primary,
          }}
        />
        {previousPercent !== null && Math.abs(previousPercent - percent) >= 1 ? (
          <View
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={{
              position: 'absolute',
              left: `${previousPercent}%`,
              top: 0,
              bottom: 0,
              width: 2,
              backgroundColor: theme.colors.mutedForeground,
            }}
          />
        ) : null}
      </View>
    </View>
  )
}
