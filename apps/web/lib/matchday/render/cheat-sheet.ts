/**
 * lib/matchday/render/cheat-sheet.ts
 *
 * The sideline sheet, as a model and as a 1080×1920 image.
 *
 * The model is what the on-screen preview, the print view and the PNG all render, so the three
 * cannot disagree. The image leaves the top of the frame empty on purpose: a phone lock screen
 * paints its clock there, and a line-up hidden under "14:32" is no use on the touchline.
 */

import {
  type Formation,
  type Player,
  type PreMatchPlan,
  type RotationBlock,
  MATCHDAY_BRAND,
} from "@halisaha/shared/matchday"

import { displayName, formationOf, playerById, slotLabel } from "../plan"
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
  drawText,
  fillRoundRect,
} from "./draw"

/* -------------------------------------------------------------------------- */
/*  Model                                                                     */
/* -------------------------------------------------------------------------- */

export interface CheatSheetSwapLine {
  out: Player | null
  in: Player | null
  slotLabel: string
}

export interface CheatSheetBlock {
  index: number
  period: number
  startMinute: number
  endMinute: number
  swaps: CheatSheetSwapLine[]
  keeper: Player | null
}

export interface CheatSheetModel {
  formation: Formation
  startingRows: Array<{ slotLabel: string; player: Player | null }>
  blocks: CheatSheetBlock[]
  /** Blocks that actually require the coach to do something. */
  swapBlocks: CheatSheetBlock[]
  bench: Player[]
  unavailable: Player[]
  keeperMode: PreMatchPlan["goalkeeperMode"]
}

export function cheatSheetModel(plan: PreMatchPlan): CheatSheetModel {
  const formation = formationOf(plan)
  const first: RotationBlock | undefined = plan.scheduledRotations[0]
  const starting = first?.onPitch ?? plan.startingLineup
  const bySlot = new Map(starting.map((entry) => [entry.slotId, entry.playerId]))

  const startingRows = formation.slots.map((slot) => ({
    slotLabel: slot.label,
    player: playerById(plan, bySlot.get(slot.id)),
  }))

  const blocks: CheatSheetBlock[] = plan.scheduledRotations.map((block) => ({
    index: block.index,
    period: block.period,
    startMinute: block.startMinute,
    endMinute: block.endMinute,
    keeper: playerById(plan, block.goalkeeperId),
    swaps: block.swaps.map((swap) => ({
      out: playerById(plan, swap.out),
      in: playerById(plan, swap.in),
      slotLabel: slotLabel(formation, swap.slotId),
    })),
  }))

  const onPitch = new Set(starting.map((entry) => entry.playerId))
  return {
    formation,
    startingRows,
    blocks,
    swapBlocks: blocks.filter((block) => block.swaps.length > 0),
    bench: plan.squad.filter((player) => player.status === "available" && !onPitch.has(player.id)),
    unavailable: plan.squad.filter((player) => player.status !== "available"),
    keeperMode: plan.goalkeeperMode,
  }
}

export function minuteLabel(minute: number): string {
  return `${minute}'`
}

/* -------------------------------------------------------------------------- */
/*  Image                                                                     */
/* -------------------------------------------------------------------------- */

export interface CheatSheetRenderInput {
  plan: PreMatchPlan
  teamName: string
  opponentName: string
  /** e.g. "Cmt 6 Eyl, 17:00 · Saha 1" */
  subtitle: string
  /** Leave room for the lock-screen clock. Default on. */
  lockScreen?: boolean
}

export const CHEAT_SHEET_WIDTH = 1080
export const CHEAT_SHEET_HEIGHT = 1920

export function renderCheatSheet(input: CheatSheetRenderInput): HTMLCanvasElement {
  const model = cheatSheetModel(input.plan)
  const canvas = createCanvas(CHEAT_SHEET_WIDTH, CHEAT_SHEET_HEIGHT)
  const ctx = context2d(canvas)
  const width = CHEAT_SHEET_WIDTH
  const margin = 56
  const lockScreen = input.lockScreen ?? true

  ctx.fillStyle = INK
  ctx.fillRect(0, 0, width, CHEAT_SHEET_HEIGHT)

  let y = lockScreen ? 420 : 120

  /* ---- header ---------------------------------------------------------- */

  drawText(ctx, `${input.teamName}  vs  ${input.opponentName}`, margin, y, { size: 44, weight: 700, color: PAPER }, width - margin * 2)
  y += 46
  drawText(ctx, input.subtitle, margin, y, { size: 28, weight: 500, color: PAPER_DIM }, width - margin * 2)
  y += 18
  drawText(ctx, model.formation.name.toUpperCase(), width - margin, y - 64, {
    size: 26,
    weight: 700,
    family: FONT_MONO,
    color: GOLD,
    align: "right",
    letterSpacing: 2,
  })

  /* ---- pitch with the starting line-up --------------------------------- */

  y += 30
  const pitchWidth = width - margin * 2
  const pitchHeight = 640
  const pitchRect = { x: margin, y, width: pitchWidth, height: pitchHeight }
  drawLineup(ctx, pitchRect, model.formation, input.plan.startingLineup, input.plan.squad, {
    tokenRadius: 34,
  })
  y += pitchHeight + 56

  /* ---- schedule -------------------------------------------------------- */

  drawText(ctx, "DEĞİŞİKLİKLER", margin, y, { size: 24, weight: 700, family: FONT_MONO, color: GOLD, letterSpacing: 3 })
  y += 20

  const rowHeight = 46
  const available = CHEAT_SHEET_HEIGHT - 180 - y
  const lines: Array<{ kind: "block" | "swap" | "keeper"; text: string; minute?: string }> = []
  for (const block of model.swapBlocks) {
    lines.push({ kind: "block", minute: minuteLabel(block.startMinute), text: `${block.period}. devre` })
    for (const swap of block.swaps) {
      lines.push({
        kind: "swap",
        text: `ÇIKAN ${displayName(swap.out)}  ›  GİREN ${displayName(swap.in)}  (${swap.slotLabel})`,
      })
    }
    if (model.keeperMode === "rotating" && block.keeper) {
      lines.push({ kind: "keeper", text: `Kaleci: ${displayName(block.keeper)}` })
    }
  }
  if (lines.length === 0) {
    lines.push({ kind: "swap", text: "Planlı değişiklik yok — herkes maç boyu sahada." })
  }

  const maxRows = Math.max(3, Math.floor(available / rowHeight))
  const shown = lines.slice(0, maxRows)
  for (const line of shown) {
    y += rowHeight
    if (line.kind === "block") {
      fillRoundRect(ctx, margin, y - 34, width - margin * 2, 44, 6, INK_SOFT)
      drawText(ctx, line.minute ?? "", margin + 16, y - 2, { size: 30, weight: 700, family: FONT_MONO, color: TEAL })
      drawText(ctx, line.text, margin + 130, y - 2, { size: 24, weight: 600, color: PAPER_DIM })
    } else if (line.kind === "keeper") {
      drawText(ctx, line.text, margin + 24, y - 2, { size: 26, weight: 600, color: GOLD }, width - margin * 2 - 24)
    } else {
      drawText(ctx, line.text, margin + 24, y - 2, { size: 27, weight: 600, color: PAPER }, width - margin * 2 - 24)
    }
  }
  if (lines.length > shown.length) {
    y += rowHeight
    drawText(ctx, `+${lines.length - shown.length} satır daha — tam liste uygulamada`, margin + 24, y - 2, { size: 22, color: VERMILION })
  }

  /* ---- footer ---------------------------------------------------------- */

  const footerY = CHEAT_SHEET_HEIGHT - 96
  const benchText = model.bench.length > 0 ? `Yedek: ${model.bench.map((player) => displayName(player)).join(", ")}` : "Yedek yok"
  drawText(ctx, benchText, margin, footerY, { size: 24, weight: 500, color: PAPER_DIM }, width - margin * 2)
  if (model.unavailable.length > 0) {
    drawText(
      ctx,
      `Yok: ${model.unavailable.map((player) => player.name).join(", ")}`,
      margin,
      footerY + 34,
      { size: 22, weight: 500, color: VERMILION },
      width - margin * 2 - 200,
    )
  }
  drawText(ctx, MATCHDAY_BRAND, width - margin, footerY + 34, {
    size: 22,
    weight: 700,
    family: FONT_MONO,
    color: GOLD,
    align: "right",
    letterSpacing: 3,
  })

  return canvas
}
