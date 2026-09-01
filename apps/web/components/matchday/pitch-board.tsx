"use client"

/**
 * components/matchday/pitch-board.tsx
 *
 * The 2D pitch with one button per formation slot.
 *
 * HTML buttons over an SVG pitch rather than an all-SVG board: every slot is a real, focusable,
 * 44px-plus control with an accessible name ("DEF 2: #4 Can — dokunarak seç"), keyboard users
 * can tab through the line-up, and the drag layer is optional sugar on top.
 *
 * The board is presentational. It reports taps and drops; the plan helpers decide what they mean.
 */

import type { PointerEvent as ReactPointerEvent } from "react"

import type { Formation, LineupAssignment, Player } from "@halisaha/shared/matchday"
import { cn } from "@/lib/utils"

export interface PitchBoardProps {
  formation: Formation
  lineup: LineupAssignment[]
  players: Player[]
  /** Player the coach has picked up (bench or pitch). */
  selectedPlayerId?: string | null
  /** Slot the drag layer is hovering. */
  hoverSlotId?: string | null
  onSlotTap?: (slotId: string, occupantId: string | null) => void
  onTokenPointerDown?: (event: ReactPointerEvent<HTMLElement>, playerId: string) => void
  /** Read-only rendering (live panel, print). */
  readOnly?: boolean
  className?: string
}

export function PitchBoard({
  formation,
  lineup,
  players,
  selectedPlayerId = null,
  hoverSlotId = null,
  onSlotTap,
  onTokenPointerDown,
  readOnly = false,
  className,
}: PitchBoardProps) {
  const byId = new Map(players.map((player) => [player.id, player]))
  const bySlot = new Map(lineup.map((entry) => [entry.slotId, entry.playerId]))

  return (
    <div
      className={cn(
        "relative mx-auto w-full max-w-[480px] select-none overflow-hidden rounded-md border border-foreground/10 shadow-sm",
        "aspect-[3/4] bg-[#1d5a3a]",
        className,
      )}
      role="group"
      aria-label={`Saha, ${formation.name}`}
    >
      <PitchMarkings />

      {formation.slots.map((slot) => {
        const occupantId = bySlot.get(slot.id) ?? null
        const occupant = occupantId ? (byId.get(occupantId) ?? null) : null
        const isSelected = Boolean(occupantId && occupantId === selectedPlayerId)
        const isTarget = hoverSlotId === slot.id || (Boolean(selectedPlayerId) && !isSelected)
        const isKeeper = slot.role === "GK"

        const label = occupant
          ? `${slot.label}: ${occupant.number !== null ? `#${occupant.number} ` : ""}${occupant.name}`
          : `${slot.label}: boş`

        return (
          <button
            key={slot.id}
            type="button"
            data-slot-id={slot.id}
            disabled={readOnly}
            aria-label={readOnly ? label : `${label}. ${occupant ? "Seçmek ya da taşımak için dokun" : "Seçili oyuncuyu buraya koymak için dokun"}`}
            aria-pressed={isSelected}
            onClick={() => onSlotTap?.(slot.id, occupantId)}
            onPointerDown={(event) => {
              if (occupantId && onTokenPointerDown) onTokenPointerDown(event, occupantId)
            }}
            style={{ left: `${slot.x}%`, top: `${slot.y}%`, touchAction: "none" }}
            className={cn(
              "absolute flex min-h-11 min-w-11 -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center gap-0.5",
              "rounded-full transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-2 focus-visible:ring-offset-[#1d5a3a]",
              readOnly ? "cursor-default" : "cursor-pointer active:scale-95",
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                "grid size-11 place-items-center rounded-full font-mono text-base font-bold tabular-nums shadow-md sm:size-12",
                occupant
                  ? isKeeper
                    ? "bg-gold text-primary-foreground"
                    : "bg-[#f6f1e7] text-[#1b2230]"
                  : "border-2 border-dashed border-[#f6f1e7]/70 bg-[#f6f1e7]/10 text-[#f6f1e7]/90 text-[11px] font-semibold",
                isSelected && "ring-4 ring-gold ring-offset-2 ring-offset-[#1d5a3a]",
                isTarget && !occupant && "border-solid bg-[#f6f1e7]/25",
                hoverSlotId === slot.id && "scale-110 ring-4 ring-teal",
              )}
            >
              {occupant ? (occupant.number !== null ? occupant.number : initials(occupant.name)) : slot.label}
            </span>
            <span
              aria-hidden="true"
              className={cn(
                "max-w-[84px] truncate rounded-sm px-1.5 py-0.5 text-[11px] font-semibold leading-tight",
                occupant ? "bg-[#0f1520]/80 text-[#f6f1e7]" : "text-[#f6f1e7]/70",
              )}
            >
              {occupant ? shortName(occupant.name) : slot.label}
            </span>
          </button>
        )
      })}
    </div>
  )
}

function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toLocaleUpperCase("tr-TR") ?? "")
    .join("")
}

function shortName(name: string): string {
  const parts = name.trim().split(/\s+/)
  if (parts.length < 2) return name.trim()
  return `${parts[0]} ${parts[parts.length - 1]?.charAt(0).toLocaleUpperCase("tr-TR")}.`
}

/** Pitch lines as a background SVG. Our goal is at the bottom. */
function PitchMarkings() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 300 400"
      preserveAspectRatio="none"
      className="pointer-events-none absolute inset-0 size-full"
      fill="none"
      stroke="rgba(246,241,231,0.75)"
      strokeWidth="2"
    >
      <rect x="6" y="6" width="288" height="388" />
      <line x1="6" y1="200" x2="294" y2="200" />
      <circle cx="150" cy="200" r="36" />
      <rect x="63" y="6" width="174" height="60" />
      <rect x="111" y="6" width="78" height="20" />
      <rect x="63" y="334" width="174" height="60" />
      <rect x="111" y="374" width="78" height="20" />
      <path d="M 120 66 A 30 30 0 0 0 180 66" />
      <path d="M 120 334 A 30 30 0 0 1 180 334" />
    </svg>
  )
}
