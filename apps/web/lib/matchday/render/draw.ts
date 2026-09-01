/**
 * lib/matchday/render/draw.ts
 *
 * Canvas primitives shared by the three matchday graphics. Nothing here knows what a plan or a
 * debrief is; it draws text that fits, boxes with corners, a pitch, and player tokens on it.
 *
 * Output sizes are fixed (1080 wide) rather than DPR-scaled: the images are meant to be saved and
 * shared, and a 1080×1920 PNG is what a phone lock screen and an Instagram story both expect.
 */

import type { Formation, LineupAssignment, Player } from "@halisaha/shared/matchday"

/* -------------------------------------------------------------------------- */
/*  Palette — the app's editorial colours, at contrast levels a lock screen needs */
/* -------------------------------------------------------------------------- */

export const INK = "#0f1520"
export const INK_SOFT = "#1b2230"
export const PAPER = "#f6f1e7"
export const PAPER_DIM = "rgba(246, 241, 231, 0.72)"
export const GOLD = "#e0b64a"
export const TEAL = "#2bb1bd"
export const VERMILION = "#e04a56"
export const GRASS = "#1d5a3a"
export const GRASS_LINE = "rgba(246, 241, 231, 0.82)"

export const FONT_SANS = '"Inter", "Segoe UI", system-ui, -apple-system, Roboto, sans-serif'
export const FONT_MONO = '"JetBrains Mono", "SFMono-Regular", ui-monospace, Menlo, monospace'

/* -------------------------------------------------------------------------- */
/*  Canvas                                                                    */
/* -------------------------------------------------------------------------- */

export function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  return canvas
}

export function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext("2d")
  if (!ctx) throw new Error("2D canvas is not available")
  ctx.textBaseline = "alphabetic"
  return ctx
}

export function fillRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  fill: string,
  stroke?: { color: string; width: number },
): void {
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + width, y, x + width, y + height, radius)
  ctx.arcTo(x + width, y + height, x, y + height, radius)
  ctx.arcTo(x, y + height, x, y, radius)
  ctx.arcTo(x, y, x + width, y, radius)
  ctx.closePath()
  ctx.fillStyle = fill
  ctx.fill()
  if (stroke) {
    ctx.lineWidth = stroke.width
    ctx.strokeStyle = stroke.color
    ctx.stroke()
  }
}

/* -------------------------------------------------------------------------- */
/*  Text                                                                      */
/* -------------------------------------------------------------------------- */

export interface TextStyle {
  size: number
  weight?: number | "bold" | "normal"
  family?: string
  color?: string
  align?: CanvasTextAlign
  letterSpacing?: number
}

export function font(style: TextStyle): string {
  return `${style.weight ?? 500} ${style.size}px ${style.family ?? FONT_SANS}`
}

/** Truncate with an ellipsis so `text` fits `maxWidth` at the current font. */
export function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text
  let end = text.length
  while (end > 0) {
    const candidate = `${text.slice(0, end).trimEnd()}…`
    if (ctx.measureText(candidate).width <= maxWidth) return candidate
    end -= 1
  }
  return "…"
}

export function drawText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  style: TextStyle,
  maxWidth?: number,
): number {
  ctx.font = font(style)
  ctx.fillStyle = style.color ?? PAPER
  ctx.textAlign = style.align ?? "left"
  if ("letterSpacing" in ctx) {
    ;(ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${style.letterSpacing ?? 0}px`
  }
  const final = maxWidth ? fitText(ctx, text, maxWidth) : text
  ctx.fillText(final, x, y)
  return ctx.measureText(final).width
}

/** Greedy word wrap. Returns the lines; the caller decides how many to draw. */
export function wrapText(ctx: CanvasRenderingContext2D, text: string, style: TextStyle, maxWidth: number): string[] {
  ctx.font = font(style)
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let current = ""
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word
    if (ctx.measureText(candidate).width <= maxWidth || !current) {
      current = candidate
    } else {
      lines.push(current)
      current = word
    }
  }
  if (current) lines.push(current)
  return lines
}

export function drawParagraph(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  style: TextStyle,
  maxWidth: number,
  lineHeight: number,
  maxLines = Number.POSITIVE_INFINITY,
): number {
  const lines = wrapText(ctx, text, style, maxWidth).slice(0, maxLines)
  lines.forEach((line, index) => {
    const isLast = index === lines.length - 1
    const shown = isLast && lines.length === maxLines ? fitText(ctx, line, maxWidth) : line
    drawText(ctx, shown, x, y + index * lineHeight, style)
  })
  return lines.length * lineHeight
}

/* -------------------------------------------------------------------------- */
/*  Pitch                                                                     */
/* -------------------------------------------------------------------------- */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** A portrait half-pitch: our goal at the bottom, the one we attack at the top. */
export function drawPitch(ctx: CanvasRenderingContext2D, rect: Rect, options: { fill?: string; line?: string } = {}): void {
  const fill = options.fill ?? GRASS
  const line = options.line ?? GRASS_LINE
  fillRoundRect(ctx, rect.x, rect.y, rect.width, rect.height, 18, fill, { color: line, width: 4 })

  ctx.strokeStyle = line
  ctx.lineWidth = 4
  const inset = 6

  // Halfway line and centre circle.
  const midY = rect.y + rect.height * 0.5
  ctx.beginPath()
  ctx.moveTo(rect.x + inset, midY)
  ctx.lineTo(rect.x + rect.width - inset, midY)
  ctx.stroke()
  ctx.beginPath()
  ctx.arc(rect.x + rect.width / 2, midY, rect.width * 0.12, 0, Math.PI * 2)
  ctx.stroke()

  // Penalty boxes and goals at both ends.
  const boxWidth = rect.width * 0.58
  const boxHeight = rect.height * 0.15
  const goalWidth = rect.width * 0.26
  const goalHeight = rect.height * 0.045
  for (const end of ["top", "bottom"] as const) {
    const sign = end === "top" ? 1 : -1
    const edge = end === "top" ? rect.y : rect.y + rect.height
    ctx.strokeRect(rect.x + (rect.width - boxWidth) / 2, end === "top" ? edge : edge - boxHeight, boxWidth, boxHeight)
    ctx.strokeRect(rect.x + (rect.width - goalWidth) / 2, end === "top" ? edge : edge - goalHeight, goalWidth, goalHeight)
    // Penalty arc.
    ctx.beginPath()
    ctx.arc(rect.x + rect.width / 2, edge + sign * boxHeight, rect.width * 0.1, end === "top" ? 0 : Math.PI, end === "top" ? Math.PI : Math.PI * 2)
    ctx.stroke()
  }
}

export interface TokenStyle {
  radius: number
  fill: string
  text: string
  ring?: string
}

/** A player token: number in a circle, name underneath. */
export function drawPlayerToken(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  player: Pick<Player, "name" | "number"> | null,
  label: string,
  style: TokenStyle,
  nameWidth: number,
): void {
  ctx.beginPath()
  ctx.arc(x, y, style.radius, 0, Math.PI * 2)
  ctx.fillStyle = style.fill
  ctx.fill()
  if (style.ring) {
    ctx.lineWidth = Math.max(3, style.radius * 0.12)
    ctx.strokeStyle = style.ring
    ctx.stroke()
  }

  const number = player?.number
  const inner = number !== null && number !== undefined ? String(number) : label
  drawText(ctx, inner, x, y + style.radius * 0.36, {
    size: inner.length > 2 ? style.radius * 0.8 : style.radius * 1.05,
    weight: 700,
    family: FONT_MONO,
    color: style.text,
    align: "center",
  })

  const name = player ? shortName(player.name) : "—"
  fillRoundRect(ctx, x - nameWidth / 2, y + style.radius + 8, nameWidth, style.radius * 0.95, 6, "rgba(15, 21, 32, 0.78)")
  drawText(
    ctx,
    name,
    x,
    y + style.radius + 8 + style.radius * 0.68,
    { size: style.radius * 0.62, weight: 600, color: PAPER, align: "center" },
    nameWidth - 12,
  )
}

/** "Ahmet Yılmaz" → "Ahmet Y." — enough to recognise on a token, short enough to fit. */
export function shortName(name: string): string {
  const parts = name.trim().split(/\s+/)
  if (parts.length < 2) return name.trim()
  const first = parts[0] ?? ""
  const last = parts[parts.length - 1] ?? ""
  return `${first} ${last.charAt(0).toLocaleUpperCase("tr-TR")}.`
}

export interface LineupDrawOptions {
  tokenRadius: number
  tokenFill?: string
  tokenText?: string
  keeperFill?: string
  emptyFill?: string
}

/** Every slot of a formation on `rect`, filled from `lineup` or drawn as an empty outline. */
export function drawLineup(
  ctx: CanvasRenderingContext2D,
  rect: Rect,
  formation: Formation,
  lineup: LineupAssignment[],
  players: Player[],
  options: LineupDrawOptions,
): void {
  const byId = new Map(players.map((player) => [player.id, player]))
  const bySlot = new Map(lineup.map((entry) => [entry.slotId, entry.playerId]))
  const nameWidth = Math.min(rect.width * 0.24, options.tokenRadius * 4.2)

  for (const slot of formation.slots) {
    const playerId = bySlot.get(slot.id)
    const player = playerId ? (byId.get(playerId) ?? null) : null
    const x = rect.x + (slot.x / 100) * rect.width
    const y = rect.y + (slot.y / 100) * rect.height
    const isKeeper = slot.role === "GK"
    drawPlayerToken(ctx, x, y, player, slot.label, {
      radius: options.tokenRadius,
      fill: player ? (isKeeper ? (options.keeperFill ?? GOLD) : (options.tokenFill ?? PAPER)) : (options.emptyFill ?? "rgba(246,241,231,0.18)"),
      text: player ? (options.tokenText ?? INK) : PAPER,
      ring: player ? undefined : PAPER_DIM,
    }, nameWidth)
  }
}
