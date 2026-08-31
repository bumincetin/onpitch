/**
 * components/profile/uncertainty-bar.tsx
 *
 * The rating model's two numbers, and the helpers that render them.
 *
 * TrueSkill keeps a Gaussian belief per player: `mu` is how good we think you are, `sigma` is how
 * unsure we are. Neither is what ranks you — that is `mu - 3 * sigma`, the `conservative_rating`
 * generated column, a floor the model is about 99.7% confident you are above.
 *
 * The constants below are the column defaults in 0001_schema.sql and the sigma floor enforced by
 * 0004_trueskill.sql. They are restated here rather than imported so this file renders the same
 * whatever else is in the bundle; if the migration ever changes them, change them here in the
 * same commit. `@halisaha/shared/trueskill` owns the maths, this file owns the pixels.
 */

import * as React from 'react'
import { View, type StyleProp, type ViewStyle } from 'react-native'

import { Text } from '@/components/ui'
import { useTheme } from '@/lib/theme'

/** `player_ratings.mu` default. A player nobody has seen play. */
export const MU_PRIOR = 25
/** `player_ratings.sigma` default, 25/3. Maximum uncertainty. */
export const SIGMA_PRIOR = 8.333333333333334
/** 0004_trueskill.sql never lets sigma fall below this, so an established player can still move. */
export const SIGMA_FLOOR = 0.4

/** `mu - 3 * sigma` — the number that ranks you. Mirrors the generated column exactly. */
export function conservativeRating(mu: number, sigma: number): number {
  return mu - 3 * sigma
}

/**
 * Sigma expressed as "how well we know you", in [0, 1].
 *
 * Linear between the prior (a total stranger, 0%) and the floor (as certain as the model gets,
 * 100%). A presentation device, not a statistic — the honest number is sigma, printed next to it.
 */
export function certaintyFromSigma(sigma: number): number {
  const span = SIGMA_PRIOR - SIGMA_FLOOR
  if (span <= 0) return 1
  const value = 1 - (sigma - SIGMA_FLOOR) / span
  return Math.min(1, Math.max(0, value))
}

/**
 * Intl is available in Hermes, but a build with a trimmed ICU set throws on an unsupported
 * option. Every formatter here falls back to `toFixed`, because a crashed screen is a worse
 * outcome than a rating printed with a dot instead of a comma.
 */
function fixed(value: number, digits: number): string {
  if (!Number.isFinite(value)) return '—'
  try {
    return new Intl.NumberFormat(undefined, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(value)
  } catch {
    return value.toFixed(digits)
  }
}

/** A rating, to one decimal: `31.4`. */
export function formatRating(value: number): string {
  return fixed(value, 1)
}

/** A sigma, to two decimals: `4.07`. */
export function formatSigma(value: number): string {
  return fixed(value, 2)
}

/** A change, with an explicit sign and a real minus: `+1.4`, `−0.6`, `±0.0`. */
export function formatSigned(value: number): string {
  if (!Number.isFinite(value)) return '—'
  if (Math.abs(value) < 0.05) return '±0.0'
  return `${value > 0 ? '+' : '−'}${fixed(Math.abs(value), 1)}`
}

/** Whether a delta reads as a gain, a loss, or nothing worth colouring. */
export type Direction = 'up' | 'down' | 'flat'

export function directionOf(value: number | null | undefined, epsilon = 0.05): Direction {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'flat'
  if (value > epsilon) return 'up'
  if (value < -epsilon) return 'down'
  return 'flat'
}

export interface UncertaintyBarProps {
  sigma: number
  /** Draws a ghost marker where sigma used to be, so the narrowing is visible. */
  previousSigma?: number | null
  label?: string
  style?: StyleProp<ViewStyle>
}

/**
 * A meter for how settled a rating is.
 *
 * Announced with `accessibilityValue`, so a screen reader reads "62 per cent" rather than
 * describing a coloured rectangle.
 */
export function UncertaintyBar({
  sigma,
  previousSigma = null,
  label = 'Reyting güveni',
  style,
}: UncertaintyBarProps): React.ReactElement {
  const theme = useTheme()

  const percent = Math.round(certaintyFromSigma(sigma) * 100)
  const previousPercent =
    typeof previousSigma === 'number' ? Math.round(certaintyFromSigma(previousSigma) * 100) : null
  const showGhost = previousPercent !== null && Math.abs(previousPercent - percent) > 0

  return (
    <View style={[{ gap: theme.spacing.sm }, style]}>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: theme.spacing.sm }}>
        <Text variant="caption" tone="muted" style={{ flexShrink: 1 }}>
          {label}
        </Text>
        <Text variant="caption" weight="600">
          {`${percent}%`}
          <Text variant="caption" tone="muted">
            {`  σ ${formatSigma(sigma)}`}
          </Text>
        </Text>
      </View>

      <View
        accessible
        accessibilityRole="progressbar"
        accessibilityLabel={`${label}: ${percent} per cent, sigma ${formatSigma(sigma)}`}
        accessibilityValue={{ min: 0, max: 100, now: percent }}
        // Widths are flex ratios, not percentage strings: `DimensionValue` only accepts the
        // `${number}%` template type, and a plain interpolated string does not satisfy it.
        style={{
          height: 8,
          flexDirection: 'row',
          borderRadius: theme.radius.full,
          backgroundColor: theme.colors.muted,
          overflow: 'hidden',
        }}
      >
        <View style={{ flex: percent, backgroundColor: theme.colors.primary }} />
        <View style={{ flex: 100 - percent }} />

        {showGhost && previousPercent !== null ? (
          <View
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, flexDirection: 'row' }}
          >
            <View style={{ flex: previousPercent }} />
            <View style={{ width: 2, backgroundColor: theme.colors.mutedForeground }} />
            <View style={{ flex: 100 - previousPercent }} />
          </View>
        ) : null}
      </View>
    </View>
  )
}
