/**
 * lib/matchday/plan.ts
 *
 * Pure operations on a `PreMatchPlan`: seeding a squad from the fixture's roster, moving players
 * between bench and slots, changing formation without losing the line-up, and keeping the
 * rotation schedule in step with every edit. Components call these and persist the result; none
 * of them touch storage or the DOM, so they are testable in node.
 */

import type { TeamSide } from "@halisaha/shared/domain"
import {
  defaultFormationFor,
  planRotations,
  resolveFormation,
  type Formation,
  type LineupAssignment,
  type PitchFormat,
  type Player,
  type Position,
  type PreMatchPlan,
  type RotationFairness,
  type RotationResult,
} from "@halisaha/shared/matchday"

/* -------------------------------------------------------------------------- */
/*  Ids                                                                       */
/* -------------------------------------------------------------------------- */

/** A local player id for someone without an account. Never collides with a uuid. */
export function newLocalId(prefix = "local"): string {
  const random =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10)
  return `${prefix}-${random}`
}

/* -------------------------------------------------------------------------- */
/*  Seeding                                                                   */
/* -------------------------------------------------------------------------- */

export interface RosterSeedPlayer {
  profileId: string
  name: string | null
  number: number | null
  teamSide: TeamSide | null
}

/**
 * The first squad for a plan: everyone on our side of the fixture, with the numbers and
 * positions remembered from the last plan for this team layered on top. Players remembered but
 * not in this fixture's roster are kept too — a youth squad rarely has every child registered.
 */
export function seedSquad(roster: RosterSeedPlayer[], side: TeamSide, remembered: Player[] | null): Player[] {
  const byProfile = new Map((remembered ?? []).filter((player) => player.profileId).map((player) => [player.profileId!, player]))
  const seeded: Player[] = []
  const used = new Set<string>()

  for (const entry of roster) {
    if (entry.teamSide !== side) continue
    const memory = byProfile.get(entry.profileId)
    seeded.push({
      id: entry.profileId,
      name: entry.name?.trim() || memory?.name || "Oyuncu",
      number: memory?.number ?? entry.number,
      preferredPositions: memory?.preferredPositions ?? [],
      status: "available",
      profileId: entry.profileId,
    })
    used.add(entry.profileId)
  }

  for (const player of remembered ?? []) {
    if (player.profileId && used.has(player.profileId)) continue
    if (used.has(player.id)) continue
    seeded.push({ ...player, status: "available" })
    used.add(player.id)
  }

  return seeded
}

export interface DefaultPlanInput {
  matchId: string
  teamSide: TeamSide
  opponentName: string | null
  pitchFormat: PitchFormat
  durationMinutes: number
  squad: Player[]
}

export function createDefaultPlan(input: DefaultPlanInput, now = new Date()): PreMatchPlan {
  const formation = defaultFormationFor(input.pitchFormat)
  const keeper = input.squad.find((player) => player.preferredPositions.includes("GK") && player.status === "available")
  const base: PreMatchPlan = {
    matchId: input.matchId,
    teamSide: input.teamSide,
    opponentName: input.opponentName,
    formationId: formation.id,
    squad: input.squad,
    startingLineup: [],
    durationMinutes: input.durationMinutes,
    periods: 2,
    rotationIntervalMinutes: defaultInterval(input.durationMinutes),
    goalkeeperMode: "dedicated",
    dedicatedGoalkeeperId: keeper?.id ?? null,
    scheduledRotations: [],
    updatedAt: now.toISOString(),
  }
  return withRotations(autoFillLineup(base))
}

function defaultInterval(durationMinutes: number): number {
  if (durationMinutes <= 40) return 5
  if (durationMinutes <= 60) return 10
  return 15
}

/* -------------------------------------------------------------------------- */
/*  Formation & rotation                                                      */
/* -------------------------------------------------------------------------- */

export function formationOf(plan: PreMatchPlan, fallback: PitchFormat = "7v7"): Formation {
  return resolveFormation(plan.formationId) ?? defaultFormationFor(fallback)
}

export function rotationOf(plan: PreMatchPlan): RotationResult {
  return planRotations({
    durationMinutes: plan.durationMinutes,
    periods: plan.periods,
    rotationIntervalMinutes: plan.rotationIntervalMinutes,
    formation: formationOf(plan),
    players: plan.squad,
    startingLineup: plan.startingLineup,
    goalkeeperMode: plan.goalkeeperMode,
    dedicatedGoalkeeperId: plan.dedicatedGoalkeeperId,
  })
}

/** Recompute `scheduledRotations` from the current settings. Called after every edit. */
export function withRotations(plan: PreMatchPlan): PreMatchPlan {
  return { ...plan, scheduledRotations: rotationOf(plan).blocks }
}

export function fairnessOf(plan: PreMatchPlan): RotationFairness {
  return rotationOf(plan).fairness
}

/**
 * Change shape without emptying the pitch: the keeper stays in goal and outfield players are
 * re-seated in order, so a 2-3-1 becoming a 3-2-1 keeps the same six people on.
 */
export function setFormation(plan: PreMatchPlan, formationId: string): PreMatchPlan {
  const next = resolveFormation(formationId)
  if (!next) return plan
  const previous = formationOf(plan)
  const bySlot = new Map(plan.startingLineup.map((entry) => [entry.slotId, entry.playerId]))

  const keeperId = bySlot.get("gk")
  const outfieldInOrder = previous.slots
    .filter((slot) => slot.role !== "GK")
    .map((slot) => bySlot.get(slot.id))
    .filter((id): id is string => Boolean(id))

  const lineup: LineupAssignment[] = []
  if (keeperId) lineup.push({ slotId: "gk", playerId: keeperId })
  next.slots
    .filter((slot) => slot.role !== "GK")
    .forEach((slot, index) => {
      const playerId = outfieldInOrder[index]
      if (playerId) lineup.push({ slotId: slot.id, playerId })
    })

  return withRotations({ ...plan, formationId: next.id, startingLineup: lineup })
}

/* -------------------------------------------------------------------------- */
/*  Line-up edits                                                             */
/* -------------------------------------------------------------------------- */

function lineupWithout(lineup: LineupAssignment[], playerId: string): LineupAssignment[] {
  return lineup.filter((entry) => entry.playerId !== playerId)
}

/**
 * Put `playerId` in `slotId`. If they are already on the pitch they move; if the slot is taken,
 * the occupant goes where the mover came from (a swap) or to the bench (a replacement).
 */
export function assignToSlot(plan: PreMatchPlan, slotId: string, playerId: string): PreMatchPlan {
  const formation = formationOf(plan)
  if (!formation.slots.some((slot) => slot.id === slotId)) return plan
  const player = plan.squad.find((candidate) => candidate.id === playerId)
  if (!player || player.status !== "available") return plan

  const fromSlot = plan.startingLineup.find((entry) => entry.playerId === playerId)?.slotId ?? null
  const occupant = plan.startingLineup.find((entry) => entry.slotId === slotId)?.playerId ?? null
  if (occupant === playerId) return plan

  let lineup = lineupWithout(plan.startingLineup, playerId).filter((entry) => entry.slotId !== slotId)
  lineup.push({ slotId, playerId })
  if (occupant && fromSlot) lineup.push({ slotId: fromSlot, playerId: occupant })
  lineup = sortLineup(formation, lineup)

  const next = { ...plan, startingLineup: lineup }
  // Whoever sits in goal in the line-up is the dedicated keeper unless the coach chose otherwise.
  if (slotId === "gk" && plan.goalkeeperMode === "dedicated") next.dedicatedGoalkeeperId = playerId
  return withRotations(next)
}

export function clearSlot(plan: PreMatchPlan, slotId: string): PreMatchPlan {
  return withRotations({
    ...plan,
    startingLineup: plan.startingLineup.filter((entry) => entry.slotId !== slotId),
  })
}

export function benchPlayer(plan: PreMatchPlan, playerId: string): PreMatchPlan {
  return withRotations({ ...plan, startingLineup: lineupWithout(plan.startingLineup, playerId) })
}

function sortLineup(formation: Formation, lineup: LineupAssignment[]): LineupAssignment[] {
  const order = new Map(formation.slots.map((slot, index) => [slot.id, index]))
  return [...lineup].sort((a, b) => (order.get(a.slotId) ?? 99) - (order.get(b.slotId) ?? 99))
}

/** Fill every empty slot: preferred positions first, then squad order. Never moves anyone. */
export function autoFillLineup(plan: PreMatchPlan): PreMatchPlan {
  const formation = formationOf(plan)
  const taken = new Set(plan.startingLineup.map((entry) => entry.slotId))
  const onPitch = new Set(plan.startingLineup.map((entry) => entry.playerId))
  const bench = plan.squad.filter((player) => player.status === "available" && !onPitch.has(player.id))
  const lineup = [...plan.startingLineup]

  const empty = formation.slots.filter((slot) => !taken.has(slot.id))
  // Keeper first, and only someone who wants to be there if anyone does.
  for (const slot of empty) {
    const wants = bench.find((player) => player.preferredPositions.includes(slot.role))
    const pick = wants ?? (slot.role === "GK" ? undefined : bench[0])
    if (!pick) continue
    bench.splice(bench.indexOf(pick), 1)
    lineup.push({ slotId: slot.id, playerId: pick.id })
  }
  // A goal left empty because nobody asked for it still needs a body.
  const gkFilled = lineup.some((entry) => entry.slotId === "gk")
  if (!gkFilled && formation.slots.some((slot) => slot.id === "gk") && bench[0]) {
    lineup.push({ slotId: "gk", playerId: bench[0].id })
  }

  const next = { ...plan, startingLineup: sortLineup(formation, lineup) }
  if (next.goalkeeperMode === "dedicated" && !next.dedicatedGoalkeeperId) {
    next.dedicatedGoalkeeperId = lineup.find((entry) => entry.slotId === "gk")?.playerId ?? null
  }
  return withRotations(next)
}

/* -------------------------------------------------------------------------- */
/*  Squad edits                                                               */
/* -------------------------------------------------------------------------- */

export function updatePlayer(plan: PreMatchPlan, playerId: string, patch: Partial<Omit<Player, "id">>): PreMatchPlan {
  const squad = plan.squad.map((player) => (player.id === playerId ? { ...player, ...patch } : player))
  let lineup = plan.startingLineup
  // Someone who is no longer available cannot start.
  if (patch.status && patch.status !== "available") lineup = lineupWithout(lineup, playerId)
  const next: PreMatchPlan = { ...plan, squad, startingLineup: lineup }
  if (patch.status && patch.status !== "available" && plan.dedicatedGoalkeeperId === playerId) {
    next.dedicatedGoalkeeperId = null
  }
  return withRotations(next)
}

export function addPlayer(plan: PreMatchPlan, input: { name: string; number: number | null; preferredPositions?: Position[] }): PreMatchPlan {
  const name = input.name.trim()
  if (!name) return plan
  const player: Player = {
    id: newLocalId(),
    name,
    number: input.number,
    preferredPositions: input.preferredPositions ?? [],
    status: "available",
    profileId: null,
  }
  return withRotations({ ...plan, squad: [...plan.squad, player] })
}

export function removePlayer(plan: PreMatchPlan, playerId: string): PreMatchPlan {
  return withRotations({
    ...plan,
    squad: plan.squad.filter((player) => player.id !== playerId),
    startingLineup: lineupWithout(plan.startingLineup, playerId),
    dedicatedGoalkeeperId: plan.dedicatedGoalkeeperId === playerId ? null : plan.dedicatedGoalkeeperId,
  })
}

export function togglePosition(plan: PreMatchPlan, playerId: string, position: Position): PreMatchPlan {
  const player = plan.squad.find((candidate) => candidate.id === playerId)
  if (!player) return plan
  const has = player.preferredPositions.includes(position)
  const preferredPositions = has
    ? player.preferredPositions.filter((entry) => entry !== position)
    : [...player.preferredPositions, position]
  return updatePlayer(plan, playerId, { preferredPositions })
}

/* -------------------------------------------------------------------------- */
/*  Reading                                                                   */
/* -------------------------------------------------------------------------- */

export function playerById(plan: Pick<PreMatchPlan, "squad">, playerId: string | null | undefined): Player | null {
  if (!playerId) return null
  return plan.squad.find((player) => player.id === playerId) ?? null
}

export function slotLabel(formation: Formation, slotId: string): string {
  return formation.slots.find((slot) => slot.id === slotId)?.label ?? slotId
}

export function benchOf(plan: PreMatchPlan): Player[] {
  const onPitch = new Set(plan.startingLineup.map((entry) => entry.playerId))
  return plan.squad.filter((player) => player.status === "available" && !onPitch.has(player.id))
}

export function displayName(player: Pick<Player, "name" | "number"> | null): string {
  if (!player) return "—"
  return player.number !== null ? `#${player.number} ${player.name}` : player.name
}
