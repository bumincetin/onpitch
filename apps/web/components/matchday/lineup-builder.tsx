"use client"

/**
 * components/matchday/lineup-builder.tsx
 *
 * Formation picker + pitch board + bench. Two ways to place a player, both always available:
 *
 *   2-tap    tap a name on the bench (or a token on the pitch), then tap the slot it goes in.
 *   drag     press a token or bench chip and drop it on a slot.
 *
 * All edits go through `lib/matchday/plan.ts`, which also recomputes the rotation schedule, so
 * the rotation tab is never stale.
 */

import { useCallback, useState } from "react"
import { Sparkles, Undo2 } from "lucide-react"

import { formationsFor, type PreMatchPlan } from "@halisaha/shared/matchday"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  assignToSlot,
  autoFillLineup,
  benchOf,
  benchPlayer,
  clearSlot,
  displayName,
  formationOf,
  playerById,
  setFormation,
} from "@/lib/matchday/plan"
import { cn } from "@/lib/utils"

import { PitchBoard } from "./pitch-board"
import { useDragToSlot } from "./use-drag-to-slot"

export interface LineupBuilderProps {
  plan: PreMatchPlan
  onChange: (plan: PreMatchPlan) => void
}

export function LineupBuilder({ plan, onChange }: LineupBuilderProps) {
  const formation = formationOf(plan)
  const bench = benchOf(plan)
  const [selectedPlayerId, setSelectedPlayerId] = useState<string | null>(null)
  const selected = playerById(plan, selectedPlayerId)
  const selectedOnPitch = Boolean(selectedPlayerId && plan.startingLineup.some((entry) => entry.playerId === selectedPlayerId))

  const onDrop = useCallback(
    (playerId: string, slotId: string) => {
      onChange(assignToSlot(plan, slotId, playerId))
      setSelectedPlayerId(null)
    },
    [plan, onChange],
  )
  const { drag, hoverSlotId, startDrag, justDropped } = useDragToSlot(onDrop)
  const dragging = drag?.active ? playerById(plan, drag.playerId) : null

  function onSlotTap(slotId: string, occupantId: string | null) {
    if (justDropped()) return
    if (selectedPlayerId) {
      if (occupantId === selectedPlayerId) {
        setSelectedPlayerId(null)
        return
      }
      onChange(assignToSlot(plan, slotId, selectedPlayerId))
      setSelectedPlayerId(null)
      return
    }
    if (occupantId) setSelectedPlayerId(occupantId)
  }

  const available = plan.squad.filter((player) => player.status === "available").length
  const filled = plan.startingLineup.length

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[12rem] flex-1 space-y-1">
          <Label htmlFor="formation">Diziliş</Label>
          <Select value={plan.formationId} onValueChange={(value) => onChange(setFormation(plan, value))}>
            <SelectTrigger id="formation" className="h-11">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {formationsFor(formation.format).map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  {option.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button type="button" variant="outline" className="h-11" onClick={() => onChange(autoFillLineup(plan))}>
          <Sparkles />
          Boşlukları doldur
        </Button>
      </div>

      <p className="text-sm text-muted-foreground" aria-live="polite">
        {filled}/{formation.slots.length} mevki dolu · {available} oyuncu hazır.{" "}
        {selected ? (
          <span className="font-medium text-foreground">
            {displayName(selected)} seçili — gideceği mevkiye dokun.
          </span>
        ) : (
          "Bir oyuncuya, sonra bir mevkiye dokun; ya da sürükle."
        )}
      </p>

      <PitchBoard
        formation={formation}
        lineup={plan.startingLineup}
        players={plan.squad}
        selectedPlayerId={selectedPlayerId}
        hoverSlotId={hoverSlotId}
        onSlotTap={onSlotTap}
        onTokenPointerDown={startDrag}
      />

      {selected ? (
        <div className="flex flex-wrap gap-2">
          {selectedOnPitch ? (
            <Button
              type="button"
              variant="outline"
              className="h-11"
              onClick={() => {
                onChange(benchPlayer(plan, selected.id))
                setSelectedPlayerId(null)
              }}
            >
              <Undo2 />
              {displayName(selected)} kenara
            </Button>
          ) : null}
          <Button type="button" variant="ghost" className="h-11" onClick={() => setSelectedPlayerId(null)}>
            Seçimi bırak
          </Button>
        </div>
      ) : null}

      <section aria-labelledby="bench-heading" className="space-y-2">
        <h3 id="bench-heading" className="text-sm font-medium">
          Yedek kulübesi <span className="font-normal text-muted-foreground">({bench.length})</span>
        </h3>
        {bench.length === 0 ? (
          <p className="rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
            Hazır oyuncuların hepsi sahada.
          </p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {bench.map((player) => {
              const isSelected = player.id === selectedPlayerId
              return (
                <li key={player.id}>
                  <button
                    type="button"
                    aria-pressed={isSelected}
                    onClick={() => !justDropped() && setSelectedPlayerId(isSelected ? null : player.id)}
                    onPointerDown={(event) => startDrag(event, player.id)}
                    style={{ touchAction: "none" }}
                    className={cn(
                      "flex min-h-11 items-center gap-2 rounded-md border bg-card px-3 text-sm font-medium transition-colors",
                      "hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      isSelected && "border-gold ring-2 ring-gold",
                    )}
                  >
                    <span className="grid size-7 place-items-center rounded-full bg-muted font-mono text-xs font-bold tabular-nums">
                      {player.number ?? "–"}
                    </span>
                    {player.name}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {/* Clearing a slot is also reachable without selecting anyone. */}
      {plan.startingLineup.length > 0 ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">Mevki boşalt</summary>
          <ul className="mt-2 flex flex-wrap gap-2">
            {plan.startingLineup.map((entry) => (
              <li key={entry.slotId}>
                <Button type="button" variant="outline" size="sm" className="h-11" onClick={() => onChange(clearSlot(plan, entry.slotId))}>
                  {formation.slots.find((slot) => slot.id === entry.slotId)?.label}: {displayName(playerById(plan, entry.playerId))} ✕
                </Button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {/* Drag ghost. */}
      {dragging && drag ? (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-1/2 rounded-full bg-gold px-3 py-2 font-mono text-sm font-bold text-primary-foreground shadow-lg"
          style={{ left: drag.x, top: drag.y }}
        >
          {dragging.number ?? dragging.name}
        </div>
      ) : null}
    </div>
  )
}
