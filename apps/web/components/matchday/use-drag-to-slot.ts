"use client"

/**
 * components/matchday/use-drag-to-slot.ts
 *
 * Pointer-event drag from a player token (on the pitch or on the bench) onto a slot.
 *
 * Pointer events, not HTML5 drag-and-drop: the latter does not fire on touch in Safari, and the
 * whole point is a coach with a phone. The target is resolved with `elementFromPoint` on release,
 * so slots only need a `data-slot-id` attribute — no drop listeners, no hit-test maths.
 *
 * The 2-tap path (tap a player, tap a slot) lives in the components; this hook is the optional
 * faster route and must never be the only one, because a screen reader cannot drag.
 */

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react"

export interface DragState {
  playerId: string
  x: number
  y: number
  /** Where the pointer started; movement below the threshold is a tap, not a drag. */
  originX: number
  originY: number
  active: boolean
}

const DRAG_THRESHOLD_PX = 8

export interface UseDragToSlotResult {
  drag: DragState | null
  /** Slot currently under the pointer, for highlighting. */
  hoverSlotId: string | null
  startDrag: (event: ReactPointerEvent<HTMLElement>, playerId: string) => void
  /** True for a moment after a drop — the browser's follow-up `click` should be ignored. */
  justDropped: () => boolean
}

const CLICK_SUPPRESS_MS = 300

export function useDragToSlot(onDrop: (playerId: string, slotId: string) => void): UseDragToSlotResult {
  const [drag, setDrag] = useState<DragState | null>(null)
  const [hoverSlotId, setHoverSlotId] = useState<string | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const droppedAtRef = useRef(0)
  const justDropped = useCallback(() => Date.now() - droppedAtRef.current < CLICK_SUPPRESS_MS, [])

  const slotAt = useCallback((x: number, y: number): string | null => {
    const element = document.elementFromPoint(x, y)
    const slot = element?.closest<HTMLElement>("[data-slot-id]")
    return slot?.dataset.slotId ?? null
  }, [])

  const startDrag = useCallback((event: ReactPointerEvent<HTMLElement>, playerId: string) => {
    if (event.button !== 0 && event.pointerType === "mouse") return
    const next: DragState = {
      playerId,
      x: event.clientX,
      y: event.clientY,
      originX: event.clientX,
      originY: event.clientY,
      active: false,
    }
    dragRef.current = next
    setDrag(next)
  }, [])

  useEffect(() => {
    if (!drag) return

    function onMove(event: PointerEvent) {
      const current = dragRef.current
      if (!current) return
      const moved = Math.hypot(event.clientX - current.originX, event.clientY - current.originY)
      const active = current.active || moved > DRAG_THRESHOLD_PX
      const next = { ...current, x: event.clientX, y: event.clientY, active }
      dragRef.current = next
      setDrag(next)
      if (active) {
        event.preventDefault()
        setHoverSlotId(slotAt(event.clientX, event.clientY))
      }
    }

    function onUp(event: PointerEvent) {
      const current = dragRef.current
      dragRef.current = null
      setDrag(null)
      setHoverSlotId(null)
      if (!current?.active) return
      droppedAtRef.current = Date.now()
      const slotId = slotAt(event.clientX, event.clientY)
      if (slotId) onDrop(current.playerId, slotId)
    }

    function onCancel() {
      dragRef.current = null
      setDrag(null)
      setHoverSlotId(null)
    }

    window.addEventListener("pointermove", onMove, { passive: false })
    window.addEventListener("pointerup", onUp)
    window.addEventListener("pointercancel", onCancel)
    return () => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      window.removeEventListener("pointercancel", onCancel)
    }
    // Only the identity of `drag` starting/stopping matters; re-binding on every move is wasteful.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag !== null, onDrop, slotAt])

  return { drag, hoverSlotId, startDrag, justDropped }
}
