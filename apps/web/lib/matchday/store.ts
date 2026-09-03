/**
 * lib/matchday/store.ts
 *
 * Where a matchday record lives between page loads.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY THIS IS LOCAL, AND WHAT THAT MEANS
 * ---------------------------------------------------------------------------------------------
 *
 * The phone-free workflow is the whole point: a coach plans on the sofa, exports the sheet to a
 * lock screen, leaves the phone in the bag, and reconstructs the match afterwards — possibly with
 * no signal at the pitch. So the record is written to `localStorage` synchronously on every
 * change, validated with the shared zod schema on the way back in, and keyed per match. It
 * survives refreshes, tab closes and reboots on the device it was written on.
 *
 * It does NOT follow the coach across devices. `MatchdayRepository` is the seam for that: a
 * Supabase-backed implementation with the same four methods can replace `localStorageRepository`
 * without touching a component. Nothing in this module writes to `matches` — the confirmed result
 * still enters the system through `score_reports` only.
 */

import {
  emptyMatchdayRecord,
  matchdayRecordSchema,
  playerSchema,
  type MatchdayRecord,
  type Player,
} from "@onpitch/shared/matchday"
import { z } from "zod"

/* -------------------------------------------------------------------------- */
/*  Repository                                                                */
/* -------------------------------------------------------------------------- */

export interface MatchdayRepository {
  read(matchId: string): MatchdayRecord | null
  write(record: MatchdayRecord): void
  remove(matchId: string): void
  /** Per-team squad memory: numbers, preferred positions, last availability. */
  readSquad(teamKey: string): Player[] | null
  writeSquad(teamKey: string, squad: Player[]): void
}

const RECORD_PREFIX = "onpitch:matchday:v1:"
const SQUAD_PREFIX = "onpitch:matchday:squad:v1:"

export function recordStorageKey(matchId: string): string {
  return `${RECORD_PREFIX}${matchId}`
}

export function squadStorageKey(teamKey: string): string {
  return `${SQUAD_PREFIX}${teamKey}`
}

const squadListSchema = z.array(playerSchema).max(40)

/**
 * A repository over any `Storage`-shaped object. The browser one is `window.localStorage`; tests
 * pass a `Map`-backed stub. Every read is parsed — a record that fails the schema is treated as
 * absent rather than crashing the page, because a corrupted plan is recoverable and a white
 * screen on matchday is not.
 */
export function createStorageRepository(storage: Pick<Storage, "getItem" | "setItem" | "removeItem">): MatchdayRepository {
  function readJson<T>(key: string, schema: z.ZodType<T>): T | null {
    let raw: string | null
    try {
      raw = storage.getItem(key)
    } catch {
      return null
    }
    if (!raw) return null
    try {
      const parsed = schema.safeParse(JSON.parse(raw))
      return parsed.success ? parsed.data : null
    } catch {
      return null
    }
  }

  function writeJson(key: string, value: unknown): void {
    try {
      storage.setItem(key, JSON.stringify(value))
    } catch {
      // Quota exceeded or private mode with storage disabled. The in-memory state is still
      // correct for this session; the hook surfaces `persisted: false` so the UI can say so.
      throw new MatchdayStorageError(key)
    }
  }

  return {
    read: (matchId) => readJson(recordStorageKey(matchId), matchdayRecordSchema),
    write: (record) => writeJson(recordStorageKey(record.matchId), record),
    remove: (matchId) => {
      try {
        storage.removeItem(recordStorageKey(matchId))
      } catch {
        /* nothing to do */
      }
    },
    readSquad: (teamKey) => readJson(squadStorageKey(teamKey), squadListSchema),
    writeSquad: (teamKey, squad) => writeJson(squadStorageKey(teamKey), squad),
  }
}

export class MatchdayStorageError extends Error {
  constructor(public readonly key: string) {
    super(`Could not persist ${key}`)
    this.name = "MatchdayStorageError"
  }
}

/** A repository that keeps everything in memory — SSR, tests, and browsers with storage off. */
export function createMemoryRepository(): MatchdayRepository {
  const map = new Map<string, string>()
  return createStorageRepository({
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  })
}

let browserRepository: MatchdayRepository | null = null

/** The repository for this runtime: localStorage in a browser, memory anywhere else. */
export function getMatchdayRepository(): MatchdayRepository {
  if (browserRepository) return browserRepository
  if (typeof window === "undefined") return createMemoryRepository()
  try {
    // Accessing `localStorage` itself can throw (Safari with cookies blocked).
    const storage = window.localStorage
    browserRepository = createStorageRepository(storage)
  } catch {
    browserRepository = createMemoryRepository()
  }
  return browserRepository
}

/* -------------------------------------------------------------------------- */
/*  Record helpers                                                            */
/* -------------------------------------------------------------------------- */

export function loadOrCreateRecord(repository: MatchdayRepository, matchId: string): MatchdayRecord {
  return repository.read(matchId) ?? emptyMatchdayRecord(matchId)
}

/** Every record key in a storage, for the "your matchdays" list and for cleanup. */
export function listRecordMatchIds(storage: Pick<Storage, "length" | "key">): string[] {
  const ids: string[] = []
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    if (key?.startsWith(RECORD_PREFIX)) ids.push(key.slice(RECORD_PREFIX.length))
  }
  return ids
}
