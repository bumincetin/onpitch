import { describe, expect, it } from "vitest"

import {
  RATING_CONFIG,
  conservativeRating,
  defaultRating,
  drawMargin,
  rate,
  stdNormalCdf,
  stdNormalIcdf,
  stdNormalPdf,
  vDraw,
  vWin,
  wDraw,
  wWin,
  type RatedTeamMember,
} from "../trueskill"

/**
 * This module is a second implementation of `public.trueskill2_update` in 0004_trueskill.sql.
 * The database is the only writer of persisted ratings; this copy exists so a client can preview
 * a rating change without a round trip, and the two have to stay numerically identical.
 *
 * The end-to-end case below is the SAME golden vector the migration's `do $selftest$` block
 * asserts — a default 1v1 reproducing the published TrueSkill reference of 29.396 / 7.171 for the
 * winner and 25.000 / 6.458 for a draw. It exercises the whole chain in one shot: tau inflation,
 * c, the eps/c standardisation, v, w and the variance shrink. A plain "is it finite" check sails
 * straight past the standardisation bug this catches.
 */

const player = (id: string, mu: number, sigma: number): RatedTeamMember => ({
  playerId: id,
  mu,
  sigma,
})

describe("normal distribution helpers", () => {
  it("has a pdf that integrates to about 1 over [-6, 6]", () => {
    const step = 0.001
    let area = 0
    for (let x = -6; x <= 6; x += step) area += stdNormalPdf(x) * step
    expect(area).toBeCloseTo(1, 3)
  })

  it("does not blow up in the far tail, where exp() underflows", () => {
    // Postgres RAISES on float8 underflow rather than returning 0, which is why the SQL side
    // guards |x| > ~38.6. The TypeScript side must at least not return NaN.
    for (const x of [-60, -40, 40, 60]) {
      expect(Number.isFinite(stdNormalPdf(x))).toBe(true)
      expect(stdNormalPdf(x)).toBeGreaterThanOrEqual(0)
    }
  })

  it("has a cdf that is monotone, bounded and symmetric", () => {
    expect(stdNormalCdf(0)).toBeCloseTo(0.5, 9)
    expect(stdNormalCdf(-1.959963985)).toBeCloseTo(0.025, 6)
    expect(stdNormalCdf(1.959963985)).toBeCloseTo(0.975, 6)

    let previous = -1
    for (let x = -8; x <= 8; x += 0.05) {
      const p = stdNormalCdf(x)
      expect(p).toBeGreaterThanOrEqual(previous)
      expect(p).toBeGreaterThanOrEqual(0)
      expect(p).toBeLessThanOrEqual(1)
      previous = p
    }
  })

  it("has an icdf that inverts the cdf", () => {
    for (const p of [0.001, 0.05, 0.25, 0.5, 0.75, 0.95, 0.999]) {
      expect(stdNormalCdf(stdNormalIcdf(p))).toBeCloseTo(p, 5)
    }
  })
})

describe("truncated-Gaussian moments", () => {
  it("keeps w in [0, 1], which is what makes sigma shrink rather than grow", () => {
    for (let t = -5; t <= 5; t += 0.1) {
      for (const eps of [0, 0.05, 0.5]) {
        const win = wWin(t, eps)
        const draw = wDraw(t, eps)
        expect(win).toBeGreaterThanOrEqual(0)
        expect(win).toBeLessThanOrEqual(1)
        expect(draw).toBeGreaterThanOrEqual(0)
        expect(draw).toBeLessThanOrEqual(1)
      }
    }
  })

  it("moves mu not at all on an evenly matched draw", () => {
    // v_draw(0, eps) = 0 by symmetry. This is the assertion the SQL self-test makes too.
    expect(vDraw(0, 0.05619521497878026)).toBeCloseTo(0, 12)
  })

  it("moves mu upward for a winner and the same amount downward for the loser", () => {
    expect(vWin(0, 0.05619521497878026)).toBeGreaterThan(0)
  })
})

describe("drawMargin", () => {
  it("reproduces the SQL fixture for p=0.10, beta=25/6, n=2", () => {
    expect(drawMargin(0.1, 25 / 6, 2)).toBeCloseTo(0.7405, 3)
  })

  it("is zero when a draw is impossible and grows with the draw probability", () => {
    const beta = 25 / 6
    // Not exactly zero: the margin runs through `stdNormalIcdf`, which is Acklam's rational
    // approximation, and its error at p = 0.5 is around 1e-9. The SQL side uses the same
    // approximation, so both agree — and 1e-9 of a goal margin cannot move a rating.
    expect(Math.abs(drawMargin(0, beta, 2))).toBeLessThan(1e-6)
    expect(drawMargin(0.3, beta, 2)).toBeGreaterThan(drawMargin(0.1, beta, 2))
  })
})

describe("rate — the golden vector from 0004_trueskill.sql", () => {
  const a = [player("a", 25, 25 / 3)]
  const b = [player("b", 25, 25 / 3)]

  it("gives the published reference for a decisive default 1v1", () => {
    const result = rate(a, b, "a_wins")

    const winner = result.deltas.find((d) => d.playerId === "a")
    const loser = result.deltas.find((d) => d.playerId === "b")
    expect(winner).toBeDefined()
    expect(loser).toBeDefined()

    expect(winner?.muAfter).toBeCloseTo(29.395831692991514, 9)
    expect(winner?.sigmaAfter).toBeCloseTo(7.171475807009221, 9)
    expect(loser?.muAfter).toBeCloseTo(20.604168307008486, 9)
    expect(loser?.sigmaAfter).toBeCloseTo(7.171475807009221, 9)
  })

  it("gives the published reference for a drawn default 1v1", () => {
    const result = rate(a, b, "draw")
    for (const delta of result.deltas) {
      expect(delta.muAfter).toBeCloseTo(25, 9)
      expect(delta.sigmaAfter).toBeCloseTo(6.457515683245048, 9)
    }
  })

  it("is antisymmetric: swapping the sides mirrors the result", () => {
    const forward = rate(a, b, "a_wins")
    const reversed = rate(b, a, "b_wins")

    const fwdWinner = forward.deltas.find((d) => d.playerId === "a")
    const revWinner = reversed.deltas.find((d) => d.playerId === "a")
    expect(fwdWinner?.muAfter).toBeCloseTo(revWinner?.muAfter ?? Number.NaN, 12)
    expect(fwdWinner?.sigmaAfter).toBeCloseTo(revWinner?.sigmaAfter ?? Number.NaN, 12)
  })
})

describe("rate — invariants that hold for any legal input", () => {
  it("never increases sigma on a rated result", () => {
    // Uncertainty only grows through the nightly decay job, never through playing.
    const teamA = [player("a1", 30, 4), player("a2", 18, 7.9)]
    const teamB = [player("b1", 22, 2.5), player("b2", 27, 6.1)]

    for (const outcome of ["a_wins", "b_wins", "draw"] as const) {
      for (const delta of rate(teamA, teamB, outcome).deltas) {
        expect(delta.sigmaAfter).toBeLessThanOrEqual(delta.sigmaBefore + 1e-9)
        expect(delta.sigmaAfter).toBeGreaterThan(0)
        expect(Number.isFinite(delta.muAfter)).toBe(true)
      }
    }
  })

  it("moves the winning side up and the losing side down", () => {
    const teamA = [player("a1", 25, 8), player("a2", 25, 8)]
    const teamB = [player("b1", 25, 8), player("b2", 25, 8)]

    for (const delta of rate(teamA, teamB, "a_wins").deltas) {
      if (delta.playerId.startsWith("a")) expect(delta.muAfter).toBeGreaterThan(delta.muBefore)
      else expect(delta.muAfter).toBeLessThan(delta.muBefore)
    }
  })

  it("moves a heavy favourite less for winning than an underdog would", () => {
    const favourite = rate([player("fav", 40, 3)], [player("dog", 15, 3)], "a_wins")
    const upset = rate([player("dog", 15, 3)], [player("fav", 40, 3)], "a_wins")

    const expected = favourite.deltas.find((d) => d.playerId === "fav")
    const surprising = upset.deltas.find((d) => d.playerId === "dog")

    const expectedGain = (expected?.muAfter ?? 0) - (expected?.muBefore ?? 0)
    const surprisingGain = (surprising?.muAfter ?? 0) - (surprising?.muBefore ?? 0)
    expect(surprisingGain).toBeGreaterThan(expectedGain)
  })

  it("refuses a player who appears on both sides", () => {
    expect(() => rate([player("x", 25, 8)], [player("x", 25, 8)], "draw")).toThrow(RangeError)
  })

  it("refuses an empty side and an unknown outcome", () => {
    expect(() => rate([], [player("b", 25, 8)], "draw")).toThrow(RangeError)
    // @ts-expect-error deliberately passing an outcome outside the union
    expect(() => rate([player("a", 25, 8)], [player("b", 25, 8)], "nonsense")).toThrow(RangeError)
  })
})

describe("defaults", () => {
  it("starts a newcomer at the prior the database uses", () => {
    const start = defaultRating()
    expect(start.mu).toBeCloseTo(RATING_CONFIG.mu0, 12)
    expect(start.sigma).toBeCloseTo(RATING_CONFIG.sigma0, 12)
    // mu - 3*sigma, which is the generated `conservative_rating` column in 0001.
    expect(conservativeRating(start)).toBeCloseTo(0, 9)
  })
})
