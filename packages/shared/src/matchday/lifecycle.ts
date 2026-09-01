/**
 * packages/shared/src/matchday/lifecycle.ts
 *
 * The matchday state machine, and how it lines up with `public.match_status`.
 *
 *   draft        nothing saved yet
 *   planned      a pre-match plan exists (line-up, rotation, cheat sheet)
 *   in_progress  the coach started live tracking on a device, or the fixture is `live`
 *   completed    a debrief exists, or the fixture has reached a post-match database status
 *
 * Two workflows have to be legal: PLANNED → IN_PROGRESS → COMPLETED (full live) and
 * PLANNED → COMPLETED (phone-free sideline, debrief reconstructed afterwards). A completed match
 * can also be re-opened to the debrief, which is an edit of the same phase, not a transition.
 *
 * The database status is authoritative where it speaks. It never says "planned" — a plan is
 * local — so the two are merged by {@link deriveMatchdayPhase}, and the persisted `phase` on a
 * record is only ever advanced, never rolled back, by the merge.
 */

import type { Enums } from "../database"
import { MATCHDAY_PHASES, type MatchdayPhase, type MatchdayRecord } from "./types"

export const MATCHDAY_TRANSITIONS: Record<MatchdayPhase, readonly MatchdayPhase[]> = {
  draft: ["planned", "in_progress", "completed"],
  planned: ["in_progress", "completed"],
  in_progress: ["completed"],
  completed: [],
}

export function canTransition(from: MatchdayPhase, to: MatchdayPhase): boolean {
  return from === to || MATCHDAY_TRANSITIONS[from].includes(to)
}

export function phaseRank(phase: MatchdayPhase): number {
  return MATCHDAY_PHASES.indexOf(phase)
}

/** The later of two phases. */
export function maxPhase(a: MatchdayPhase, b: MatchdayPhase): MatchdayPhase {
  return phaseRank(a) >= phaseRank(b) ? a : b
}

/** What the fixture's database status says about the matchday, on its own. */
export function phaseFromMatchStatus(status: Enums<"match_status">): MatchdayPhase {
  switch (status) {
    case "scheduled":
      return "draft"
    case "live":
      return "in_progress"
    case "awaiting_report":
    case "requires_consensus":
    case "disputed":
    case "finalized":
      return "completed"
    case "cancelled":
      // A cancelled fixture has no matchday. The record keeps whatever it had; the UI says why.
      return "draft"
  }
}

export interface DerivePhaseInput {
  matchStatus: Enums<"match_status"> | null
  record: Pick<MatchdayRecord, "phase" | "plan" | "liveSession" | "debrief"> | null
}

/**
 * Merge everything known into one phase. Local evidence (a plan, a started session, a debrief)
 * and the database status each imply a floor; the answer is the highest floor.
 */
export function deriveMatchdayPhase({ matchStatus, record }: DerivePhaseInput): MatchdayPhase {
  let phase: MatchdayPhase = record?.phase ?? "draft"
  if (record?.plan) phase = maxPhase(phase, "planned")
  if (record?.liveSession?.startedAt) phase = maxPhase(phase, "in_progress")
  if (record?.debrief?.completedAt) phase = maxPhase(phase, "completed")
  if (matchStatus) phase = maxPhase(phase, phaseFromMatchStatus(matchStatus))
  return phase
}

/** Apply a transition to a record, refusing anything the machine does not allow. */
export function transitionRecord(record: MatchdayRecord, to: MatchdayPhase, now = new Date()): MatchdayRecord {
  if (!canTransition(record.phase, to)) {
    throw new RangeError(`Matchday cannot go from ${record.phase} to ${to}.`)
  }
  if (record.phase === to) return record
  return { ...record, phase: to, updatedAt: now.toISOString() }
}

export function emptyMatchdayRecord(matchId: string, now = new Date()): MatchdayRecord {
  return {
    version: 1,
    matchId,
    phase: "draft",
    plan: null,
    liveSession: null,
    debrief: null,
    updatedAt: now.toISOString(),
  }
}
