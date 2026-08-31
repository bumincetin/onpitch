import { describe, expect, it } from "vitest"

import {
  DIVISIONS,
  LEAGUE_RULES,
  assertDivisionLadderMatchesSql,
  daysLeft,
  divisionAt,
  divisionRank,
  toLeagueStanding,
  zoneFor,
  type Division,
} from "../leagues"

/**
 * `zoneFor` is what colours a row on the standings page and what tells a captain they are going
 * down. It has to mirror `close_season()` in 0009_leagues.sql exactly — a UI that shows a
 * relegation edge on a row the database will hold is worse than no edge at all.
 */

describe("division ladder", () => {
  it("matches the enum order 0009 depends on", () => {
    expect(DIVISIONS).toEqual(["bronze", "silver", "gold", "platinum", "diamond"])
    expect(divisionRank("bronze")).toBe(1)
    expect(divisionRank("diamond")).toBe(5)
  })

  it("clamps at both ends, the way division_at() does", () => {
    expect(divisionAt(0)).toBe("bronze")
    expect(divisionAt(-99)).toBe("bronze")
    expect(divisionAt(6)).toBe("diamond")
    expect(divisionAt(99)).toBe("diamond")
    expect(divisionAt(3)).toBe("gold")
  })

  it("round-trips across the whole ladder", () => {
    expect(() => assertDivisionLadderMatchesSql()).not.toThrow()
  })
})

describe("zoneFor", () => {
  const full = LEAGUE_RULES.minimumForMovement + 4 // 10 teams, comfortably over the threshold

  it("puts the top two in the promotion zone", () => {
    expect(zoneFor(1, full, "bronze")).toBe("promotion")
    expect(zoneFor(2, full, "bronze")).toBe("promotion")
    expect(zoneFor(3, full, "bronze")).toBe("safe")
  })

  it("puts the bottom two in the relegation zone", () => {
    expect(zoneFor(full, full, "silver")).toBe("relegation")
    expect(zoneFor(full - 1, full, "silver")).toBe("relegation")
    expect(zoneFor(full - 2, full, "silver")).toBe("safe")
  })

  it("never relegates out of bronze or promotes out of diamond", () => {
    expect(zoneFor(full, full, "bronze")).toBe("safe")
    expect(zoneFor(1, full, "diamond")).toBe("safe")
    // …but diamond still relegates and bronze still promotes.
    expect(zoneFor(full, full, "diamond")).toBe("relegation")
    expect(zoneFor(1, full, "bronze")).toBe("promotion")
  })

  it("shows no zones at all below the movement threshold", () => {
    const small = LEAGUE_RULES.minimumForMovement - 1
    for (let place = 1; place <= small; place += 1) {
      for (const division of DIVISIONS) {
        expect(zoneFor(place, small, division as Division)).toBe("safe")
      }
    }
  })

  it("does not let the two zones overlap in a table that only just qualifies", () => {
    const size = LEAGUE_RULES.minimumForMovement // 6: places 1-2 up, 5-6 down, 3-4 safe
    const zones = Array.from({ length: size }, (_, i) => zoneFor(i + 1, size, "gold"))
    expect(zones).toEqual(["promotion", "promotion", "safe", "safe", "relegation", "relegation"])
  })
})

describe("daysLeft", () => {
  it("counts whole days to the end of the closing date", () => {
    const now = new Date("2026-09-01T12:00:00Z")
    expect(daysLeft("2026-09-01", now)).toBe(1)
    expect(daysLeft("2026-09-02", now)).toBe(2)
  })

  it("floors at zero once the season is over, rather than going negative", () => {
    const now = new Date("2026-10-10T00:00:00Z")
    expect(daysLeft("2026-10-04", now)).toBe(0)
  })

  it("returns zero for an unparseable date instead of NaN", () => {
    expect(daysLeft("not-a-date")).toBe(0)
  })
})

describe("toLeagueStanding", () => {
  it("camel-cases the wire row without dropping or renaming a number", () => {
    const entry = toLeagueStanding({
      place: 3,
      team_id: "11111111-1111-4111-8111-111111111111",
      team_name: "Kadıköy Kartalları",
      team_slug: "kadikoy-kartallari",
      crest_url: null,
      played: 8,
      won: 3,
      drawn: 2,
      lost: 3,
      goals_for: 14,
      goals_against: 14,
      goal_difference: 0,
      points: 11,
    })

    expect(entry.place).toBe(3)
    expect(entry.teamSlug).toBe("kadikoy-kartallari")
    expect(entry.crestUrl).toBeNull()
    // The invariants the generated columns enforce in Postgres should survive the trip.
    expect(entry.won * 3 + entry.drawn).toBe(entry.points)
    expect(entry.goalsFor - entry.goalsAgainst).toBe(entry.goalDifference)
    expect(entry.won + entry.drawn + entry.lost).toBe(entry.played)
  })
})
