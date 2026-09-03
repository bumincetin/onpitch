"use client"

/**
 * components/venue/booking-calendar.tsx
 *
 * The venue owner's live availability grid: seven local days across, one row per bookable slot
 * down, for one pitch at a time.
 *
 * ===========================================================================
 * 1. WHY THE GRID IS BUILT FROM WALL CLOCK, NOT FROM `weekStart + n * 86400000`
 * ===========================================================================
 * Opening hours are wall-clock times in `venues.timezone`; bookings are absolute instants. Adding
 * 24h per column is wrong twice a year — the day a DST zone shifts, the 08:00 row would silently
 * become 07:00 and every cell would be offset against the bookings drawn on top of it. So every
 * cell boundary is resolved through `zonedWallClockToUtc` from `lib/venue/metrics.ts` — the SAME
 * function the occupancy numbers use, which is what stops the calendar and the dashboard from
 * disagreeing about what "Tuesday" means.
 *
 * ===========================================================================
 * 2. REALTIME — RLS IS THE AUTHORISATION, THE FILTER IS ONLY A VOLUME CONTROL
 * ===========================================================================
 * The stream is `supabase.channel(venueTopic(venueId)).on('postgres_changes', { table:
 * 'bookings', filter: 'pitch_id=in.(…)' })`. Two separate mechanisms are at work and conflating
 * them is a security bug waiting to happen:
 *
 *   • The `filter` is a PERFORMANCE control. It tells Realtime not to bother sending rows for
 *     pitches this grid is not showing. It is not a permission, and it is trivially removable by
 *     anyone with a browser console.
 *   • The `bookings_select_stakeholders` RLS SELECT policy is the AUTHORISATION. Supabase
 *     Realtime re-evaluates that policy per subscriber per change, so a socket only ever receives
 *     rows the same user could have SELECTed over HTTP. Removing the filter client-side widens
 *     what is ASKED FOR, never what is ALLOWED.
 *
 * That policy is evaluated against the JWT the socket carries, which is why `realtime.setAuth()`
 * is called with the current access token before subscribing: an anonymous socket sees nothing.
 *
 * Realtime filters travel in the channel join payload and are not unbounded, so beyond a handful
 * of pitches the filter is dropped and the same predicate is applied client-side. Correctness is
 * identical either way — RLS is doing the real work — only the volume changes.
 *
 * `pitch_availability_blocks` is deliberately NOT in the `supabase_realtime` publication
 * (0006_realtime.sql publishes four tables and no more, because every published table costs WAL
 * decoding whether or not anyone is listening). Blackout windows are therefore reflected
 * optimistically here and confirmed by the POST response, not streamed.
 *
 * ===========================================================================
 * 3. RECONNECTION
 * ===========================================================================
 * A dropped socket that never comes back is worse than no socket at all: the grid keeps rendering
 * confidently stale data. So `CHANNEL_ERROR` / `TIMED_OUT` / `CLOSED` schedule a reconnect with
 * exponential backoff plus full jitter (the jitter matters — without it every open dashboard
 * retries on the same tick and turns a blip into a thundering herd), the connection state is
 * shown to the owner, and every successful RE-subscribe refetches the window, because changes
 * that happened while the socket was down were never delivered.
 *
 * ===========================================================================
 * 4. BLACKOUTS AND THE EXCLUSION CONSTRAINT
 * ===========================================================================
 * Drag across free cells — or click one and shift-click/shift-arrow to another — to black out
 * time. There is no "is it free?" query before the write, on purpose: `pitch_blocks_no_overlap`
 * is an EXCLUDE constraint evaluated inside the insert's own transaction, so it is the only check
 * that cannot be raced. A losing insert returns SQLSTATE 23P01, the route maps it to
 * `BLOCK_OVERLAP`, and this component rolls its optimistic row back and raises a toast.
 *
 * ===========================================================================
 * 5. COMPOSITION
 * ===========================================================================
 * The ARIA grid roles and the roving tabindex come from `@/components/ui/calendar-grid`; this
 * file supplies geometry, state and behaviour. Drag selection rides on pointer events attached to
 * the cell body that `renderCell` returns — the primitive marks unavailable cells `aria-disabled`
 * rather than `disabled`, so they stay focusable AND keep firing pointer events, which is exactly
 * what a drag passing over a booked slot needs.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { RealtimeChannel, RealtimePostgresChangesPayload } from "@supabase/supabase-js"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CalendarGrid, type CalendarCell, type CalendarDay, type CalendarSlot } from "@/components/ui/calendar-grid"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { venueTopic } from "@onpitch/shared/channels"
import { createClient } from "@/lib/supabase/client"
import { toast } from "@/lib/use-toast"
import { cn } from "@/lib/utils"
import {
  OCCUPYING_BOOKING_STATUSES,
  addDaysToDateKey,
  parseDateKey,
  parseRange,
  timeToMinutes,
  zonedDateKey,
  zonedWallClockToUtc,
} from "@/lib/venue/metrics"
import type { Enums } from "@onpitch/shared/database"
import { formatMinor, isApiOk, type ApiResponse } from "@onpitch/shared/domain"

/* ========================================================================== */
/*  Public shapes                                                             */
/* ========================================================================== */

export interface CalendarPitch {
  id: string
  name: string
  /** `HH:MM:SS` wall clock in the venue timezone. */
  openingTime: string
  closingTime: string
  slotMinutes: number
  hourlyRateMinor: number
  currency: string
  isActive: boolean
}

/** Shaped like the `bookings` row so a Realtime payload can be dropped straight in. */
export interface CalendarBooking {
  id: string
  pitch_id: string
  time_range: string
  status: Enums<"booking_status">
  payment_status: Enums<"payment_status">
  total_minor: number
  currency: string
}

export interface CalendarBlock {
  id: string
  pitch_id: string
  block_range: string
  reason: string | null
}

export interface BookingCalendarProps {
  venueId: string
  /** IANA zone from `venues.timezone`. */
  timezone: string
  pitches: readonly CalendarPitch[]
  /** `YYYY-MM-DD` local date of the first column. The server picks the current week's Monday. */
  initialWeekStart: string
  initialPitchId: string
  initialBookings: readonly CalendarBooking[]
  initialBlocks: readonly CalendarBlock[]
  /** False for an admin viewing someone else's venue read-only. */
  canEdit?: boolean
  className?: string
}

type SlotState = "open" | "booked" | "blocked" | "past" | "closed"

interface SlotInfo {
  start: number
  end: number
  state: SlotState
  booking: CalendarBooking | null
  block: CalendarBlock | null
}

type ConnectionState = "connecting" | "live" | "reconnecting" | "offline"

const DAY_COUNT = 7
const MAX_FILTER_PITCHES = 12
const MAX_BACKOFF_MS = 30_000

/* ========================================================================== */
/*  Component                                                                 */
/* ========================================================================== */

export function BookingCalendar({
  venueId,
  timezone,
  pitches,
  initialWeekStart,
  initialPitchId,
  initialBookings,
  initialBlocks,
  canEdit = true,
  className,
}: BookingCalendarProps) {
  const supabase = useMemo(() => createClient(), [])

  const [pitchId, setPitchId] = useState(initialPitchId)
  const [weekStart, setWeekStart] = useState(initialWeekStart)
  const [bookings, setBookings] = useState<CalendarBooking[]>(() => [...initialBookings])
  const [blocks, setBlocks] = useState<CalendarBlock[]>(() => [...initialBlocks])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [connection, setConnection] = useState<ConnectionState>("connecting")

  // Selection: an anchor cell and a moving head, always within one day column.
  const [anchor, setAnchor] = useState<{ dayIndex: number; slotIndex: number } | null>(null)
  const [head, setHead] = useState<{ dayIndex: number; slotIndex: number } | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [blockReason, setBlockReason] = useState("")
  const [submitting, setSubmitting] = useState(false)
  // A blackout the owner has clicked and may now lift. Kept out of `selection` because it is a
  // different action, on a different kind of cell.
  const [pendingUnblock, setPendingUnblock] = useState<CalendarBlock | null>(null)

  // Pointer/keyboard modifiers live in refs: they change far more often than the render needs to.
  const dragRef = useRef({ active: false, moved: false })
  const shiftHeldRef = useRef(false)

  const pitch = useMemo(
    () => pitches.find((candidate) => candidate.id === pitchId) ?? pitches[0] ?? null,
    [pitches, pitchId],
  )

  /* ---------------------------------------------------------------------- */
  /*  Geometry                                                              */
  /* ---------------------------------------------------------------------- */

  const dayKeys = useMemo(
    () => Array.from({ length: DAY_COUNT }, (_, index) => addDaysToDateKey(weekStart, index)),
    [weekStart],
  )

  const slotMinutes = useMemo(() => {
    if (!pitch) return []
    const open = timeToMinutes(pitch.openingTime)
    const rawClose = timeToMinutes(pitch.closingTime)
    const step = Math.max(15, pitch.slotMinutes)
    // A closing time at or before the opening time means the pitch is open past midnight --
    // 0001_schema.sql says closing_time "may sort before opening_time for venues open past
    // midnight". Project the session onto a continuous [open, close + 24h) axis, the same
    // projection `assertWithinOpeningHours` in lib/payments.ts uses to price such a slot;
    // `wallClock` and `minutesToLabel` below both normalise a minute-of-day past 24:00.
    const close = rawClose <= open ? rawClose + 24 * 60 : rawClose

    const result: number[] = []
    for (let minute = open; minute + step <= close; minute += step) result.push(minute)
    return result
  }, [pitch])

  /** The exact instants the grid covers — what the refetch asks for, no more. */
  const windowRange = useMemo(() => {
    if (!pitch) return null
    const step = Math.max(15, pitch.slotMinutes)
    // `noUncheckedIndexedAccess` is on, so every edge lookup is narrowed rather than asserted.
    const firstKey = dayKeys[0]
    const lastKey = dayKeys[dayKeys.length - 1]
    const openMinute = slotMinutes[0]
    const lastMinute = slotMinutes[slotMinutes.length - 1]
    if (firstKey === undefined || lastKey === undefined) return null
    if (openMinute === undefined || lastMinute === undefined) return null

    return {
      from: wallClock(parseDateKey(firstKey), openMinute, timezone),
      to: wallClock(parseDateKey(lastKey), lastMinute + step, timezone),
    }
  }, [dayKeys, pitch, slotMinutes, timezone])

  // Re-rendered every minute so the "past" shading advances without a manual refresh.
  const now = useNowTick(60_000)
  const todayKey = useMemo(() => zonedDateKey(new Date(now), timezone), [now, timezone])

  /**
   * `slotIndex:dayIndex` → what is in that cell.
   *
   * Built once per data change rather than searched per cell: a 7x15 grid with a busy week would
   * otherwise be 105 linear scans of the booking list on every render.
   */
  const cellInfo = useMemo(() => {
    const map = new Map<string, SlotInfo>()
    if (!pitch || slotMinutes.length === 0) return map

    const step = Math.max(15, pitch.slotMinutes)

    const pitchBookings = bookings
      .filter(
        (booking) =>
          booking.pitch_id === pitch.id && OCCUPYING_BOOKING_STATUSES.includes(booking.status),
      )
      .map((booking) => ({ booking, interval: parseRange(booking.time_range) }))
      .filter((entry) => entry.interval !== null)

    const pitchBlocks = blocks
      .filter((block) => block.pitch_id === pitch.id)
      .map((block) => ({ block, interval: parseRange(block.block_range) }))
      .filter((entry) => entry.interval !== null)

    dayKeys.forEach((dayKey, dayIndex) => {
      const date = parseDateKey(dayKey)
      slotMinutes.forEach((minute, slotIndex) => {
        const start = wallClock(date, minute, timezone).getTime()
        const end = wallClock(date, minute + step, timezone).getTime()

        const booking =
          pitchBookings.find(
            (entry) => entry.interval!.start < end && entry.interval!.end > start,
          )?.booking ?? null
        const block =
          pitchBlocks.find((entry) => entry.interval!.start < end && entry.interval!.end > start)
            ?.block ?? null

        let state: SlotState = "open"
        if (!pitch.isActive) state = "closed"
        else if (booking) state = "booked"
        else if (block) state = "blocked"
        else if (end <= now) state = "past"

        map.set(`${slotIndex}:${dayIndex}`, { start, end, state, booking, block })
      })
    })

    return map
  }, [blocks, bookings, dayKeys, now, pitch, slotMinutes, timezone])

  const infoAt = useCallback(
    (slotIndex: number, dayIndex: number) => cellInfo.get(`${slotIndex}:${dayIndex}`) ?? null,
    [cellInfo],
  )

  const days: CalendarDay[] = useMemo(
    () =>
      dayKeys.map((key) => ({
        key,
        label: formatWeekdayLabel(key),
        subLabel: formatDayNumber(key),
        isToday: key === todayKey,
      })),
    [dayKeys, todayKey],
  )

  const slots: CalendarSlot[] = useMemo(() => {
    if (!pitch) return []
    const step = Math.max(15, pitch.slotMinutes)
    return slotMinutes.map((minute) => ({
      key: minutesToLabel(minute),
      label: minutesToLabel(minute),
      subLabel: minutesToLabel(minute + step),
    }))
  }, [pitch, slotMinutes])

  /* ---------------------------------------------------------------------- */
  /*  Fetching a window                                                     */
  /* ---------------------------------------------------------------------- */

  const initialKey = `${initialPitchId}|${initialWeekStart}`
  const currentKey = `${pitchId}|${weekStart}`

  const refetch = useCallback(
    async (signal?: AbortSignal) => {
      if (!pitch || !windowRange) return
      setLoading(true)
      setLoadError(null)
      try {
        const url =
          `/api/pitches/${encodeURIComponent(pitch.id)}/availability` +
          `?from=${encodeURIComponent(windowRange.from.toISOString())}` +
          `&to=${encodeURIComponent(windowRange.to.toISOString())}`

        const response = await fetch(url, { credentials: "same-origin", signal })
        const payload = (await response.json()) as ApiResponse<{
          bookings: CalendarBooking[]
          blocks: CalendarBlock[]
        }>

        if (!isApiOk(payload)) {
          setLoadError(payload.error.message)
          return
        }
        setBookings(payload.data.bookings)
        setBlocks(payload.data.blocks)
      } catch (error) {
        if ((error as { name?: string }).name === "AbortError") return
        setLoadError("Could not load the schedule. Check your connection and try again.")
      } finally {
        setLoading(false)
      }
    },
    [pitch, windowRange],
  )

  // Only refetch once the view has moved off what the server already rendered.
  useEffect(() => {
    if (currentKey === initialKey) return
    const controller = new AbortController()
    void refetch(controller.signal)
    return () => controller.abort()
  }, [currentKey, initialKey, refetch])

  /* ---------------------------------------------------------------------- */
  /*  Realtime                                                              */
  /* ---------------------------------------------------------------------- */

  const pitchIds = useMemo(() => pitches.map((candidate) => candidate.id), [pitches])
  const pitchIdKey = pitchIds.join(",")

  // Held in refs so the (stable) subscription never has to be torn down for a data change.
  const pitchIdSetRef = useRef(new Set(pitchIds))
  useEffect(() => {
    pitchIdSetRef.current = new Set(pitchIds)
  }, [pitchIds])

  const refetchRef = useRef(refetch)
  useEffect(() => {
    refetchRef.current = refetch
  }, [refetch])

  useEffect(() => {
    const ids = pitchIdKey.split(",").filter(Boolean)
    if (ids.length === 0) return

    let cancelled = false
    let channel: RealtimeChannel | null = null
    let retries = 0
    let timer: ReturnType<typeof setTimeout> | null = null
    let hasConnectedOnce = false

    const handleChange = (payload: RealtimePostgresChangesPayload<CalendarBooking>) => {
      if (payload.eventType === "DELETE") {
        // `bookings` sits at REPLICA IDENTITY DEFAULT, so a delete carries only the primary key.
        // Removing by id unconditionally is correct — an id we are not holding is a no-op.
        const removed = payload.old as Partial<CalendarBooking>
        if (typeof removed?.id !== "string") return
        setBookings((previous) => previous.filter((booking) => booking.id !== removed.id))
        return
      }

      const row = payload.new as Partial<CalendarBooking>
      if (typeof row?.id !== "string" || typeof row.pitch_id !== "string") return
      // The same predicate as the server-side filter, for the case where the filter was too long
      // to send. RLS has already decided we are allowed to see this row.
      if (!pitchIdSetRef.current.has(row.pitch_id)) return

      const next = row as CalendarBooking
      setBookings((previous) => {
        const index = previous.findIndex((booking) => booking.id === next.id)
        if (index === -1) return [...previous, next]
        const copy = [...previous]
        copy[index] = { ...copy[index], ...next }
        return copy
      })
    }

    const scheduleReconnect = () => {
      if (cancelled) return
      retries += 1
      const ceiling = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** Math.min(retries, 5))
      // Full jitter over the top half of the window: still backs off, but two dashboards never
      // retry on the same tick.
      const delay = Math.round(ceiling / 2 + Math.random() * (ceiling / 2))
      timer = setTimeout(() => {
        void connect()
      }, delay)
    }

    const teardown = async () => {
      if (!channel) return
      const doomed = channel
      channel = null
      try {
        await supabase.removeChannel(doomed)
      } catch {
        // The socket may already be gone; there is nothing useful to do about it.
      }
    }

    const connect = async () => {
      if (cancelled) return
      await teardown()
      setConnection(retries === 0 ? "connecting" : "reconnecting")

      // Realtime evaluates `bookings_select_stakeholders` against the JWT on the socket. Without
      // a token the subscription is anonymous and RLS correctly shows it nothing.
      try {
        const { data } = await supabase.auth.getSession()
        const token = data.session?.access_token
        if (token) await Promise.resolve(supabase.realtime.setAuth(token))
      } catch {
        // The @supabase/ssr browser client normally propagates the token itself; this is
        // belt-and-braces, never the only thing keeping the stream authorised.
      }
      if (cancelled) return

      const filter = buildPitchFilter(ids)
      // Every topic in lib/realtime/channels.ts is a Realtime PRIVATE channel. Without
      // `config: { private: true }` Realtime never consults `realtime.messages`, so the
      // `rt_venue_read` / `rt_venue_write` policies 0006_realtime.sql installs for the
      // `venue:<uuid>` topic are never evaluated and the topic's ACL simply does not run.
      const created = supabase.channel(venueTopic(venueId), { config: { private: true } })

      const subscribed = filter
        ? created.on(
            "postgres_changes",
            { event: "*", schema: "public", table: "bookings", filter },
            handleChange,
          )
        : created.on(
            "postgres_changes",
            { event: "*", schema: "public", table: "bookings" },
            handleChange,
          )

      channel = subscribed.subscribe((status) => {
        if (cancelled) return
        if (status === "SUBSCRIBED") {
          setConnection("live")
          // Anything that changed while the socket was down was never delivered, so the first
          // thing a recovered connection does is resynchronise the window it is responsible for.
          if (hasConnectedOnce) void refetchRef.current()
          hasConnectedOnce = true
          retries = 0
          return
        }
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          setConnection(retries >= 5 ? "offline" : "reconnecting")
          scheduleReconnect()
        }
      })
    }

    void connect()

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      void teardown()
    }
  }, [supabase, venueId, pitchIdKey])

  /* ---------------------------------------------------------------------- */
  /*  Selection                                                             */
  /* ---------------------------------------------------------------------- */

  // Shift is tracked globally so both shift-click and shift-arrow extend a selection; the
  // CalendarGrid primitive's `onSelect` deliberately hands over a cell, not a DOM event.
  useEffect(() => {
    const onDown = (event: KeyboardEvent) => {
      if (event.key === "Shift") shiftHeldRef.current = true
    }
    const onUp = (event: KeyboardEvent) => {
      if (event.key === "Shift") shiftHeldRef.current = false
    }
    const onBlur = () => {
      shiftHeldRef.current = false
    }
    window.addEventListener("keydown", onDown)
    window.addEventListener("keyup", onUp)
    window.addEventListener("blur", onBlur)
    return () => {
      window.removeEventListener("keydown", onDown)
      window.removeEventListener("keyup", onUp)
      window.removeEventListener("blur", onBlur)
    }
  }, [])

  // A drag released outside the grid (or outside the window) must still end, or the next
  // unrelated pointer move would keep extending a selection nobody is holding.
  useEffect(() => {
    const stop = () => {
      dragRef.current.active = false
    }
    window.addEventListener("pointerup", stop)
    window.addEventListener("pointercancel", stop)
    return () => {
      window.removeEventListener("pointerup", stop)
      window.removeEventListener("pointercancel", stop)
    }
  }, [])

  const selection = useMemo(() => {
    if (!anchor || !head || anchor.dayIndex !== head.dayIndex) return null
    const from = Math.min(anchor.slotIndex, head.slotIndex)
    const to = Math.max(anchor.slotIndex, head.slotIndex)
    return { dayIndex: anchor.dayIndex, from, to }
  }, [anchor, head])

  /**
   * The instants a selection covers — and `null` when any cell inside it is not free.
   *
   * A drag can pass THROUGH a booked or already-blocked slot (the primitive marks such cells
   * `aria-disabled`, which keeps them focusable and still pointer-reactive). Blocking across one
   * would either be rejected by the database or, worse for a booking, quietly black out a slot a
   * customer has paid for. So the whole range is validated before the action is offered.
   */
  const selectionRange = useMemo(() => {
    if (!selection) return null
    let start = Number.POSITIVE_INFINITY
    let end = Number.NEGATIVE_INFINITY

    for (let slotIndex = selection.from; slotIndex <= selection.to; slotIndex += 1) {
      const info = infoAt(slotIndex, selection.dayIndex)
      if (!info || info.state !== "open") return null
      start = Math.min(start, info.start)
      end = Math.max(end, info.end)
    }

    return Number.isFinite(start) && Number.isFinite(end) ? { start, end } : null
  }, [infoAt, selection])

  const clearSelection = useCallback(() => {
    setAnchor(null)
    setHead(null)
    setPendingUnblock(null)
    dragRef.current = { active: false, moved: false }
  }, [])

  const handleSelect = useCallback(
    (cell: CalendarCell) => {
      if (!canEdit) return
      // Swallow the click that terminates a drag: the pointer handlers already placed the
      // selection, and re-anchoring on mouse-up would collapse it to a single cell.
      if (dragRef.current.moved) {
        dragRef.current.moved = false
        return
      }
      if (shiftHeldRef.current && anchor && anchor.dayIndex === cell.dayIndex) {
        setHead({ dayIndex: cell.dayIndex, slotIndex: cell.slotIndex })
        return
      }
      const info = infoAt(cell.slotIndex, cell.dayIndex)

      // A blocked cell is not selectable but it IS actionable: clicking it offers to lift the
      // blackout. That is exactly why blocked cells stay enabled while booked and past ones do not.
      if (info?.state === "blocked" && info.block) {
        setAnchor(null)
        setHead(null)
        setPendingUnblock(info.block)
        return
      }

      if (!info || info.state !== "open") {
        clearSelection()
        return
      }
      setPendingUnblock(null)
      setAnchor({ dayIndex: cell.dayIndex, slotIndex: cell.slotIndex })
      setHead({ dayIndex: cell.dayIndex, slotIndex: cell.slotIndex })
    },
    [anchor, canEdit, clearSelection, infoAt],
  )

  const beginDrag = useCallback(
    (cell: CalendarCell) => {
      if (!canEdit) return
      const info = infoAt(cell.slotIndex, cell.dayIndex)
      if (!info || info.state !== "open") return
      dragRef.current = { active: true, moved: false }
      setAnchor({ dayIndex: cell.dayIndex, slotIndex: cell.slotIndex })
      setHead({ dayIndex: cell.dayIndex, slotIndex: cell.slotIndex })
    },
    [canEdit, infoAt],
  )

  const extendDrag = useCallback(
    (cell: CalendarCell) => {
      if (!dragRef.current.active || !anchor) return
      if (anchor.dayIndex !== cell.dayIndex) return
      dragRef.current.moved = true
      setHead({ dayIndex: cell.dayIndex, slotIndex: cell.slotIndex })
    },
    [anchor],
  )

  const isSelected = useCallback(
    (slotIndex: number, dayIndex: number) =>
      selection !== null &&
      selection.dayIndex === dayIndex &&
      slotIndex >= selection.from &&
      slotIndex <= selection.to,
    [selection],
  )

  /* ---------------------------------------------------------------------- */
  /*  Blackout write path                                                   */
  /* ---------------------------------------------------------------------- */

  const submitBlock = useCallback(async () => {
    if (!pitch || !selectionRange) return
    setSubmitting(true)

    const optimisticId = `optimistic-${Date.now()}`
    const startsAt = new Date(selectionRange.start).toISOString()
    const endsAt = new Date(selectionRange.end).toISOString()
    const optimistic: CalendarBlock = {
      id: optimisticId,
      pitch_id: pitch.id,
      block_range: `["${startsAt}","${endsAt}")`,
      reason: blockReason.trim() || null,
    }
    setBlocks((previous) => [...previous, optimistic])

    try {
      const response = await fetch(`/api/pitches/${encodeURIComponent(pitch.id)}/availability`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          startsAt,
          endsAt,
          ...(blockReason.trim() ? { reason: blockReason.trim() } : {}),
        }),
      })
      const payload = (await response.json()) as ApiResponse<{ block: CalendarBlock }>

      if (!isApiOk(payload)) {
        // The optimistic row was a guess and the database disagreed. Roll it back BEFORE saying
        // anything, so the grid never shows a blackout that does not exist.
        setBlocks((previous) => previous.filter((block) => block.id !== optimisticId))
        toast({
          variant: "destructive",
          title:
            payload.error.code === "BLOCK_OVERLAP"
              ? "That time is already blocked"
              : payload.error.code === "SLOT_TAKEN"
                ? "There is a booking in that window"
                : "Could not block that time",
          description: payload.error.message,
        })
        return
      }

      setBlocks((previous) =>
        previous.map((block) => (block.id === optimisticId ? payload.data.block : block)),
      )
      toast({
        variant: "success",
        title: "Saat kapatıldı",
        description: `${formatRangeLabel(selectionRange.start, selectionRange.end, timezone)} is no longer bookable.`,
      })
      setConfirming(false)
      setBlockReason("")
      clearSelection()
    } catch {
      setBlocks((previous) => previous.filter((block) => block.id !== optimisticId))
      toast({
        variant: "destructive",
        title: "Sunucuya ulaşılamadı",
        description: "Değişikliğin kaydedilmedi. Bağlantını kontrol edip tekrar dene.",
      })
    } finally {
      setSubmitting(false)
    }
  }, [blockReason, clearSelection, pitch, selectionRange, timezone])

  const removeBlock = useCallback(
    async (block: CalendarBlock) => {
      if (!pitch || block.id.startsWith("optimistic-")) return
      const snapshot = blocks
      setBlocks((previous) => previous.filter((entry) => entry.id !== block.id))

      try {
        const response = await fetch(
          `/api/pitches/${encodeURIComponent(pitch.id)}/availability?blockId=${encodeURIComponent(block.id)}`,
          { method: "DELETE", credentials: "same-origin" },
        )
        const payload = (await response.json()) as ApiResponse<{ blockId: string }>
        if (!isApiOk(payload)) {
          setBlocks(snapshot)
          toast({
            variant: "destructive",
            title: "Saat açılamadı",
            description: payload.error.message,
          })
          return
        }
        toast({ variant: "success", title: "Saat açıldı" })
      } catch {
        setBlocks(snapshot)
        toast({
          variant: "destructive",
          title: "Sunucuya ulaşılamadı",
          description: "Değişikliğin kaydedilmedi.",
        })
      }
    },
    [blocks, pitch],
  )

  /* ---------------------------------------------------------------------- */
  /*  Render                                                                */
  /* ---------------------------------------------------------------------- */

  if (pitches.length === 0) {
    return (
      <EmptyCalendar
        title="Henüz saha yok"
        body="Çalışma saatleri olan bir saha ekle; haftalık müsaitliği burada görünür."
      />
    )
  }

  if (!pitch || slots.length === 0) {
    return (
      <EmptyCalendar
        title="Rezerve edilebilir saat yok"
        body="Bu saha açılış saatinde ya da öncesinde kapanıyor, gösterilecek bir şey yok. Çalışma saatlerini düzelt."
      />
    )
  }

  const slotPrice = slotPriceMinorLocal(pitch.hourlyRateMinor, pitch.slotMinutes)
  // Both are defined here: `slots.length === 0` returned above and `dayKeys` is a fixed 7.
  const firstDayKey = dayKeys[0] ?? weekStart
  const lastDayKey = dayKeys[dayKeys.length - 1] ?? weekStart

  return (
    <div className={cn("space-y-4", className)}>
      {/* ---- Controls ---- */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center rounded-md border border-border">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                clearSelection()
                setWeekStart((current) => addDaysToDateKey(current, -DAY_COUNT))
              }}
              aria-label="Önceki week"
            >
              <Chevron direction="left" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                clearSelection()
                setWeekStart(startOfWeek(zonedDateKey(new Date(), timezone)))
              }}
            >
              Bugün
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                clearSelection()
                setWeekStart((current) => addDaysToDateKey(current, DAY_COUNT))
              }}
              aria-label="Sonraki hafta"
            >
              <Chevron direction="right" />
            </Button>
          </div>

          <p className="text-sm font-medium" aria-live="polite">
            {formatDayLabel(firstDayKey)} – {formatDayLabel(lastDayKey)}
            <span className="ml-2 font-normal text-muted-foreground">{timezone}</span>
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {pitches.length > 1 ? (
            <div role="group" aria-label="Saha seç" className="flex flex-wrap gap-1">
              {pitches.map((candidate) => (
                <Button
                  key={candidate.id}
                  variant={candidate.id === pitch.id ? "default" : "outline"}
                  size="sm"
                  aria-pressed={candidate.id === pitch.id}
                  onClick={() => {
                    clearSelection()
                    setPitchId(candidate.id)
                  }}
                >
                  {candidate.name}
                </Button>
              ))}
            </div>
          ) : null}
          <ConnectionBadge state={connection} />
        </div>
      </div>

      {loadError ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>Takvim yüklenemedi</AlertTitle>
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      ) : null}

      <Legend slotPrice={slotPrice} currency={pitch.currency} canEdit={canEdit} />

      {/* ---- Grid ---- */}
      <div className="relative">
        {loading ? (
          <div className="absolute inset-0 z-20 flex items-center justify-center rounded-lg bg-background/60 backdrop-blur-[1px]">
            <span className="text-sm font-medium text-muted-foreground">Loading…</span>
          </div>
        ) : null}

        <CalendarGrid
          days={days}
          slots={slots}
          label={`Availability for ${pitch.name}, week of ${formatDayLabel(firstDayKey)}`}
          onSelect={canEdit ? handleSelect : undefined}
          // Booked, past and closed cells are `aria-disabled` — still focusable, so arrow-key
          // traversal has no holes, but never the start of a selection. BLOCKED cells stay
          // enabled, because clicking one is how an owner lifts the blackout.
          isCellDisabled={(cell) => {
            const state = infoAt(cell.slotIndex, cell.dayIndex)?.state
            return state !== "open" && state !== "blocked"
          }}
          // `relative` lets each cell body fill its button and paint the slot state; `group` is
          // what reveals the per-slot price on hover.
          cellClassName="group relative"
          renderCell={(cell) => (
            <SlotBody
              cell={cell}
              info={infoAt(cell.slotIndex, cell.dayIndex)}
              selected={isSelected(cell.slotIndex, cell.dayIndex)}
              slotPrice={slotPrice}
              currency={pitch.currency}
              timezone={timezone}
              canEdit={canEdit}
              onPointerDown={() => beginDrag(cell)}
              onPointerEnter={() => extendDrag(cell)}
            />
          )}
        />
      </div>

      {/* ---- Selection action bar ---- */}
      {canEdit && selection ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-muted/40 px-4 py-3">
          {selectionRange ? (
            <p className="text-sm">
              <span className="font-medium">
                {formatRangeLabel(selectionRange.start, selectionRange.end, timezone)}
              </span>
              <span className="ml-2 text-muted-foreground">
                {Math.round((selectionRange.end - selectionRange.start) / 60_000)} minutes selected
              </span>
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              Bu aralık dolu ya da zaten kapatılmış bir saate denk geliyor. Boş saatlerden oluşan bir aralık seç.
            </p>
          )}
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={clearSelection}>
              Temizle
            </Button>
            <Button size="sm" onClick={() => setConfirming(true)} disabled={!selectionRange}>
              Bu saati kapat
            </Button>
          </div>
        </div>
      ) : null}

      {/* ---- Lift a blackout ---- */}
      {canEdit && pendingUnblock && !selection ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-muted/40 px-4 py-3">
          <p className="text-sm">
            <span className="font-medium">Kapalı</span>
            <span className="ml-2 text-muted-foreground">
              {describeBlockRange(pendingUnblock, timezone)}
            </span>
            {pendingUnblock.reason ? (
              <span className="ml-2 text-muted-foreground">&middot; {pendingUnblock.reason}</span>
            ) : null}
          </p>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => setPendingUnblock(null)}>
              Vazgeç
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const target = pendingUnblock
                setPendingUnblock(null)
                void removeBlock(target)
              }}
            >
              Bu saati aç
            </Button>
          </div>
        </div>
      ) : null}

      {/* ---- Confirm dialog ---- */}
      <Dialog
        open={confirming}
        onOpenChange={(next) => {
          if (!submitting) setConfirming(next)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Bu saati kapatalım mı?</DialogTitle>
            <DialogDescription>
              {selectionRange
                ? `${pitch.name} will not be bookable ${formatRangeLabel(selectionRange.start, selectionRange.end, timezone)}.`
                : "Choose a run of free slots on the calendar first."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <Label htmlFor="blackout-reason">Gerekçe (isteğe bağlı)</Label>
            <Textarea
              id="blackout-reason"
              value={blockReason}
              onChange={(event) => setBlockReason(event.target.value.slice(0, 280))}
              placeholder="Maintenance, private event, resurfacing…"
              rows={3}
              aria-describedby="blackout-reason-hint"
            />
            <p id="blackout-reason-hint" className="text-xs text-muted-foreground">
              Bunu yalnızca sen ve ekibin görür. Oyunculara yalnızca saatin satışta olmadığı söylenir, gerekçe söylenmez.
            </p>
          </div>

          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={() => setConfirming(false)} disabled={submitting}>
              Vazgeç
            </Button>
            <Button onClick={() => void submitBlock()} disabled={submitting || !selectionRange}>
              {submitting ? "Blocking…" : "Block time"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/* ========================================================================== */
/*  Cell body                                                                 */
/* ========================================================================== */

const STATE_CLASS: Readonly<Record<SlotState, string>> = {
  open: "bg-background hover:bg-accent",
  booked: "bg-primary/15",
  blocked: "bg-muted",
  past: "bg-muted/40",
  closed: "bg-muted/40",
}

const BOOKING_SHORT_LABEL: Readonly<Record<Enums<"booking_status">, string>> = {
  pending: "Held",
  awaiting_payment: "Unpaid",
  confirmed: "Booked",
  completed: "Oynadığı",
  cancelled: "Cancelled",
  refunded: "Refunded",
  disputed: "Disputed",
}

function SlotBody({
  cell,
  info,
  selected,
  slotPrice,
  currency,
  timezone,
  canEdit,
  onPointerDown,
  onPointerEnter,
}: {
  cell: CalendarCell
  info: SlotInfo | null
  selected: boolean
  slotPrice: number
  currency: string
  timezone: string
  canEdit: boolean
  onPointerDown: () => void
  onPointerEnter: () => void
}) {
  const state = info?.state ?? "closed"
  const description = describeCell(cell, info, slotPrice, currency, timezone)

  return (
    <span
      // Fills the primitive's button so the whole cell is a drag target, and carries the slot
      // state's colour (the primitive's `cellClassName` is one string for every cell and so
      // cannot vary per state).
      onPointerDown={onPointerDown}
      onPointerEnter={onPointerEnter}
      className={cn(
        "absolute inset-0 flex select-none items-center justify-between gap-1 rounded-md px-1.5 text-[11px] leading-tight transition-colors",
        STATE_CLASS[state],
        selected && "bg-primary/30 ring-2 ring-inset ring-primary",
      )}
    >
      {/* The full sentence is the cell's accessible name; the visible text is an abbreviation. */}
      <span className="sr-only">{description}</span>

      {state === "booked" && info?.booking ? (
        <span aria-hidden="true" className="flex min-w-0 items-center gap-1 truncate font-medium">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
          {BOOKING_SHORT_LABEL[info.booking.status]}
        </span>
      ) : null}

      {/*
        No nested control here. This body already lives inside the primitive's <button>, and
        interactive content inside a button is invalid HTML and unreliable for keyboard users —
        so "unblock" is offered in the action bar below the grid once the cell is clicked.
      */}
      {state === "blocked" && info?.block ? (
        <span aria-hidden="true" className="min-w-0 truncate text-muted-foreground">
          {info.block.reason ?? "Blocked"}
          {canEdit ? <span className="ml-1 opacity-60">&middot; tap to lift</span> : null}
        </span>
      ) : null}

      {state === "open" ? (
        <span
          aria-hidden="true"
          className="w-full text-center text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
        >
          {formatMinor(slotPrice, currency)}
        </span>
      ) : null}
    </span>
  )
}

function describeCell(
  cell: CalendarCell,
  info: SlotInfo | null,
  slotPrice: number,
  currency: string,
  timezone: string,
): string {
  const when = info
    ? formatRangeLabel(info.start, info.end, timezone)
    : `${cell.day.subLabel ?? cell.day.label} ${cell.slot.label}`

  switch (info?.state) {
    case "booked":
      return `${when} — booked (${info.booking ? BOOKING_SHORT_LABEL[info.booking.status] : "held"}), ${formatMinor(info.booking?.total_minor ?? slotPrice, info.booking?.currency ?? currency)}`
    case "blocked":
      return `${when} — blocked${info.block?.reason ? `: ${info.block.reason}` : ""}`
    case "past":
      return `${when} — in the past`
    case "closed":
      return `${when} — pitch is not bookable`
    default:
      return `${when} — available, ${formatMinor(slotPrice, currency)}`
  }
}

/* ========================================================================== */
/*  Chrome                                                                    */
/* ========================================================================== */

function Legend({
  slotPrice,
  currency,
  canEdit,
}: {
  slotPrice: number
  currency: string
  canEdit: boolean
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
      <LegendSwatch
        className="bg-background ring-1 ring-inset ring-border"
        label={`Available · ${formatMinor(slotPrice, currency)} per slot`}
      />
      <LegendSwatch className="bg-primary/15 ring-1 ring-inset ring-primary/40" label="Dolu" />
      <LegendSwatch className="bg-muted ring-1 ring-inset ring-border" label="Senin kapattığın" />
      <LegendSwatch className="bg-muted/40 ring-1 ring-inset ring-border" label="Geçmiş" />
      {canEdit ? (
        <span className="ml-auto">
          Sürükle ya da <kbd className="rounded border border-border px-1">Enter</kbd> then{" "}
          <kbd className="rounded border border-border px-1">Shift</kbd>+arrows, to block time.
        </span>
      ) : null}
    </div>
  )
}

function LegendSwatch({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden="true" className={cn("h-3 w-3 rounded-sm", className)} />
      {label}
    </span>
  )
}

function ConnectionBadge({ state }: { state: ConnectionState }) {
  const meta: Record<
    ConnectionState,
    { label: string; dot: string; variant: "outline" | "secondary" | "destructive" }
  > = {
    connecting: {
      label: "Bağlanıyor",
      dot: "bg-muted-foreground animate-pulse",
      variant: "outline",
    },
    live: { label: "Canlı", dot: "bg-emerald-500", variant: "secondary" },
    reconnecting: { label: "Yeniden bağlanıyor", dot: "bg-amber-500 animate-pulse", variant: "outline" },
    offline: { label: "Çevrimdışı", dot: "bg-destructive", variant: "destructive" },
  }
  const current = meta[state]

  return (
    <Badge
      variant={current.variant}
      className="gap-1.5"
      title="Rezervasyon akışından canlı güncellemeler"
    >
      <span aria-hidden="true" className={cn("h-1.5 w-1.5 shrink-0 rounded-full", current.dot)} />
      <span className="sr-only">Canlı güncelleme: </span>
      {current.label}
    </Badge>
  )
}

function EmptyCalendar({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border px-6 py-16 text-center">
      <p className="text-sm font-medium">{title}</p>
      <p className="max-w-md text-xs text-muted-foreground">{body}</p>
    </div>
  )
}

/** Skeleton with the same 7-column geometry, so the swap does not reflow the page. */
export function BookingCalendarSkeleton({ rows = 12 }: { rows?: number }) {
  return (
    <div className="space-y-4" role="status" aria-label="Müsaitlik takvimi yükleniyor">
      <div className="flex items-center justify-between">
        <Skeleton className="h-9 w-56" />
        <Skeleton className="h-9 w-40" />
      </div>
      <div className="overflow-hidden rounded-lg border border-border">
        <div
          className="grid gap-px bg-border"
          style={{ gridTemplateColumns: `5rem repeat(${DAY_COUNT}, minmax(0, 1fr))` }}
        >
          {Array.from({ length: (rows + 1) * (DAY_COUNT + 1) }, (_, index) => (
            <Skeleton key={index} className="h-10 rounded-none" />
          ))}
        </div>
      </div>
    </div>
  )
}

function Chevron({ direction }: { direction: "left" | "right" }) {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden="true" focusable="false">
      <path
        d={direction === "left" ? "M10 3L5 8l5 5" : "M6 3l5 5-5 5"}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/* ========================================================================== */
/*  Utilities                                                                 */
/* ========================================================================== */

/**
 * Realtime filters travel in the channel join payload and are not unbounded. Beyond a handful of
 * UUIDs the filter is dropped and the same predicate is applied in the change handler — the
 * stream becomes chattier, never wider, because RLS decides what may be sent regardless of what
 * is asked for.
 */
function buildPitchFilter(pitchIds: readonly string[]): string | null {
  if (pitchIds.length === 0 || pitchIds.length > MAX_FILTER_PITCHES) return null
  return `pitch_id=in.(${pitchIds.join(",")})`
}

/**
 * Price of one slot. Mirrors `slotPriceMinor` in `lib/payments.ts` — duplicated rather than
 * imported because that module pulls in the server-only Stripe client, which must never reach a
 * browser bundle. Identical integer arithmetic and identical rounding, so the grid quotes exactly
 * what checkout charges.
 */
function slotPriceMinorLocal(hourlyRateMinor: number, slotMinutes: number): number {
  if (!Number.isFinite(hourlyRateMinor) || !Number.isFinite(slotMinutes) || slotMinutes <= 0) {
    return 0
  }
  return Math.floor((hourlyRateMinor * slotMinutes + 30) / 60)
}

/** The absolute instant of a local wall-clock minute-of-day on a given local date. */
function wallClock(
  date: { year: number; month: number; day: number },
  minuteOfDay: number,
  timeZone: string,
): Date {
  return zonedWallClockToUtc(
    date.year,
    date.month,
    date.day,
    Math.floor(minuteOfDay / 60),
    minuteOfDay % 60,
    timeZone,
  )
}

/** Ticks a state value on an interval so time-dependent styling stays honest without a reload. */
function useNowTick(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

function minutesToLabel(minute: number): string {
  const hours = Math.floor(minute / 60) % 24
  const minutes = minute % 60
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`
}

/** Monday-first week containing `dateKey`. */
export function startOfWeek(dateKey: string): string {
  const { year, month, day } = parseDateKey(dateKey)
  // getUTCDay(): 0 = Sunday. Shift so Monday leads the week.
  const offset = (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7
  return addDaysToDateKey(dateKey, -offset)
}

/* -- Labels. Day keys are already LOCAL dates, so they are formatted as UTC. -- */

function keyToDate(dateKey: string): Date {
  return new Date(`${dateKey}T12:00:00.000Z`)
}

function formatWeekdayLabel(dateKey: string): string {
  return new Intl.DateTimeFormat("tr-TR", { timeZone: "UTC", weekday: "short" }).format(
    keyToDate(dateKey),
  )
}

function formatDayNumber(dateKey: string): string {
  return new Intl.DateTimeFormat("tr-TR", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
  }).format(keyToDate(dateKey))
}

function formatDayLabel(dateKey: string): string {
  return new Intl.DateTimeFormat("tr-TR", {
    timeZone: "UTC",
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(keyToDate(dateKey))
}

/** Human range for a stored blackout; empty when its literal will not parse. */
function describeBlockRange(block: CalendarBlock, timeZone: string): string {
  const interval = parseRange(block.block_range)
  if (!interval) return ""
  return formatRangeLabel(interval.start, interval.end, timeZone)
}

/** Absolute instants, so these ARE rendered through the venue timezone. */
function formatRangeLabel(startMs: number, endMs: number, timeZone: string): string {
  const day = safeFormat(startMs, { timeZone, weekday: "short", day: "numeric", month: "short" })
  const time: Intl.DateTimeFormatOptions = {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }
  return `${day} ${safeFormat(startMs, time)}–${safeFormat(endMs, time)}`
}

function safeFormat(ms: number, options: Intl.DateTimeFormatOptions): string {
  if (!Number.isFinite(ms)) return "—"
  try {
    return new Intl.DateTimeFormat("tr-TR", options).format(new Date(ms))
  } catch {
    return new Intl.DateTimeFormat("tr-TR", { ...options, timeZone: "UTC" }).format(new Date(ms))
  }
}
