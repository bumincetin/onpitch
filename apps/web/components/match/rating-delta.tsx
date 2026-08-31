/**
 * components/match/rating-delta.tsx
 *
 * What a match did to your rating, explained.
 *
 * Presentational and server-renderable. The numbers come from `player_stats`
 * (`mu_before` / `sigma_before` / `mu_after` / `sigma_after`, plus the generated `rating_delta`)
 * or from `player_ratings` for the current standing.
 *
 * ---------------------------------------------------------------------------------------------
 * THE MODEL, IN ONE PARAGRAPH
 * ---------------------------------------------------------------------------------------------
 *
 * TrueSkill keeps a Gaussian belief about each player: a mean `mu` ("how good we think you are")
 * and a standard deviation `sigma` ("how sure we are"). New players start at mu 25.0, sigma 25/3
 * — the column defaults in `0001_schema.sql`. What gets shown on a leaderboard is neither of
 * those: it is the CONSERVATIVE rating, `mu - 3 * sigma`, a pessimistic floor the model is ~99.7%
 * confident you are above.
 *
 * That is why a brand-new player displays 0 (25 - 3 * 8.333) and why simply *playing* raises your
 * number even after a defeat: every match shrinks sigma, and shrinking sigma raises `mu - 3sigma`
 * on its own. Players find this baffling unless it is said out loud, so this component says it.
 */

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"

/* -------------------------------------------------------------------------- */
/*  Model constants                                                            */
/* -------------------------------------------------------------------------- */

/*
 * Repeated from the schema contract rather than imported, so this component renders identically
 * in any context and cannot be broken by a refactor of the rating library. They ARE the column
 * defaults in 0001_schema.sql (`mu default 25.0`, `sigma default 8.333333333333334`); if those
 * ever change, change them here in the same commit.
 */
const MU_PRIOR = 25.0
const SIGMA_PRIOR = 8.333333333333334
/** `0004_trueskill.sql` never lets sigma fall below this, so an established player can still move. */
const SIGMA_FLOOR = 0.4

/** `mu - 3 * sigma`, the number on the leaderboard. Mirrors the generated column exactly. */
export function conservativeRating(mu: number, sigma: number): number {
  return mu - 3 * sigma
}

/**
 * Sigma expressed as "how well we know you", in [0, 1].
 *
 * Linear between the prior (a total stranger, 0%) and the floor (as certain as the model ever
 * gets, 100%). It is a presentation device, not a statistic — the honest number is sigma itself,
 * which is shown next to the bar.
 */
export function certaintyFromSigma(sigma: number): number {
  const span = SIGMA_PRIOR - SIGMA_FLOOR
  const value = 1 - (sigma - SIGMA_FLOOR) / span
  return Math.min(1, Math.max(0, value))
}

const NUMBER_1DP = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
})
const NUMBER_2DP = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

function signed(value: number): string {
  const formatted = NUMBER_1DP.format(Math.abs(value))
  if (Math.abs(value) < 0.05) return "±0.0"
  return `${value > 0 ? "+" : "−"}${formatted}`
}

/* -------------------------------------------------------------------------- */
/*  Uncertainty bar                                                            */
/* -------------------------------------------------------------------------- */

export interface UncertaintyBarProps {
  sigma: number
  /** Draws a ghost marker where sigma used to be, so the narrowing is visible. */
  previousSigma?: number | null
  label?: string
  className?: string
}

export function UncertaintyBar({ sigma, previousSigma, label, className }: UncertaintyBarProps) {
  const certainty = certaintyFromSigma(sigma)
  const previousCertainty = typeof previousSigma === "number" ? certaintyFromSigma(previousSigma) : null
  const percent = Math.round(certainty * 100)

  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-muted-foreground">{label ?? "Rating confidence"}</span>
        <span className="tabular-nums font-medium">
          {percent}%
          <span className="ml-1.5 font-normal text-muted-foreground">σ {NUMBER_2DP.format(sigma)}</span>
        </span>
      </div>

      <div
        className="relative h-2 w-full overflow-hidden rounded-full bg-muted"
        role="meter"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${label ?? "Rating confidence"}: ${percent} per cent, sigma ${NUMBER_2DP.format(sigma)}`}
      >
        <div
          className="h-full rounded-full bg-foreground/70 transition-[width] duration-500 ease-out"
          style={{ width: `${percent}%` }}
        />
        {previousCertainty !== null && Math.abs(previousCertainty - certainty) > 0.005 ? (
          <span
            aria-hidden="true"
            title={`Was ${Math.round(previousCertainty * 100)}%`}
            className="absolute top-0 h-full w-px bg-foreground/30"
            style={{ left: `${Math.round(previousCertainty * 100)}%` }}
          />
        ) : null}
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  The full before/after panel                                                */
/* -------------------------------------------------------------------------- */

export interface RatingDeltaProps {
  muBefore: number | null
  sigmaBefore: number | null
  muAfter: number | null
  sigmaAfter: number | null
  /** Whose rating this is. Used only for the accessible summary. */
  playerName?: string | null
  /** False when the match was a friendly: nothing moved and the panel says so. */
  isRanked?: boolean
  className?: string
}

/**
 * Before/after for one player in one match.
 *
 * Renders an explanatory empty state rather than nothing when the rating has not been applied yet
 * — "no numbers here" is a state the player needs explained, not hidden.
 */
export function RatingDelta({
  muBefore,
  sigmaBefore,
  muAfter,
  sigmaAfter,
  playerName,
  isRanked = true,
  className,
}: RatingDeltaProps) {
  const complete =
    typeof muBefore === "number" &&
    typeof sigmaBefore === "number" &&
    typeof muAfter === "number" &&
    typeof sigmaAfter === "number"

  if (!isRanked) {
    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle className="text-base">Reyting değişmedi</CardTitle>
          <CardDescription>
            Bu bir hazırlık maçıydı. Hazırlık maçları reyting modeline girmez; mu ve sigma değerlerinde hiçbir şey değişmedi.
          </CardDescription>
        </CardHeader>
      </Card>
    )
  }

  if (!complete) {
    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle className="text-base">Reyting henüz işlenmedi</CardTitle>
          <CardDescription>
            Reytingler sonuç kesinleştiğinde hesaplanır. Skor hâlâ tartışılıyorsa, karara bağlandığı anda burası dolar.
          </CardDescription>
        </CardHeader>
      </Card>
    )
  }

  const before = conservativeRating(muBefore, sigmaBefore)
  const after = conservativeRating(muAfter, sigmaAfter)
  const delta = after - before
  const muDelta = muAfter - muBefore
  const sigmaDelta = sigmaAfter - sigmaBefore

  const direction = delta > 0.05 ? "up" : delta < -0.05 ? "down" : "flat"
  const who = playerName ? `${playerName}'s` : "Your"

  return (
    <Card className={className}>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Reyting değişimi</CardTitle>
        <CardDescription>
          {who} leaderboard rating is <strong>mu − 3σ</strong>: a pessimistic floor, not the raw
          estimate.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Headline: the number people actually care about. */}
        <div className="flex flex-wrap items-end gap-x-3 gap-y-1">
          <p className="text-3xl font-semibold tabular-nums">{NUMBER_1DP.format(after)}</p>
          <p
            className={cn(
              "pb-1 text-sm font-medium tabular-nums",
              direction === "up" && "text-emerald-600 dark:text-emerald-400",
              direction === "down" && "text-destructive",
              direction === "flat" && "text-muted-foreground",
            )}
          >
            {signed(delta)}
          </p>
          <p className="pb-1 text-sm text-muted-foreground tabular-nums">
            from {NUMBER_1DP.format(before)}
          </p>
        </div>

        <p className="sr-only">
          {who} conservative rating moved from {NUMBER_1DP.format(before)} to{" "}
          {NUMBER_1DP.format(after)}, a change of {signed(delta)}. The skill estimate mu moved{" "}
          {signed(muDelta)} and the uncertainty sigma moved {signed(sigmaDelta)}.
        </p>

        <Separator />

        {/* The two underlying parameters, side by side. */}
        <dl className="grid grid-cols-2 gap-4 text-sm">
          <div className="space-y-0.5">
            <dt className="text-muted-foreground">
              Beceri tahmini <span className="font-mono text-xs">mu</span>
            </dt>
            <dd className="tabular-nums">
              <span className="text-muted-foreground">{NUMBER_2DP.format(muBefore)}</span>
              <span className="px-1.5 text-muted-foreground" aria-hidden="true">
                →
              </span>
              <span className="font-medium">{NUMBER_2DP.format(muAfter)}</span>
              <span
                className={cn(
                  "ml-2 text-xs",
                  muDelta > 0.005 && "text-emerald-600 dark:text-emerald-400",
                  muDelta < -0.005 && "text-destructive",
                  Math.abs(muDelta) <= 0.005 && "text-muted-foreground",
                )}
              >
                {signed(muDelta)}
              </span>
            </dd>
          </div>

          <div className="space-y-0.5">
            <dt className="text-muted-foreground">
              Belirsizlik <span className="font-mono text-xs">σ</span>
            </dt>
            <dd className="tabular-nums">
              <span className="text-muted-foreground">{NUMBER_2DP.format(sigmaBefore)}</span>
              <span className="px-1.5 text-muted-foreground" aria-hidden="true">
                →
              </span>
              <span className="font-medium">{NUMBER_2DP.format(sigmaAfter)}</span>
              <span
                className={cn(
                  "ml-2 text-xs",
                  // Lower sigma is BETTER, so the colour is inverted relative to mu on purpose.
                  sigmaDelta < -0.005 && "text-emerald-600 dark:text-emerald-400",
                  sigmaDelta > 0.005 && "text-amber-600 dark:text-amber-400",
                  Math.abs(sigmaDelta) <= 0.005 && "text-muted-foreground",
                )}
              >
                {signed(sigmaDelta)}
              </span>
            </dd>
          </div>
        </dl>

        <UncertaintyBar sigma={sigmaAfter} previousSigma={sigmaBefore} />

        {/*
          The counter-intuitive bit, stated plainly. Without this line, every support ticket is
          "why did my rating go UP when we lost 6-0?".
        */}
        <p className="text-xs leading-relaxed text-muted-foreground">
          Playing narrows σ whatever the result, and a narrower σ raises mu − 3σ on its own. That is
          why your rating can climb after a defeat: the model became more certain about you, and it
          stops discounting you so heavily. A brand-new player sits at{" "}
          {NUMBER_1DP.format(conservativeRating(MU_PRIOR, SIGMA_PRIOR))} — mu{" "}
          {NUMBER_1DP.format(MU_PRIOR)} minus three times a σ of {NUMBER_2DP.format(SIGMA_PRIOR)}.
        </p>
      </CardContent>
    </Card>
  )
}

/* -------------------------------------------------------------------------- */
/*  Compact inline form                                                        */
/* -------------------------------------------------------------------------- */

export interface RatingDeltaInlineProps {
  ratingDelta: number | null
  className?: string
}

/**
 * A one-line ±x.x for tables and match history rows.
 *
 * Reads `player_stats.rating_delta`, which is `GENERATED ALWAYS AS (mu_after - mu_before)`. Note
 * that is the change in MU, not in the conservative rating — a smaller, less flattering number
 * than the headline above, and the label says so on hover.
 */
export function RatingDeltaInline({ ratingDelta, className }: RatingDeltaInlineProps) {
  if (typeof ratingDelta !== "number") {
    return (
      <span className={cn("text-xs text-muted-foreground", className)} title="Reyting henüz işlenmedi">
        —
      </span>
    )
  }

  return (
    <span
      title="Bu maçtaki ham beceri tahmini (mu) değişimi"
      className={cn(
        "text-xs font-medium tabular-nums",
        ratingDelta > 0.005 && "text-emerald-600 dark:text-emerald-400",
        ratingDelta < -0.005 && "text-destructive",
        Math.abs(ratingDelta) <= 0.005 && "text-muted-foreground",
        className,
      )}
    >
      {signed(ratingDelta)} mu
    </span>
  )
}
