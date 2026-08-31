import { describe, expect, it } from "vitest"

import {
  LEVEL_CURVE_FIXTURES,
  RANKS,
  assertLevelCurveMatchesSql,
  formatXp,
  formToLetters,
  levelForXp,
  levelProgress,
  rankForLevel,
  xpForLevel,
} from "../gamification"

/**
 * The level curve exists twice: `private.level_for_xp` in 0008_gamification.sql owns the stored
 * `player_progress.level`, and this module draws the ring. These tests are the TypeScript half of
 * the pin — the migration ends with a `do $test$` block asserting the same boundary values, so a
 * change to either side fails loudly rather than letting the two disagree about somebody's level.
 */

describe("level curve", () => {
  it("matches the boundaries pinned in 0008_gamification.sql", () => {
    for (const [xp, level] of LEVEL_CURVE_FIXTURES) {
      expect(levelForXp(xp), `levelForXp(${xp})`).toBe(level)
    }
  })

  it("agrees with the SQL over the whole ladder", () => {
    expect(() => assertLevelCurveMatchesSql()).not.toThrow()
  })

  it("costs a flat 100 x L to go from L to L+1", () => {
    for (let level = 1; level <= 60; level += 1) {
      expect(xpForLevel(level + 1) - xpForLevel(level)).toBe(100 * level)
    }
  })

  it("round-trips at every level floor and every level ceiling", () => {
    for (let level = 1; level <= 200; level += 1) {
      expect(levelForXp(xpForLevel(level))).toBe(level)
      expect(levelForXp(xpForLevel(level + 1) - 1)).toBe(level)
    }
  })

  it("never returns a level below 1, whatever it is handed", () => {
    for (const xp of [0, -1, -1e9, Number.NaN, Number.NEGATIVE_INFINITY]) {
      expect(levelForXp(xp)).toBeGreaterThanOrEqual(1)
    }
  })

  it("floors a fractional XP total rather than rounding it up a level", () => {
    // 99.9 XP is not level 2. A player one point short must stay where they are.
    expect(levelForXp(99.9)).toBe(1)
    expect(levelForXp(100)).toBe(2)
  })
})

describe("levelProgress", () => {
  it("reports a ratio inside [0, 1] and a remainder that reaches zero at the boundary", () => {
    for (let xp = 0; xp <= 20_000; xp += 37) {
      const p = levelProgress(xp)
      expect(p.ratio).toBeGreaterThanOrEqual(0)
      expect(p.ratio).toBeLessThanOrEqual(1)
      expect(p.into).toBeGreaterThanOrEqual(0)
      expect(p.into).toBeLessThan(p.span)
      expect(p.floor + p.into).toBe(xp)
      expect(p.remaining).toBe(p.ceiling - xp)
    }
  })

  it("sits exactly on the floor at a level boundary", () => {
    const p = levelProgress(300)
    expect(p.level).toBe(3)
    expect(p.into).toBe(0)
    expect(p.ratio).toBe(0)
    expect(p.remaining).toBe(300)
  })
})

describe("ranks", () => {
  it("gives every level a rank, and never skips backwards", () => {
    let lastFrom = 0
    for (let level = 1; level <= 120; level += 1) {
      const rank = rankForLevel(level)
      expect(rank.from).toBeLessThanOrEqual(level)
      expect(rank.from).toBeGreaterThanOrEqual(lastFrom)
      lastFrom = rank.from
    }
  })

  it("starts at Çaylak and tops out at Efsane", () => {
    expect(rankForLevel(1).tr).toBe("Çaylak")
    expect(rankForLevel(4).tr).toBe("Çaylak")
    expect(rankForLevel(5).tr).toBe("Amatör")
    expect(rankForLevel(999).tr).toBe(RANKS[RANKS.length - 1]?.tr)
  })
})

describe("formatting", () => {
  it("groups Turkish thousands without a comma", () => {
    expect(formatXp(1494)).not.toContain(",")
    expect(formatXp(0)).toBe("0")
  })

  it("survives a non-finite total rather than printing NaN", () => {
    expect(formatXp(Number.NaN)).toBe("0")
    expect(formatXp(Number.POSITIVE_INFINITY)).toBe("0")
  })

  it("prints form oldest-first, capped at five", () => {
    expect(formToLetters(["win", "draw", "loss"])).toEqual(["G", "B", "M"])
    expect(formToLetters(["loss", "loss", "win", "win", "draw", "win"])).toEqual([
      "loss",
      "win",
      "win",
      "draw",
      "win",
    ].map((r) => (r === "win" ? "G" : r === "draw" ? "B" : "M")))
  })
})
