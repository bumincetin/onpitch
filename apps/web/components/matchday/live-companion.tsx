"use client"

/**
 * components/matchday/live-companion.tsx
 *
 * The live screen with the plan loaded next to it.
 *
 * `LiveScoreboard` is rendered exactly as before and still owns the one Realtime channel; this
 * component only listens to the tally it already computes (`onTallyChange`) and keeps a LOCAL
 * session alongside: kickoff pressed on this device, the rotation block we are in, the next
 * substitution, who scored. That session is what pre-fills the debrief. Nothing here writes to
 * the database or the channel.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { ArrowRightLeft, CheckCircle2, Flag, Play, ShieldCheck, Square } from "lucide-react"

import type { TeamSide } from "@onpitch/shared/domain"
import {
  blockAtMinute,
  nextSwapBlock,
  type LiveEvent,
  type LiveEventType,
  type LiveSession,
} from "@onpitch/shared/matchday"
import { LiveScoreboard, type LiveScoreboardProps } from "@/components/match/live-scoreboard"
import type { LiveTally } from "@/lib/realtime/use-match-channel"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { displayName, formationOf, newLocalId, playerById, slotLabel } from "@/lib/matchday/plan"
import { useMatchday } from "@/lib/matchday/use-matchday"
import { cn } from "@/lib/utils"

export interface LiveCompanionProps extends Omit<LiveScoreboardProps, "onTallyChange"> {
  /** The viewer's side, so a "+1" on our side asks who scored. */
  viewerSide: TeamSide | null
}

export function LiveCompanion({ viewerSide, ...scoreboardProps }: LiveCompanionProps) {
  const router = useRouter()
  const matchId = scoreboardProps.match.id
  const { record, phase, hydrated, update, advance } = useMatchday({
    matchId,
    matchStatus: scoreboardProps.match.status,
  })
  const plan = record.plan
  const session = record.liveSession
  const ourSide: TeamSide = plan?.teamSide ?? viewerSide ?? "home"

  /* ---- session bookkeeping --------------------------------------------- */

  const patchSession = useCallback(
    (patch: (session: LiveSession) => LiveSession) => {
      update((previous) => {
        const base: LiveSession = previous.liveSession ?? {
          matchId,
          startedAt: null,
          endedAt: null,
          tally: { home: 0, away: 0 },
          events: [],
          updatedAt: new Date().toISOString(),
        }
        return { ...previous, liveSession: { ...patch(base), updatedAt: new Date().toISOString() } }
      })
    },
    [update, matchId],
  )

  /* ---- clock: from the local kickoff press, else the scheduled kickoff -- */

  const [now, setNow] = useState<number | null>(null)
  useEffect(() => {
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [])

  const minute = useMemo(() => {
    if (now === null) return 0
    const start = session?.startedAt ? Date.parse(session.startedAt) : Date.parse(scoreboardProps.match.kickoff_at)
    if (Number.isNaN(start) || now < start) return 0
    const end = session?.endedAt ? Date.parse(session.endedAt) : now
    return Math.floor((end - start) / 60_000)
  }, [now, session?.startedAt, session?.endedAt, scoreboardProps.match.kickoff_at])

  /* ---- goal attribution ------------------------------------------------ */

  const [pendingGoal, setPendingGoal] = useState<{ side: TeamSide; minute: number } | null>(null)
  /** Scorer picked in the prompt; the next tap is the assist. */
  const [scorerPick, setScorerPick] = useState<string | null>(null)
  // The last tally this device processed. Seeded from the persisted session so a reload does not
  // re-ask "who scored?" for goals already attributed.
  const lastTally = useRef<{ home: number; away: number } | null>(null)
  useEffect(() => {
    if (hydrated && lastTally.current === null && session) lastTally.current = session.tally
  }, [hydrated, session])

  const onTallyChange = useCallback(
    (tally: LiveTally | null) => {
      if (!tally) return
      const previous = lastTally.current
      if (previous && previous.home === tally.home && previous.away === tally.away) return
      lastTally.current = { home: tally.home, away: tally.away }
      patchSession((current) => ({ ...current, tally: { home: tally.home, away: tally.away } }))

      // A goal for our side that has not been attributed yet opens the "who scored?" prompt.
      const ours = tally.scoredBy
      if (!ours) return
      const grew = previous ? tally[ours] > previous[ours] : tally[ours] > 0
      if (!grew) return
      if (ours === ourSide) {
        setPendingGoal({ side: ours, minute })
      } else {
        patchSession((current) => ({
          ...current,
          events: [...current.events, makeEvent("goal", minute, ours, null)],
        }))
      }
    },
    [patchSession, ourSide, minute],
  )

  function attributeGoal(playerId: string | null, assistPlayerId: string | null) {
    if (!pendingGoal) return
    patchSession((current) => ({
      ...current,
      events: [...current.events, { ...makeEvent("goal", pendingGoal.minute, pendingGoal.side, playerId), assistPlayerId }],
    }))
    setPendingGoal(null)
    setScorerPick(null)
  }

  /* ---- rotation position ----------------------------------------------- */

  const blocks = plan?.scheduledRotations ?? []
  const currentBlock = blockAtMinute(blocks, minute)
  const upcoming = nextSwapBlock(blocks, minute - 1)
  const formation = plan ? formationOf(plan) : null
  const doneSwapBlocks = useMemo(
    () => new Set((session?.events ?? []).filter((event) => event.type === "substitution").map((event) => Number(event.id.split(":")[1]))),
    [session?.events],
  )

  function markSwapsDone(blockIndex: number) {
    const block = blocks.find((entry) => entry.index === blockIndex)
    if (!block || !plan) return
    patchSession((current) => ({
      ...current,
      events: [
        ...current.events,
        ...block.swaps.map((swap, index) => ({
          ...makeEvent("substitution", minute, plan.teamSide, null),
          id: `sub:${block.index}:${index}`,
          inPlayerId: swap.in,
          outPlayerId: swap.out,
        })),
      ],
    }))
  }

  const onPitchIds = useMemo(() => {
    const block = currentBlock
    if (!block) return plan?.startingLineup.map((entry) => entry.playerId) ?? []
    return block.onPitch.map((entry) => entry.playerId)
  }, [currentBlock, plan])

  /* ---- quick events ---------------------------------------------------- */

  const [quickEvent, setQuickEvent] = useState<Exclude<LiveEventType, "goal" | "substitution"> | null>(null)
  function logQuickEvent(playerId: string) {
    if (!quickEvent) return
    patchSession((current) => ({ ...current, events: [...current.events, makeEvent(quickEvent, minute, ourSide, playerId)] }))
    setQuickEvent(null)
  }

  /* ---- kickoff / full time --------------------------------------------- */

  function kickoff() {
    patchSession((current) => ({ ...current, startedAt: new Date().toISOString(), endedAt: null }))
    advance("in_progress")
  }

  function fullTime() {
    patchSession((current) => ({ ...current, endedAt: new Date().toISOString() }))
    advance("completed")
    router.push(`/matches/${matchId}/debrief`)
  }

  /* ---------------------------------------------------------------------- */

  return (
    <div className="space-y-5">
      <LiveScoreboard {...scoreboardProps} onTallyChange={onTallyChange} />

      {!hydrated ? null : !plan ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Maç planı yok</CardTitle>
            <CardDescription>Diziliş ve rotasyon olmadan da skor tutabilirsin; plan varsa sıradaki değişiklik burada görünür.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Button asChild variant="outline" className="h-11">
              <Link href={`/matches/${matchId}/plan`}>Plan oluştur</Link>
            </Button>
            <Button asChild variant="outline" className="h-11">
              <Link href={`/matches/${matchId}/debrief`}>Maç özeti</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle className="text-base">Kenar yönetimi</CardTitle>
              <Badge variant="outline" className="font-mono">
                {session?.startedAt ? `${minute}'` : "Başlamadı"}
              </Badge>
            </div>
            <CardDescription>
              {formation?.name} · {plan.squad.filter((player) => player.status === "available").length} hazır ·{" "}
              {phase === "completed" ? "tamamlandı" : session?.startedAt ? "yerel saat çalışıyor" : "başlangıcı bu cihazdan işaretle"}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {!session?.startedAt ? (
              <Button type="button" className="h-12 w-full" onClick={kickoff}>
                <Play />
                Maç başladı
              </Button>
            ) : null}

            {/* ---- pending goal prompt ---- */}
            {pendingGoal ? (
              <div className="space-y-2 rounded-md border border-gold bg-gold/5 p-3" role="dialog" aria-label="Golü kim attı?">
                <p className="text-sm font-medium">
                  {pendingGoal.minute}&apos; — {scorerPick ? `${displayName(playerById(plan, scorerPick))} attı. Asist?` : "golü kim attı?"}
                </p>
                <ul className="flex flex-wrap gap-2">
                  {plan.squad
                    .filter((player) => player.status === "available")
                    .sort((a, b) => Number(onPitchIds.includes(b.id)) - Number(onPitchIds.includes(a.id)))
                    .map((player) => (
                      <li key={player.id}>
                        <button
                          type="button"
                          onClick={() => {
                            // First tap = scorer; second tap = assist (tapping the scorer again = no assist).
                            if (scorerPick === null) setScorerPick(player.id)
                            else attributeGoal(scorerPick, player.id === scorerPick ? null : player.id)
                          }}
                          className={cn(
                            "min-h-11 rounded-md border bg-card px-3 text-sm font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            !onPitchIds.includes(player.id) && "opacity-60",
                          )}
                        >
                          {displayName(player)}
                        </button>
                      </li>
                    ))}
                </ul>
                <div className="flex flex-wrap gap-2">
                  {scorerPick ? (
                    <Button type="button" variant="outline" className="h-11" onClick={() => attributeGoal(scorerPick, null)}>
                      Asist yok
                    </Button>
                  ) : null}
                  <Button type="button" variant="ghost" className="h-11" onClick={() => attributeGoal(null, null)}>
                    Bilinmiyor
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">{scorerPick ? "Şimdi asisti yapan oyuncuya dokun." : "Önce golü atan oyuncuya dokun."}</p>
              </div>
            ) : null}

            {/* ---- next substitution ---- */}
            {upcoming && formation ? (
              <div className="rounded-md border p-3">
                <p className="flex items-baseline gap-2 text-sm">
                  <ArrowRightLeft className="size-4 text-teal" aria-hidden="true" />
                  <span className="font-medium">Sıradaki değişiklik</span>
                  <span className="font-mono font-bold tabular-nums text-teal">{upcoming.startMinute}&apos;</span>
                  {upcoming.startMinute <= minute ? <Badge variant="warning">Şimdi</Badge> : null}
                </p>
                <ul className="mt-2 space-y-1 text-sm">
                  {upcoming.swaps.map((swap) => (
                    <li key={swap.slotId} className="flex flex-wrap gap-x-2">
                      <span className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">{slotLabel(formation, swap.slotId)}</span>
                      <span className="text-destructive">ÇIKAN {displayName(playerById(plan, swap.out))}</span>
                      <span aria-hidden="true">›</span>
                      <span className="font-medium text-teal">GİREN {displayName(playerById(plan, swap.in))}</span>
                    </li>
                  ))}
                </ul>
                <Button
                  type="button"
                  variant="outline"
                  className="mt-3 h-11"
                  disabled={doneSwapBlocks.has(upcoming.index)}
                  onClick={() => markSwapsDone(upcoming.index)}
                >
                  <CheckCircle2 />
                  {doneSwapBlocks.has(upcoming.index) ? "Yapıldı" : "Değişikliği yaptım"}
                </Button>
              </div>
            ) : blocks.length > 0 ? (
              <p className="text-sm text-muted-foreground">Planda başka değişiklik yok.</p>
            ) : null}

            {/* ---- quick events ---- */}
            <div className="space-y-2">
              <p className="text-sm font-medium">Hızlı kayıt</p>
              <div className="grid grid-cols-3 gap-2">
                <QuickButton active={quickEvent === "save"} onClick={() => setQuickEvent(quickEvent === "save" ? null : "save")} icon={<ShieldCheck />} label="Kurtarış" />
                <QuickButton active={quickEvent === "yellow_card"} onClick={() => setQuickEvent(quickEvent === "yellow_card" ? null : "yellow_card")} icon={<Square className="fill-gold text-gold" />} label="Sarı" />
                <QuickButton active={quickEvent === "red_card"} onClick={() => setQuickEvent(quickEvent === "red_card" ? null : "red_card")} icon={<Square className="fill-vermilion text-vermilion" />} label="Kırmızı" />
              </div>
              {quickEvent ? (
                <ul className="flex flex-wrap gap-2" aria-label="Oyuncu seç">
                  {plan.squad
                    .filter((player) => player.status === "available")
                    .map((player) => (
                      <li key={player.id}>
                        <button
                          type="button"
                          onClick={() => logQuickEvent(player.id)}
                          className="min-h-11 rounded-md border bg-card px-3 text-sm font-medium hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {displayName(player)}
                        </button>
                      </li>
                    ))}
                </ul>
              ) : null}
            </div>

            {/* ---- log ---- */}
            {session && session.events.length > 0 ? (
              <ol className="max-h-40 space-y-1 overflow-y-auto text-xs text-muted-foreground" aria-label="Maç günlüğü">
                {[...session.events].reverse().map((event) => (
                  <li key={event.id} className="flex gap-2">
                    <span className="font-mono tabular-nums">{event.minute}&apos;</span>
                    <span>{describeEvent(event, plan, scoreboardProps.homeTeamName ?? "Ev sahibi", scoreboardProps.awayTeamName ?? "Deplasman")}</span>
                  </li>
                ))}
              </ol>
            ) : null}

            <div className="flex flex-wrap gap-2 border-t pt-4">
              <Button type="button" className="h-12 flex-1" variant={session?.startedAt ? "default" : "outline"} onClick={fullTime}>
                <Flag />
                Maç bitti · özete geç
              </Button>
              <Button asChild variant="ghost" className="h-12">
                <Link href={`/matches/${matchId}/plan`}>Plan</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */

function makeEvent(type: LiveEventType, minute: number, side: TeamSide, playerId: string | null): LiveEvent {
  return { id: newLocalId("ev"), type, minute, side, playerId, at: new Date().toISOString() }
}

function describeEvent(
  event: LiveEvent,
  plan: { squad: Parameters<typeof playerById>[0]["squad"]; teamSide: TeamSide },
  homeName: string,
  awayName: string,
): string {
  const who = event.playerId ? displayName(playerById(plan, event.playerId)) : event.side === "home" ? homeName : awayName
  switch (event.type) {
    case "goal":
      return `Gol — ${who}${event.assistPlayerId ? ` (asist ${displayName(playerById(plan, event.assistPlayerId))})` : ""}`
    case "save":
      return `Kurtarış — ${who}`
    case "yellow_card":
      return `Sarı kart — ${who}`
    case "red_card":
      return `Kırmızı kart — ${who}`
    case "substitution":
      return `Değişiklik — çıkan ${displayName(playerById(plan, event.outPlayerId))}, giren ${displayName(playerById(plan, event.inPlayerId))}`
  }
}

function QuickButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <Button type="button" variant={active ? "default" : "outline"} className="h-11" aria-pressed={active} onClick={onClick}>
      {icon}
      {label}
    </Button>
  )
}
