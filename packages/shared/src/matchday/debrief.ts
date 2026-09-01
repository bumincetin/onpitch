/**
 * packages/shared/src/matchday/debrief.ts
 *
 * Building the post-match debrief: pre-filled from a live session when there was one, or as a
 * blank sheet for the 60-second reconstruction when the phone stayed in the bag. Also the
 * fair-play summary and the plain-text share, which the graphics and the WhatsApp message both
 * derive from so they can never disagree about who scored.
 */

import type { TeamSide } from "../domain"
import { playerMinutesFromBlocks } from "./rotation"
import type {
  LiveSession,
  Player,
  PlayerCount,
  PostMatchDebrief,
  PreMatchPlan,
} from "./types"

/* -------------------------------------------------------------------------- */
/*  Pre-fill                                                                  */
/* -------------------------------------------------------------------------- */

export interface DebriefDraftInput {
  matchId: string
  teamSide: TeamSide
  opponentName: string | null
  venue: string | null
  /** The fixture's kickoff instant; the debrief keeps only the calendar date. */
  kickoffAt: string
  plan: PreMatchPlan | null
  liveSession: LiveSession | null
  /** `matches.home_score / away_score` once a result is confirmed. Beats the live tally. */
  confirmedScore: { home: number; away: number } | null
}

/** Count `playerId`s into a sorted tally list. */
export function tallyPlayers(playerIds: Array<string | null | undefined>): PlayerCount[] {
  const counts = new Map<string, number>()
  for (const id of playerIds) {
    if (!id) continue
    counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([playerId, count]) => ({ playerId, count }))
    .sort((a, b) => b.count - a.count || a.playerId.localeCompare(b.playerId))
}

export function createDebriefDraft(input: DebriefDraftInput): PostMatchDebrief {
  const { liveSession, plan } = input
  const events = liveSession?.events ?? []
  const ours = events.filter((event) => event.side === input.teamSide)

  const tracked = Boolean(liveSession && (liveSession.startedAt || events.length > 0))

  const finalScore = input.confirmedScore ??
    liveSession?.tally ?? { home: 0, away: 0 }

  return {
    matchId: input.matchId,
    source: tracked ? "live" : "reconstructed",
    teamSide: input.teamSide,
    opponentName: input.opponentName ?? plan?.opponentName ?? "",
    venue: input.venue,
    playedOn: isoDate(input.kickoffAt),
    finalScore: { home: finalScore.home, away: finalScore.away },
    scorers: tallyPlayers(ours.filter((event) => event.type === "goal").map((event) => event.playerId)),
    assists: tallyPlayers(ours.filter((event) => event.type === "goal").map((event) => event.assistPlayerId)),
    saves: tallyPlayers(ours.filter((event) => event.type === "save").map((event) => event.playerId)),
    yellowCards: tallyPlayers(ours.filter((event) => event.type === "yellow_card").map((event) => event.playerId)),
    redCards: tallyPlayers(ours.filter((event) => event.type === "red_card").map((event) => event.playerId)),
    plannedMinutes: plan ? playerMinutesFromBlocks(plan.scheduledRotations) : {},
    playerMinutesAdjustments: {},
    matchRating: 7,
    coachNotes: { strengths: ["", ""], improve: "", privateNotes: "" },
    completedAt: null,
  }
}

function isoDate(instant: string): string {
  const date = new Date(instant)
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10)
  return date.toISOString().slice(0, 10)
}

/* -------------------------------------------------------------------------- */
/*  Derived views                                                             */
/* -------------------------------------------------------------------------- */

/** Actual minutes per player: planned plus the coach's ±adjustments, floored at zero. */
export function actualMinutes(debrief: PostMatchDebrief): Record<string, number> {
  const ids = new Set([
    ...Object.keys(debrief.plannedMinutes),
    ...Object.keys(debrief.playerMinutesAdjustments),
  ])
  const result: Record<string, number> = {}
  for (const id of ids) {
    const planned = debrief.plannedMinutes[id] ?? 0
    const delta = debrief.playerMinutesAdjustments[id] ?? 0
    result[id] = Math.max(0, planned + delta)
  }
  return result
}

/** Our goals and theirs, in the orientation the coach thinks in. */
export function scoreForSide(
  score: { home: number; away: number },
  side: TeamSide,
): { us: number; them: number } {
  return side === "home" ? { us: score.home, them: score.away } : { us: score.away, them: score.home }
}

export type DebriefOutcome = "win" | "draw" | "loss"

export function outcomeForSide(score: { home: number; away: number }, side: TeamSide): DebriefOutcome {
  const { us, them } = scoreForSide(score, side)
  if (us > them) return "win"
  if (us < them) return "loss"
  return "draw"
}

export interface FairPlaySummary {
  /** Players who took part (minutes > 0). */
  playerCount: number
  minMinutes: number
  maxMinutes: number
  spreadMinutes: number
  /** True when everyone who played is within `toleranceMinutes` of everyone else. */
  earned: boolean
}

/** The "everyone got their minutes" badge. Tolerance defaults to one rotation block. */
export function fairPlaySummary(minutes: Record<string, number>, toleranceMinutes = 10): FairPlaySummary {
  const played = Object.values(minutes).filter((value) => value > 0)
  if (played.length === 0) {
    return { playerCount: 0, minMinutes: 0, maxMinutes: 0, spreadMinutes: 0, earned: false }
  }
  const minMinutes = Math.min(...played)
  const maxMinutes = Math.max(...played)
  const spreadMinutes = maxMinutes - minMinutes
  return {
    playerCount: played.length,
    minMinutes,
    maxMinutes,
    spreadMinutes,
    earned: spreadMinutes <= toleranceMinutes,
  }
}

/* -------------------------------------------------------------------------- */
/*  Text share — the WhatsApp message                                         */
/* -------------------------------------------------------------------------- */

export function playerLabel(players: Player[], playerId: string): string {
  const player = players.find((candidate) => candidate.id === playerId)
  if (!player) return "Oyuncu"
  return player.number !== null ? `#${player.number} ${player.name}` : player.name
}

function listCounts(players: Player[], counts: PlayerCount[]): string {
  return counts
    .map((entry) => (entry.count > 1 ? `${playerLabel(players, entry.playerId)} (${entry.count})` : playerLabel(players, entry.playerId)))
    .join(", ")
}

export interface ShareTextInput {
  debrief: PostMatchDebrief
  players: Player[]
  teamName: string
  /** Tolerance for the fair-play badge, usually the plan's rotation interval. */
  fairPlayToleranceMinutes?: number
}

/**
 * The parent-facing summary. Private coach notes are NOT an input to this function, on purpose:
 * there is no code path from `coachNotes.privateNotes` to anything shareable.
 */
export function debriefShareText({ debrief, players, teamName, fairPlayToleranceMinutes = 10 }: ShareTextInput): string {
  const { us, them } = scoreForSide(debrief.finalScore, debrief.teamSide)
  const opponent = debrief.opponentName || "Rakip"
  const outcome = outcomeForSide(debrief.finalScore, debrief.teamSide)
  const outcomeWord = outcome === "win" ? "Galibiyet" : outcome === "loss" ? "Mağlubiyet" : "Beraberlik"

  const lines: string[] = [`⚽ ${teamName} ${us}–${them} ${opponent} · ${outcomeWord}`]
  lines.push(`📅 ${formatDateTr(debrief.playedOn)}${debrief.venue ? ` · ${debrief.venue}` : ""}`)

  if (debrief.scorers.length > 0) lines.push(`🥅 Goller: ${listCounts(players, debrief.scorers)}`)
  if (debrief.assists.length > 0) lines.push(`🎯 Asistler: ${listCounts(players, debrief.assists)}`)
  if (debrief.saves.length > 0) lines.push(`🧤 Kurtarışlar: ${listCounts(players, debrief.saves)}`)

  const fair = fairPlaySummary(actualMinutes(debrief), fairPlayToleranceMinutes)
  if (fair.earned && fair.playerCount > 1) {
    lines.push(`✅ Adil süre: ${fair.playerCount} oyuncunun hepsi en az ${fair.minMinutes} dk oynadı`)
  }

  const highlights = debrief.coachNotes.strengths.map((entry) => entry.trim()).filter(Boolean)
  if (highlights.length > 0) lines.push(`⭐ ${highlights.join(" · ")}`)

  return lines.join("\n")
}

export function formatDateTr(isoDate: string): string {
  const [year, month, day] = isoDate.split("-").map((part) => Number.parseInt(part, 10))
  if (!year || !month || !day) return isoDate
  const date = new Date(Date.UTC(year, month - 1, day))
  return new Intl.DateTimeFormat("tr-TR", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(date)
}
