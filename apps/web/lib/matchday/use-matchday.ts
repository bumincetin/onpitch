"use client"

/**
 * lib/matchday/use-matchday.ts
 *
 * The one hook a matchday screen needs: the record for a match, a way to change it, and whether
 * the change actually reached storage.
 *
 * Hydration is a two-step on purpose. The server has no storage, so the first render (and the
 * first client render, which must match it) shows `hydrated: false`; the effect then reads the
 * record and flips it. Components render skeletons until then instead of flashing an empty plan
 * over a real one. An `update` that arrives before hydration is applied on top of what storage
 * holds, never on the empty placeholder, so an early write cannot clobber a saved plan.
 *
 * Cross-tab: the `storage` event re-reads the record when another tab writes it, so the live
 * screen and the planner can be open side by side without one clobbering the other on the next
 * save.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import {
  deriveMatchdayPhase,
  emptyMatchdayRecord,
  maxPhase,
  type MatchdayPhase,
  type MatchdayRecord,
} from "@onpitch/shared/matchday"
import type { Enums } from "@onpitch/shared/database"

import { MatchdayStorageError, getMatchdayRepository, recordStorageKey } from "./store"

export interface UseMatchdayOptions {
  matchId: string
  /** The fixture's database status, so the derived phase can never lag the server. */
  matchStatus?: Enums<"match_status"> | null
}

export interface UseMatchdayResult {
  record: MatchdayRecord
  /** The merged phase — local record plus database status. */
  phase: MatchdayPhase
  hydrated: boolean
  /** False after a write that did not reach storage (quota, private mode). */
  persisted: boolean
  update: (updater: (record: MatchdayRecord) => MatchdayRecord) => void
  /** Advance the phase. Never rolls back; illegal transitions are ignored, not thrown. */
  advance: (phase: MatchdayPhase) => void
  reset: () => void
}

export function useMatchday({ matchId, matchStatus = null }: UseMatchdayOptions): UseMatchdayResult {
  const repository = useMemo(() => getMatchdayRepository(), [])
  const [record, setRecord] = useState<MatchdayRecord>(() => emptyMatchdayRecord(matchId))
  const [hydrated, setHydrated] = useState(false)
  const [persisted, setPersisted] = useState(true)

  // The latest record, readable synchronously: two updates in one tick compose instead of the
  // second overwriting the first, and an update before hydration can consult storage.
  const recordRef = useRef(record)
  const hydratedRef = useRef(false)

  useEffect(() => {
    const loaded = repository.read(matchId) ?? emptyMatchdayRecord(matchId)
    recordRef.current = loaded
    hydratedRef.current = true
    setRecord(loaded)
    setHydrated(true)

    function onStorage(event: StorageEvent) {
      if (event.key !== recordStorageKey(matchId)) return
      const next = repository.read(matchId) ?? emptyMatchdayRecord(matchId)
      recordRef.current = next
      setRecord(next)
    }
    window.addEventListener("storage", onStorage)
    return () => window.removeEventListener("storage", onStorage)
  }, [matchId, repository])

  const persist = useCallback(
    (next: MatchdayRecord) => {
      try {
        repository.write(next)
        setPersisted(true)
      } catch (error) {
        if (error instanceof MatchdayStorageError) setPersisted(false)
        else throw error
      }
    },
    [repository],
  )

  const update = useCallback(
    (updater: (record: MatchdayRecord) => MatchdayRecord) => {
      const base = hydratedRef.current
        ? recordRef.current
        : (repository.read(matchId) ?? recordRef.current)
      const next = { ...updater(base), updatedAt: new Date().toISOString() }
      recordRef.current = next
      persist(next)
      setRecord(next)
    },
    [matchId, persist, repository],
  )

  const advance = useCallback(
    (phase: MatchdayPhase) => {
      update((previous) => ({ ...previous, phase: maxPhase(previous.phase, phase) }))
    },
    [update],
  )

  const reset = useCallback(() => {
    repository.remove(matchId)
    const empty = emptyMatchdayRecord(matchId)
    recordRef.current = empty
    setRecord(empty)
  }, [matchId, repository])

  const phase = useMemo(() => deriveMatchdayPhase({ matchStatus, record }), [matchStatus, record])

  return { record, phase, hydrated, persisted, update, advance, reset }
}
