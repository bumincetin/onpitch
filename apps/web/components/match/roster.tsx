"use client"

/**
 * components/match/roster.tsx
 *
 * The two line-ups, with an optional "who is here right now" overlay.
 *
 * Two facts are shown side by side and they must never be confused:
 *
 *   CHECKED IN   `match_participants.is_confirmed` — a durable row in Postgres, written by the
 *                player themselves (the RLS insert policy pins `is_confirmed = false`, so nobody
 *                confirms attendance on someone else's behalf). This is what quorum counts.
 *
 *   HERE NOW     Realtime presence — ephemeral, client-authored, gone when the socket closes. A
 *                nice signal that the game is filling up. Evidence of nothing.
 *
 * The component renders both, labels them differently, and never lets the second stand in for the
 * first.
 *
 * ---------------------------------------------------------------------------------------------
 * ONE SUBSCRIPTION PER MATCH
 * ---------------------------------------------------------------------------------------------
 *
 * Realtime allows one channel per topic per client. If the page already owns a match channel (the
 * live scoreboard does), pass its `presence` map down as a prop and leave `live` false. Only set
 * `live` when this component is the ONLY thing on the page that wants the match channel.
 */

import Link from "next/link"

import { MessageButton } from "@/components/messaging/message-button"
import { usePresence } from "@/lib/realtime/use-presence"
import type { MatchPresencePayload } from "@onpitch/shared/channels"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"

/* -------------------------------------------------------------------------- */

export interface RosterPlayer {
  playerId: string
  displayName: string | null
  teamSide: "home" | "away" | null
  isConfirmed: boolean
  jerseyNumber?: number | null
  /** `player_ratings.conservative_rating`, i.e. mu − 3σ. */
  conservativeRating?: number | null
  isSelf?: boolean
}

export interface RosterProps {
  matchId: string
  players: RosterPlayer[]
  homeTeamName?: string | null
  awayTeamName?: string | null
  /** Nominal places per side, from the match format. Drives "5 of 7". */
  capacityPerSide?: number | null
  /**
   * Presence supplied by whoever owns the match channel on this page. When present, this
   * component does NOT subscribe.
   */
  presence?: Record<string, MatchPresencePayload>
  /** Subscribe to presence here. Only valid when nothing else on the page holds the channel. */
  live?: boolean
  /** What to publish about the viewer when `live` is set. */
  self?: MatchPresencePayload | null
  className?: string
}

const RATING_FORMAT = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
})

function initials(name: string | null, fallback: string): string {
  const source = (name ?? "").trim()
  if (!source) return fallback.slice(0, 2).toUpperCase()
  const parts = source.split(/\s+/).slice(0, 2)
  return parts.map((part) => part[0]?.toUpperCase() ?? "").join("") || fallback.slice(0, 2).toUpperCase()
}

/* -------------------------------------------------------------------------- */

export function Roster({
  matchId,
  players,
  homeTeamName,
  awayTeamName,
  capacityPerSide,
  presence,
  live = false,
  self = null,
  className,
}: RosterProps) {
  // Called unconditionally — `enabled` is the switch, not an `if`, so the rules of hooks hold and
  // a page that already owns the channel never opens a second one.
  const ownPresence = usePresence({
    matchId,
    self,
    enabled: live && presence === undefined,
  })

  const presenceMap = presence ?? ownPresence.byId

  const home = players.filter((player) => player.teamSide === "home")
  const away = players.filter((player) => player.teamSide === "away")
  const unassigned = players.filter((player) => player.teamSide !== "home" && player.teamSide !== "away")

  const hereCount = players.filter((player) =>
    Object.prototype.hasOwnProperty.call(presenceMap, player.playerId.toLowerCase()),
  ).length

  return (
    <Card className={className}>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base">Kadro</CardTitle>
            <CardDescription>
              {players.length} {players.length === 1 ? "player" : "players"} ·{" "}
              {players.filter((player) => player.isConfirmed).length} checked in
            </CardDescription>
          </div>
          {hereCount > 0 ? (
            <Badge variant="outline" className="shrink-0 gap-1.5">
              <span
                aria-hidden="true"
                className="inline-block size-1.5 rounded-full bg-emerald-500"
              />
              {hereCount} here now
            </Badge>
          ) : null}
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <RosterSide
            title={homeTeamName ?? "Home"}
            side="home"
            players={home}
            capacity={capacityPerSide}
            presenceMap={presenceMap}
          />
          <RosterSide
            title={awayTeamName ?? "Away"}
            side="away"
            players={away}
            capacity={capacityPerSide}
            presenceMap={presenceMap}
          />
        </div>

        {unassigned.length > 0 ? (
          <>
            <Separator />
            <RosterSide
              title="Henüz bir tarafa atanmadı"
              side={null}
              players={unassigned}
              capacity={null}
              presenceMap={presenceMap}
            />
          </>
        ) : null}

        <p className="text-xs leading-relaxed text-muted-foreground">
          <span className="font-medium text-foreground">Sahada</span> veritabanındaki bir kayıttır
          ve uzlaşma oylamasında sayılan şeydir.{" "}
          <span className="font-medium text-foreground">Şu an burada</span> ise yalnızca birinin bu
          maçı bir cihazda açık tuttuğu anlamına gelir — kişi ekranı kapattığında kaybolur ve
          hiçbir şeye sayılmaz.
        </p>
      </CardContent>
    </Card>
  )
}

/* -------------------------------------------------------------------------- */

function RosterSide({
  title,
  side,
  players,
  capacity,
  presenceMap,
}: {
  title: string
  side: "home" | "away" | null
  players: RosterPlayer[]
  capacity?: number | null
  presenceMap: Record<string, MatchPresencePayload>
}) {
  const headingId = `roster-${side ?? "unassigned"}`

  return (
    <section aria-labelledby={headingId} className="space-y-2">
      <h3 id={headingId} className="flex items-baseline justify-between gap-2 text-sm font-medium">
        <span className="truncate">{title}</span>
        {typeof capacity === "number" ? (
          <span className="shrink-0 text-xs font-normal tabular-nums text-muted-foreground">
            {players.length}/{capacity}
          </span>
        ) : null}
      </h3>

      {players.length === 0 ? (
        <p className="rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
          Henüz kimse yok.
        </p>
      ) : (
        <ul className="space-y-1">
          {players.map((player) => {
            const here = Object.prototype.hasOwnProperty.call(presenceMap, player.playerId.toLowerCase())
            return (
              <li
                key={player.playerId}
                className={cn(
                  "flex items-center gap-2.5 rounded-md px-2 py-1.5",
                  player.isSelf && "bg-muted/60",
                )}
              >
                <span
                  aria-hidden="true"
                  className="grid size-7 shrink-0 place-items-center rounded-full bg-muted text-[11px] font-semibold uppercase text-muted-foreground"
                >
                  {initials(player.displayName, player.playerId)}
                </span>

                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <Link
                      href={`/players/${player.playerId}`}
                      className="truncate text-sm hover:underline"
                    >
                      {player.displayName ?? "Anonymous player"}
                    </Link>
                    {player.isSelf ? (
                      <span className="shrink-0 text-[11px] text-muted-foreground">(you)</span>
                    ) : null}
                  </span>

                  <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
                    {typeof player.jerseyNumber === "number" ? (
                      <span className="tabular-nums">#{player.jerseyNumber}</span>
                    ) : null}
                    {typeof player.conservativeRating === "number" ? (
                      <span className="tabular-nums" title="Güvenli reyting (mu − 3σ)">
                        {RATING_FORMAT.format(player.conservativeRating)}
                      </span>
                    ) : null}
                  </span>
                </span>

                <span className="flex shrink-0 items-center gap-1.5">
                  {!player.isSelf ? (
                    <MessageButton userId={player.playerId} variant="icon" className="size-9" />
                  ) : null}
                  {here ? (
                    <span
                      className="inline-block size-1.5 rounded-full bg-emerald-500"
                      title="Bu maçı şu an açık tutuyor"
                    >
                      <span className="sr-only">Şu an burada</span>
                    </span>
                  ) : null}
                  {player.isConfirmed ? (
                    <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
                      Sahada
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="px-1.5 py-0 text-[10px] text-muted-foreground">
                      Gelmedi
                    </Badge>
                  )}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

/* -------------------------------------------------------------------------- */

export function RosterSkeleton() {
  return (
    <Card aria-hidden="true">
      <CardHeader className="pb-3">
        <div className="h-5 w-24 animate-pulse rounded bg-muted" />
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-2">
        {[0, 1].map((column) => (
          <div key={column} className="space-y-2">
            <div className="h-4 w-20 animate-pulse rounded bg-muted" />
            {[0, 1, 2].map((row) => (
              <div key={row} className="flex items-center gap-2.5">
                <div className="size-7 shrink-0 animate-pulse rounded-full bg-muted" />
                <div className="h-4 flex-1 animate-pulse rounded bg-muted" />
              </div>
            ))}
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
