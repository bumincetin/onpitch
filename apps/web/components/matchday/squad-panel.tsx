"use client"

/**
 * components/matchday/squad-panel.tsx
 *
 * Availability check-in and squad editing. One row per player: number, name, the three-way
 * availability toggle, preferred positions, remove. Every control is at least 44px tall, because
 * this is tapped on a phone in a car park ten minutes before kickoff.
 */

import { useState } from "react"
import { Trash2, UserPlus } from "lucide-react"

import {
  PLAYER_STATUSES,
  PLAYER_STATUS_LABEL,
  POSITIONS,
  POSITION_SHORT,
  type Player,
  type PlayerStatus,
  type Position,
} from "@halisaha/shared/matchday"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"

export interface SquadPanelProps {
  squad: Player[]
  onStatusChange: (playerId: string, status: PlayerStatus) => void
  onNameChange: (playerId: string, name: string) => void
  onNumberChange: (playerId: string, number: number | null) => void
  onTogglePosition: (playerId: string, position: Position) => void
  onAdd: (input: { name: string; number: number | null }) => void
  onRemove: (playerId: string) => void
}

const STATUS_STYLE: Record<PlayerStatus, string> = {
  available: "data-[on=true]:bg-teal data-[on=true]:text-white",
  injured: "data-[on=true]:bg-gold data-[on=true]:text-primary-foreground",
  absent: "data-[on=true]:bg-muted-foreground data-[on=true]:text-background",
}

export function SquadPanel({
  squad,
  onStatusChange,
  onNameChange,
  onNumberChange,
  onTogglePosition,
  onAdd,
  onRemove,
}: SquadPanelProps) {
  const [newName, setNewName] = useState("")
  const [newNumber, setNewNumber] = useState("")

  const available = squad.filter((player) => player.status === "available").length

  function submitAdd() {
    const number = newNumber.trim() === "" ? null : Number.parseInt(newNumber, 10)
    onAdd({ name: newName, number: Number.isNaN(number as number) ? null : number })
    setNewName("")
    setNewNumber("")
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        <span className="font-medium text-foreground">{available}</span> / {squad.length} oyuncu hazır.
        Durumu değiştirmek için dokun; sakat ya da gelmeyen oyuncu dizilişten ve rotasyondan düşer.
      </p>

      <ul className="divide-y rounded-md border">
        {squad.map((player) => (
          <li key={player.id} className="space-y-3 p-3">
            <div className="flex items-center gap-2">
              <Input
                inputMode="numeric"
                aria-label={`${player.name} forma numarası`}
                value={player.number ?? ""}
                placeholder="#"
                onChange={(event) => {
                  const raw = event.target.value.replace(/\D/g, "")
                  onNumberChange(player.id, raw === "" ? null : Number.parseInt(raw, 10))
                }}
                className="h-11 w-16 text-center font-mono tabular-nums"
              />
              <Input
                aria-label="Oyuncu adı"
                value={player.name}
                onChange={(event) => onNameChange(player.id, event.target.value)}
                className="h-11 flex-1"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-11 shrink-0 text-muted-foreground hover:text-destructive"
                aria-label={`${player.name} oyuncusunu kadrodan çıkar`}
                onClick={() => onRemove(player.id)}
              >
                <Trash2 />
              </Button>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <div role="group" aria-label={`${player.name} durumu`} className="grid flex-1 grid-cols-3 gap-1">
                {PLAYER_STATUSES.map((status) => (
                  <button
                    key={status}
                    type="button"
                    data-on={player.status === status}
                    aria-pressed={player.status === status}
                    onClick={() => onStatusChange(player.id, status)}
                    className={cn(
                      "min-h-11 rounded-md border px-2 text-sm font-medium transition-colors",
                      "hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      STATUS_STYLE[status],
                    )}
                  >
                    {PLAYER_STATUS_LABEL[status]}
                  </button>
                ))}
              </div>

              <div role="group" aria-label={`${player.name} tercih ettiği mevkiler`} className="flex gap-1">
                {POSITIONS.map((position) => {
                  const on = player.preferredPositions.includes(position)
                  return (
                    <button
                      key={position}
                      type="button"
                      aria-pressed={on}
                      onClick={() => onTogglePosition(player.id, position)}
                      className={cn(
                        "min-h-11 min-w-11 rounded-md border px-2 font-mono text-xs font-semibold transition-colors",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        on ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent",
                      )}
                    >
                      {POSITION_SHORT[position]}
                    </button>
                  )
                })}
              </div>
            </div>
          </li>
        ))}
        {squad.length === 0 ? (
          <li className="p-6 text-center text-sm text-muted-foreground">Kadro boş. Aşağıdan oyuncu ekle.</li>
        ) : null}
      </ul>

      <form
        className="flex flex-wrap items-end gap-2 rounded-md border border-dashed p-3"
        onSubmit={(event) => {
          event.preventDefault()
          submitAdd()
        }}
      >
        <div className="w-20 space-y-1">
          <Label htmlFor="new-player-number" className="text-xs">
            No
          </Label>
          <Input
            id="new-player-number"
            inputMode="numeric"
            value={newNumber}
            onChange={(event) => setNewNumber(event.target.value.replace(/\D/g, ""))}
            className="h-11 text-center font-mono"
          />
        </div>
        <div className="min-w-[10rem] flex-1 space-y-1">
          <Label htmlFor="new-player-name" className="text-xs">
            Oyuncu ekle
          </Label>
          <Input
            id="new-player-name"
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            placeholder="Ad Soyad"
            className="h-11"
          />
        </div>
        <Button type="submit" className="h-11" disabled={!newName.trim()}>
          <UserPlus />
          Ekle
        </Button>
      </form>
    </div>
  )
}
