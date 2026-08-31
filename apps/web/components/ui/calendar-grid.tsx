"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * calendar-grid — a dependency-free weekly time-slot grid.
 *
 * This primitive knows NOTHING about pitches, bookings or availability. It lays columns
 * (days) against rows (slots), asks the caller to render each intersection, and handles the
 * two things every hand-rolled calendar gets wrong: roving-tabindex keyboard navigation and
 * the ARIA grid roles. Feature code (the venue calendar, the booking picker) composes on top.
 *
 * Deliberately NOT a date library: the caller supplies already-formatted labels together with
 * a stable key per day and per slot. That keeps timezone arithmetic — which for this platform
 * must happen in the venue's own timezone, not the browser's — in one place upstream instead
 * of being re-derived here from a Date the server never agreed to.
 */

export interface CalendarDay {
  /** Stable identity for the column. An ISO date ("2026-08-30") is the natural choice. */
  key: string
  /** Short weekday, e.g. "Pzt". */
  label: string
  /** Optional second line, e.g. "30 Agu". */
  subLabel?: string
  isToday?: boolean
  /** Greys the whole column; individual cells can still be disabled via isCellDisabled. */
  isDisabled?: boolean
}

export interface CalendarSlot {
  /** Stable identity for the row, e.g. "19:00". */
  key: string
  /** Row header text, e.g. "19:00". */
  label: string
  /** Optional second line, e.g. "60 dk". */
  subLabel?: string
}

/** Everything a cell renderer or a select handler needs to identify one intersection. */
export interface CalendarCell {
  day: CalendarDay
  slot: CalendarSlot
  dayIndex: number
  slotIndex: number
  /** True when the column, or `isCellDisabled`, marks this intersection unavailable. */
  isDisabled: boolean
}

export interface CalendarGridProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "onSelect" | "children"> {
  /** Columns, left to right. */
  days: readonly CalendarDay[]
  /** Rows, top to bottom. */
  slots: readonly CalendarSlot[]
  /** Cell body. Return a Badge, a price, a "Dolu" label — anything. */
  renderCell: (cell: CalendarCell) => React.ReactNode
  /** Click / Enter / Space on an enabled cell. Omit for a read-only grid. */
  onSelect?: (cell: CalendarCell) => void
  /** Per-cell availability, on top of `day.isDisabled`. */
  isCellDisabled?: (cell: CalendarCell) => boolean
  /** Accessible name for the grid, e.g. "Merkez Saha - haftalik takvim". */
  label?: string
  /** Width of the time-label gutter. */
  gutterWidth?: string
  /** Extra classes for every cell button. */
  cellClassName?: string
}

/** Roving-tabindex position. */
interface Focus {
  slotIndex: number
  dayIndex: number
}

function cellId(slotIndex: number, dayIndex: number): string {
  return `${slotIndex}:${dayIndex}`
}

function clamp(value: number, max: number): number {
  if (max < 0) return 0
  if (value < 0) return 0
  if (value > max) return max
  return value
}

const CalendarGrid = React.forwardRef<HTMLDivElement, CalendarGridProps>(function CalendarGrid(
  {
    days,
    slots,
    renderCell,
    onSelect,
    isCellDisabled,
    label,
    gutterWidth = "5rem",
    cellClassName,
    className,
    ...props
  },
  ref,
) {
  const [focus, setFocus] = React.useState<Focus>({ slotIndex: 0, dayIndex: 0 })
  const cellRefs = React.useRef(new Map<string, HTMLButtonElement>())

  const lastSlot = slots.length - 1
  const lastDay = days.length - 1

  // Shrinking the grid (a narrower week, fewer slots) must not strand the roving tabindex on
  // a cell that no longer exists, or the next arrow key would find nothing to focus.
  React.useEffect(() => {
    setFocus((current) => {
      const slotIndex = clamp(current.slotIndex, lastSlot)
      const dayIndex = clamp(current.dayIndex, lastDay)
      if (slotIndex === current.slotIndex && dayIndex === current.dayIndex) return current
      return { slotIndex, dayIndex }
    })
  }, [lastSlot, lastDay])

  const moveFocus = React.useCallback(
    (next: Focus) => {
      const target: Focus = {
        slotIndex: clamp(next.slotIndex, lastSlot),
        dayIndex: clamp(next.dayIndex, lastDay),
      }
      setFocus(target)
      cellRefs.current.get(cellId(target.slotIndex, target.dayIndex))?.focus()
    },
    [lastSlot, lastDay],
  )

  const buildCell = React.useCallback(
    (slotIndex: number, dayIndex: number): CalendarCell | null => {
      const slot = slots[slotIndex]
      const day = days[dayIndex]
      if (!slot || !day) return null
      const base: CalendarCell = { day, slot, dayIndex, slotIndex, isDisabled: day.isDisabled === true }
      return { ...base, isDisabled: base.isDisabled || isCellDisabled?.(base) === true }
    },
    [days, slots, isCellDisabled],
  )

  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, slotIndex: number, dayIndex: number) => {
      switch (event.key) {
        case "ArrowRight":
          event.preventDefault()
          moveFocus({ slotIndex, dayIndex: dayIndex + 1 })
          break
        case "ArrowLeft":
          event.preventDefault()
          moveFocus({ slotIndex, dayIndex: dayIndex - 1 })
          break
        case "ArrowDown":
          event.preventDefault()
          moveFocus({ slotIndex: slotIndex + 1, dayIndex })
          break
        case "ArrowUp":
          event.preventDefault()
          moveFocus({ slotIndex: slotIndex - 1, dayIndex })
          break
        case "Home":
          event.preventDefault()
          // Ctrl+Home jumps to the very first cell, plain Home to the start of the row.
          moveFocus(event.ctrlKey ? { slotIndex: 0, dayIndex: 0 } : { slotIndex, dayIndex: 0 })
          break
        case "End":
          event.preventDefault()
          moveFocus(
            event.ctrlKey
              ? { slotIndex: lastSlot, dayIndex: lastDay }
              : { slotIndex, dayIndex: lastDay },
          )
          break
        default:
          break
      }
    },
    [moveFocus, lastSlot, lastDay],
  )

  const templateColumns = `${gutterWidth} repeat(${Math.max(days.length, 1)}, minmax(0, 1fr))`

  if (days.length === 0 || slots.length === 0) {
    return (
      <div
        ref={ref}
        className={cn(
          "rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground",
          className,
        )}
        {...props}
      >
        Gösterilecek zaman aralığı yok.
      </div>
    )
  }

  return (
    <div ref={ref} className={cn("w-full overflow-x-auto", className)} {...props}>
      <div
        role="grid"
        aria-label={label}
        aria-readonly={onSelect ? undefined : true}
        className="min-w-[44rem] rounded-lg border bg-card text-card-foreground"
      >
        {/* ---- header row: day columns ---- */}
        <div
          role="row"
          className="sticky top-0 z-10 grid border-b bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/80"
          style={{ gridTemplateColumns: templateColumns }}
        >
          <div role="columnheader" className="p-2">
            <span className="sr-only">Saat</span>
          </div>
          {days.map((day) => (
            <div
              key={day.key}
              role="columnheader"
              aria-disabled={day.isDisabled === true ? true : undefined}
              className={cn(
                "border-l p-2 text-center",
                day.isDisabled === true && "opacity-50",
                day.isToday === true && "bg-primary/5",
              )}
            >
              <div
                className={cn(
                  "text-xs font-semibold uppercase tracking-wide",
                  day.isToday === true ? "text-primary" : "text-muted-foreground",
                )}
              >
                {day.label}
              </div>
              {day.subLabel ? (
                <div className="text-sm font-medium tabular-nums">{day.subLabel}</div>
              ) : null}
            </div>
          ))}
        </div>

        {/* ---- one row per slot ---- */}
        {slots.map((slot, slotIndex) => (
          <div
            key={slot.key}
            role="row"
            className="grid border-b last:border-b-0"
            style={{ gridTemplateColumns: templateColumns }}
          >
            <div
              role="rowheader"
              className="flex flex-col justify-center px-2 py-3 text-right text-xs tabular-nums text-muted-foreground"
            >
              <span className="font-medium text-foreground">{slot.label}</span>
              {slot.subLabel ? <span>{slot.subLabel}</span> : null}
            </div>

            {days.map((day, dayIndex) => {
              const cell = buildCell(slotIndex, dayIndex)
              if (!cell) return null
              const isFocusTarget = focus.slotIndex === slotIndex && focus.dayIndex === dayIndex
              return (
                <div key={day.key} role="gridcell" className="border-l p-1">
                  <button
                    type="button"
                    ref={(node) => {
                      const id = cellId(slotIndex, dayIndex)
                      if (node) cellRefs.current.set(id, node)
                      else cellRefs.current.delete(id)
                    }}
                    // Roving tabindex: exactly one cell in the whole grid is in the tab
                    // order, and the arrow keys move it. Without this a 7x15 grid would
                    // cost a keyboard user 105 tab stops to walk past.
                    tabIndex={isFocusTarget ? 0 : -1}
                    // aria-disabled rather than `disabled`: a disabled button drops out of
                    // the focus order, which would punch holes in the arrow-key traversal.
                    aria-disabled={cell.isDisabled || undefined}
                    onFocus={() => setFocus({ slotIndex, dayIndex })}
                    onKeyDown={(event) => handleKeyDown(event, slotIndex, dayIndex)}
                    onClick={() => {
                      if (cell.isDisabled) return
                      onSelect?.(cell)
                    }}
                    className={cn(
                      "flex h-full min-h-[3rem] w-full items-center justify-center rounded-md px-1 py-2 text-xs transition-colors",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                      cell.isDisabled
                        ? "cursor-not-allowed bg-muted/40 text-muted-foreground"
                        : onSelect
                          ? "cursor-pointer hover:bg-accent hover:text-accent-foreground"
                          : "cursor-default",
                      cellClassName,
                    )}
                  >
                    {renderCell(cell)}
                  </button>
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
})

export { CalendarGrid }
