import { describe, expect, it } from "vitest"

import { emptyMatchdayRecord, type Player } from "@onpitch/shared/matchday"

import {
  addPlayer,
  assignToSlot,
  autoFillLineup,
  benchOf,
  createDefaultPlan,
  seedSquad,
  setFormation,
  updatePlayer,
} from "@/lib/matchday/plan"
import {
  MatchdayStorageError,
  createMemoryRepository,
  createStorageRepository,
  listRecordMatchIds,
  recordStorageKey,
} from "@/lib/matchday/store"

/* -------------------------------------------------------------------------- */

function stubStorage(): Storage & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    get length() {
      return map.size
    },
    key: (index) => [...map.keys()][index] ?? null,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
    clear: () => map.clear(),
  }
}

function squad(count: number): Player[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `p${index + 1}`,
    name: `Oyuncu ${index + 1}`,
    number: index + 1,
    preferredPositions: index === 0 ? ["GK"] : [],
    status: "available",
    profileId: null,
  }))
}

/* -------------------------------------------------------------------------- */

describe("matchday repository", () => {
  it("round-trips a record through storage and validates on the way back", () => {
    const storage = stubStorage()
    const repository = createStorageRepository(storage)
    const record = emptyMatchdayRecord("m1")

    repository.write(record)
    expect(repository.read("m1")).toEqual(record)
    expect(listRecordMatchIds(storage)).toEqual(["m1"])

    storage.map.set(recordStorageKey("m1"), '{"version":1,"phase":"nope"}')
    expect(repository.read("m1")).toBeNull()

    storage.map.set(recordStorageKey("m1"), "not json")
    expect(repository.read("m1")).toBeNull()
  })

  it("surfaces a failed write as a typed error rather than swallowing it", () => {
    const repository = createStorageRepository({
      getItem: () => null,
      setItem: () => {
        throw new DOMException("QuotaExceededError")
      },
      removeItem: () => undefined,
    })
    expect(() => repository.write(emptyMatchdayRecord("m1"))).toThrow(MatchdayStorageError)
  })

  it("remembers a squad per team", () => {
    const repository = createMemoryRepository()
    repository.writeSquad("team-a", squad(3))
    expect(repository.readSquad("team-a")).toHaveLength(3)
    expect(repository.readSquad("team-b")).toBeNull()
  })
})

/* -------------------------------------------------------------------------- */

describe("plan helpers", () => {
  it("seeds our side of the roster and layers remembered numbers on top", () => {
    const remembered: Player[] = [
      { id: "u1", name: "Ali", number: 9, preferredPositions: ["FWD"], status: "injured", profileId: "u1" },
      { id: "local-1", name: "Misafir", number: 14, preferredPositions: [], status: "available", profileId: null },
    ]
    const seeded = seedSquad(
      [
        { profileId: "u1", name: "Ali Veli", number: null, teamSide: "home" },
        { profileId: "u2", name: "Can", number: 4, teamSide: "home" },
        { profileId: "u3", name: "Rakip", number: 1, teamSide: "away" },
      ],
      "home",
      remembered,
    )
    expect(seeded.map((player) => player.id)).toEqual(["u1", "u2", "local-1"])
    expect(seeded[0]).toMatchObject({ name: "Ali Veli", number: 9, preferredPositions: ["FWD"], status: "available" })
    expect(seeded[1]).toMatchObject({ number: 4 })
  })

  it("builds a default plan with a full line-up, a keeper and a schedule", () => {
    const plan = createDefaultPlan({
      matchId: "m1",
      teamSide: "home",
      opponentName: "X",
      pitchFormat: "7v7",
      durationMinutes: 60,
      squad: squad(10),
    })
    expect(plan.startingLineup).toHaveLength(7)
    expect(plan.startingLineup.find((entry) => entry.slotId === "gk")?.playerId).toBe("p1")
    expect(plan.dedicatedGoalkeeperId).toBe("p1")
    expect(plan.scheduledRotations.length).toBeGreaterThan(0)
    expect(benchOf(plan)).toHaveLength(3)
  })

  it("moves, swaps and benches without ever duplicating a player", () => {
    let plan = createDefaultPlan({
      matchId: "m1",
      teamSide: "home",
      opponentName: null,
      pitchFormat: "7v7",
      durationMinutes: 60,
      squad: squad(10),
    })
    const bench = benchOf(plan)[0]!
    const forwardSlot = "l3p1"
    const before = plan.startingLineup.find((entry) => entry.slotId === forwardSlot)!.playerId

    plan = assignToSlot(plan, forwardSlot, bench.id)
    expect(plan.startingLineup.find((entry) => entry.slotId === forwardSlot)?.playerId).toBe(bench.id)
    expect(plan.startingLineup.some((entry) => entry.playerId === before)).toBe(false)

    // Swap two on-pitch players.
    const a = plan.startingLineup.find((entry) => entry.slotId === "l1p1")!.playerId
    const b = plan.startingLineup.find((entry) => entry.slotId === "l2p1")!.playerId
    plan = assignToSlot(plan, "l2p1", a)
    expect(plan.startingLineup.find((entry) => entry.slotId === "l2p1")?.playerId).toBe(a)
    expect(plan.startingLineup.find((entry) => entry.slotId === "l1p1")?.playerId).toBe(b)

    const ids = plan.startingLineup.map((entry) => entry.playerId)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("keeps the same people on when the formation changes", () => {
    const plan = createDefaultPlan({
      matchId: "m1",
      teamSide: "home",
      opponentName: null,
      pitchFormat: "7v7",
      durationMinutes: 60,
      squad: squad(10),
    })
    const changed = setFormation(plan, "7v7:3-2-1")
    expect(changed.formationId).toBe("7v7:3-2-1")
    expect(changed.startingLineup.map((entry) => entry.playerId).sort()).toEqual(
      plan.startingLineup.map((entry) => entry.playerId).sort(),
    )
  })

  it("drops an injured starter from the line-up and refills the gap on request", () => {
    let plan = createDefaultPlan({
      matchId: "m1",
      teamSide: "home",
      opponentName: null,
      pitchFormat: "7v7",
      durationMinutes: 60,
      squad: squad(10),
    })
    plan = updatePlayer(plan, "p1", { status: "injured" })
    expect(plan.startingLineup.some((entry) => entry.playerId === "p1")).toBe(false)
    expect(plan.dedicatedGoalkeeperId).toBeNull()
    plan = autoFillLineup(plan)
    expect(plan.startingLineup).toHaveLength(7)
    expect(plan.dedicatedGoalkeeperId).not.toBeNull()
  })

  it("adds a walk-on player with a local id", () => {
    const plan = addPlayer(
      createDefaultPlan({ matchId: "m1", teamSide: "away", opponentName: null, pitchFormat: "5v5", durationMinutes: 40, squad: squad(5) }),
      { name: "Yeni", number: 22 },
    )
    const added = plan.squad[plan.squad.length - 1]!
    expect(added.id.startsWith("local-")).toBe(true)
    expect(added.profileId).toBeNull()
  })
})
