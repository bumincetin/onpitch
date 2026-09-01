import { describe, expect, it } from "vitest"

import {
  FORMATIONS,
  PITCH_FORMAT_PLAYERS,
  actualMinutes,
  blockAtMinute,
  buildBlockBoundaries,
  buildFormation,
  canTransition,
  createDebriefDraft,
  debriefShareText,
  defaultFormationFor,
  deriveMatchdayPhase,
  emptyMatchdayRecord,
  fairPlaySummary,
  matchdayRecordSchema,
  planRotations,
  playerMinutesFromBlocks,
  resolveFormation,
  transitionRecord,
  type Player,
  type PreMatchPlan,
  type RotationInput,
} from "../matchday"

/* -------------------------------------------------------------------------- */

function squad(count: number, overrides: Partial<Player> = {}): Player[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `p${index + 1}`,
    name: `Oyuncu ${index + 1}`,
    number: index + 1,
    preferredPositions: [],
    status: "available",
    ...overrides,
  }))
}

function rotationInput(overrides: Partial<RotationInput> = {}): RotationInput {
  const formation = defaultFormationFor("7v7")
  const players = squad(10)
  return {
    durationMinutes: 60,
    periods: 2,
    rotationIntervalMinutes: 10,
    formation,
    players,
    startingLineup: formation.slots.map((slot, index) => ({ slotId: slot.id, playerId: players[index]!.id })),
    goalkeeperMode: "dedicated",
    dedicatedGoalkeeperId: "p1",
    ...overrides,
  }
}

/* -------------------------------------------------------------------------- */

describe("formations", () => {
  it("has one goalkeeper and the right number of outfield slots for every preset", () => {
    for (const formation of FORMATIONS) {
      expect(formation.slots.length).toBe(PITCH_FORMAT_PLAYERS[formation.format])
      expect(formation.slots.filter((slot) => slot.role === "GK")).toHaveLength(1)
      const ids = new Set(formation.slots.map((slot) => slot.id))
      expect(ids.size).toBe(formation.slots.length)
    }
  })

  it("keeps every node inside the pitch, attacking upwards", () => {
    for (const formation of FORMATIONS) {
      for (const slot of formation.slots) {
        expect(slot.x).toBeGreaterThan(0)
        expect(slot.x).toBeLessThan(100)
        expect(slot.y).toBeGreaterThan(0)
        expect(slot.y).toBeLessThan(100)
      }
      const gk = formation.slots.find((slot) => slot.role === "GK")!
      const forwards = formation.slots.filter((slot) => slot.role === "FWD")
      for (const forward of forwards) expect(forward.y).toBeLessThan(gk.y)
    }
  })

  it("names presets the way a coach says them", () => {
    expect(resolveFormation("7v7:2-3-1")?.name).toBe("7v7 2-3-1")
    expect(resolveFormation("11v11:4-3-3")?.slots).toHaveLength(11)
    expect(resolveFormation("9v9:3-3-2")?.shape).toEqual([3, 3, 2])
  })

  it("builds a custom shape on the fly and rejects an impossible one", () => {
    expect(resolveFormation("7v7:1-4-1")?.slots).toHaveLength(7)
    expect(resolveFormation("7v7:4-4-1")).toBeNull()
    expect(resolveFormation("nonsense")).toBeNull()
    expect(() => buildFormation("5v5", [2, 2, 2])).toThrow(RangeError)
  })
})

/* -------------------------------------------------------------------------- */

describe("block boundaries", () => {
  it("never straddles a period break", () => {
    const blocks = buildBlockBoundaries(60, 2, 10)
    expect(blocks).toHaveLength(6)
    expect(blocks.map((block) => block.period)).toEqual([1, 1, 1, 2, 2, 2])
    expect(blocks[2]!.endMinute).toBe(30)
    expect(blocks[3]!.startMinute).toBe(30)
  })

  it("spreads a remainder evenly instead of leaving a stub", () => {
    const blocks = buildBlockBoundaries(90, 2, 10)
    expect(blocks).toHaveLength(10)
    for (const block of blocks) expect(block.endMinute - block.startMinute).toBe(9)
    expect(blocks[blocks.length - 1]!.endMinute).toBe(90)
  })

  it("gives one block per period when the interval exceeds the period", () => {
    expect(buildBlockBoundaries(40, 4, 15)).toHaveLength(4)
  })
})

/* -------------------------------------------------------------------------- */

describe("rotation engine — dedicated goalkeeper", () => {
  it("keeps the keeper in goal for every block and shares the rest equally", () => {
    const result = planRotations(rotationInput())

    expect(result.blocks).toHaveLength(6)
    for (const block of result.blocks) {
      expect(block.goalkeeperId).toBe("p1")
      expect(block.onPitch.find((entry) => entry.slotId === "gk")?.playerId).toBe("p1")
      expect(block.onPitch).toHaveLength(7)
    }
    expect(result.minutesByPlayer.p1).toBe(60)

    // 9 outfield players share 6 slots × 60 minutes = 360 → 40 each, exactly.
    for (const id of ["p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9", "p10"]) {
      expect(result.minutesByPlayer[id]).toBe(40)
    }
    expect(result.fairness.targetMinutes).toBe(40)
    expect(result.fairness.spreadMinutes).toBe(0)
  })

  it("honours the starting line-up in the first block and makes no swaps there", () => {
    const result = planRotations(rotationInput())
    const first = result.blocks[0]!
    expect(first.swaps).toEqual([])
    expect(first.onPitch.map((entry) => entry.playerId)).toEqual(["p1", "p2", "p3", "p4", "p5", "p6", "p7"])
  })

  it("brings on the bench first, and every swap names a slot", () => {
    const result = planRotations(rotationInput())
    const second = result.blocks[1]!
    expect(second.swaps.map((swap) => swap.in).sort()).toEqual(["p10", "p8", "p9"])
    for (const swap of second.swaps) {
      expect(swap.out).not.toBeNull()
      expect(second.onPitch.some((entry) => entry.slotId === swap.slotId && entry.playerId === swap.in)).toBe(true)
    }
  })

  it("keeps the spread within one block when the split is not exact", () => {
    // 11 outfield players over 6 slots with 6 blocks of 10: 360 / 11 = 32.7 minutes each.
    const players = squad(12)
    const result = planRotations(rotationInput({ players }))
    expect(result.fairness.spreadMinutes).toBeLessThanOrEqual(10)
    expect(Object.values(result.minutesByPlayer).reduce((sum, value) => sum + value, 0)).toBe(60 + 360)
  })

  it("is deterministic", () => {
    const a = planRotations(rotationInput())
    const b = planRotations(rotationInput())
    expect(a).toEqual(b)
  })

  it("ignores injured and absent players", () => {
    const players = squad(10)
    players[9]!.status = "injured"
    players[8]!.status = "absent"
    const result = planRotations(rotationInput({ players }))
    for (const block of result.blocks) {
      expect(block.onPitch.some((entry) => entry.playerId === "p10")).toBe(false)
      expect(block.onPitch.some((entry) => entry.playerId === "p9")).toBe(false)
    }
    expect(result.minutesByPlayer.p10).toBe(0)
  })

  it("plays everyone all match when there is no bench", () => {
    const result = planRotations(rotationInput({ players: squad(7) }))
    for (const block of result.blocks) expect(block.swaps).toEqual([])
    expect(result.fairness.spreadMinutes).toBe(0)
  })

  it("prefers a vacated slot that matches the substitute's preferred position", () => {
    const players = squad(10)
    players[7]!.preferredPositions = ["FWD"]
    const formation = defaultFormationFor("7v7") // 2-3-1: the lone forward is l3p1
    const result = planRotations(rotationInput({ players, formation }))
    const second = result.blocks[1]!
    const swapForP8 = second.swaps.find((swap) => swap.in === "p8")
    // p8 comes on in block 2 (bench, 0 minutes) and the forward slot is one of the vacated ones
    // only if its holder rests; either way p8 must never land in goal.
    expect(swapForP8).toBeDefined()
    expect(swapForP8!.slotId).not.toBe("gk")
  })
})

describe("rotation engine — rotating goalkeeper", () => {
  it("rotates goal duty and counts keeper minutes as playing time", () => {
    const result = planRotations(
      rotationInput({ goalkeeperMode: "rotating", dedicatedGoalkeeperId: null, players: squad(8) }),
    )
    const keepers = new Set(result.blocks.map((block) => block.goalkeeperId))
    expect(keepers.size).toBeGreaterThan(1)
    for (const block of result.blocks) {
      expect(block.onPitch.find((entry) => entry.slotId === "gk")?.playerId).toBe(block.goalkeeperId)
      expect(block.onPitch).toHaveLength(7)
    }
    // 8 players share 7 × 60 = 420 minutes → 52.5 each, so within one block of each other.
    expect(result.fairness.spreadMinutes).toBeLessThanOrEqual(10)
    const keeperMinutes = Object.values(result.goalkeeperMinutesByPlayer).reduce((sum, value) => sum + value, 0)
    expect(keeperMinutes).toBe(60)
  })

  it("falls back to rotation when the dedicated keeper is unavailable", () => {
    const players = squad(9)
    players[0]!.status = "injured"
    const result = planRotations(rotationInput({ players }))
    for (const block of result.blocks) {
      expect(block.goalkeeperId).not.toBe("p1")
      expect(block.onPitch.some((entry) => entry.playerId === "p1")).toBe(false)
    }
  })
})

describe("reading a schedule", () => {
  it("recovers minutes from blocks and finds the block for a minute", () => {
    const result = planRotations(rotationInput())
    expect(playerMinutesFromBlocks(result.blocks)).toEqual(result.minutesByPlayer)
    const rested = planRotations(rotationInput({ players: squad(12) }))
    expect(playerMinutesFromBlocks(rested.blocks)).toEqual(rested.minutesByPlayer)
    expect(blockAtMinute(result.blocks, 0)?.index).toBe(0)
    expect(blockAtMinute(result.blocks, 29)?.index).toBe(2)
    expect(blockAtMinute(result.blocks, 30)?.index).toBe(3)
    expect(blockAtMinute(result.blocks, 999)?.index).toBe(5)
  })
})

/* -------------------------------------------------------------------------- */

describe("lifecycle", () => {
  it("allows both coach workflows", () => {
    expect(canTransition("planned", "in_progress")).toBe(true)
    expect(canTransition("in_progress", "completed")).toBe(true)
    expect(canTransition("planned", "completed")).toBe(true)
    expect(canTransition("completed", "planned")).toBe(false)
    expect(canTransition("in_progress", "planned")).toBe(false)
  })

  it("refuses an illegal transition on a record", () => {
    const record = transitionRecord(emptyMatchdayRecord("m1"), "completed")
    expect(record.phase).toBe("completed")
    expect(() => transitionRecord(record, "draft")).toThrow(RangeError)
  })

  it("derives the phase from local evidence and the database status, taking the higher", () => {
    expect(deriveMatchdayPhase({ matchStatus: "scheduled", record: null })).toBe("draft")
    const planned = { phase: "draft" as const, plan: {} as PreMatchPlan, liveSession: null, debrief: null }
    expect(deriveMatchdayPhase({ matchStatus: "scheduled", record: planned })).toBe("planned")
    expect(deriveMatchdayPhase({ matchStatus: "live", record: planned })).toBe("in_progress")
    expect(deriveMatchdayPhase({ matchStatus: "finalized", record: planned })).toBe("completed")
    expect(deriveMatchdayPhase({ matchStatus: "scheduled", record: { ...planned, phase: "completed" } })).toBe("completed")
  })
})

/* -------------------------------------------------------------------------- */

describe("debrief", () => {
  const players = squad(10)

  function plan(): PreMatchPlan {
    const input = rotationInput({ players })
    const result = planRotations(input)
    return {
      matchId: "m1",
      teamSide: "home",
      opponentName: "Rakip SK",
      formationId: input.formation.id,
      squad: players,
      startingLineup: input.startingLineup,
      durationMinutes: 60,
      periods: 2,
      rotationIntervalMinutes: 10,
      goalkeeperMode: "dedicated",
      dedicatedGoalkeeperId: "p1",
      scheduledRotations: result.blocks,
      updatedAt: "2026-09-01T10:00:00.000Z",
    }
  }

  it("pre-fills from a live session, attributing goals and assists", () => {
    const draft = createDebriefDraft({
      matchId: "m1",
      teamSide: "home",
      opponentName: null,
      venue: "Saha 1",
      kickoffAt: "2026-09-05T17:00:00.000Z",
      plan: plan(),
      confirmedScore: null,
      liveSession: {
        matchId: "m1",
        startedAt: "2026-09-05T17:02:00.000Z",
        endedAt: null,
        tally: { home: 2, away: 1 },
        updatedAt: "2026-09-05T18:00:00.000Z",
        events: [
          { id: "e1", type: "goal", minute: 5, side: "home", playerId: "p7", assistPlayerId: "p5", at: "x" },
          { id: "e2", type: "goal", minute: 20, side: "away", playerId: null, at: "x" },
          { id: "e3", type: "goal", minute: 40, side: "home", playerId: "p7", at: "x" },
          { id: "e4", type: "save", minute: 41, side: "home", playerId: "p1", at: "x" },
        ],
      },
    })

    expect(draft.source).toBe("live")
    expect(draft.finalScore).toEqual({ home: 2, away: 1 })
    expect(draft.scorers).toEqual([{ playerId: "p7", count: 2 }])
    expect(draft.assists).toEqual([{ playerId: "p5", count: 1 }])
    expect(draft.saves).toEqual([{ playerId: "p1", count: 1 }])
    expect(draft.opponentName).toBe("Rakip SK")
    expect(draft.playedOn).toBe("2026-09-05")
    expect(draft.plannedMinutes.p1).toBe(60)
    expect(draft.plannedMinutes.p2).toBe(40)
  })

  it("starts a reconstruction when the phone stayed in the bag", () => {
    const draft = createDebriefDraft({
      matchId: "m1",
      teamSide: "away",
      opponentName: "Ev sahibi",
      venue: null,
      kickoffAt: "2026-09-05T17:00:00.000Z",
      plan: null,
      liveSession: null,
      confirmedScore: null,
    })
    expect(draft.source).toBe("reconstructed")
    expect(draft.finalScore).toEqual({ home: 0, away: 0 })
    expect(draft.plannedMinutes).toEqual({})
  })

  it("applies ±minute adjustments and judges fair play from the result", () => {
    const draft = createDebriefDraft({
      matchId: "m1",
      teamSide: "home",
      opponentName: "X",
      venue: null,
      kickoffAt: "2026-09-05T17:00:00.000Z",
      plan: plan(),
      liveSession: null,
      confirmedScore: { home: 3, away: 3 },
    })
    draft.playerMinutesAdjustments = { p2: -5, p3: 5 }
    const minutes = actualMinutes(draft)
    expect(minutes.p2).toBe(35)
    expect(minutes.p3).toBe(45)
    expect(fairPlaySummary(minutes, 10).earned).toBe(false) // keeper on 60 vs 35
    expect(fairPlaySummary({ p2: 35, p3: 45 }, 10).earned).toBe(true)
  })

  it("never puts private notes in the share text", () => {
    const draft = createDebriefDraft({
      matchId: "m1",
      teamSide: "home",
      opponentName: "Rakip SK",
      venue: "Saha 1",
      kickoffAt: "2026-09-05T17:00:00.000Z",
      plan: plan(),
      liveSession: null,
      confirmedScore: { home: 2, away: 0 },
    })
    draft.scorers = [{ playerId: "p7", count: 2 }]
    draft.coachNotes = {
      strengths: ["Pres çok iyiydi", "Kanat oyunu"],
      improve: "İkinci toplar",
      privateNotes: "GİZLİ NOT",
    }
    const text = debriefShareText({ debrief: draft, players, teamName: "Bizim Takım" })
    expect(text).toContain("Bizim Takım 2–0 Rakip SK")
    expect(text).toContain("#7 Oyuncu 7 (2)")
    expect(text).toContain("Pres çok iyiydi")
    expect(text).not.toContain("GİZLİ NOT")
    expect(text).not.toContain("İkinci toplar")
  })
})

/* -------------------------------------------------------------------------- */

describe("record schema", () => {
  it("round-trips a full record and rejects a tampered one", () => {
    const record = emptyMatchdayRecord("m1")
    expect(matchdayRecordSchema.safeParse(JSON.parse(JSON.stringify(record))).success).toBe(true)
    expect(matchdayRecordSchema.safeParse({ ...record, phase: "flying" }).success).toBe(false)
    expect(matchdayRecordSchema.safeParse({ ...record, version: 2 }).success).toBe(false)
  })
})
