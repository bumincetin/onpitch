/**
 * packages/shared/src/matchday/formations.ts
 *
 * Formation presets and the geometry that places them on a pitch.
 *
 * Coordinates are percentages of a portrait pitch: `x` across the width (0 = left touchline),
 * `y` along the length with 0 at the goal we attack and 100 at our own goal line. The pitch
 * board, the cheat sheet and the story graphic all read the same numbers, so a formation looks
 * identical on screen, on a lock screen and on Instagram.
 */

import {
  PITCH_FORMATS,
  PITCH_FORMAT_PLAYERS,
  POSITION_SHORT,
  type Formation,
  type FormationSlot,
  type PitchFormat,
  type Position,
} from "./types"

/* -------------------------------------------------------------------------- */
/*  Geometry                                                                  */
/* -------------------------------------------------------------------------- */

/** Where the goalkeeper stands. */
const GOALKEEPER_Y = 91
/** The deepest outfield line (defence) and the highest (attack). */
const DEEPEST_LINE_Y = 74
const HIGHEST_LINE_Y = 22

/** Role of the n-th outfield line in a formation with `lineCount` lines. */
function roleForLine(lineIndex: number, lineCount: number): Position {
  if (lineIndex === 0) return "DEF"
  if (lineIndex === lineCount - 1) return "FWD"
  return "MID"
}

/**
 * Spread `count` players across the width of the pitch. `(i + 1) / (count + 1)` gives 50 for a
 * lone striker, 33/67 for a pair, 25/50/75 for a trio — wide enough to read, never on the line.
 */
function spreadAcross(count: number): number[] {
  return Array.from({ length: count }, (_, index) => Math.round(((index + 1) / (count + 1)) * 100))
}

/**
 * Build a formation from its shape. `[2, 3, 1]` on a 7v7 pitch is one goalkeeper plus six
 * outfield players in three lines; the shape must sum to `players − 1` for its format.
 */
export function buildFormation(format: PitchFormat, shape: number[]): Formation {
  const outfield = PITCH_FORMAT_PLAYERS[format] - 1
  const total = shape.reduce((sum, line) => sum + line, 0)
  if (total !== outfield) {
    throw new RangeError(`Formation ${shape.join("-")} has ${total} outfield players; ${format} needs ${outfield}.`)
  }
  if (shape.some((line) => line < 1 || !Number.isInteger(line))) {
    throw new RangeError(`Formation ${shape.join("-")} has an empty line.`)
  }

  const slots: FormationSlot[] = [{ id: "gk", role: "GK", label: "KL", x: 50, y: GOALKEEPER_Y }]

  const lineCount = shape.length
  const lineGap = lineCount > 1 ? (DEEPEST_LINE_Y - HIGHEST_LINE_Y) / (lineCount - 1) : 0
  const counters: Record<Position, number> = { GK: 1, DEF: 0, MID: 0, FWD: 0 }

  shape.forEach((count, lineIndex) => {
    const role = roleForLine(lineIndex, lineCount)
    const y = lineCount > 1 ? Math.round(DEEPEST_LINE_Y - lineGap * lineIndex) : Math.round((DEEPEST_LINE_Y + HIGHEST_LINE_Y) / 2)
    spreadAcross(count).forEach((x, positionIndex) => {
      counters[role] += 1
      slots.push({
        id: `l${lineIndex + 1}p${positionIndex + 1}`,
        role,
        label: `${POSITION_SHORT[role]} ${counters[role]}`,
        x,
        y,
      })
    })
  })

  const shapeName = shape.join("-")
  return {
    id: `${format}:${shapeName}`,
    name: `${format} ${shapeName}`,
    format,
    shape: [...shape],
    slots,
  }
}

/* -------------------------------------------------------------------------- */
/*  Presets                                                                   */
/* -------------------------------------------------------------------------- */

const PRESET_SHAPES: Record<PitchFormat, number[][]> = {
  "5v5": [
    [1, 2, 1],
    [2, 2],
    [2, 1, 1],
  ],
  "6v6": [
    [2, 2, 1],
    [2, 1, 2],
    [1, 3, 1],
  ],
  "7v7": [
    [2, 3, 1],
    [3, 2, 1],
    [2, 2, 2],
    [3, 1, 2],
  ],
  "8v8": [
    [3, 3, 1],
    [2, 3, 2],
    [3, 2, 2],
  ],
  "9v9": [
    [3, 3, 2],
    [3, 2, 3],
    [2, 4, 2],
    [3, 4, 1],
  ],
  "11v11": [
    [4, 3, 3],
    [4, 4, 2],
    [3, 5, 2],
    [4, 2, 3, 1],
    [3, 4, 3],
  ],
}

/** Every preset, in display order. The first entry per format is that format's default. */
export const FORMATIONS: readonly Formation[] = PITCH_FORMATS.flatMap((format) =>
  PRESET_SHAPES[format].map((shape) => buildFormation(format, shape)),
)

const FORMATION_BY_ID = new Map(FORMATIONS.map((formation) => [formation.id, formation]))

export function formationsFor(format: PitchFormat): Formation[] {
  return FORMATIONS.filter((formation) => formation.format === format)
}

export function defaultFormationFor(format: PitchFormat): Formation {
  const first = formationsFor(format)[0]
  if (!first) throw new Error(`No formation preset for ${format}`)
  return first
}

/**
 * Resolve a formation id. A custom id of the form `7v7:3-2-1` that is not a preset is built on
 * the fly, so a plan never loses its shape if the preset list changes; anything unparseable
 * returns `null` and the caller falls back to the format's default.
 */
export function resolveFormation(id: string): Formation | null {
  const preset = FORMATION_BY_ID.get(id)
  if (preset) return preset

  const [format, shapeText] = id.split(":")
  if (!format || !shapeText || !(PITCH_FORMATS as readonly string[]).includes(format)) return null
  const shape = shapeText.split("-").map((part) => Number.parseInt(part, 10))
  if (shape.some((line) => Number.isNaN(line))) return null
  try {
    return buildFormation(format as PitchFormat, shape)
  } catch {
    return null
  }
}

/** The goalkeeper slot, if the formation has one (every preset does). */
export function goalkeeperSlot(formation: Formation): FormationSlot | null {
  return formation.slots.find((slot) => slot.role === "GK") ?? null
}
