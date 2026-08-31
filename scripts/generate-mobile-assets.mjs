/**
 * scripts/generate-mobile-assets.mjs
 *
 *   node scripts/generate-mobile-assets.mjs
 *
 * Draws the launcher icon, the Android adaptive foreground, the splash mark and the web favicon
 * for `apps/mobile`, and writes them as PNGs.
 *
 * ---------------------------------------------------------------------------
 * WHY GENERATE THEM
 * ---------------------------------------------------------------------------
 * The Expo project had no `assets/` directory at all. That is not cosmetic: an iOS build with no
 * `AppIcon` is rejected by App Store Connect at upload, and an Android build ships the green
 * default robot. So the assets had to exist before a store build could be attempted.
 *
 * Generating rather than committing binaries keeps the mark tied to the palette it comes from —
 * `apps/web/components/three/palette.ts` — instead of being a PNG whose provenance is a mystery
 * in six months. Re-run this after changing `NIGHT` and the icons follow.
 *
 * The PNG is written by hand (zlib is in Node's standard library, an image encoder is not) so
 * this script adds no dependency to the repo for something it runs a handful of times.
 *
 * The mark is a floodlit centre circle: it survives being masked into a circle by Android, being
 * rounded by iOS, and being scaled to 16px in a browser tab, which a ball or a whole pitch does
 * not.
 */

import { deflateSync } from "node:zlib"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const ASSETS = resolve(HERE, "..", "apps", "mobile", "assets")

/* ========================================================================== */
/*  Palette — mirrors NIGHT in apps/web/components/three/palette.ts           */
/* ========================================================================== */

const TURF_LIGHT = [0x1d, 0x6a, 0x46]
const TURF_DARK = [0x0f, 0x3d, 0x28]
const LAMP = [0xff, 0xe6, 0xb8]
const SKY = [0x0b, 0x15, 0x12]

/* ========================================================================== */
/*  A very small RGBA canvas                                                  */
/* ========================================================================== */

class Canvas {
  constructor(size) {
    this.size = size
    // RGBA, row-major, premultiplied by nothing — we composite manually.
    this.data = new Uint8Array(size * size * 4)
  }

  /** Source-over composite of one pixel. `alpha` in [0, 1]. */
  blend(x, y, [r, g, b], alpha) {
    if (alpha <= 0 || x < 0 || y < 0 || x >= this.size || y >= this.size) return
    const i = (y * this.size + x) * 4
    const dstA = this.data[i + 3] / 255
    const outA = alpha + dstA * (1 - alpha)
    if (outA <= 0) return
    for (let c = 0; c < 3; c += 1) {
      const src = [r, g, b][c]
      const dst = this.data[i + c]
      this.data[i + c] = Math.round((src * alpha + dst * dstA * (1 - alpha)) / outA)
    }
    this.data[i + 3] = Math.round(outA * 255)
  }

  /** Vertical linear gradient across the whole canvas, fully opaque. */
  fillGradient(top, bottom) {
    for (let y = 0; y < this.size; y += 1) {
      const t = y / (this.size - 1)
      const colour = top.map((c, i) => Math.round(c + (bottom[i] - c) * t))
      for (let x = 0; x < this.size; x += 1) this.blend(x, y, colour, 1)
    }
  }

  /**
   * Radial glow centred at (cx, cy). `falloff` is the exponent — 2 gives the soft shoulder a
   * floodlight pool has, 1 an obviously linear ramp.
   */
  glow(cx, cy, radius, colour, peakAlpha, falloff = 2) {
    const r0 = Math.max(0, Math.floor(cy - radius))
    const r1 = Math.min(this.size - 1, Math.ceil(cy + radius))
    for (let y = r0; y <= r1; y += 1) {
      for (let x = Math.max(0, Math.floor(cx - radius)); x <= Math.min(this.size - 1, Math.ceil(cx + radius)); x += 1) {
        const d = Math.hypot(x - cx, y - cy) / radius
        if (d >= 1) continue
        this.blend(x, y, colour, peakAlpha * Math.pow(1 - d, falloff))
      }
    }
  }

  /**
   * Antialiased ring. Coverage is estimated by supersampling 4x4 inside each pixel, which is
   * cheap at these sizes and avoids the stair-stepping a plain distance test gives on a curve.
   */
  ring(cx, cy, radius, width, colour, alpha = 1) {
    const inner = radius - width / 2
    const outer = radius + width / 2
    const lo = Math.max(0, Math.floor(cy - outer - 1))
    const hi = Math.min(this.size - 1, Math.ceil(cy + outer + 1))
    for (let y = lo; y <= hi; y += 1) {
      for (let x = Math.max(0, Math.floor(cx - outer - 1)); x <= Math.min(this.size - 1, Math.ceil(cx + outer + 1)); x += 1) {
        let hits = 0
        for (let sy = 0; sy < 4; sy += 1) {
          for (let sx = 0; sx < 4; sx += 1) {
            const d = Math.hypot(x + (sx + 0.5) / 4 - cx, y + (sy + 0.5) / 4 - cy)
            if (d >= inner && d <= outer) hits += 1
          }
        }
        if (hits > 0) this.blend(x, y, colour, alpha * (hits / 16))
      }
    }
  }

  /** Horizontal bar, used for the halfway line. */
  bar(y0, height, colour, alpha) {
    for (let y = Math.round(y0); y < Math.round(y0 + height); y += 1) {
      for (let x = 0; x < this.size; x += 1) this.blend(x, y, colour, alpha)
    }
  }

  /**
   * Rounded-rectangle mask applied to the alpha channel. iOS masks the icon itself, but a
   * pre-rounded source avoids a hairline of the old corner showing through on some launchers.
   */
  roundCorners(radius) {
    const s = this.size
    for (let y = 0; y < s; y += 1) {
      for (let x = 0; x < s; x += 1) {
        const dx = Math.max(radius - x, x - (s - 1 - radius), 0)
        const dy = Math.max(radius - y, y - (s - 1 - radius), 0)
        if (dx === 0 || dy === 0) continue
        const d = Math.hypot(dx, dy)
        if (d <= radius) continue
        const i = (y * s + x) * 4
        // One pixel of feather so the corner is not jagged.
        const coverage = Math.max(0, 1 - (d - radius))
        this.data[i + 3] = Math.round(this.data[i + 3] * coverage)
      }
    }
  }
}

/* ========================================================================== */
/*  PNG encoder — 8-bit RGBA, one IDAT                                        */
/* ========================================================================== */

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, payload) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(payload.length)
  const typed = Buffer.concat([Buffer.from(type, "ascii"), payload])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typed))
  return Buffer.concat([length, typed, crc])
}

function encodePng(canvas) {
  const { size, data } = canvas

  // Filter type 0 (None) on every scanline. The images are flat enough that a smarter filter
  // buys a few percent and costs a lot of code.
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0
    Buffer.from(data.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  ihdr[10] = 0 // deflate
  ihdr[11] = 0 // adaptive filtering
  ihdr[12] = 0 // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

/* ========================================================================== */
/*  The four marks                                                            */
/* ========================================================================== */

/** The full icon: turf, one floodlight pool, halfway line, centre circle. */
function drawIcon(size, { rounded = false, padding = 0 } = {}) {
  const c = new Canvas(size)
  c.fillGradient(TURF_LIGHT, TURF_DARK)
  c.glow(size * 0.18, size * 0.1, size * 0.75, LAMP, 0.3)
  c.glow(size * 0.9, size * 0.06, size * 0.55, LAMP, 0.16)

  const inset = size * padding
  const span = size - inset * 2
  c.bar(size / 2 - span * 0.008, span * 0.016, LAMP, 0.5)
  c.ring(size / 2, size / 2, span * 0.26, span * 0.035, LAMP, 0.95)
  // The penalty spot, which is what keeps the mark from reading as a plain target.
  c.ring(size / 2, size / 2, span * 0.035, span * 0.07, LAMP, 0.95)

  if (rounded) c.roundCorners(size * 0.22)
  return c
}

/**
 * Android's adaptive foreground. The launcher masks to a shape inscribed in the middle 66%, so
 * everything meaningful has to sit inside that circle — an icon drawn edge to edge loses its
 * outer third on most devices.
 */
function drawAdaptiveForeground(size) {
  const c = new Canvas(size)
  const span = size * 0.62
  c.glow(size / 2, size / 2, span * 0.75, LAMP, 0.22)
  c.bar(size / 2 - span * 0.01, span * 0.02, LAMP, 0.55)
  c.ring(size / 2, size / 2, span * 0.3, span * 0.045, LAMP, 1)
  c.ring(size / 2, size / 2, span * 0.04, span * 0.08, LAMP, 1)
  return c
}

/** Splash mark: the circle alone on transparency, over the `backgroundColor` in app.json. */
function drawSplash(size) {
  const c = new Canvas(size)
  c.glow(size / 2, size / 2, size * 0.48, LAMP, 0.18)
  c.ring(size / 2, size / 2, size * 0.26, size * 0.028, LAMP, 1)
  c.ring(size / 2, size / 2, size * 0.035, size * 0.07, LAMP, 1)
  return c
}

/* ========================================================================== */
/*  Write                                                                     */
/* ========================================================================== */

mkdirSync(ASSETS, { recursive: true })

const outputs = [
  ["icon.png", drawIcon(1024, { rounded: false })],
  ["adaptive-icon.png", drawAdaptiveForeground(1024)],
  ["splash-icon.png", drawSplash(512)],
  ["favicon.png", drawIcon(48, { rounded: true })],
  // Expo Web's PWA manifest wants a large maskable source too.
  ["icon-192.png", drawIcon(192, { rounded: true })],
]

for (const [name, canvas] of outputs) {
  const png = encodePng(canvas)
  writeFileSync(join(ASSETS, name), png)
  console.log(`${name.padEnd(20)} ${canvas.size}x${canvas.size}  ${(png.length / 1024).toFixed(1)} kB`)
}

console.log(`\nWrote ${outputs.length} files to ${ASSETS}`)
