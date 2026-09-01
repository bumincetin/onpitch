/**
 * packages/shared/src/matchday/rotation.ts
 *
 * The fair-play rotation engine.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT "FAIR" MEANS HERE
 * ---------------------------------------------------------------------------------------------
 *
 * The match is cut into substitution blocks (every `rotationIntervalMinutes`, never straddling a
 * period break, because a sub at half time is free). Block by block the engine puts on the pitch
 * the players who have played LEAST so far — ties broken by who has been on the longest without
 * a rest, then by squad order. Greedy "least minutes first" keeps every player within one block
 * length of every other, which is the best any schedule with fixed block boundaries can promise,
 * and the result is deterministic: the same squad and settings always print the same sheet.
 *
 * The first block is the coach's starting line-up, not the engine's guess. Substitutes then take
 * the slot of the player they replace, preferring a vacated slot that matches one of their
 * preferred positions, so a defender coming on does not land at centre forward by accident.
 *
 * Goalkeepers:
 *   dedicated   one player owns the goalkeeper slot for the whole match and is excluded from the
 *               outfield rotation; outfield minutes are shared equally among everyone else.
 *   rotating    everyone rotates through goal. The keeper for a block is whoever on the pitch
 *               has kept goal least; changing keeper is a positional shuffle, not a substitution.
 */

import { goalkeeperSlot } from "./formations"
import type {
  Formation,
  GoalkeeperMode,
  LineupAssignment,
  Player,
  RotationBlock,
  ScheduledSwap,
} from "./types"

/* -------------------------------------------------------------------------- */
/*  Blocks                                                                    */
/* -------------------------------------------------------------------------- */

export interface BlockBoundary {
  index: number
  period: number
  startMinute: number
  endMinute: number
}

/**
 * Cut `durationMinutes` into `periods` equal periods, then each period into blocks as close to
 * `intervalMinutes` as possible. Blocks inside a period are equal length, so a 45-minute half
 * with a 10-minute interval becomes five 9-minute blocks rather than four 10s and a 5.
 */
export function buildBlockBoundaries(
  durationMinutes: number,
  periods: number,
  intervalMinutes: number,
): BlockBoundary[] {
  const safePeriods = Math.max(1, Math.floor(periods))
  const safeInterval = Math.max(1, intervalMinutes)
  const periodLength = durationMinutes / safePeriods

  const blocks: BlockBoundary[] = []
  for (let period = 0; period < safePeriods; period += 1) {
    const periodStart = Math.round(period * periodLength)
    const periodEnd = Math.round((period + 1) * periodLength)
    const count = Math.max(1, Math.round((periodEnd - periodStart) / safeInterval))
    for (let cut = 0; cut < count; cut += 1) {
      const startMinute = periodStart + Math.round(((periodEnd - periodStart) * cut) / count)
      const endMinute = periodStart + Math.round(((periodEnd - periodStart) * (cut + 1)) / count)
      if (endMinute <= startMinute) continue
      blocks.push({ index: blocks.length, period: period + 1, startMinute, endMinute })
    }
  }
  return blocks
}

/* -------------------------------------------------------------------------- */
/*  The engine                                                                */
/* -------------------------------------------------------------------------- */

export interface RotationInput {
  durationMinutes: number
  periods: number
  rotationIntervalMinutes: number
  formation: Formation
  /** The whole squad; only `status === "available"` players are rotated. */
  players: Player[]
  startingLineup: LineupAssignment[]
  goalkeeperMode: GoalkeeperMode
  dedicatedGoalkeeperId: string | null
}

export interface RotationFairness {
  /** Minutes everyone would get if the split were perfect. */
  targetMinutes: number
  minMinutes: number
  maxMinutes: number
  /** max − min. Zero is perfect; anything up to one block length is as good as it gets. */
  spreadMinutes: number
}

export interface RotationResult {
  blocks: RotationBlock[]
  minutesByPlayer: Record<string, number>
  goalkeeperMinutesByPlayer: Record<string, number>
  fairness: RotationFairness
}

interface PlayerState {
  minutes: number
  goalkeeperMinutes: number
  /** Consecutive blocks on the pitch going into the current block. */
  stint: number
  squadIndex: number
}

export function planRotations(input: RotationInput): RotationResult {
  const { formation, goalkeeperMode } = input
  const available = input.players.filter((player) => player.status === "available")
  const availableIds = new Set(available.map((player) => player.id))
  const playerById = new Map(available.map((player) => [player.id, player]))

  const gkSlot = goalkeeperSlot(formation)
  const dedicatedKeeperId =
    goalkeeperMode === "dedicated" &&
    gkSlot &&
    input.dedicatedGoalkeeperId &&
    availableIds.has(input.dedicatedGoalkeeperId)
      ? input.dedicatedGoalkeeperId
      : null

  // The slots the rotation fills, and the players who compete for them.
  const rotatingSlots = dedicatedKeeperId
    ? formation.slots.filter((slot) => slot.id !== gkSlot?.id)
    : formation.slots
  const rotatingSlotIds = new Set(rotatingSlots.map((slot) => slot.id))
  const candidates = available.filter((player) => player.id !== dedicatedKeeperId)
  const capacity = Math.min(rotatingSlots.length, candidates.length)

  const state = new Map<string, PlayerState>()
  available.forEach((player, squadIndex) => {
    state.set(player.id, { minutes: 0, goalkeeperMinutes: 0, stint: 0, squadIndex })
  })

  const boundaries = buildBlockBoundaries(
    input.durationMinutes,
    input.periods,
    input.rotationIntervalMinutes,
  )

  /* ---- block 0: the coach's starting line-up ---------------------------- */

  const seen = new Set<string>()
  let slotOf = new Map<string, string>() // playerId → slotId, rotating slots only
  for (const assignment of input.startingLineup) {
    if (!rotatingSlotIds.has(assignment.slotId)) continue
    if (!availableIds.has(assignment.playerId) || assignment.playerId === dedicatedKeeperId) continue
    if (seen.has(assignment.playerId)) continue
    if ([...slotOf.values()].includes(assignment.slotId)) continue
    seen.add(assignment.playerId)
    slotOf.set(assignment.playerId, assignment.slotId)
  }
  // Gaps in the line-up are filled from the bench in squad order, so an incomplete plan still
  // produces a full first block instead of an empty slot on the sheet.
  for (const player of candidates) {
    if (slotOf.size >= capacity) break
    if (slotOf.has(player.id)) continue
    const freeSlot = rotatingSlots.find((slot) => ![...slotOf.values()].includes(slot.id))
    if (!freeSlot) break
    slotOf.set(player.id, freeSlot.id)
  }

  let currentKeeperId: string | null = dedicatedKeeperId
  const blocks: RotationBlock[] = []

  for (const boundary of boundaries) {
    const length = boundary.endMinute - boundary.startMinute
    const previousSlotOf = slotOf
    const previousOn = new Set(previousSlotOf.keys())

    /* ---- who is on the pitch this block --------------------------------- */

    let onIds: string[]
    if (boundary.index === 0) {
      onIds = [...previousOn]
    } else {
      onIds = [...candidates]
        .sort((a, b) => {
          const sa = state.get(a.id)!
          const sb = state.get(b.id)!
          if (sa.minutes !== sb.minutes) return sa.minutes - sb.minutes
          if (sa.stint !== sb.stint) return sa.stint - sb.stint
          return sa.squadIndex - sb.squadIndex
        })
        .slice(0, capacity)
        .map((player) => player.id)
    }
    const onSet = new Set(onIds)

    /* ---- slots: stayers keep theirs, newcomers take a vacated one --------- */

    const nextSlotOf = new Map<string, string>()
    for (const id of onIds) {
      const kept = previousSlotOf.get(id)
      if (kept) nextSlotOf.set(id, kept)
    }
    const takenSlots = new Set(nextSlotOf.values())
    const vacated = rotatingSlots.filter((slot) => !takenSlots.has(slot.id))
    const vacatedBy = new Map<string, string>() // slotId → outgoing playerId
    for (const [id, slotId] of previousSlotOf) {
      if (!onSet.has(id)) vacatedBy.set(slotId, id)
    }

    const swaps: ScheduledSwap[] = []
    const incoming = onIds.filter((id) => !previousOn.has(id))
    for (const id of incoming) {
      const preferred = playerById.get(id)?.preferredPositions ?? []
      const pick = vacated.find((slot) => preferred.includes(slot.role)) ?? vacated[0]
      if (!pick) break
      vacated.splice(vacated.indexOf(pick), 1)
      nextSlotOf.set(id, pick.id)
      if (boundary.index > 0) {
        swaps.push({ out: vacatedBy.get(pick.id) ?? null, in: id, slotId: pick.id })
      }
    }

    /* ---- goalkeeper ----------------------------------------------------- */

    let keeperId: string | null = dedicatedKeeperId
    if (!dedicatedKeeperId && gkSlot && nextSlotOf.size > 0) {
      const ranked = [...nextSlotOf.keys()].sort((a, b) => {
        const sa = state.get(a)!
        const sb = state.get(b)!
        if (sa.goalkeeperMinutes !== sb.goalkeeperMinutes) return sa.goalkeeperMinutes - sb.goalkeeperMinutes
        // Same keeper minutes: the current keeper stays rather than shuffling for nothing.
        if (a === currentKeeperId) return -1
        if (b === currentKeeperId) return 1
        return sa.squadIndex - sb.squadIndex
      })
      keeperId = ranked[0] ?? null
      if (keeperId && nextSlotOf.get(keeperId) !== gkSlot.id) {
        // Move the new keeper into goal; whoever was there takes the keeper's outfield slot.
        const keeperSlot = nextSlotOf.get(keeperId)!
        const holder = [...nextSlotOf.entries()].find(([, slotId]) => slotId === gkSlot.id)?.[0]
        nextSlotOf.set(keeperId, gkSlot.id)
        if (holder) nextSlotOf.set(holder, keeperSlot)
        // A swap that named the old slot now names the goal, so the sheet says where to stand.
        for (const swap of swaps) {
          if (swap.in === keeperId) swap.slotId = gkSlot.id
          else if (holder && swap.in === holder) swap.slotId = keeperSlot
        }
      }
    }
    currentKeeperId = keeperId

    /* ---- bookkeeping ---------------------------------------------------- */

    const onPitch: LineupAssignment[] = []
    if (dedicatedKeeperId && gkSlot) onPitch.push({ slotId: gkSlot.id, playerId: dedicatedKeeperId })
    for (const [playerId, slotId] of nextSlotOf) onPitch.push({ slotId, playerId })
    onPitch.sort((a, b) => slotOrder(formation, a.slotId) - slotOrder(formation, b.slotId))

    for (const [id, playerState] of state) {
      const on = nextSlotOf.has(id) || id === dedicatedKeeperId
      if (on) {
        playerState.minutes += length
        playerState.stint += 1
        if (id === keeperId) playerState.goalkeeperMinutes += length
      } else {
        playerState.stint = 0
      }
    }

    blocks.push({
      index: boundary.index,
      period: boundary.period,
      startMinute: boundary.startMinute,
      endMinute: boundary.endMinute,
      onPitch,
      swaps,
      goalkeeperId: keeperId,
    })

    slotOf = nextSlotOf
  }

  /* ---- summary ---------------------------------------------------------- */

  // Every squad member gets a row, so a sheet can say "0 dk (sakat)" instead of omitting someone.
  const minutesByPlayer: Record<string, number> = {}
  const goalkeeperMinutesByPlayer: Record<string, number> = {}
  for (const player of input.players) {
    minutesByPlayer[player.id] = 0
    goalkeeperMinutesByPlayer[player.id] = 0
  }
  for (const [id, playerState] of state) {
    minutesByPlayer[id] = playerState.minutes
    goalkeeperMinutesByPlayer[id] = playerState.goalkeeperMinutes
  }

  const rotatedMinutes = candidates.map((player) => state.get(player.id)!.minutes)
  const totalOnPitch = boundaries.reduce(
    (sum, block) => sum + (block.endMinute - block.startMinute) * capacity,
    0,
  )
  const fairness: RotationFairness = {
    targetMinutes: candidates.length > 0 ? totalOnPitch / candidates.length : 0,
    minMinutes: rotatedMinutes.length > 0 ? Math.min(...rotatedMinutes) : 0,
    maxMinutes: rotatedMinutes.length > 0 ? Math.max(...rotatedMinutes) : 0,
    spreadMinutes: 0,
  }
  fairness.spreadMinutes = fairness.maxMinutes - fairness.minMinutes

  return { blocks, minutesByPlayer, goalkeeperMinutesByPlayer, fairness }
}

function slotOrder(formation: Formation, slotId: string): number {
  const index = formation.slots.findIndex((slot) => slot.id === slotId)
  return index === -1 ? Number.MAX_SAFE_INTEGER : index
}

/* -------------------------------------------------------------------------- */
/*  Reading a schedule back                                                   */
/* -------------------------------------------------------------------------- */

/** Minutes per player implied by a block schedule. What the debrief pre-fills from. */
export function playerMinutesFromBlocks(blocks: RotationBlock[]): Record<string, number> {
  const minutes: Record<string, number> = {}
  for (const block of blocks) {
    const length = block.endMinute - block.startMinute
    for (const assignment of block.onPitch) {
      minutes[assignment.playerId] = (minutes[assignment.playerId] ?? 0) + length
    }
  }
  return minutes
}

/** The block whose window contains `minute`, or the last block once the match has run over. */
export function blockAtMinute(blocks: RotationBlock[], minute: number): RotationBlock | null {
  if (blocks.length === 0) return null
  return blocks.find((block) => minute >= block.startMinute && minute < block.endMinute) ?? blocks[blocks.length - 1] ?? null
}

/** The next block that has substitutions to make after `minute`. */
export function nextSwapBlock(blocks: RotationBlock[], minute: number): RotationBlock | null {
  return blocks.find((block) => block.startMinute > minute && block.swaps.length > 0) ?? null
}
