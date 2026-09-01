"use client"

/**
 * components/match/live-scoreboard.tsx
 *
 * The screen somebody props against a fence at the side of the pitch.
 *
 * ---------------------------------------------------------------------------------------------
 * TWO NUMBERS, AND WHY THEY ARE NOT THE SAME NUMBER
 * ---------------------------------------------------------------------------------------------
 *
 * There is a LIVE TALLY and there is a CONFIRMED SCORE, and this component keeps them visibly
 * apart because the database does:
 *
 *   LIVE TALLY       Broadcast only. A participant taps "+1", every watching device paints it in
 *                    ~50ms, and nothing is written anywhere. It cannot be written: `home_score`
 *                    and `away_score` appear in NO column-level UPDATE grant (0002_rls.sql §4) —
 *                    "a result can only ever enter the system through `score_reports`". Ephemeral
 *                    by construction, lossy by transport, and labelled as such.
 *
 *   CONFIRMED SCORE  The `matches` row. Arrives via Postgres Changes and the server-side
 *                    broadcast, reconciled last-write-wins on `updated_at`. It only becomes
 *                    non-null after the result is reported and agreed.
 *
 * So the "+1" buttons do exactly what the task of a live scoreboard is — keep everyone at the
 * pitch looking at the same number — and full time hands that number to the score reporter, which
 * is the one path that persists.
 *
 * ---------------------------------------------------------------------------------------------
 * ACCESSIBILITY
 * ---------------------------------------------------------------------------------------------
 *
 * The score is announced through a single `aria-live="polite"` region carrying a whole sentence
 * ("Riverside 2, Vardar 1 (unconfirmed running score)."). Marking the digits themselves as live would make
 * a screen reader read "2" into the middle of whatever the user was doing. Polite, not assertive:
 * a goal is not an emergency, and assertive would interrupt them mid-word.
 *
 * The clock is NOT live — a region that changes every second is unusable with a screen reader —
 * it carries `aria-hidden` on the ticking digits and is left out of the score sentence entirely,
 * so that sentence only changes when the score does.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"

import { useMatchChannel, type LiveTally } from "@/lib/realtime/use-match-channel"
import { CONNECTION_LABEL, type MatchPresencePayload } from "@halisaha/shared/channels"
import { MATCH_FORMAT_LABEL, MATCH_STATUS_META } from "@/components/match/match-card"
import { Roster, type RosterPlayer } from "@/components/match/roster"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import type { Enums } from "@halisaha/shared/database"

/* -------------------------------------------------------------------------- */

export interface LiveScoreboardMatch {
  id: string
  kickoff_at: string
  duration_minutes: number
  format: Enums<"match_format">
  status: Enums<"match_status">
  home_score: number | null
  away_score: number | null
  is_ranked: boolean
  updated_at: string
}

export interface LiveScoreboardProps {
  match: LiveScoreboardMatch
  homeTeamName?: string | null
  awayTeamName?: string | null
  /** The line-up, server-rendered. Presence is layered on top of it. */
  participants: RosterPlayer[]
  /**
   * Who is watching. `null` for a spectator, who gets the scoreboard read-only and does not
   * appear in presence.
   */
  viewer: MatchPresencePayload | null
  /**
   * May this viewer push tally ticks? Mirror of the `rt_match_public_write` policy: participants,
   * the venue owner of the match, admins. Getting it wrong here is a cosmetic bug, not a hole —
   * the broadcast is refused server-side either way.
   */
  canScore: boolean
  /** Where "report the final score" goes. */
  reportHref?: string
  /**
   * Observe the unofficial tally as it changes, from this device or any other. Used by the
   * matchday companion to keep a local session for the debrief; the scoreboard itself is
   * unaffected by whether anyone listens.
   */
  onTallyChange?: (tally: LiveTally | null) => void
  className?: string
}

/* -------------------------------------------------------------------------- */

const CONNECTION_DOT: Record<string, string> = {
  connected: "bg-emerald-500",
  connecting: "bg-amber-500 animate-pulse",
  reconnecting: "bg-amber-500 animate-pulse",
  offline: "bg-destructive",
  disabled: "bg-muted-foreground",
}

/** Statuses during which a live tally makes any sense at all. */
const TALLYABLE: ReadonlySet<Enums<"match_status">> = new Set<Enums<"match_status">>([
  "scheduled",
  "live",
  "awaiting_report",
])

function pad(value: number): string {
  return value.toString().padStart(2, "0")
}

/* -------------------------------------------------------------------------- */

export function LiveScoreboard({
  match,
  homeTeamName,
  awayTeamName,
  participants,
  viewer,
  canScore,
  reportHref,
  onTallyChange,
  className,
}: LiveScoreboardProps) {
  const home = homeTeamName ?? "Home"
  const away = awayTeamName ?? "Away"

  const channel = useMatchChannel({
    matchId: match.id,
    presence: viewer,
    initial: {
      homeScore: match.home_score,
      awayScore: match.away_score,
      status: match.status,
      updatedAt: match.updated_at,
    },
  })

  const { score, status, connection, tally, presence, error, broadcastScore, resync } = channel

  const [sendWarning, setSendWarning] = useState<string | null>(null)

  useEffect(() => {
    onTallyChange?.(tally)
  }, [tally, onTallyChange])

  /* ---- the clock ------------------------------------------------------- */

  /*
   * `null` on the server and on the first client render, so the markup matches and React does not
   * throw a hydration mismatch. The clock only exists once the browser has a tick.
   */
  const [now, setNow] = useState<number | null>(null)

  useEffect(() => {
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [])

  const clock = useMemo(() => {
    if (now === null) return { text: "--:--", label: "", phase: "pending" as const }

    const kickoff = Date.parse(match.kickoff_at)
    if (Number.isNaN(kickoff)) return { text: "--:--", label: "", phase: "pending" as const }

    if (status === "cancelled") return { text: "—", label: "İptal edildi", phase: "over" as const }
    if (status === "finalized") return { text: "FT", label: "Maç sonu", phase: "over" as const }

    if (now < kickoff) {
      const remaining = Math.floor((kickoff - now) / 1000)
      const hours = Math.floor(remaining / 3600)
      const minutes = Math.floor((remaining % 3600) / 60)
      const seconds = remaining % 60
      return {
        text: hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`,
        label: "Başlama saatine",
        phase: "pre" as const,
      }
    }

    const elapsed = Math.floor((now - kickoff) / 1000)
    const minutes = Math.floor(elapsed / 60)
    const seconds = elapsed % 60
    const overtime = minutes >= match.duration_minutes

    return {
      text: `${pad(minutes)}:${pad(seconds)}`,
      label: overtime ? `Past the nominal ${match.duration_minutes} min` : "Oynadığı",
      phase: overtime ? ("overtime" as const) : ("live" as const),
    }
  }, [now, match.kickoff_at, match.duration_minutes, status])

  /* ---- what to display ------------------------------------------------- */

  const confirmed = score.home !== null && score.away !== null
  const showTally = TALLYABLE.has(status) && !confirmed

  const displayHome = showTally ? (tally?.home ?? score.home ?? 0) : (score.home ?? 0)
  const displayAway = showTally ? (tally?.away ?? score.away ?? 0) : (score.away ?? 0)

  /**
   * The whole sentence a screen reader hears. Only changes when something meaningful does.
   *
   * The elapsed minute is deliberately NOT in here. `aria-atomic="true"` re-reads the entire
   * sentence whenever any part of it changes, so folding the clock in would re-announce the score
   * once a minute for ninety minutes. The clock is exposed visually and is not live; this region
   * is for the score alone.
   */
  const announcement = useMemo(() => {
    const scoreLine = `${home} ${displayHome}, ${away} ${displayAway}`
    const qualifier = showTally ? " (unconfirmed running score)" : " (confirmed final score)"
    return `${scoreLine}${qualifier}.`
  }, [home, away, displayHome, displayAway, showTally])

  /* ---- scoring --------------------------------------------------------- */

  const adjust = useCallback(
    async (side: "home" | "away", delta: 1 | -1) => {
      const nextHome = side === "home" ? Math.max(0, displayHome + delta) : displayHome
      const nextAway = side === "away" ? Math.max(0, displayAway + delta) : displayAway

      setSendWarning(null)
      const delivered = await broadcastScore({
        home: nextHome,
        away: nextAway,
        scoredBy: delta === 1 ? side : null,
      })

      if (!delivered) {
        // Deliberately NOT rolled back. The local count is still this person's best knowledge of
        // the game; discarding it would be worse than the others being briefly out of step, and
        // the ± buttons are right there to correct it.
        setSendWarning(
          "That change is showing on this device but did not reach everyone else. It will sync when the connection comes back.",
        )
      }
    },
    [displayHome, displayAway, broadcastScore],
  )

  const scoringEnabled = canScore && showTally && status !== "cancelled"

  /* ---------------------------------------------------------------------- */

  return (
    <div className={cn("space-y-4", className)}>
      {/* -------- header: status + connection ----------------------------- */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={MATCH_STATUS_META[status].variant} className={MATCH_STATUS_META[status].className}>
            {MATCH_STATUS_META[status].label}
          </Badge>
          <Badge variant="outline">{MATCH_FORMAT_LABEL[match.format]}</Badge>
          {match.is_ranked ? <Badge variant="outline">Reytingli</Badge> : <Badge variant="outline">Hazırlık</Badge>}
        </div>

        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <span
            aria-hidden="true"
            className={cn("inline-block size-2 rounded-full", CONNECTION_DOT[connection] ?? "bg-muted-foreground")}
          />
          <span>
            <span className="sr-only">Canlı bağlantı: </span>
            {CONNECTION_LABEL[connection]}
          </span>
          {connection !== "connected" ? (
            <Button variant="ghost" size="sm" className="h-6 px-2" onClick={() => void resync()}>
              Yenile
            </Button>
          ) : null}
        </p>
      </div>

      {/* -------- the scoreboard ------------------------------------------ */}
      <Card>
        <CardContent className="p-4 sm:p-6">
          {/*
            One polite live region for the whole board. Everything visual below is aria-hidden so
            the same information is not announced twice in a jumble of loose digits.
          */}
          <p className="sr-only" aria-live="polite" aria-atomic="true">
            {announcement}
          </p>

          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 sm:gap-4" aria-hidden="true">
            <TeamColumn name={home} score={displayHome} align="right" />

            <div className="flex flex-col items-center gap-1 px-1">
              <span
                className={cn(
                  "font-mono text-lg font-medium tabular-nums sm:text-2xl",
                  clock.phase === "overtime" && "text-amber-600 dark:text-amber-400",
                  clock.phase === "over" && "text-muted-foreground",
                )}
              >
                {clock.text}
              </span>
              <span className="text-center text-[10px] uppercase tracking-wide text-muted-foreground">
                {clock.label}
              </span>
            </div>

            <TeamColumn name={away} score={displayAway} align="left" />
          </div>

          {/* -------- provenance of the number on screen ------------------- */}
          <p className="mt-4 text-center text-xs text-muted-foreground">
            {confirmed ? (
              <>Bu, onaylanmış sonuç.</>
            ) : showTally && tally ? (
              <>
                Onaysız anlık skor; sahadakiler tutuyor. Biri maç sonucunu bildirene kadar hiçbir şey kaydedilmez.
              </>
            ) : (
              <>Henüz skor yok. Anlık toplam, sahadakilerin girdiği skordur.</>
            )}
          </p>

          {/* -------- the buttons ------------------------------------------ */}
          {scoringEnabled ? (
            <div className="mt-5 grid grid-cols-2 gap-3 border-t pt-5">
              <ScoreControls
                label={home}
                onIncrement={() => void adjust("home", 1)}
                onDecrement={() => void adjust("home", -1)}
                canDecrement={displayHome > 0}
              />
              <ScoreControls
                label={away}
                onIncrement={() => void adjust("away", 1)}
                onDecrement={() => void adjust("away", -1)}
                canDecrement={displayAway > 0}
              />
            </div>
          ) : null}

          {canScore && !showTally ? (
            <p className="mt-5 border-t pt-5 text-center text-xs text-muted-foreground">
              Scoring is closed for this match.{" "}
              {status === "requires_consensus"
                ? "The reported scores disagree — cast your vote on the match page."
                : "The result is settled."}
            </p>
          ) : null}

          {reportHref && (status === "live" || status === "awaiting_report") ? (
            <div className="mt-5 flex justify-center border-t pt-5">
              <Link
                href={reportHref}
                className="inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                Maç sonucunu bildir
              </Link>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* -------- problems ------------------------------------------------ */}
      {error ? (
        <Alert>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {sendWarning ? (
        <Alert>
          <AlertDescription>{sendWarning}</AlertDescription>
        </Alert>
      ) : null}

      {/* -------- roster, fed from THIS channel's presence ------------------ */}
      {/*
        `live` is false and `presence` is passed in: this page already holds the one channel
        Realtime permits for `match:<id>`, and a second join would be rejected outright.
      */}
      <Roster
        matchId={match.id}
        players={participants}
        homeTeamName={home}
        awayTeamName={away}
        presence={presence}
        live={false}
      />
    </div>
  )
}

/* -------------------------------------------------------------------------- */

function TeamColumn({
  name,
  score,
  align,
}: {
  name: string
  score: number
  align: "left" | "right"
}) {
  return (
    <div className={cn("min-w-0", align === "right" ? "text-right" : "text-left")}>
      <p className="truncate text-sm font-medium sm:text-base" title={name}>
        {name}
      </p>
      <p className="text-5xl font-bold leading-none tabular-nums sm:text-7xl">{score}</p>
    </div>
  )
}

function ScoreControls({
  label,
  onIncrement,
  onDecrement,
  canDecrement,
}: {
  label: string
  onIncrement: () => void
  onDecrement: () => void
  canDecrement: boolean
}) {
  return (
    <div className="flex flex-col items-center gap-2">
      <Button
        type="button"
        size="lg"
        className="h-14 w-full text-base"
        onClick={onIncrement}
        // The visible "+1" is decoration; the label has to say which team, because "plus one"
        // twice on a screen is two identical buttons to a screen reader.
        aria-label={`Add a goal for ${label}`}
      >
        <span aria-hidden="true">+1 {label}</span>
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 w-full text-xs"
        onClick={onDecrement}
        disabled={!canDecrement}
        aria-label={`Remove a goal from ${label}`}
      >
        <span aria-hidden="true">Geri al</span>
      </Button>
    </div>
  )
}

/* -------------------------------------------------------------------------- */

export function LiveScoreboardSkeleton() {
  return (
    <Card aria-hidden="true">
      <CardHeader className="pb-2">
        <CardTitle className="sr-only">Skor tablosu yükleniyor</CardTitle>
      </CardHeader>
      <CardContent className="p-6">
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-4">
          <div className="space-y-2 text-right">
            <div className="ml-auto h-4 w-24 animate-pulse rounded bg-muted" />
            <div className="ml-auto h-14 w-16 animate-pulse rounded bg-muted" />
          </div>
          <div className="h-8 w-16 animate-pulse rounded bg-muted" />
          <div className="space-y-2">
            <div className="h-4 w-24 animate-pulse rounded bg-muted" />
            <div className="h-14 w-16 animate-pulse rounded bg-muted" />
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
