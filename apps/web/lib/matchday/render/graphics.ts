/**
 * lib/matchday/render/graphics.ts
 *
 * The two post-match shareables:
 *
 *   WhatsApp / parent card   1080×1350 (4:5). Score, scorers, the fair-play badge and the two
 *                            stars. Reads at a glance in a group chat.
 *   Instagram story          1080×1920 (9:16). Score, the starting line-up on a pitch, and the
 *                            key moments down the side.
 *
 * Both take the debrief and NOTHING ELSE from the coach's notes: `coachNotes.privateNotes` and
 * `coachNotes.improve` are never read here. The only path from the private notes to a pixel does
 * not exist.
 */

import {
  MATCHDAY_BRAND,
  actualMinutes,
  fairPlaySummary,
  formatDateTr,
  outcomeForSide,
  scoreForSide,
  type LiveEvent,
  type Player,
  type PostMatchDebrief,
  type PreMatchPlan,
} from "@onpitch/shared/matchday"

import { displayName, formationOf } from "../plan"
import {
  FONT_MONO,
  GOLD,
  INK,
  INK_SOFT,
  PAPER,
  PAPER_DIM,
  TEAL,
  VERMILION,
  context2d,
  createCanvas,
  drawLineup,
  drawParagraph,
  drawText,
  fillRoundRect,
} from "./draw"

/* -------------------------------------------------------------------------- */

export interface GraphicInput {
  debrief: PostMatchDebrief
  players: Player[]
  teamName: string
  plan: PreMatchPlan | null
  /** Live events, when the match was tracked. Used for the story's "key moments". */
  events?: LiveEvent[]
}

const OUTCOME_LABEL = { win: "GALİBİYET", draw: "BERABERLİK", loss: "MAĞLUBİYET" } as const
const OUTCOME_COLOR = { win: TEAL, draw: GOLD, loss: VERMILION } as const

function playerName(players: Player[], playerId: string): string {
  return displayName(players.find((player) => player.id === playerId) ?? null)
}

function countList(players: Player[], counts: PostMatchDebrief["scorers"]): string[] {
  return counts.map((entry) =>
    entry.count > 1 ? `${playerName(players, entry.playerId)} ×${entry.count}` : playerName(players, entry.playerId),
  )
}

function fairPlayLine(input: GraphicInput): string | null {
  const tolerance = input.plan?.rotationIntervalMinutes ?? 10
  const summary = fairPlaySummary(actualMinutes(input.debrief), tolerance)
  if (!summary.earned || summary.playerCount < 2) return null
  return `Adil süre · ${summary.playerCount} oyuncunun hepsi en az ${summary.minMinutes} dk oynadı`
}

/* -------------------------------------------------------------------------- */
/*  WhatsApp card                                                             */
/* -------------------------------------------------------------------------- */

export const CARD_WIDTH = 1080
export const CARD_HEIGHT = 1350

export function renderWhatsappCard(input: GraphicInput): HTMLCanvasElement {
  const { debrief, players, teamName } = input
  const canvas = createCanvas(CARD_WIDTH, CARD_HEIGHT)
  const ctx = context2d(canvas)
  const margin = 72
  const inner = CARD_WIDTH - margin * 2

  ctx.fillStyle = PAPER
  ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT)
  ctx.fillStyle = INK
  ctx.fillRect(0, 0, CARD_WIDTH, 560)

  const outcome = outcomeForSide(debrief.finalScore, debrief.teamSide)
  const { us, them } = scoreForSide(debrief.finalScore, debrief.teamSide)
  const opponent = debrief.opponentName || "Rakip"

  drawText(ctx, "MAÇ SONUCU", margin, 110, { size: 24, weight: 700, family: FONT_MONO, color: GOLD, letterSpacing: 4 })
  drawText(ctx, OUTCOME_LABEL[outcome], CARD_WIDTH - margin, 110, {
    size: 24,
    weight: 700,
    family: FONT_MONO,
    color: OUTCOME_COLOR[outcome],
    align: "right",
    letterSpacing: 4,
  })

  // Score block: our name left, theirs right, digits in the middle.
  drawText(ctx, `${us} – ${them}`, CARD_WIDTH / 2, 330, { size: 200, weight: 800, family: FONT_MONO, color: PAPER, align: "center" })
  drawText(ctx, teamName, CARD_WIDTH / 2 - 250, 420, { size: 40, weight: 700, color: PAPER, align: "center" }, 420)
  drawText(ctx, opponent, CARD_WIDTH / 2 + 250, 420, { size: 40, weight: 700, color: PAPER_DIM, align: "center" }, 420)
  drawText(
    ctx,
    `${formatDateTr(debrief.playedOn)}${debrief.venue ? ` · ${debrief.venue}` : ""}`,
    CARD_WIDTH / 2,
    490,
    { size: 28, weight: 500, color: PAPER_DIM, align: "center" },
    inner,
  )

  let y = 660

  const sections: Array<{ title: string; lines: string[] }> = []
  if (debrief.scorers.length > 0) sections.push({ title: "GOLLER", lines: countList(players, debrief.scorers) })
  if (debrief.assists.length > 0) sections.push({ title: "ASİSTLER", lines: countList(players, debrief.assists) })
  if (debrief.saves.length > 0) sections.push({ title: "KURTARIŞLAR", lines: countList(players, debrief.saves) })

  for (const section of sections) {
    drawText(ctx, section.title, margin, y, { size: 22, weight: 700, family: FONT_MONO, color: INK_SOFT, letterSpacing: 3 })
    y += 44
    y += drawParagraph(ctx, section.lines.join("  ·  "), margin, y, { size: 32, weight: 600, color: INK }, inner, 42, 3)
    y += 26
  }

  const fair = fairPlayLine(input)
  if (fair) {
    fillRoundRect(ctx, margin, y, inner, 84, 10, "rgba(43, 177, 189, 0.14)", { color: TEAL, width: 3 })
    drawText(ctx, "✓", margin + 28, y + 56, { size: 40, weight: 800, color: TEAL })
    drawText(ctx, fair, margin + 84, y + 54, { size: 28, weight: 600, color: INK }, inner - 110)
    y += 120
  }

  const highlights = debrief.coachNotes.strengths.map((entry) => entry.trim()).filter(Boolean)
  if (highlights.length > 0) {
    drawText(ctx, "ÖNE ÇIKANLAR", margin, y, { size: 22, weight: 700, family: FONT_MONO, color: INK_SOFT, letterSpacing: 3 })
    y += 44
    for (const highlight of highlights.slice(0, 2)) {
      drawText(ctx, "★", margin, y, { size: 30, color: GOLD })
      y += drawParagraph(ctx, highlight, margin + 46, y, { size: 30, weight: 500, color: INK }, inner - 46, 40, 2)
      y += 14
    }
  }

  drawText(ctx, MATCHDAY_BRAND, CARD_WIDTH - margin, CARD_HEIGHT - 60, {
    size: 22,
    weight: 700,
    family: FONT_MONO,
    color: INK_SOFT,
    align: "right",
    letterSpacing: 3,
  })
  drawText(ctx, `Takım puanı ${debrief.matchRating}/10`, margin, CARD_HEIGHT - 60, { size: 22, weight: 600, color: INK_SOFT })

  return canvas
}

/* -------------------------------------------------------------------------- */
/*  Instagram story                                                           */
/* -------------------------------------------------------------------------- */

export const STORY_WIDTH = 1080
export const STORY_HEIGHT = 1920

export function renderStoryGraphic(input: GraphicInput): HTMLCanvasElement {
  const { debrief, players, teamName, plan } = input
  const canvas = createCanvas(STORY_WIDTH, STORY_HEIGHT)
  const ctx = context2d(canvas)
  const margin = 64

  // Ground: ink with a diagonal gold wash so it reads as designed, not as a screenshot.
  const gradient = ctx.createLinearGradient(0, 0, STORY_WIDTH, STORY_HEIGHT)
  gradient.addColorStop(0, "#151d2b")
  gradient.addColorStop(1, "#0b1018")
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, STORY_WIDTH, STORY_HEIGHT)
  ctx.fillStyle = "rgba(224, 182, 74, 0.08)"
  ctx.beginPath()
  ctx.moveTo(0, 0)
  ctx.lineTo(STORY_WIDTH, 0)
  ctx.lineTo(0, 900)
  ctx.closePath()
  ctx.fill()

  const outcome = outcomeForSide(debrief.finalScore, debrief.teamSide)
  const { us, them } = scoreForSide(debrief.finalScore, debrief.teamSide)
  const opponent = debrief.opponentName || "Rakip"

  drawText(ctx, MATCHDAY_BRAND, margin, 140, { size: 26, weight: 700, family: FONT_MONO, color: GOLD, letterSpacing: 5 })
  drawText(ctx, OUTCOME_LABEL[outcome], STORY_WIDTH - margin, 140, {
    size: 26,
    weight: 700,
    family: FONT_MONO,
    color: OUTCOME_COLOR[outcome],
    align: "right",
    letterSpacing: 5,
  })

  drawText(ctx, teamName.toUpperCase(), margin, 250, { size: 54, weight: 800, color: PAPER }, STORY_WIDTH - margin * 2)
  drawText(ctx, `vs ${opponent}`, margin, 310, { size: 38, weight: 600, color: PAPER_DIM }, STORY_WIDTH - margin * 2)
  drawText(ctx, `${us} – ${them}`, STORY_WIDTH / 2, 560, { size: 260, weight: 800, family: FONT_MONO, color: PAPER, align: "center" })
  drawText(ctx, formatDateTr(debrief.playedOn), STORY_WIDTH / 2, 630, { size: 30, weight: 500, color: PAPER_DIM, align: "center" })

  // Line-up on a pitch, when there was a plan.
  let y = 700
  if (plan && plan.startingLineup.length > 0) {
    const rect = { x: margin, y, width: STORY_WIDTH - margin * 2, height: 760 }
    drawLineup(ctx, rect, formationOf(plan), plan.startingLineup, plan.squad, { tokenRadius: 36 })
    y += 760 + 60
  }

  // Key moments: goals with minutes when tracked live, otherwise the scorers list.
  const moments: string[] = []
  const goals = (input.events ?? []).filter((event) => event.type === "goal").sort((a, b) => a.minute - b.minute)
  if (goals.length > 0) {
    for (const goal of goals) {
      const ours = goal.side === debrief.teamSide
      const who = ours && goal.playerId ? playerName(players, goal.playerId) : ours ? teamName : opponent
      moments.push(`${goal.minute}'  ${ours ? "⚽" : "•"}  ${who}${goal.assistPlayerId ? ` (asist ${playerName(players, goal.assistPlayerId)})` : ""}`)
    }
  } else if (debrief.scorers.length > 0) {
    moments.push(`⚽  ${countList(players, debrief.scorers).join(", ")}`)
    if (debrief.assists.length > 0) moments.push(`🎯  ${countList(players, debrief.assists).join(", ")}`)
  }

  if (moments.length > 0) {
    drawText(ctx, "ANLAR", margin, y, { size: 24, weight: 700, family: FONT_MONO, color: GOLD, letterSpacing: 4 })
    y += 20
    for (const moment of moments.slice(0, 6)) {
      y += 50
      drawText(ctx, moment, margin, y, { size: 30, weight: 600, color: PAPER }, STORY_WIDTH - margin * 2)
    }
    y += 30
  }

  const fair = fairPlayLine(input)
  if (fair && y < STORY_HEIGHT - 200) {
    fillRoundRect(ctx, margin, y, STORY_WIDTH - margin * 2, 80, 10, "rgba(43, 177, 189, 0.16)", { color: TEAL, width: 3 })
    drawText(ctx, `✓  ${fair}`, margin + 28, y + 52, { size: 26, weight: 600, color: PAPER }, STORY_WIDTH - margin * 2 - 56)
  }

  return canvas
}
