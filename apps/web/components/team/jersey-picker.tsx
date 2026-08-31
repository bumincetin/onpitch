"use client"

/**
 * components/team/jersey-picker.tsx
 *
 * Pick a squad number, 1 to 99, without offering one that is already worn.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY A GRID AND NOT A DROPDOWN
 * ---------------------------------------------------------------------------------------------
 * The question a player actually asks is "is 10 free?", and a list of 99 options answers it one
 * scroll at a time. A grid answers it at a glance: taken numbers are visibly out, and the one you
 * are wearing is highlighted. It is also the layout a squad list is printed in, so it reads the
 * way the thing it represents does.
 *
 * ---------------------------------------------------------------------------------------------
 * THE DISABLED STATE IS A COURTESY, NOT A CHECK
 * ---------------------------------------------------------------------------------------------
 * `uq_team_members_jersey` is a partial unique index on `(team_id, jersey_number)` where the
 * member is active. Two captains can pick 10 in the same second and this component cannot know
 * that, so the routes treat SQLSTATE 23505 as "that number is taken" and answer 409. What is
 * greyed out here is what was taken when the page rendered — it removes the obvious mistakes, and
 * the database settles the race.
 *
 * `taken` is filtered against `value` internally: the number you are already wearing must stay
 * selectable, or reopening the picker would show your own shirt as unavailable.
 */

import { useCallback, useMemo, useState } from "react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"

/** The CHECK on `team_members.jersey_number`: `between 1 and 99`. */
export const MIN_JERSEY = 1
export const MAX_JERSEY = 99

const ALL_NUMBERS: readonly number[] = Array.from(
  { length: MAX_JERSEY - MIN_JERSEY + 1 },
  (_, index) => MIN_JERSEY + index,
)

export interface JerseyPickerProps {
  /** The number currently worn, or `null` for none. */
  value: number | null
  /** Numbers worn by other ACTIVE members. The wearer's own number is ignored. */
  taken: readonly number[]
  onChange: (value: number | null) => void
  disabled?: boolean
  /** Applied to the trigger, so a <Label htmlFor> can point at it. */
  id?: string
  /** Whose shirt this is, for the dialog title and the trigger's accessible name. */
  playerName?: string
  className?: string
}

export function JerseyPicker({
  value,
  taken,
  onChange,
  disabled = false,
  id,
  playerName,
  className,
}: JerseyPickerProps) {
  const [open, setOpen] = useState(false)

  const unavailable = useMemo(() => {
    const set = new Set(taken)
    if (value !== null) set.delete(value)
    return set
  }, [taken, value])

  const choose = useCallback(
    (next: number | null) => {
      setOpen(false)
      if (next !== value) onChange(next)
    },
    [onChange, value],
  )

  const triggerLabel = value === null ? "—" : String(value)
  const accessibleName = playerName
    ? `Kadro number for ${playerName}: ${value === null ? "none" : value}`
    : `Kadro number: ${value === null ? "none" : value}`

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          aria-label={accessibleName}
          className={cn("w-14 justify-center tabular-nums", className)}
        >
          {triggerLabel}
        </Button>
      </DialogTrigger>

      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{playerName ? `Kadro number for ${playerName}` : "Kadro number"}</DialogTitle>
          <DialogDescription>
            Soluk numaralar aktif kadroda başkasının üzerinde. İki kişi aynı anda aynı numarayı seçerse, ikinci kaydedene yeniden seçmesi söylenir.
          </DialogDescription>
        </DialogHeader>

        <div
          role="group"
          aria-label="Forma numaraları"
          className="grid grid-cols-8 gap-1.5 sm:grid-cols-10"
        >
          {ALL_NUMBERS.map((number) => {
            const isTaken = unavailable.has(number)
            const isCurrent = number === value

            return (
              <button
                key={number}
                type="button"
                disabled={isTaken}
                aria-pressed={isCurrent}
                onClick={() => choose(number)}
                className={cn(
                  "h-9 rounded-md border text-sm font-medium tabular-nums transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
                  isCurrent && "border-primary bg-primary text-primary-foreground",
                  !isCurrent && !isTaken && "hover:bg-accent hover:text-accent-foreground",
                  isTaken && "cursor-not-allowed border-dashed text-muted-foreground/50",
                )}
              >
                {number}
                {isTaken ? <span className="sr-only"> (taken)</span> : null}
              </button>
            )
          })}
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <Button type="button" variant="ghost" onClick={() => choose(null)}>
            Numarasız oyna
          </Button>
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>
            Vazgeç
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
