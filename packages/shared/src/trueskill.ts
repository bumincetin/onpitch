/**
 * packages/shared/src/trueskill.ts
 *
 * A pure-TypeScript MIRROR of the TrueSkill 2 engine implemented in
 * `supabase/migrations/0004_trueskill.sql`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  THE SQL IS THE SINGLE SOURCE OF TRUTH FOR PERSISTED RATINGS.
 * ─────────────────────────────────────────────────────────────────────────────
 *  `public.trueskill2_update()` / `public.apply_match_rating()` are the ONLY
 *  writers of `player_ratings`. This module never writes anything. It exists for
 *  exactly two jobs:
 *
 *    1. Client-side PREVIEW — "if we win 3-1, what happens to my rating?" — so
 *       the UI can answer without a round trip.
 *    2. Scoring candidate line-ups inside `balance.ts` / `quality.ts`, where the
 *       balancer evaluates hundreds of splits and cannot pay a network hop per
 *       evaluation.
 *
 *  Because of (1) and (2) this file MUST stay numerically identical to the SQL:
 *  same constants, same branch structure, same underflow fallbacks, same
 *  clamps. If you change one, change the other in the same commit and re-run
 *  the golden-vector test. Divergence shows up as a UI that promises +2.4 and a
 *  database that awards +1.9, which reads to a player as the platform lying.
 *
 *  The constants below are the DEFAULT row of `public.rating_config`. That table
 *  is tunable at runtime without a deploy, so anything that has to be exact
 *  (an audit, a dispute) must read the server's answer, not this mirror's.
 *  `rate()` and `matchQuality()` therefore both accept a config override.
 *
 *  No money and no timestamps are handled here; nothing in this file does I/O.
 */

/* ========================================================================== */
/*  Configuration — mirrors the default row of public.rating_config           */
/* ========================================================================== */

export interface TrueSkillConfig {
  /** Prior mean for a brand-new player. */
  mu0: number
  /** Prior standard deviation. 25/3, so a fresh player's 3-sigma floor is 0. */
  sigma0: number
  /** Performance noise: the skill gap giving the stronger side ~76% to win. */
  beta: number
  /** Additive per-match dynamics on sigma^2, so certainty never fully collapses. */
  tau: number
  /** Prior probability of a draw. Amateur 7-a-side draws roughly 1 in 10. */
  drawProbability: number
  /** marginFactor = 1 + ln(1 + |goal diff|) / marginLogDivisor. Larger = flatter. */
  marginLogDivisor: number
  /** Hard cap on the outcome-magnitude multiplier. */
  marginFactorMax: number
  /** Floating-point backstop on the variance multiplier. Not a tuning knob. */
  minVarianceRatio: number
  /** Sigma is never allowed below this, so an established player can still move. */
  sigmaFloor: number
  /** Lower clamp on mu. */
  muFloor: number
  /** Upper clamp on mu. */
  muCeiling: number
}

/**
 * The defaults inserted by `0004_trueskill.sql`. Keep byte-identical to the
 * column defaults — these literals are the same decimal expansions the
 * migration writes, so `25/3` is spelled out rather than computed.
 */
export const RATING_CONFIG: Readonly<TrueSkillConfig> = Object.freeze({
  mu0: 25.0,
  sigma0: 8.333333333333334,
  beta: 4.166666666666667,
  tau: 0.08333333333333334,
  drawProbability: 0.1,
  marginLogDivisor: 8.0,
  marginFactorMax: 1.35,
  minVarianceRatio: 0.0001,
  sigmaFloor: 0.4,
  muFloor: 1.0,
  muCeiling: 60.0,
})

/** The hard clamp `trueskill2_update` applies to `p_score_margin`. */
export const MAX_SCORE_MARGIN = 30

/* ========================================================================== */
/*  Types                                                                     */
/* ========================================================================== */

/** The three outcomes `public.trueskill2_update` accepts, spelled identically. */
export type MatchOutcome = "a_wins" | "b_wins" | "draw"

/** A Gaussian belief over one player's latent skill. */
export interface Rating {
  mu: number
  sigma: number
}

/** A player on one side of a fixture, with an optional partial-play weight. */
export interface RatedTeamMember extends Rating {
  playerId: string
  /** TrueSkill 2 partial play, clamped to [0,1]. Defaults to 1 (played the lot). */
  weight?: number
}

/** One player's before/after snapshot, mirroring `trueskill2_update`'s RETURNS. */
export interface RatingDelta {
  playerId: string
  muBefore: number
  sigmaBefore: number
  muAfter: number
  sigmaAfter: number
  /** `muAfter - muBefore`, mirroring the generated `player_stats.rating_delta`. */
  muDelta: number
  /** `sigmaAfter - sigmaBefore`; negative means the model got more certain. */
  sigmaDelta: number
  /** Leaderboard number before and after: `mu - 3 * sigma`. */
  conservativeBefore: number
  conservativeAfter: number
}

/** Everything `rate()` produced, including the intermediates worth showing. */
export interface RateResult {
  /** One entry per player, team A first then team B, in the input order. */
  deltas: RatingDelta[]
  /** Standardised performance gap `t`, winner-first. */
  standardisedGap: number
  /** Draw margin epsilon, standardised by `c` (the same units as `standardisedGap`). */
  drawMargin: number
  /** Total performance standard deviation `c`. */
  c: number
  /** The outcome-magnitude multiplier that was applied to the mean update. */
  marginFactor: number
  /** The truncated-Gaussian mean correction v. */
  v: number
  /** The truncated-Gaussian variance correction w, in [0,1]. */
  w: number
}

export interface RateOptions {
  /** |goal difference|. Ignored (forced to 0) for a draw. Clamped to [0,30]. */
  scoreMargin?: number
  /** Runtime override of `public.rating_config`. */
  config?: Partial<TrueSkillConfig>
}

/* ========================================================================== */
/*  1. Standard normal primitives                                             */
/* ========================================================================== */

/** phi(x) — mirrors `private.std_normal_pdf`. */
export function stdNormalPdf(x: number): number {
  return 0.3989422804014327 * Math.exp(-0.5 * x * x)
}

/**
 * Phi(x) — mirrors `private.std_normal_cdf` on PostgreSQL 15.
 *
 * Hart's (1968) rational approximation as published by Graeme West. ~1e-15
 * RELATIVE accuracy out to |x| = 37, which is what matters: `vWin` divides by
 * Phi deep in the tail, so an absolute-error approximation (Abramowitz & Stegun
 * 7.1.26) would be off by orders of magnitude exactly where it is used.
 *
 * PostgreSQL 16+ swaps the SQL implementation for `0.5 * erfc(-x/sqrt(2))`.
 * Both agree to ~1e-15 relative, so this mirror is valid on either server.
 */
export function stdNormalCdf(x: number): number {
  if (Number.isNaN(x)) return Number.NaN

  const abs = Math.abs(x)
  let tail: number

  if (abs > 37.0) {
    tail = 0.0
  } else {
    const e = Math.exp(-0.5 * abs * abs)

    if (abs < 7.07106781186547) {
      // Central + near-tail: ratio of two polynomials in |x|.
      let num = 3.52624965998911e-2 * abs + 0.700383064443688
      num = num * abs + 6.37396220353165
      num = num * abs + 33.912866078383
      num = num * abs + 112.079291497871
      num = num * abs + 221.213596169931
      num = num * abs + 220.206867912376

      let den = 8.83883476483184e-2 * abs + 1.75566716318264
      den = den * abs + 16.064177579207
      den = den * abs + 86.7807322029461
      den = den * abs + 296.564248779674
      den = den * abs + 637.333633378831
      den = den * abs + 793.826512519948
      den = den * abs + 440.413735824752

      tail = (e * num) / den
    } else {
      // Deep tail: five-term continued fraction for the Mills ratio.
      let den = abs + 0.65
      den = abs + 4.0 / den
      den = abs + 3.0 / den
      den = abs + 2.0 / den
      den = abs + 1.0 / den
      tail = e / (den * 2.506628274631)
    }
  }

  // `tail` is Phi(-|x|); mirror it for the positive half.
  return x > 0.0 ? 1.0 - tail : tail
}

/**
 * Phi^-1(p) — mirrors `private.std_normal_icdf`.
 *
 * Peter Acklam's rational approximation (relative error < 1.15e-9) followed by
 * one Halley step against `stdNormalCdf`, which takes it to full double
 * precision. Returns +/-Infinity outside (0,1), exactly as the SQL does.
 */
export function stdNormalIcdf(p: number): number {
  if (Number.isNaN(p)) return Number.NaN
  if (p <= 0.0) return Number.NEGATIVE_INFINITY
  if (p >= 1.0) return Number.POSITIVE_INFINITY

  let x: number
  let q: number

  if (p < 0.02425) {
    q = Math.sqrt(-2.0 * Math.log(p))
    x =
      (((((-7.784894002430293e-3 * q - 3.223964580411365e-1) * q - 2.400758277161838) * q -
        2.549732539343734) *
        q +
        4.374664141464968) *
        q +
        2.938163982698783) /
      ((((7.784695709041462e-3 * q + 3.224671290700398e-1) * q + 2.445134137142996) * q +
        3.754408661907416) *
        q +
        1.0)
  } else if (p <= 0.97575) {
    q = p - 0.5
    const r = q * q
    x =
      ((((((-3.969683028665376e1 * r + 2.209460984245205e2) * r - 2.759285104469687e2) * r +
        1.38357751867269e2) *
        r -
        3.066479806614716e1) *
        r +
        2.506628277459239) *
        q) /
      (((((-5.447609879822406e1 * r + 1.615858368580409e2) * r - 1.556989798598866e2) * r +
        6.680131188771972e1) *
        r -
        1.328068155288572e1) *
        r +
        1.0)
  } else {
    q = Math.sqrt(-2.0 * Math.log(1.0 - p))
    x =
      -(((((-7.784894002430293e-3 * q - 3.223964580411365e-1) * q - 2.400758277161838) * q -
        2.549732539343734) *
        q +
        4.374664141464968) *
        q +
        2.938163982698783) /
      ((((7.784695709041462e-3 * q + 3.224671290700398e-1) * q + 2.445134137142996) * q +
        3.754408661907416) *
        q +
        1.0)
  }

  // Halley refinement. Skipped in the extreme tails where exp(x^2/2) overflows;
  // Acklam alone is already far more accurate than the draw margin needs there.
  if (Math.abs(x) < 25.0) {
    const e = stdNormalCdf(x) - p
    const u = e * 2.5066282746310002 * Math.exp(0.5 * x * x)
    x = x - u / (1.0 + 0.5 * x * u)
  }

  return x
}

/* ========================================================================== */
/*  2. Truncated-Gaussian moment corrections                                  */
/* ========================================================================== */

/**
 * V for a decisive result — mirrors `private.v_win`.
 *
 * Once Phi underflows, `vWin` would divide ~0 by ~0, which is what the
 * `cdf < 1e-300` branch avoids. The Mills-ratio asymptote `-x - 1/x` keeps the
 * second-order term so that `wWin` still converges to its true limit of 1.
 */
export function vWin(t: number, eps: number): number {
  const x = t - eps
  const cdf = stdNormalCdf(x)
  if (cdf < 1e-300) return -x - 1.0 / x
  return stdNormalPdf(x) / cdf
}

/** W for a decisive result — mirrors `private.w_win`. Clamped to [0,1]. */
export function wWin(t: number, eps: number): number {
  const x = t - eps
  const v = vWin(t, eps)
  const w = v * (v + x)
  // NaN can only arrive here from Inf - Inf. Fail safe to "learn nothing from
  // this match" rather than "collapse the variance".
  if (Number.isNaN(w)) return 0.0
  return Math.min(1.0, Math.max(0.0, w))
}

/**
 * V for a draw — mirrors `private.v_draw`.
 *
 * A draw is a two-sided truncation to [-eps, eps]. The correction is computed
 * on |t| and then signed, because a draw pulls the favourite down and the
 * underdog up regardless of which side is nominally first.
 */
export function vDraw(t: number, eps: number): number {
  const abs = Math.abs(t)
  const a = eps - abs
  const b = -eps - abs
  const sign = t < 0.0 ? -1.0 : 1.0

  const den = stdNormalCdf(a) - stdNormalCdf(b)
  // Both bounds deep in the left tail (an enormous favourite drew): the mass in
  // the band underflows and the truncated mean collapses onto the nearer bound.
  if (den < 1e-300) return sign * a

  return sign * ((stdNormalPdf(b) - stdNormalPdf(a)) / den)
}

/** W for a draw — mirrors `private.w_draw`. Clamped to [0,1]. */
export function wDraw(t: number, eps: number): number {
  const abs = Math.abs(t)
  const a = eps - abs
  const b = -eps - abs

  const den = stdNormalCdf(a) - stdNormalCdf(b)
  // As |t| -> inf the two-sided w tends to 1: an "impossible" draw is maximally
  // informative, so it removes as much variance as the model allows.
  if (den < 1e-300) return 1.0

  const v = vDraw(abs, eps)
  const w = v * v + (a * stdNormalPdf(a) - b * stdNormalPdf(b)) / den

  if (Number.isNaN(w)) return 1.0
  return Math.min(1.0, Math.max(0.0, w))
}

/**
 * Half-width of the draw band — mirrors `private.draw_margin`.
 *
 *     eps = Phi^-1((p + 1) / 2) * sqrt(totalPlayers) * beta
 *
 * `totalPlayers` is the EFFECTIVE headcount `sum(w_i^2)`, which reduces to the
 * plain headcount when every partial-play weight is 1. `p` is clamped away from
 * 0 and 1 so the quantile stays finite.
 *
 * The result is in RAW performance units. Every caller — this mirror's `rate()`,
 * `outcomeProbabilities()`, and `private.trueskill2_update` in the SQL — divides
 * it by `c` before handing it to v()/w(), exactly as canonical TrueSkill does.
 */
export function drawMargin(drawProbability: number, beta: number, totalPlayers: number): number {
  const p = Math.min(Math.max(drawProbability, 1e-9), 1.0 - 1e-9)
  return stdNormalIcdf((p + 1.0) / 2.0) * Math.sqrt(Math.max(totalPlayers, 1e-9)) * beta
}

/* ========================================================================== */
/*  3. Small helpers                                                          */
/* ========================================================================== */

/** The leaderboard number: `mu - 3 * sigma`, mirroring the generated column. */
export function conservativeRating(rating: Rating): number {
  return rating.mu - 3 * rating.sigma
}

/** A brand-new player's prior, as `private.ensure_rating_row` would seed it. */
export function defaultRating(config?: Partial<TrueSkillConfig>): Rating {
  const cfg = resolveConfig(config)
  return { mu: cfg.mu0, sigma: cfg.sigma0 }
}

/** Merge a partial override over the defaults. */
export function resolveConfig(config?: Partial<TrueSkillConfig>): TrueSkillConfig {
  if (!config) return RATING_CONFIG
  return { ...RATING_CONFIG, ...config }
}

/**
 * Postgres `round(numeric, 5)`. Only ever applied to non-negative values here,
 * where "half away from zero" and JavaScript's "half toward +Infinity" agree.
 * Used so a quality written from TypeScript is bit-comparable with one written
 * by `public.match_quality`, which rounds before storing into numeric(6,5).
 */
export function round5(value: number): number {
  return Math.round(value * 1e5) / 1e5
}

/** Clamp helper used by every public entry point that returns a probability. */
function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/* ========================================================================== */
/*  4. rate() — the mirror of public.trueskill2_update                        */
/* ========================================================================== */

/** One player's working state inside `rate()`. `+1` = team A, `-1` = team B. */
interface PlayerState {
  playerId: string
  side: 1 | -1
  mu: number
  sigma: number
  /** `sigma^2 + tau^2` — the dynamics-inflated variance the update works on. */
  s2: number
  weight: number
}

/**
 * Run one TrueSkill 2 posterior update for a two-team fixture.
 *
 * `teamA` is the HOME side and `teamB` the AWAY side, matching the
 * `p_team_a` / `p_team_b` argument order of `public.trueskill2_update`.
 *
 * Throws on the same degenerate inputs the SQL raises 22023 for: an empty side,
 * a player on both sides, all-zero weights on a side, or a non-positive total
 * variance. Duplicate player ids WITHIN a side are collapsed, as
 * `array_agg(distinct ...)` does.
 *
 * Never writes. To persist, call `public.apply_match_rating(matchId)`.
 */
export function rate(
  teamA: readonly RatedTeamMember[],
  teamB: readonly RatedTeamMember[],
  outcome: MatchOutcome,
  options: RateOptions = {},
): RateResult {
  const cfg = resolveConfig(options.config)

  if (outcome !== "a_wins" && outcome !== "b_wins" && outcome !== "draw") {
    throw new RangeError(`rate: outcome must be a_wins | b_wins | draw, got ${String(outcome)}`)
  }

  const a = dedupeById(teamA)
  const b = dedupeById(teamB)

  if (a.length === 0 || b.length === 0) {
    throw new RangeError(`rate: both teams need at least one player (a=${a.length}, b=${b.length})`)
  }

  const bIds = new Set(b.map((p) => p.playerId))
  for (const p of a) {
    if (bIds.has(p.playerId)) {
      throw new RangeError("rate: a player cannot appear on both teams")
    }
  }

  // The SQL keeps six parallel arrays; this keeps one array of records. Same
  // layout (team A first, then team B), same order, but no indexed access —
  // which under `noUncheckedIndexedAccess` would be `number | undefined` at
  // every arithmetic site.
  //
  // TAU: sigma^2 grows a little before every match so a long-inactive but
  // previously certain player can still move.
  const tau2 = cfg.tau * cfg.tau
  const toState = (p: RatedTeamMember, side: 1 | -1): PlayerState => ({
    playerId: p.playerId,
    side,
    mu: p.mu,
    sigma: p.sigma,
    s2: p.sigma * p.sigma + tau2,
    weight: Math.min(1, Math.max(0, p.weight ?? 1)),
  })

  const roster: PlayerState[] = [
    ...a.map((p) => toState(p, 1)),
    ...b.map((p) => toState(p, -1)),
  ]

  let muA = 0
  let muB = 0
  let s2A = 0
  let s2B = 0
  let wsumA = 0
  let wsumB = 0
  let betaTerms = 0 // sum(w_i^2) = effective headcount

  for (const player of roster) {
    if (player.side === 1) {
      muA += player.weight * player.mu
      s2A += player.weight * player.weight * player.s2
      wsumA += player.weight
    } else {
      muB += player.weight * player.mu
      s2B += player.weight * player.weight * player.s2
      wsumB += player.weight
    }
    betaTerms += player.weight * player.weight
  }

  if (wsumA <= 0 || wsumB <= 0) {
    throw new RangeError("rate: every partial-play weight on a team is zero")
  }

  const beta2 = cfg.beta * cfg.beta
  const c2 = s2A + s2B + betaTerms * beta2
  if (!(c2 > 0)) {
    throw new RangeError(`rate: degenerate total variance (c^2 = ${c2})`)
  }
  const c = Math.sqrt(c2)

  const isDraw = outcome === "draw"
  // Order the teams so the winner is first. A draw keeps team A first; vDraw
  // carries its own sign, so the direction still comes out right.
  const dir = outcome === "b_wins" ? -1 : 1
  const t = dir === 1 ? (muA - muB) / c : (muB - muA) / c
  const eps = drawMargin(cfg.drawProbability, cfg.beta, betaTerms) / c

  let v: number
  let w: number
  let marginFactor: number

  if (isDraw) {
    v = vDraw(t, eps)
    w = wDraw(t, eps)
    marginFactor = 1.0 // a draw has no magnitude by definition
  } else {
    v = vWin(t, eps)
    w = wWin(t, eps)
    // Outcome magnitude (TrueSkill 2): logarithmic, multiplicative on the MEAN
    // only, hard-capped, with the raw margin clamped first so a data-entry slip
    // of 999 is a bounded error. The variance update is left exactly as the
    // moment-matching projection produced it — inflating the shrink alongside a
    // heuristic about the mean would make the model falsely confident.
    const margin = Math.min(Math.max(Math.trunc(options.scoreMargin ?? 0), 0), MAX_SCORE_MARGIN)
    marginFactor = Math.min(cfg.marginFactorMax, 1.0 + Math.log(1.0 + margin) / cfg.marginLogDivisor)
  }

  const deltas: RatingDelta[] = roster.map((player) => {
    // Mean: shift by this player's share of the team's uncertainty. A player
    // the model is unsure about absorbs more of the surprise. `player.side * dir`
    // is +1 for the winning side and -1 for the losing one.
    let muNew = player.mu + player.side * dir * player.weight * (player.s2 / c) * v * marginFactor

    // Variance: multiplicative shrink. The bracket is analytically in (0,1);
    // minVarianceRatio is a floating-point backstop, not a tuning knob.
    const ratio = Math.max(1.0 - player.weight * (player.s2 / c2) * w, cfg.minVarianceRatio)
    const sig2New = player.s2 * ratio

    // Product clamps. sigmaFloor keeps every player able to move again; sigma0
    // is the ceiling because nobody should be less known than a new account.
    const sigmaNew = Math.min(cfg.sigma0, Math.max(cfg.sigmaFloor, Math.sqrt(sig2New)))
    muNew = Math.min(cfg.muCeiling, Math.max(cfg.muFloor, muNew))

    return {
      playerId: player.playerId,
      muBefore: player.mu,
      sigmaBefore: player.sigma,
      muAfter: muNew,
      sigmaAfter: sigmaNew,
      muDelta: muNew - player.mu,
      sigmaDelta: sigmaNew - player.sigma,
      conservativeBefore: player.mu - 3 * player.sigma,
      conservativeAfter: muNew - 3 * sigmaNew,
    }
  })

  return { deltas, standardisedGap: t, drawMargin: eps, c, marginFactor, v, w }
}

/**
 * Convenience wrapper for the UI preview: "what would this scoreline do to us?"
 * Derives the outcome and the margin from a scoreline instead of making the
 * caller do it, exactly as `public.apply_match_rating` does before it delegates.
 */
export function rateScoreline(
  home: readonly RatedTeamMember[],
  away: readonly RatedTeamMember[],
  homeScore: number,
  awayScore: number,
  config?: Partial<TrueSkillConfig>,
): RateResult {
  const outcome: MatchOutcome =
    homeScore > awayScore ? "a_wins" : awayScore > homeScore ? "b_wins" : "draw"
  return rate(home, away, outcome, {
    scoreMargin: Math.abs(homeScore - awayScore),
    config,
  })
}

/* ========================================================================== */
/*  5. matchQuality() — the mirror of public.match_quality                    */
/* ========================================================================== */

/**
 * Standard TrueSkill match quality in [0,1] — mirrors `public.match_quality`.
 *
 *     q   = sqrt(n * beta^2 / c^2) * exp( -(muA - muB)^2 / (2 * c^2) )
 *     c^2 = n * beta^2 + sum(sigmaA^2) + sum(sigmaB^2)
 *
 * The first factor penalises uncertainty (two unknown teams could be anything);
 * the second penalises a skill gap. 1 is a perfectly even, well-understood
 * fixture.
 *
 * Returns the FULL-PRECISION value. `public.match_quality` applies
 * `round(..., 5)` on top before storing into `matches.match_quality
 * numeric(6,5)`; use `round5()` (or `matchQualityForStorage()`) when you need
 * the exact stored value. The balancer wants the extra digits to discriminate
 * between near-identical splits.
 *
 * Returns 0 for an empty side instead of throwing, so it is safe inside a loop
 * over many candidate fixtures — the same contract the SQL offers.
 *
 * Unlike `rate()`, partial-play weights are ignored: the SQL does not use them
 * here either, because quality is a property of the fixture, not of the minutes
 * somebody ended up playing.
 */
export function matchQuality(
  teamA: readonly Rating[],
  teamB: readonly Rating[],
  config?: Partial<TrueSkillConfig>,
): number {
  if (teamA.length === 0 || teamB.length === 0) return 0

  const cfg = resolveConfig(config)
  const beta2 = cfg.beta * cfg.beta
  const n = teamA.length + teamB.length

  let muA = 0
  let s2A = 0
  for (const p of teamA) {
    muA += p.mu
    s2A += p.sigma * p.sigma
  }

  let muB = 0
  let s2B = 0
  for (const p of teamB) {
    muB += p.mu
    s2B += p.sigma * p.sigma
  }

  const c2 = n * beta2 + s2A + s2B
  if (!(c2 > 0)) return 0

  const q = Math.sqrt((n * beta2) / c2) * Math.exp(-((muA - muB) * (muA - muB)) / (2.0 * c2))
  if (Number.isNaN(q)) return 0

  return Math.min(1.0, Math.max(0.0, q))
}

/** `matchQuality()` rounded exactly as `public.match_quality` stores it. */
export function matchQualityForStorage(
  teamA: readonly Rating[],
  teamB: readonly Rating[],
  config?: Partial<TrueSkillConfig>,
): number {
  return round5(matchQuality(teamA, teamB, config))
}

/* ========================================================================== */
/*  6. Outcome probabilities                                                  */
/* ========================================================================== */

/**
 * The full outcome distribution for a proposed fixture.
 *
 * The performance difference is `d ~ N(muA - muB, c^2)` with
 * `c^2 = n*beta^2 + sum(sigma^2)`, and a draw is `|d| <= eps` where `eps` is the
 * raw draw margin. So:
 *
 *     P(draw)     = Phi((eps - dMu)/c) - Phi((-eps - dMu)/c)
 *     P(A wins)   = 1 - Phi((eps - dMu)/c)
 *     P(B wins)   = Phi((-eps - dMu)/c)
 *
 * `eps` is standardised by `c` here, exactly as the rating update does, so a
 * forecast and the update it previews agree on where the draw band sits.
 * `quality` is the separate, canonical TrueSkill balance score.
 *
 * `drawProbability` is what gets written to
 * `matches.predicted_draw_probability numeric(6,5)`, so it is rounded to 5 dp;
 * the three probabilities are each clamped to [0,1] and, being rounded
 * independently, may sum to 1 +/- 1e-5.
 */
export function outcomeProbabilities(
  teamA: readonly Rating[],
  teamB: readonly Rating[],
  config?: Partial<TrueSkillConfig>,
): { quality: number; drawProbability: number; homeWinProbability: number; awayWinProbability: number } {
  if (teamA.length === 0 || teamB.length === 0) {
    return { quality: 0, drawProbability: 0, homeWinProbability: 0, awayWinProbability: 0 }
  }

  const cfg = resolveConfig(config)
  const n = teamA.length + teamB.length

  let muA = 0
  let s2A = 0
  for (const p of teamA) {
    muA += p.mu
    s2A += p.sigma * p.sigma
  }
  let muB = 0
  let s2B = 0
  for (const p of teamB) {
    muB += p.mu
    s2B += p.sigma * p.sigma
  }

  const c2 = n * cfg.beta * cfg.beta + s2A + s2B
  if (!(c2 > 0)) {
    return { quality: 0, drawProbability: 0, homeWinProbability: 0, awayWinProbability: 0 }
  }
  const c = Math.sqrt(c2)
  const dMu = muA - muB
  const eps = drawMargin(cfg.drawProbability, cfg.beta, n)

  const upper = stdNormalCdf((eps - dMu) / c)
  const lower = stdNormalCdf((-eps - dMu) / c)

  return {
    quality: round5(matchQuality(teamA, teamB, cfg)),
    drawProbability: round5(clamp01(upper - lower)),
    homeWinProbability: round5(clamp01(1 - upper)),
    awayWinProbability: round5(clamp01(lower)),
  }
}

/* ========================================================================== */
/*  7. Internals                                                              */
/* ========================================================================== */

/**
 * Collapse duplicate player ids within one side, keeping the FIRST occurrence.
 * `array_agg(distinct ...)` in the SQL does the same de-duplication; it also
 * sorts, but the update is order-independent so the difference is invisible.
 */
function dedupeById(team: readonly RatedTeamMember[]): RatedTeamMember[] {
  const seen = new Set<string>()
  const out: RatedTeamMember[] = []
  for (const p of team) {
    if (seen.has(p.playerId)) continue
    seen.add(p.playerId)
    out.push(p)
  }
  return out
}
