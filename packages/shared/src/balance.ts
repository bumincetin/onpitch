/**
 * packages/shared/src/balance.ts
 *
 * Split N players into two sides that are as even as the rating model can make
 * them.
 *
 * ── Why this shape ───────────────────────────────────────────────────────────
 * Exhaustive search is C(14,7)/2 = 1716 splits for 7-a-side — cheap — but 22
 * players is C(22,11)/2 = 352 716, and the same code has to run inside a route
 * handler while a player waits. So instead:
 *
 *   1. SNAKE-DRAFT SEED. Sort by conservative rating (`mu - 3*sigma`) and deal
 *      A,B,B,A,A,B,B,... That is the standard pick-up-game heuristic and it is
 *      already close to optimal because it equalises the running sum at every
 *      even step.
 *   2. BOUNDED LOCAL SEARCH. Repeatedly consider every cross-side swap, apply
 *      the single best improvement, stop when no swap improves quality or the
 *      iteration budget runs out. Steepest-ascent hill climbing: O(passes *
 *      home*away) quality evaluations, each of which is a handful of flops.
 *
 * ── Determinism is a hard requirement ────────────────────────────────────────
 * There is NO randomness anywhere in this file — no `Math.random`, no
 * `Date.now`, no iteration over a `Set`/`Map` whose insertion order came from
 * elsewhere. Ties are broken by player id, which is stable across processes.
 * The same roster therefore always yields the same suggestion, which is what
 * makes the algorithm testable and what stops "re-roll the teams until I like
 * them" from being a strategy.
 *
 * ── Goalkeepers ──────────────────────────────────────────────────────────────
 * Rating balance is not the only constraint that matters to a real game. If the
 * pool contains at least two goalkeepers, both sides must end up with one; the
 * local search will not accept a swap that breaks that. If the pool has fewer
 * than two, the constraint is dropped rather than failing the whole balance —
 * five-a-side rotates the keeper anyway.
 *
 * Nothing here does I/O. `matches.match_quality` and
 * `matches.predicted_draw_probability` are written from these values by the
 * route handlers.
 */

import type { Enums } from "./database"
import type { MatchQuality, RatedPlayer } from "./domain"

import {
  matchQuality,
  outcomeProbabilities,
  type Rating,
  type TrueSkillConfig,
} from "./trueskill"

/* ========================================================================== */
/*  Format tables                                                             */
/* ========================================================================== */

/** Players per side for each `match_format` enum value. */
export const FORMAT_TEAM_SIZE: Readonly<Record<Enums<"match_format">, number>> = Object.freeze({
  five_a_side: 5,
  six_a_side: 6,
  seven_a_side: 7,
  eight_a_side: 8,
  eleven_a_side: 11,
})

/**
 * Expected COMBINED goals for a format, used only to render a plausible
 * scoreline in the UI. These are product judgement calls tuned to Turkish
 * amateur football (small pitches score more per minute than eleven-a-side),
 * not model outputs. Nothing downstream of the scoreline consumes them.
 */
export const FORMAT_EXPECTED_TOTAL_GOALS: Readonly<Record<Enums<"match_format">, number>> =
  Object.freeze({
    five_a_side: 10,
    six_a_side: 10,
    seven_a_side: 9,
    eight_a_side: 8,
    eleven_a_side: 5,
  })

/**
 * Free-text `profiles.preferred_position` values that mean "keeper". The column
 * has no CHECK constraint by design, so this has to be a tolerant match rather
 * than an enum lookup: Turkish and English, long and short.
 */
const GOALKEEPER_TOKENS: readonly string[] = [
  "gk",
  "goalkeeper",
  "goalie",
  "keeper",
  "kaleci",
  "kale",
]

/** True when a free-text position string names a goalkeeper. */
export function isGoalkeeper(preferredPosition: string | null | undefined): boolean {
  if (!preferredPosition) return false
  const normalised = preferredPosition.trim().toLowerCase()
  if (normalised.length === 0) return false
  return GOALKEEPER_TOKENS.some(
    (token) => normalised === token || normalised.includes(token),
  )
}

/* ========================================================================== */
/*  Options and result                                                        */
/* ========================================================================== */

export interface BalanceOptions {
  /** Drives the team size cap and the expected-scoreline table. */
  format?: Enums<"match_format">
  /**
   * Override the per-side cap from the format. Useful when a venue runs
   * 7-a-side on a pitch that only fits 6, or for a friendly with rolling subs.
   */
  teamSize?: number
  /**
   * Hard ceiling on quality evaluations. The default comfortably covers a
   * 22-player roster (11*11 = 121 candidate swaps per pass, 12 passes) while
   * staying well inside a route handler's budget.
   */
  maxIterations?: number
  /** Require one goalkeeper per side when the pool has at least two. Default true. */
  enforceGoalkeeperCoverage?: boolean
  /** Runtime override of `public.rating_config`. */
  config?: Partial<TrueSkillConfig>
}

/**
 * What `balanceTeams()` returns.
 *
 * Widens `BalancedLineup` from `./domain` (which is `{ home, away,
 * quality }`) with the fields the match-creation route persists and the UI
 * shows. `bench` is not in the domain type because the API never returns it as
 * part of a lineup — it is the balancer telling the caller "these people did not
 * fit", which the caller has to do something about.
 */
export interface BalanceResult {
  home: RatedPlayer[]
  away: RatedPlayer[]
  /** Players who did not fit inside `2 * teamSize`, worst-rated first excluded. */
  bench: RatedPlayer[]
  quality: MatchQuality
  /** Convenience mirror of `quality.drawProbability`, matching the DB column. */
  predictedDrawProbability: number
  /** A plausible scoreline for this fixture. UI garnish — see the note above. */
  expectedScoreline: { home: number; away: number }
  /** How many quality evaluations the local search actually spent. */
  iterations: number
  /** How many improving swaps were applied after the snake-draft seed. */
  swapsApplied: number
  /** True when both sides ended up with a goalkeeper (or the rule was dropped). */
  goalkeeperCoverage: boolean
}

/* ========================================================================== */
/*  Entry point                                                               */
/* ========================================================================== */

/**
 * Deterministically split `players` into two balanced sides.
 *
 * Returns empty sides (and a zero quality) for an empty roster rather than
 * throwing: the balancer is called speculatively while a match is still filling
 * up, and an empty pool is a normal state, not an error.
 *
 * A single player goes home-side with an empty away side — again, normal while
 * filling. `quality` is 0 in that case, exactly as `public.match_quality`
 * reports for an empty side.
 */
export function balanceTeams(
  players: readonly RatedPlayer[],
  options: BalanceOptions = {},
): BalanceResult {
  const format: Enums<"match_format"> = options.format ?? "seven_a_side"
  const cap = Math.max(1, Math.trunc(options.teamSize ?? FORMAT_TEAM_SIZE[format]))
  const maxIterations = Math.max(0, Math.trunc(options.maxIterations ?? 2000))
  const enforceGk = options.enforceGoalkeeperCoverage ?? true
  const config = options.config

  // Deduplicate defensively: a caller assembling a roster from participants plus
  // team members can easily list somebody twice, and `rate()` would throw.
  const pool = dedupe(players)

  // Deterministic seed order: strongest first, ties broken by id so two players
  // on identical ratings never swap places between two calls.
  const ranked = [...pool].sort(compareByStrengthDesc)

  // Only 2 * cap can play; the rest are bench, taken from the WEAKEST end so the
  // fixture that does happen is the strongest one available.
  const playing = ranked.slice(0, cap * 2)
  const bench = ranked.slice(cap * 2)

  if (playing.length === 0) {
    return emptyResult(bench)
  }

  // ── 1. Snake-draft seed ──────────────────────────────────────────────────
  // A,B,B,A,A,B,B,... equalises the running strength sum at every even index.
  // The size caps are respected by falling through to whichever side has room.
  const home: RatedPlayer[] = []
  const away: RatedPlayer[] = []

  for (const [i, player] of playing.entries()) {
    const prefersHome = i % 4 === 0 || i % 4 === 3
    const target = prefersHome ? home : away
    const other = prefersHome ? away : home
    // `playing.length <= 2 * cap`, so at least one side always has room.
    if (target.length < cap) target.push(player)
    else other.push(player)
  }

  // ── 2. Goalkeeper repair ─────────────────────────────────────────────────
  // Done BEFORE the local search so the search starts from a feasible point and
  // only ever has to preserve feasibility, never restore it.
  const gkRequired = enforceGk && countGoalkeepers(playing) >= 2 && home.length > 0 && away.length > 0
  if (gkRequired) {
    repairGoalkeeperCoverage(home, away)
  }

  // ── 3. Bounded steepest-ascent local search ──────────────────────────────
  let iterations = 0
  let swapsApplied = 0
  let current = matchQuality(ratingsOf(home), ratingsOf(away), config)

  if (home.length > 0 && away.length > 0) {
    let improved = true

    while (improved && iterations < maxIterations) {
      improved = false
      let bestQuality = current
      let best: { homeIndex: number; awayIndex: number } | null = null

      // Index-derived, strictly ascending iteration order. This IS the
      // "deterministic ordering" the no-RNG rule demands: there is no shuffle to
      // replace, the candidate list is enumerated in a fixed order and ties are
      // broken by taking the first-seen best.
      outer: for (const [h, homePlayer] of home.entries()) {
        for (const [a, awayPlayer] of away.entries()) {
          if (iterations >= maxIterations) break outer
          if (gkRequired && breaksGoalkeeperCoverage(home, away, homePlayer, awayPlayer)) continue

          iterations += 1

          // Evaluate the swap without mutating: build the two candidate sides by
          // substituting a single element each.
          const candidateHome = substitute(home, h, awayPlayer)
          const candidateAway = substitute(away, a, homePlayer)
          const q = matchQuality(candidateHome, candidateAway, config)

          // Strict `>` keeps the search from cycling between two equal states.
          if (q > bestQuality) {
            bestQuality = q
            best = { homeIndex: h, awayIndex: a }
          }
        }
      }

      if (best) {
        const fromHome = home[best.homeIndex]
        const fromAway = away[best.awayIndex]
        if (fromHome && fromAway) {
          home[best.homeIndex] = fromAway
          away[best.awayIndex] = fromHome
          current = bestQuality
          swapsApplied += 1
          improved = true
        }
      }
    }
  }

  // ── 4. Present the result ────────────────────────────────────────────────
  // Sort each side strongest-first so the UI renders a stable line-up; the sort
  // cannot change the quality, which is symmetric in the roster.
  home.sort(compareByStrengthDesc)
  away.sort(compareByStrengthDesc)

  const probabilities = outcomeProbabilities(ratingsOf(home), ratingsOf(away), config)
  const quality: MatchQuality = {
    quality: probabilities.quality,
    drawProbability: probabilities.drawProbability,
    homeWinProbability: probabilities.homeWinProbability,
    awayWinProbability: probabilities.awayWinProbability,
  }

  return {
    home,
    away,
    bench,
    quality,
    predictedDrawProbability: quality.drawProbability,
    expectedScoreline: expectedScoreline(quality, format),
    iterations,
    swapsApplied,
    goalkeeperCoverage: !gkRequired || (hasGoalkeeper(home) && hasGoalkeeper(away)),
  }
}

/* ========================================================================== */
/*  Side selection for a single joiner                                        */
/* ========================================================================== */

/**
 * Which side should ONE new player join?
 *
 * Used by `POST /api/matches/[id]/join`, where the existing line-up is fixed and
 * only the newcomer's side is in question. Rebalancing everybody at that moment
 * would be hostile — people have already been told which shirt to bring.
 *
 * Rules, in order:
 *   1. A side that is already full is not an option.
 *   2. If exactly one side has room, that is the answer.
 *   3. Otherwise pick the side that yields the higher post-join match quality.
 *   4. Ties (including the very first joiner, where both sides are empty and
 *      quality is 0 either way) go to the SMALLER side, then to 'home'. That
 *      keeps sides even while a match fills instead of stacking one dressing
 *      room and relying on later swaps.
 */
export function chooseSideForJoin(
  home: readonly Rating[],
  away: readonly Rating[],
  joiner: Rating,
  options: { teamSize: number; config?: Partial<TrueSkillConfig> },
): { side: "home" | "away"; qualityIfHome: number; qualityIfAway: number } {
  const cap = Math.max(1, Math.trunc(options.teamSize))
  const homeHasRoom = home.length < cap
  const awayHasRoom = away.length < cap

  const qualityIfHome = matchQuality([...home, joiner], away, options.config)
  const qualityIfAway = matchQuality(home, [...away, joiner], options.config)

  if (homeHasRoom && !awayHasRoom) return { side: "home", qualityIfHome, qualityIfAway }
  if (awayHasRoom && !homeHasRoom) return { side: "away", qualityIfHome, qualityIfAway }

  if (qualityIfHome > qualityIfAway) return { side: "home", qualityIfHome, qualityIfAway }
  if (qualityIfAway > qualityIfHome) return { side: "away", qualityIfHome, qualityIfAway }

  if (home.length > away.length) return { side: "away", qualityIfHome, qualityIfAway }
  return { side: "home", qualityIfHome, qualityIfAway }
}

/* ========================================================================== */
/*  Scoreline heuristic                                                       */
/* ========================================================================== */

/**
 * Render a plausible scoreline from an outcome distribution.
 *
 * Deliberately simple and clearly labelled as a heuristic: total goals come from
 * the format table, and the margin is the win-probability edge scaled by half
 * the total. It is a nicety on a match card ("expect roughly 5-4"), never an
 * input to a rating, a payout, or a dispute.
 */
export function expectedScoreline(
  quality: MatchQuality,
  format: Enums<"match_format"> = "seven_a_side",
): { home: number; away: number } {
  const total = FORMAT_EXPECTED_TOTAL_GOALS[format]
  const edge = quality.homeWinProbability - quality.awayWinProbability // [-1, 1]
  const diff = edge * (total / 2)

  const home = Math.max(0, Math.round((total + diff) / 2))
  const away = Math.max(0, Math.round((total - diff) / 2))
  return { home, away }
}

/* ========================================================================== */
/*  Internals                                                                 */
/* ========================================================================== */

/** Strongest first; `playerId` breaks every tie so the order is total. */
function compareByStrengthDesc(a: RatedPlayer, b: RatedPlayer): number {
  const ca = a.rating.conservativeRating
  const cb = b.rating.conservativeRating
  if (cb !== ca) return cb - ca
  if (b.rating.mu !== a.rating.mu) return b.rating.mu - a.rating.mu
  return a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0
}

/** Project a line-up down to the bare Gaussians the rating maths consumes. */
export function ratingsOf(players: readonly RatedPlayer[]): Rating[] {
  return players.map((p) => p.rating)
}

function dedupe(players: readonly RatedPlayer[]): RatedPlayer[] {
  const seen = new Set<string>()
  const out: RatedPlayer[] = []
  for (const p of players) {
    if (seen.has(p.playerId)) continue
    seen.add(p.playerId)
    out.push(p)
  }
  return out
}

/** A copy of `list` with element `index` replaced. Never mutates the input. */
function substitute(
  list: readonly RatedPlayer[],
  index: number,
  replacement: RatedPlayer,
): Rating[] {
  return list.map((player, i) => (i === index ? replacement.rating : player.rating))
}

function countGoalkeepers(players: readonly RatedPlayer[]): number {
  let n = 0
  for (const p of players) if (isGoalkeeper(p.preferredPosition)) n += 1
  return n
}

function hasGoalkeeper(players: readonly RatedPlayer[]): boolean {
  return players.some((p) => isGoalkeeper(p.preferredPosition))
}

/**
 * Move one goalkeeper across so both sides have cover.
 *
 * Only ever runs when the pool holds at least two keepers, so the side that
 * gives one up is guaranteed to keep one. The keeper who moves is the one
 * closest in strength to the outfield player coming back, which minimises the
 * balance damage the repair does; ties fall to the lowest player id.
 */
function repairGoalkeeperCoverage(home: RatedPlayer[], away: RatedPlayer[]): void {
  const homeHas = hasGoalkeeper(home)
  const awayHas = hasGoalkeeper(away)
  if (homeHas && awayHas) return
  if (!homeHas && !awayHas) return // nothing to move; caller's precondition failed

  const donor = homeHas ? home : away
  const receiver = homeHas ? away : home

  // Keep the donor's best keeper; give away the weakest one.
  const donorKeepers = [...donor.entries()]
    .filter(([, player]) => isGoalkeeper(player.preferredPosition))
    .sort(([, x], [, y]) => compareByStrengthDesc(x, y))

  const moving = donorKeepers.at(-1)
  if (donorKeepers.length < 2 || !moving) return
  const [movingIndex, movingPlayer] = moving

  // Swap for the receiver's outfield player nearest in strength; ties fall to
  // the lowest player id so the repair is as deterministic as the draft.
  let best: { index: number; player: RatedPlayer } | null = null
  let bestGap = Number.POSITIVE_INFINITY

  for (const [i, player] of receiver.entries()) {
    if (isGoalkeeper(player.preferredPosition)) continue
    const gap = Math.abs(
      player.rating.conservativeRating - movingPlayer.rating.conservativeRating,
    )
    const better =
      gap < bestGap || (gap === bestGap && best !== null && player.playerId < best.player.playerId)
    if (better) {
      bestGap = gap
      best = { index: i, player }
    }
  }

  if (!best) return

  donor[movingIndex] = best.player
  receiver[best.index] = movingPlayer
}

/**
 * Would swapping these two players leave a side without a keeper?
 *
 * Cheap structural test rather than a re-scan: coverage can only break when the
 * swap moves a keeper out of a side that has exactly one.
 */
function breaksGoalkeeperCoverage(
  home: readonly RatedPlayer[],
  away: readonly RatedPlayer[],
  homePlayer: RatedPlayer,
  awayPlayer: RatedPlayer,
): boolean {
  const homeOut = isGoalkeeper(homePlayer.preferredPosition)
  const awayOut = isGoalkeeper(awayPlayer.preferredPosition)
  if (homeOut === awayOut) return false // keeper-for-keeper, or neither: coverage unchanged

  if (homeOut) return countGoalkeepers(home) <= 1
  return countGoalkeepers(away) <= 1
}

function emptyResult(bench: RatedPlayer[]): BalanceResult {
  const quality: MatchQuality = {
    quality: 0,
    drawProbability: 0,
    homeWinProbability: 0,
    awayWinProbability: 0,
  }
  return {
    home: [],
    away: [],
    bench,
    quality,
    predictedDrawProbability: 0,
    expectedScoreline: { home: 0, away: 0 },
    iterations: 0,
    swapsApplied: 0,
    goalkeeperCoverage: true,
  }
}
