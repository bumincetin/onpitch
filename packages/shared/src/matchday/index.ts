/**
 * packages/shared/src/matchday/index.ts
 *
 * The matchday operating system's shared core: types and schemas, formation geometry, the
 * fair-play rotation engine, the lifecycle state machine and the debrief builder. Pure and
 * platform-neutral — no DOM, no React — so the web app renders it, the tests pin it, and the
 * mobile app can read the same records.
 */

export * from "./types"
export * from "./formations"
export * from "./rotation"
export * from "./lifecycle"
export * from "./debrief"
