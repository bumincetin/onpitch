/**
 * packages/shared/src/matchday/types.ts
 *
 * The matchday vocabulary: everything a coach needs BEFORE kickoff (squad, formation, line-up,
 * rotation schedule), DURING the game (the live session that shadows the realtime tally) and
 * AFTER it (the debrief). None of this is a database row yet — it is persisted by the app through
 * `MatchdayRecord`, which is why every shape here has a zod schema next to it: a record read back
 * from storage crosses a trust boundary exactly like a request body does (docs/SECURITY.md §2).
 *
 * The existing live model — `matches.status`, the broadcast tally, presence — is untouched. The
 * matchday lifecycle sits BESIDE it and is derived from it where they overlap (see lifecycle.ts).
 */

import { z } from "zod"

import type { Enums } from "../database"
import { TEAM_SIDES, type TeamSide } from "../domain"

/* ========================================================================== */
/*  Pitch formats                                                             */
/* ========================================================================== */

export const PITCH_FORMATS = ["5v5", "6v6", "7v7", "8v8", "9v9", "11v11"] as const
export type PitchFormat = (typeof PITCH_FORMATS)[number]

/** Players on the pitch per side, goalkeeper included. */
export const PITCH_FORMAT_PLAYERS: Record<PitchFormat, number> = {
  "5v5": 5,
  "6v6": 6,
  "7v7": 7,
  "8v8": 8,
  "9v9": 9,
  "11v11": 11,
}

/** `public.match_format` → the pitch format the planner draws. 9v9 has no database twin yet. */
export function pitchFormatFromMatchFormat(format: Enums<"match_format">): PitchFormat {
  switch (format) {
    case "five_a_side":
      return "5v5"
    case "six_a_side":
      return "6v6"
    case "seven_a_side":
      return "7v7"
    case "eight_a_side":
      return "8v8"
    case "eleven_a_side":
      return "11v11"
  }
}

/* ========================================================================== */
/*  Players                                                                   */
/* ========================================================================== */

export const POSITIONS = ["GK", "DEF", "MID", "FWD"] as const
export type Position = (typeof POSITIONS)[number]

export const PLAYER_STATUSES = ["available", "injured", "absent"] as const
export type PlayerStatus = (typeof PLAYER_STATUSES)[number]

export interface Player {
  /** Stable within the plan. A profile id when the player has an account, otherwise a local id. */
  id: string
  name: string
  number: number | null
  preferredPositions: Position[]
  status: PlayerStatus
  /** Set when this player is a `profiles` row; lets the debrief link back to a real person. */
  profileId?: string | null
}

/* ========================================================================== */
/*  Formations                                                                */
/* ========================================================================== */

export interface FormationSlot {
  /** Unique within the formation, e.g. `gk`, `l1p2`. */
  id: string
  role: Position
  /** Short on-pitch label, e.g. "DEF 2". */
  label: string
  /** Percent of pitch width, 0 = left touchline. */
  x: number
  /** Percent of pitch length, 0 = the goal we attack, 100 = our own goal line. */
  y: number
}

export interface Formation {
  /** `${format}:${shape}`, e.g. `7v7:2-3-1`. */
  id: string
  /** Human name, e.g. "7v7 2-3-1". */
  name: string
  format: PitchFormat
  /** Outfield lines from defence to attack, e.g. [2, 3, 1]. */
  shape: number[]
  slots: FormationSlot[]
}

/* ========================================================================== */
/*  Pre-match plan                                                            */
/* ========================================================================== */

export const GOALKEEPER_MODES = ["dedicated", "rotating"] as const
export type GoalkeeperMode = (typeof GOALKEEPER_MODES)[number]

export interface LineupAssignment {
  slotId: string
  playerId: string
}

export interface ScheduledSwap {
  /** Player leaving the slot. `null` when the slot was empty (a late arrival filling a gap). */
  out: string | null
  in: string
  slotId: string
}

export interface RotationBlock {
  index: number
  /** 1-based period (half, quarter) the block belongs to. */
  period: number
  startMinute: number
  endMinute: number
  onPitch: LineupAssignment[]
  /** Substitutions to make at `startMinute`. Empty for the first block. */
  swaps: ScheduledSwap[]
  goalkeeperId: string | null
}

export interface PreMatchPlan {
  matchId: string
  /** Which side of the fixture this plan is for. */
  teamSide: TeamSide
  opponentName: string | null
  formationId: string
  squad: Player[]
  startingLineup: LineupAssignment[]
  durationMinutes: number
  periods: number
  rotationIntervalMinutes: number
  goalkeeperMode: GoalkeeperMode
  dedicatedGoalkeeperId: string | null
  scheduledRotations: RotationBlock[]
  updatedAt: string
}

/* ========================================================================== */
/*  Live session — the local shadow of the realtime tally                     */
/* ========================================================================== */

export const LIVE_EVENT_TYPES = ["goal", "save", "yellow_card", "red_card", "substitution"] as const
export type LiveEventType = (typeof LIVE_EVENT_TYPES)[number]

export interface LiveEvent {
  id: string
  type: LiveEventType
  /** Match minute the event was logged at. */
  minute: number
  side: TeamSide
  /** Our player involved (scorer, keeper, carded player). `null` for an opponent goal. */
  playerId: string | null
  assistPlayerId?: string | null
  /** Substitution only. */
  inPlayerId?: string | null
  outPlayerId?: string | null
  at: string
}

export interface LiveSession {
  matchId: string
  /** When the coach pressed kickoff on THIS device. `null` until they do. */
  startedAt: string | null
  endedAt: string | null
  /** Last broadcast tally seen on this device, in fixture (home/away) orientation. */
  tally: { home: number; away: number }
  events: LiveEvent[]
  updatedAt: string
}

/* ========================================================================== */
/*  Post-match debrief                                                        */
/* ========================================================================== */

export interface PlayerCount {
  playerId: string
  count: number
}

export interface CoachNotes {
  /** "Two stars": two things that went well. */
  strengths: string[]
  /** "A wish": the one thing to work on at the next session. */
  improve: string
  /** Never leaves the coach's device or appears on a shareable. */
  privateNotes: string
}

export interface PostMatchDebrief {
  matchId: string
  /** `live` when pre-filled from a live session, `reconstructed` when typed in afterwards. */
  source: "live" | "reconstructed"
  teamSide: TeamSide
  opponentName: string
  venue: string | null
  /** ISO date (YYYY-MM-DD) the match was played. */
  playedOn: string
  finalScore: { home: number; away: number }
  scorers: PlayerCount[]
  assists: PlayerCount[]
  saves: PlayerCount[]
  yellowCards: PlayerCount[]
  redCards: PlayerCount[]
  /** Minutes planned per player, from the rotation schedule. Zero when there was no plan. */
  plannedMinutes: Record<string, number>
  /** ±minutes vs the plan, per player. Actual = planned + adjustment. */
  playerMinutesAdjustments: Record<string, number>
  /** 1..10 */
  matchRating: number
  coachNotes: CoachNotes
  completedAt: string | null
}

/* ========================================================================== */
/*  Lifecycle                                                                 */
/* ========================================================================== */

export const MATCHDAY_PHASES = ["draft", "planned", "in_progress", "completed"] as const
export type MatchdayPhase = (typeof MATCHDAY_PHASES)[number]

/** Everything the app persists about one match's matchday, as one document. */
export interface MatchdayRecord {
  version: 1
  matchId: string
  phase: MatchdayPhase
  plan: PreMatchPlan | null
  liveSession: LiveSession | null
  debrief: PostMatchDebrief | null
  updatedAt: string
}

/* ========================================================================== */
/*  Schemas                                                                   */
/* ========================================================================== */

const isoString = z.string().min(1)

export const positionSchema = z.enum(POSITIONS)
export const playerStatusSchema = z.enum(PLAYER_STATUSES)
export const pitchFormatSchema = z.enum(PITCH_FORMATS)
export const goalkeeperModeSchema = z.enum(GOALKEEPER_MODES)
export const matchdayPhaseSchema = z.enum(MATCHDAY_PHASES)
export const liveEventTypeSchema = z.enum(LIVE_EVENT_TYPES)
const matchdayTeamSideSchema = z.enum(TEAM_SIDES)

export const playerSchema: z.ZodType<Player> = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(60),
  number: z.number().int().min(0).max(999).nullable(),
  preferredPositions: z.array(positionSchema).max(4),
  status: playerStatusSchema,
  profileId: z.string().nullable().optional(),
})

export const lineupAssignmentSchema: z.ZodType<LineupAssignment> = z.object({
  slotId: z.string().min(1),
  playerId: z.string().min(1),
})

export const scheduledSwapSchema: z.ZodType<ScheduledSwap> = z.object({
  out: z.string().nullable(),
  in: z.string().min(1),
  slotId: z.string().min(1),
})

export const rotationBlockSchema: z.ZodType<RotationBlock> = z.object({
  index: z.number().int().min(0),
  period: z.number().int().min(1),
  startMinute: z.number().min(0),
  endMinute: z.number().min(0),
  onPitch: z.array(lineupAssignmentSchema),
  swaps: z.array(scheduledSwapSchema),
  goalkeeperId: z.string().nullable(),
})

export const preMatchPlanSchema: z.ZodType<PreMatchPlan> = z.object({
  matchId: z.string().min(1),
  teamSide: matchdayTeamSideSchema,
  opponentName: z.string().max(80).nullable(),
  formationId: z.string().min(1),
  squad: z.array(playerSchema).max(40),
  startingLineup: z.array(lineupAssignmentSchema),
  durationMinutes: z.number().int().min(10).max(180),
  periods: z.number().int().min(1).max(6),
  rotationIntervalMinutes: z.number().int().min(1).max(90),
  goalkeeperMode: goalkeeperModeSchema,
  dedicatedGoalkeeperId: z.string().nullable(),
  scheduledRotations: z.array(rotationBlockSchema),
  updatedAt: isoString,
})

export const liveEventSchema: z.ZodType<LiveEvent> = z.object({
  id: z.string().min(1),
  type: liveEventTypeSchema,
  minute: z.number().min(0),
  side: matchdayTeamSideSchema,
  playerId: z.string().nullable(),
  assistPlayerId: z.string().nullable().optional(),
  inPlayerId: z.string().nullable().optional(),
  outPlayerId: z.string().nullable().optional(),
  at: isoString,
})

export const liveSessionSchema: z.ZodType<LiveSession> = z.object({
  matchId: z.string().min(1),
  startedAt: isoString.nullable(),
  endedAt: isoString.nullable(),
  tally: z.object({ home: z.number().int().min(0), away: z.number().int().min(0) }),
  events: z.array(liveEventSchema),
  updatedAt: isoString,
})

const playerCountSchema: z.ZodType<PlayerCount> = z.object({
  playerId: z.string().min(1),
  count: z.number().int().min(0),
})

export const coachNotesSchema: z.ZodType<CoachNotes> = z.object({
  strengths: z.array(z.string().max(280)).max(4),
  improve: z.string().max(280),
  privateNotes: z.string().max(4000),
})

export const postMatchDebriefSchema: z.ZodType<PostMatchDebrief> = z.object({
  matchId: z.string().min(1),
  source: z.enum(["live", "reconstructed"]),
  teamSide: matchdayTeamSideSchema,
  opponentName: z.string().max(80),
  venue: z.string().max(120).nullable(),
  playedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  finalScore: z.object({
    home: z.number().int().min(0).max(99),
    away: z.number().int().min(0).max(99),
  }),
  scorers: z.array(playerCountSchema),
  assists: z.array(playerCountSchema),
  saves: z.array(playerCountSchema),
  yellowCards: z.array(playerCountSchema),
  redCards: z.array(playerCountSchema),
  plannedMinutes: z.record(z.number().min(0)),
  playerMinutesAdjustments: z.record(z.number()),
  matchRating: z.number().int().min(1).max(10),
  coachNotes: coachNotesSchema,
  completedAt: isoString.nullable(),
})

export const matchdayRecordSchema: z.ZodType<MatchdayRecord> = z.object({
  version: z.literal(1),
  matchId: z.string().min(1),
  phase: matchdayPhaseSchema,
  plan: preMatchPlanSchema.nullable(),
  liveSession: liveSessionSchema.nullable(),
  debrief: postMatchDebriefSchema.nullable(),
  updatedAt: isoString,
})

/* ========================================================================== */
/*  Labels — kept here so web and mobile say the same words                   */
/* ========================================================================== */

export const POSITION_LABEL: Record<Position, string> = {
  GK: "Kaleci",
  DEF: "Defans",
  MID: "Orta saha",
  FWD: "Forvet",
}

export const POSITION_SHORT: Record<Position, string> = {
  GK: "KL",
  DEF: "DEF",
  MID: "ORT",
  FWD: "FOR",
}

export const PLAYER_STATUS_LABEL: Record<PlayerStatus, string> = {
  available: "Hazır",
  injured: "Sakat",
  absent: "Yok",
}

export const MATCHDAY_PHASE_LABEL: Record<MatchdayPhase, string> = {
  draft: "Taslak",
  planned: "Planlandı",
  in_progress: "Oynanıyor",
  completed: "Tamamlandı",
}

/** Brand stamped on the shareable graphics. One place to change. */
export const MATCHDAY_BRAND = "OnPitch"
