/**
 * components/team/team-rating.tsx
 *
 * One team's collective TrueSkill standing, and the arithmetic behind it.
 *
 * ---------------------------------------------------------------------------------------------
 * THE AGGREGATION RULE IS NOT A CHOICE
 * ---------------------------------------------------------------------------------------------
 * A team's belief is the sum of its players' beliefs. `rate()` and `matchQuality()` in
 * `@halisaha/shared/trueskill` both build a side the same way, and this file copies that exactly:
 *
 *     muTeam    = sum(mu_i)
 *     sigmaTeam = sqrt(sum(sigma_i^2))          // variances add, standard deviations do not
 *
 * That is the model, not a presentation decision. Independent Gaussians sum by adding means and
 * adding VARIANCES, which is why the second line squares and then takes a root — averaging the
 * sigmas, or summing them, would produce a number the rating engine has never heard of and would
 * disagree with every fixture forecast the platform shows.
 *
 * `conservativeRating` is then `mu - 3 * sigma`, the same pessimistic floor used everywhere else.
 * For a squad it is a large number (a six-a-side of fresh players sits near 150 - 3 * 20.4), which
 * is why {@link TeamRating} also shows the per-player figures recovered from it: `mu / n` and
 * `sigma / sqrt(n)` invert the two sums above exactly, so they are the same snapshot expressed per
 * head rather than a second, competing rating.
 *
 * ---------------------------------------------------------------------------------------------
 * PLAYERS WITH NO RATING ROW
 * ---------------------------------------------------------------------------------------------
 * `player_ratings` is seeded on a player's first rated match, so a new signing has no row. They
 * are folded in at the prior — `defaultRating()`, mu 25 and sigma 25/3 — which is what
 * `private.ensure_rating_row` would write the moment they played, and what the balancer already
 * assumes. Dropping them instead would make a squad of ten unrated players look like an empty
 * team, and treating them as zero would be a lie about a person nobody has measured yet.
 *
 * Purely presentational and server-renderable: no client hooks, no I/O.
 */

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import type { RatingSnapshot } from "@halisaha/shared/domain"
import { conservativeRating, defaultRating, type Rating } from "@halisaha/shared/trueskill"

/* ========================================================================== */
/*  Aggregation                                                               */
/* ========================================================================== */

/** One squad member's standing. `null` means "no `player_ratings` row yet". */
export interface TeamMemberRating {
  playerId: string
  rating: Rating | null
}

export interface TeamRatingSummary {
  snapshot: RatingSnapshot
  /** Active squad members folded into the sums, rated or not. */
  squadSize: number
  /** How many of them had a real `player_ratings` row. */
  ratedCount: number
  /** `mu / n` — the snapshot expressed per head, not a separate rating. */
  meanMu: number
  /** `sigma / sqrt(n)` — the inverse of the variance sum, same snapshot per head. */
  meanSigma: number
  /** `meanMu - 3 * meanSigma`, the number a single player's page would show. */
  meanConservative: number
}

/**
 * Fold a roster into one {@link RatingSnapshot} using the team rule above.
 *
 * Returns `null` for an empty roster rather than a zeroed snapshot: a team with nobody in it has
 * no standing, and rendering 0 would put it below every real team on a leaderboard.
 */
export function aggregateTeamRating(
  members: readonly TeamMemberRating[],
): TeamRatingSummary | null {
  if (members.length === 0) return null

  const prior = defaultRating()
  let mu = 0
  let variance = 0
  let ratedCount = 0

  for (const member of members) {
    const rating = member.rating ?? prior
    if (member.rating) ratedCount += 1
    mu += rating.mu
    variance += rating.sigma * rating.sigma
  }

  const sigma = Math.sqrt(variance)
  const squadSize = members.length
  const meanMu = mu / squadSize
  const meanSigma = sigma / Math.sqrt(squadSize)

  return {
    snapshot: { mu, sigma, conservativeRating: conservativeRating({ mu, sigma }) },
    squadSize,
    ratedCount,
    meanMu,
    meanSigma,
    meanConservative: conservativeRating({ mu: meanMu, sigma: meanSigma }),
  }
}

/* ========================================================================== */
/*  Formatting                                                                */
/* ========================================================================== */

const NUMBER_1DP = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
})

function oneDecimal(value: number): string {
  return Number.isFinite(value) ? NUMBER_1DP.format(value) : "—"
}

/* ========================================================================== */
/*  Card                                                                      */
/* ========================================================================== */

export interface TeamRatingProps {
  summary: TeamRatingSummary | null
  className?: string
}

export function TeamRating({ summary, className }: TeamRatingProps) {
  if (!summary) {
    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle className="text-base">Takım reytingi</CardTitle>
          <CardDescription>
            Kadroda henüz kimse yok. Oyuncu ekle, reyting hemen burada belirir.
          </CardDescription>
        </CardHeader>
      </Card>
    )
  }

  const { snapshot, squadSize, ratedCount } = summary
  const unrated = squadSize - ratedCount

  return (
    <Card className={className}>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Takım reytingi</CardTitle>
        <CardDescription>
          Aktif her oyuncunun beceri tahmini, reyting motorunun bir tarafı topladığı şekilde toplanmış hâli.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-3xl font-semibold tabular-nums tracking-tight">
            {oneDecimal(snapshot.conservativeRating)}
          </span>
          <span className="text-xs text-muted-foreground">
            squad total, mu &minus; 3&sigma; across {squadSize}{" "}
            {squadSize === 1 ? "player" : "players"}
          </span>
        </div>

        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Figure label="Kadro mu" value={oneDecimal(snapshot.mu)} hint="bütün mu değerlerinin toplamı" />
          <Figure
            label="Kadro sigma"
            value={oneDecimal(snapshot.sigma)}
            hint="varyans toplamının karekökü"
          />
          <Figure
            label="Oyuncu başına"
            value={oneDecimal(summary.meanConservative)}
            hint="aynı değerlerin oyuncu başına bölünmüş hâli"
          />
          <Figure
            label="Reytingli"
            value={`${ratedCount}/${squadSize}`}
            hint={unrated === 0 ? "everyone has played" : `${unrated} still on the prior`}
          />
        </dl>

        <p className="text-xs leading-relaxed text-muted-foreground">
          Ortalamalar toplanır, varyanslar toplanır; bu yüzden kadro sigması bir toplam değil, karelerin toplamının kareköküdür. Henüz reytingi olmayan oyuncu, motorun ilk maçta varsaydığı yeni oyuncu değeri olan mu 25,0 ile sayılır.
        </p>
      </CardContent>
    </Card>
  )
}

function Figure({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums">{value}</dd>
      <p className="text-[11px] leading-snug text-muted-foreground">{hint}</p>
    </div>
  )
}

/* ========================================================================== */
/*  Inline variant                                                            */
/* ========================================================================== */

/**
 * One line for a list row. Shows the per-player figure rather than the squad total, because a
 * card next to a five-a-side and an eleven-a-side has to be comparable at a glance and the squad
 * total scales with headcount.
 */
export function TeamRatingInline({
  summary,
  className,
}: {
  summary: TeamRatingSummary | null
  className?: string
}) {
  if (!summary) {
    return <span className={cn("text-xs text-muted-foreground", className)}>Henüz reyting yok</span>
  }

  return (
    <span className={cn("text-xs text-muted-foreground", className)}>
      <span className="font-semibold tabular-nums text-foreground">
        {oneDecimal(summary.meanConservative)}
      </span>{" "}
      per player · {summary.squadSize} on the squad
    </span>
  )
}
