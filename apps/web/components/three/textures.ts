import * as THREE from "three"

import { NIGHT } from "./palette"
import { clamp, mulberry32, rand, TAU } from "./math"

/**
 * Every texture in the scene is drawn here, into a 2D canvas, at load time.
 *
 * Nothing is fetched. That is a deliberate constraint borrowed from the reference: no image
 * request can 404, no CDN can be slow, the whole environment is a few hundred kilobytes of
 * JavaScript, and the palette stays in one place instead of being baked into art nobody can
 * edit. It also means the turf markings are drawn in metres against the same pitch dimensions
 * the geometry uses, so the lines cannot drift out of register with the goals.
 */

function canvas(w: number, h: number): { cv: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const cv = document.createElement("canvas")
  cv.width = w
  cv.height = h
  const ctx = cv.getContext("2d")
  if (!ctx) throw new Error("2D canvas context unavailable")
  return { cv, ctx }
}

function hex(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`
}

function colorMap(cv: HTMLCanvasElement): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(cv)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 8
  return tex
}

/** Alpha/data maps must stay linear — tagging them sRGB double-corrects the cutout edge. */
function dataMap(cv: HTMLCanvasElement): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(cv)
  tex.anisotropy = 8
  return tex
}

/* -------------------------------------------------------------------------- */
/*  Pitch                                                                      */
/* -------------------------------------------------------------------------- */

export interface PitchDims {
  /** Touchline to touchline, metres. */
  width: number
  /** Goal line to goal line, metres. */
  length: number
}

/**
 * OnPitch markings, drawn to scale.
 *
 * These are the Turkish small-sided markings rather than the eleven-a-side ones: no rectangular
 * penalty box, but a six-metre D struck from the centre of each goal line, a three-metre centre
 * circle, and a penalty spot at seven. Getting this wrong is the kind of detail that makes a
 * scene read as "generic football" instead of "the pitch you played on last Tuesday".
 */
export function turfTexture(dims: PitchDims): THREE.CanvasTexture {
  const ppm = 44 // pixels per metre
  const w = Math.round(dims.width * ppm)
  const h = Math.round(dims.length * ppm)
  const { cv, ctx } = canvas(w, h)
  const rng = mulberry32(0x5a4a)

  const m = (metres: number) => metres * ppm

  ctx.fillStyle = hex(NIGHT.turfDark)
  ctx.fillRect(0, 0, w, h)

  // Mowing bands across the short axis. Artificial turf has no nap to speak of, but the pile
  // is laid in rolls and the seams catch the floodlights the same way.
  const bands = 14
  for (let i = 0; i < bands; i++) {
    if (i % 2 === 0) continue
    ctx.fillStyle = "rgba(255,255,255,0.028)"
    ctx.fillRect(0, (i * h) / bands, w, h / bands)
  }

  // Fibre speckle. Without it the plane reads as felt under the bloom pass.
  const speckles = Math.round((w * h) / 900)
  for (let i = 0; i < speckles; i++) {
    const x = rng() * w
    const y = rng() * h
    const v = rng()
    ctx.fillStyle = v > 0.55 ? "rgba(190,225,180,0.07)" : "rgba(0,0,0,0.10)"
    ctx.fillRect(x, y, 1.6, 1.6)
  }

  // Worn patches in front of each goal, where every match is actually decided.
  for (const cy of [m(4.5), h - m(4.5)]) {
    const g = ctx.createRadialGradient(w / 2, cy, 0, w / 2, cy, m(5))
    g.addColorStop(0, "rgba(60,48,30,0.30)")
    g.addColorStop(1, "rgba(60,48,30,0)")
    ctx.fillStyle = g
    ctx.fillRect(0, cy - m(5), w, m(10))
  }

  /* ------------------------------------------------------------- markings */
  ctx.strokeStyle = "rgba(223,231,220,0.80)"
  ctx.lineWidth = m(0.12)
  ctx.lineCap = "butt"

  const inset = m(0.6)
  ctx.strokeRect(inset, inset, w - inset * 2, h - inset * 2)

  ctx.beginPath()
  ctx.moveTo(inset, h / 2)
  ctx.lineTo(w - inset, h / 2)
  ctx.stroke()

  ctx.beginPath()
  ctx.arc(w / 2, h / 2, m(3), 0, TAU)
  ctx.stroke()

  ctx.beginPath()
  ctx.arc(w / 2, h / 2, m(0.18), 0, TAU)
  ctx.fillStyle = "rgba(223,231,220,0.80)"
  ctx.fill()

  // The two D areas and their penalty spots.
  for (const near of [true, false]) {
    const gy = near ? inset : h - inset
    ctx.beginPath()
    ctx.arc(w / 2, gy, m(6), near ? 0 : Math.PI, near ? Math.PI : TAU)
    ctx.stroke()

    const spotY = near ? gy + m(7) : gy - m(7)
    ctx.beginPath()
    ctx.arc(w / 2, spotY, m(0.18), 0, TAU)
    ctx.fill()
  }

  // Corner arcs.
  for (const [cx, cy, a0] of [
    [inset, inset, 0],
    [w - inset, inset, Math.PI / 2],
    [w - inset, h - inset, Math.PI],
    [inset, h - inset, (3 * Math.PI) / 2],
  ] as const) {
    ctx.beginPath()
    ctx.arc(cx, cy, m(0.6), a0, a0 + Math.PI / 2)
    ctx.stroke()
  }

  return colorMap(cv)
}

/* -------------------------------------------------------------------------- */
/*  Cutouts                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Chain-link fence, one tile.
 *
 * Rendered with `alphaTest` rather than `transparent`, so it writes depth and sorts correctly
 * against the players behind it. A transparent fence would have to be depth-sorted per frame
 * against thirty moving figures, and would still be wrong from some angles.
 */
export function chainLinkTexture(): THREE.CanvasTexture {
  const s = 128
  const { cv, ctx } = canvas(s, s)
  ctx.clearRect(0, 0, s, s)
  ctx.lineWidth = 3
  ctx.lineCap = "round"

  for (const [dir, shade] of [
    [1, "rgba(196,206,220,0.95)"],
    [-1, "rgba(140,152,170,0.95)"],
  ] as const) {
    ctx.strokeStyle = shade
    for (let i = -s; i <= s * 2; i += s / 4) {
      ctx.beginPath()
      ctx.moveTo(i, dir > 0 ? 0 : s)
      ctx.lineTo(i + s, dir > 0 ? s : 0)
      ctx.stroke()
    }
  }

  const tex = dataMap(cv)
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  return tex
}

/** Goal netting: a square grid, finer than the fence and much brighter under the lamps. */
export function netTexture(): THREE.CanvasTexture {
  const s = 128
  const { cv, ctx } = canvas(s, s)
  ctx.clearRect(0, 0, s, s)
  ctx.strokeStyle = "rgba(228,236,240,0.92)"
  ctx.lineWidth = 2
  for (let i = 0; i <= s; i += s / 8) {
    ctx.beginPath()
    ctx.moveTo(i, 0)
    ctx.lineTo(i, s)
    ctx.moveTo(0, i)
    ctx.lineTo(s, i)
    ctx.stroke()
  }
  const tex = dataMap(cv)
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  return tex
}

/**
 * A soft radial falloff. Used three ways: additively as a lamp flare, additively as a moth,
 * and multiplied as the contact shadow under a player. One texture, three jobs.
 */
export function glowTexture(hardness = 0.12): THREE.CanvasTexture {
  const s = 128
  const { cv, ctx } = canvas(s, s)
  const g = ctx.createRadialGradient(s / 2, s / 2, s * hardness * 0.5, s / 2, s / 2, s / 2)
  g.addColorStop(0, "rgba(255,255,255,1)")
  g.addColorStop(0.35, "rgba(255,255,255,0.42)")
  g.addColorStop(0.72, "rgba(255,255,255,0.08)")
  g.addColorStop(1, "rgba(255,255,255,0)")
  ctx.fillStyle = g
  ctx.fillRect(0, 0, s, s)
  return dataMap(cv)
}

/**
 * Vertical falloff for the floodlight beams.
 *
 * An additive cone with a flat material has a hard rim where its base meets the air, which is
 * the single most artificial thing in the frame — real light does not stop at a line. This is
 * an alpha map applied down the cone's height: solid at the lamp, gone before the ground.
 *
 * `flipY` is on by default, so the top row of this canvas lands at v = 1, which on a
 * `ConeGeometry` is the apex.
 */
export function beamFadeTexture(): THREE.CanvasTexture {
  const { cv, ctx } = canvas(4, 128)
  const g = ctx.createLinearGradient(0, 0, 0, 128)
  g.addColorStop(0, "rgba(255,255,255,1)")
  g.addColorStop(0.35, "rgba(255,255,255,0.55)")
  g.addColorStop(0.78, "rgba(255,255,255,0.12)")
  g.addColorStop(1, "rgba(255,255,255,0)")
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 4, 128)
  return dataMap(cv)
}

/* -------------------------------------------------------------------------- */
/*  Environment                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The sky dome.
 *
 * A city night sky is not black and it is barely starry — the horizon is the brightest part of
 * it because that is where the sodium haze sits. The gradient runs the other way from a
 * daylight sky, and the handful of stars are only visible in the top third.
 */
export function skyTexture(): THREE.CanvasTexture {
  const w = 512
  const h = 512
  const { cv, ctx } = canvas(w, h)
  const rng = mulberry32(0x51a7)

  const g = ctx.createLinearGradient(0, 0, 0, h)
  g.addColorStop(0, hex(NIGHT.skyHigh))
  g.addColorStop(0.32, "#080d18")
  g.addColorStop(0.46, hex(NIGHT.skyLow))
  g.addColorStop(0.52, "#26334c")
  g.addColorStop(1, "#080b12")
  ctx.fillStyle = g
  ctx.fillRect(0, 0, w, h)

  for (let i = 0; i < 340; i++) {
    const y = rng() * h * 0.44
    const a = (1 - y / (h * 0.44)) * rand(rng, 0.12, 0.62)
    ctx.fillStyle = `rgba(226,236,255,${a.toFixed(3)})`
    const r = rng() > 0.94 ? 1.7 : 1
    ctx.fillRect(rng() * w, y, r, r)
  }

  // Sodium bloom along the horizon, off to one side, where the city centre would be.
  const glow = ctx.createRadialGradient(w * 0.72, h * 0.52, 0, w * 0.72, h * 0.52, h * 0.3)
  glow.addColorStop(0, "rgba(255,178,96,0.20)")
  glow.addColorStop(1, "rgba(255,178,96,0)")
  ctx.fillStyle = glow
  ctx.fillRect(0, 0, w, h)

  const tex = colorMap(cv)
  tex.wrapS = THREE.RepeatWrapping
  return tex
}

/**
 * A wall of apartment windows for the distant blocks.
 *
 * Most are dark. The lit ones are warm and irregular, because a block where every window is on
 * looks like an office, and an amateur match happens in a neighbourhood.
 */
export function windowTexture(seed: number): THREE.CanvasTexture {
  const w = 128
  const h = 256
  const { cv, ctx } = canvas(w, h)
  const rng = mulberry32(seed)

  ctx.fillStyle = hex(NIGHT.block)
  ctx.fillRect(0, 0, w, h)

  const cols = 5
  const rows = 13
  const cw = w / cols
  const ch = h / rows
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const lit = rng()
      if (lit < 0.68) continue
      const warmth = clamp(0.4 + rng() * 0.6, 0, 1)
      ctx.fillStyle =
        lit > 0.94
          ? `rgba(180,215,255,${(warmth * 0.8).toFixed(2)})`
          : `rgba(255,196,120,${warmth.toFixed(2)})`
      ctx.fillRect(c * cw + cw * 0.22, r * ch + ch * 0.24, cw * 0.56, ch * 0.44)
    }
  }

  const tex = colorMap(cv)
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  return tex
}

/** Monochrome noise for the film-grain pass. */
export function grainTexture(): THREE.DataTexture {
  const s = 256
  const data = new Uint8Array(s * s * 4)
  const rng = mulberry32(0x9e37)
  for (let i = 0; i < s * s; i++) {
    const v = Math.round(rng() * 255)
    data[i * 4] = v
    data[i * 4 + 1] = v
    data[i * 4 + 2] = v
    data[i * 4 + 3] = 255
  }
  const tex = new THREE.DataTexture(data, s, s, THREE.RGBAFormat)
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.needsUpdate = true
  return tex
}

/** Scuffed asphalt for the concourse between the pitches. */
export function groundTexture(): THREE.CanvasTexture {
  const s = 512
  const { cv, ctx } = canvas(s, s)
  const rng = mulberry32(0x2b19)

  ctx.fillStyle = hex(NIGHT.ground)
  ctx.fillRect(0, 0, s, s)
  for (let i = 0; i < 9000; i++) {
    const v = rng()
    ctx.fillStyle = v > 0.5 ? "rgba(255,255,255,0.035)" : "rgba(0,0,0,0.35)"
    ctx.fillRect(rng() * s, rng() * s, 2, 2)
  }

  const tex = colorMap(cv)
  tex.wrapS = THREE.RepeatWrapping
  tex.wrapT = THREE.RepeatWrapping
  tex.repeat.set(18, 18)
  return tex
}
