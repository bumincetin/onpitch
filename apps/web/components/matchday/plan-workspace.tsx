"use client"

/**
 * components/matchday/plan-workspace.tsx
 *
 * The pre-match screen: squad check-in, line-up, rotation, cheat sheet — four tabs over one plan
 * that is saved on every edit — and the bridge at the bottom: start live tracking with this plan
 * loaded, or skip it and come back for the debrief.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { AlertTriangle, ClipboardList, Radio, SkipForward } from "lucide-react"

import type { Enums } from "@onpitch/shared/database"
import type { TeamSide } from "@onpitch/shared/domain"
import { MATCHDAY_PHASE_LABEL, type PitchFormat, type PreMatchPlan } from "@onpitch/shared/matchday"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  addPlayer,
  createDefaultPlan,
  removePlayer,
  seedSquad,
  togglePosition,
  updatePlayer,
  type RosterSeedPlayer,
} from "@/lib/matchday/plan"
import { getMatchdayRepository } from "@/lib/matchday/store"
import { useMatchday } from "@/lib/matchday/use-matchday"
import { cn } from "@/lib/utils"

import { CheatSheet } from "./cheat-sheet"
import { LineupBuilder } from "./lineup-builder"
import { RotationPlanner } from "./rotation-planner"
import { SquadPanel } from "./squad-panel"

export interface PlanWorkspaceProps {
  matchId: string
  matchStatus: Enums<"match_status">
  pitchFormat: PitchFormat
  durationMinutes: number
  kickoffLabel: string
  venueName: string | null
  homeTeam: { id: string | null; name: string }
  awayTeam: { id: string | null; name: string }
  /** The side the viewer is on, if they are in the line-up. */
  viewerSide: TeamSide | null
  roster: RosterSeedPlayer[]
}

export function PlanWorkspace(props: PlanWorkspaceProps) {
  const router = useRouter()
  const { record, phase, hydrated, persisted, update, advance } = useMatchday({
    matchId: props.matchId,
    matchStatus: props.matchStatus,
  })
  const [tab, setTab] = useState("squad")

  const plan = record.plan
  const side: TeamSide = plan?.teamSide ?? props.viewerSide ?? "home"
  const ourTeam = side === "home" ? props.homeTeam : props.awayTeam
  const theirTeam = side === "home" ? props.awayTeam : props.homeTeam
  const teamKey = ourTeam.id ?? `${props.matchId}:${side}`

  const setPlan = useCallback(
    (next: PreMatchPlan) => {
      update((previous) => ({ ...previous, plan: { ...next, updatedAt: new Date().toISOString() } }))
      try {
        getMatchdayRepository().writeSquad(teamKey, next.squad)
      } catch {
        /* squad memory is a convenience; the plan itself reports persistence */
      }
    },
    [update, teamKey],
  )

  // First visit: build a plan from the roster and whatever this team remembered last time.
  useEffect(() => {
    if (!hydrated || record.plan) return
    const remembered = getMatchdayRepository().readSquad(teamKey)
    const squad = seedSquad(props.roster, side, remembered)
    const fresh = createDefaultPlan({
      matchId: props.matchId,
      teamSide: side,
      opponentName: theirTeam.name,
      pitchFormat: props.pitchFormat,
      durationMinutes: props.durationMinutes,
      squad,
    })
    update((previous) => ({ ...previous, plan: fresh, phase: previous.phase === "draft" ? "planned" : previous.phase }))
  }, [hydrated, record.plan, props.roster, props.matchId, props.pitchFormat, props.durationMinutes, side, teamKey, theirTeam.name, update])

  const subtitle = useMemo(
    () => [props.kickoffLabel, props.venueName].filter(Boolean).join(" · "),
    [props.kickoffLabel, props.venueName],
  )

  function flipSide() {
    if (!plan) return
    const nextSide: TeamSide = plan.teamSide === "home" ? "away" : "home"
    const nextTeam = nextSide === "home" ? props.homeTeam : props.awayTeam
    const nextOpponent = nextSide === "home" ? props.awayTeam : props.homeTeam
    const remembered = getMatchdayRepository().readSquad(nextTeam.id ?? `${props.matchId}:${nextSide}`)
    const squad = seedSquad(props.roster, nextSide, remembered)
    setPlan(
      createDefaultPlan({
        matchId: props.matchId,
        teamSide: nextSide,
        opponentName: nextOpponent.name,
        pitchFormat: props.pitchFormat,
        durationMinutes: plan.durationMinutes,
        squad,
      }),
    )
  }

  function startLive() {
    advance("in_progress")
    router.push(`/matches/${props.matchId}/live`)
  }

  if (!hydrated || !plan) {
    return (
      <div className="space-y-3" aria-busy="true">
        <div className="h-8 w-40 animate-pulse rounded bg-muted" />
        <div className="h-64 animate-pulse rounded bg-muted" />
      </div>
    )
  }

  const completed = phase === "completed"
  const cancelled = props.matchStatus === "cancelled"

  return (
    <div className="space-y-5">
      <header className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={phase === "in_progress" ? "destructive" : phase === "completed" ? "default" : "secondary"}>
            {MATCHDAY_PHASE_LABEL[phase]}
          </Badge>
          <Badge variant="outline">{props.pitchFormat}</Badge>
          {!persisted ? (
            <Badge variant="warning" title="Tarayıcı depolaması kapalı ya da dolu">
              Kaydedilemiyor
            </Badge>
          ) : null}
        </div>

        <div className="grid gap-3 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-end">
          <div className="space-y-1">
            <span className="text-sm font-medium">Biz</span>
            <div className="flex gap-1" role="group" aria-label="Hangi taraf biziz">
              {(["home", "away"] as const).map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  aria-pressed={plan.teamSide === candidate}
                  onClick={() => {
                    if (plan.teamSide === candidate) return
                    if (
                      plan.startingLineup.length === 0 ||
                      window.confirm("Taraf değiştirmek planı o takımın kadrosuyla yeniden kurar. Devam edilsin mi?")
                    ) {
                      flipSide()
                    }
                  }}
                  className={cn(
                    "min-h-11 rounded-md border px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    plan.teamSide === candidate ? "bg-primary text-primary-foreground" : "hover:bg-accent",
                  )}
                >
                  {candidate === "home" ? props.homeTeam.name : props.awayTeam.name}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="opponent">Rakip</Label>
            <Input
              id="opponent"
              value={plan.opponentName ?? ""}
              onChange={(event) => setPlan({ ...plan, opponentName: event.target.value })}
              className="h-11"
            />
          </div>
        </div>
      </header>

      {cancelled ? (
        <Alert>
          <AlertTitle>Bu maç iptal edildi</AlertTitle>
          <AlertDescription>Plan saklanır; başka bir maçta kadro hafızası olarak kullanılır.</AlertDescription>
        </Alert>
      ) : null}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="grid h-auto w-full grid-cols-4">
          <TabsTrigger value="squad" className="min-h-11">
            Kadro
          </TabsTrigger>
          <TabsTrigger value="lineup" className="min-h-11">
            Diziliş
          </TabsTrigger>
          <TabsTrigger value="rotation" className="min-h-11">
            Rotasyon
          </TabsTrigger>
          <TabsTrigger value="sheet" className="min-h-11">
            Kenar notu
          </TabsTrigger>
        </TabsList>

        <TabsContent value="squad" className="pt-2">
          <SquadPanel
            squad={plan.squad}
            onStatusChange={(id, status) => setPlan(updatePlayer(plan, id, { status }))}
            onNameChange={(id, name) => setPlan(updatePlayer(plan, id, { name }))}
            onNumberChange={(id, number) => setPlan(updatePlayer(plan, id, { number }))}
            onTogglePosition={(id, position) => setPlan(togglePosition(plan, id, position))}
            onAdd={(input) => setPlan(addPlayer(plan, input))}
            onRemove={(id) => setPlan(removePlayer(plan, id))}
          />
        </TabsContent>

        <TabsContent value="lineup" className="pt-2">
          <LineupBuilder plan={plan} onChange={setPlan} />
        </TabsContent>

        <TabsContent value="rotation" className="pt-2">
          <RotationPlanner plan={plan} onChange={setPlan} />
        </TabsContent>

        <TabsContent value="sheet" className="pt-2">
          <CheatSheet plan={plan} teamName={ourTeam.name} opponentName={plan.opponentName || theirTeam.name} subtitle={subtitle} />
        </TabsContent>
      </Tabs>

      {/* ---- bridge -------------------------------------------------------- */}
      <section aria-labelledby="bridge-heading" className="space-y-3 rounded-md border p-4">
        <h2 id="bridge-heading" className="text-base font-semibold">
          Maç günü
        </h2>
        {plan.startingLineup.length === 0 ? (
          <p className="flex items-start gap-2 text-sm text-muted-foreground">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-gold" aria-hidden="true" />
            Henüz diziliş yok. Canlı takip yine çalışır ama kenar notu boş çıkar.
          </p>
        ) : null}
        <div className="grid gap-2 sm:grid-cols-2">
          <Button type="button" className="h-12" onClick={startLive} disabled={cancelled || completed}>
            <Radio />
            Canlı takibi başlat
          </Button>
          <Button asChild variant="outline" className="h-12">
            <Link href={`/matches/${props.matchId}/debrief`}>
              {completed ? <ClipboardList /> : <SkipForward />}
              {completed ? "Maç özetini aç" : "Canlıyı atla, sonra özetle"}
            </Link>
          </Button>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Canlı takip mevcut skor tablosunu bu planla açar: sıradaki değişiklik, golü kim attı, kim kenara geldi. Atlarsan
          maçtan sonra 60 saniyelik özet sihirbazı plandaki süreleri hazır getirir.
        </p>
      </section>
    </div>
  )
}
