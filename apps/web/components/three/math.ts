/**
 * Small numeric helpers for the night-pitch scene.
 *
 * Kept apart from the Three.js modules so they are trivially unit-testable and so nothing here
 * touches the DOM — this file is safe to import on the server even though nothing else in
 * `components/three` is.
 */

export const TAU = Math.PI * 2

export function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** Hermite ease between two edges, matching GLSL `smoothstep`. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0 || 1e-6), 0, 1)
  return t * t * (3 - 2 * t)
}

/**
 * Frame-rate independent exponential approach.
 *
 * `lerp(current, target, 0.1)` per frame is the usual shortcut, but it converges twice as fast
 * at 120 Hz as at 60 Hz — the camera literally moves at a different speed on a different
 * monitor. Solving the decay over elapsed time removes that dependency.
 */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return lerp(current, target, 1 - Math.exp(-lambda * dt))
}

/**
 * Deterministic PRNG (mulberry32). The scene seeds every random decision from this: window
 * lighting, mast jitter, player formations, moth drift. Two visitors on the same viewport see
 * the same complex, and a bad-looking layout can be reproduced by its seed rather than reloaded
 * until it goes away.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Uniform sample in `[lo, hi)` from a mulberry32 stream. */
export function rand(rng: () => number, lo: number, hi: number): number {
  return lo + rng() * (hi - lo)
}
