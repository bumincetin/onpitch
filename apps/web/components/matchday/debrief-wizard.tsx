"use client"

/**
 * components/matchday/debrief-wizard.tsx
 *
 * The 60-second debrief. Four steps, one screen each, saved on every change:
 *
 *   1. Sonuç       opponent, score, date, venue
 *   2. Anlar       tap a player card: goal / assist / save / card
 *   3. Süreler     planned minutes from the rotation, ±5 to correct
 *   4. Değerlendirme  rating 1–10, two stars and a wish, private notes
 *
 * then the shareables. When the match was tracked live, steps 1–3 arrive filled in and the coach
 * is confirming rather than typing.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { ChevronLeft, ChevronRight, Minus, Plus } from "lucide-react"

import type { Enums } from "@onpitch/shared/database"
import type { TeamSide } from "@onpitch/shared/domain"
import {
  actualMinutes,
  createDebriefDraft,
  fairPlaySummary,
  scoreForSide,
  type PlayerCount,
  type PostMatchDebrief,
} from "@onpitch/shared/matchday"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { displayName } from "@/lib/matchday/plan"
import { useMatchday } from "@/lib/matchday/use-matchday"
import { cn } from "@/lib/utils"

import { Shareables } from "./shareables"

export interface DebriefWizardProps {
  matchId: string
  matchStatus: Enums<"match_status">
  kickoffAt: string
  venueName: string | null
  homeTeam: { name: string }
  awayTeam: { name: string }
  viewerSide: TeamSide | null
  confirmedScore: { home: number; away: number } | null
}

const STEPS = ["Sonuç", "Anlar", "Süreler", "Değerlendirme", "Paylaş"] as const
type CountKey = "scorers" | "assists" | "saves" | "yellowCards" | "redCards"

export function DebriefWizard(props: DebriefWizardProps) {
  const { record, hydrated, persisted, update, advance } = useMatchday({ matchId: props.matchId, matchStatus: props.matchStatus })
  const plan = record.plan
  const side: TeamSide = record.debrief?.teamSide ?? plan?.teamSide ?? props.viewerSide ?? "home"
  const ourName = side === "home" ? props.homeTeam.name : props.awayTeam.name
  const theirName = side === "home" ? props.awayTeam.name : props.homeTeam.name
  const [step, setStep] = useState(0)

  // First visit: pre-fill from live, or start the reconstruction.
  useEffect(() => {
    if (!hydrated || record.debrief) return
    const draft = createDebriefDraft({
      matchId: props.matchId,
      teamSide: side,
      opponentName: plan?.opponentName ?? theirName,
      venue: props.venueName,
      kickoffAt: props.kickoffAt,
      plan,
      liveSession: record.liveSession,
      confirmedScore: props.confirmedScore,
    })
    update((previous) => ({ ...previous, debrief: draft }))
  }, [hydrated, record.debrief, record.liveSession, plan, props, side, theirName, update])

  const debrief = record.debrief
  useEffect(() => {
    if (debrief?.completedAt) setStep(STEPS.length - 1)
    // Only on first hydration: re-opening a finished debrief lands on the share step.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated])

  const setDebrief = useCallback(
    (patch: (debrief: PostMatchDebrief) => PostMatchDebrief) => {
      update((previous) => (previous.debrief ? { ...previous, debrief: patch(previous.debrief) } : previous))
    },
    [update],
  )

  const squad = useMemo(() => plan?.squad.filter((player) => player.status !== "absent") ?? [], [plan])

  if (!hydrated || !debrief) {
    return <div className="h-64 animate-pulse rounded bg-muted" aria-busy="true" />
  }

  const { us, them } = scoreForSide(debrief.finalScore, side)

  function setScore(next: { us: number; them: number }) {
    const clamped = { us: Math.max(0, Math.min(99, next.us)), them: Math.max(0, Math.min(99, next.them)) }
    setDebrief((current) => ({
      ...current,
      finalScore: side === "home" ? { home: clamped.us, away: clamped.them } : { home: clamped.them, away: clamped.us },
    }))
  }

  function bump(key: CountKey, playerId: string, delta: 1 | -1) {
    setDebrief((current) => ({ ...current, [key]: adjustCount(current[key], playerId, delta) }))
  }

  function finish() {
    setDebrief((current) => ({ ...current, completedAt: new Date().toISOString() }))
    advance("completed")
    setStep(STEPS.length - 1)
  }

  const fair = fairPlaySummary(actualMinutes(debrief), plan?.rotationIntervalMinutes ?? 10)

  return (
    <div className="space-y-5">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={debrief.source === "live" ? "success" : "secondary"}>
            {debrief.source === "live" ? "Canlıdan dolduruldu" : "60 saniyede yeniden kur"}
          </Badge>
          {debrief.completedAt ? <Badge variant="default">Tamamlandı</Badge> : null}
          {!persisted ? <Badge variant="warning">Kaydedilemiyor</Badge> : null}
        </div>
        <ol className="grid grid-cols-5 gap-1" aria-label="Adımlar">
          {STEPS.map((label, index) => (
            <li key={label}>
              <button
                type="button"
                onClick={() => setStep(index)}
                aria-current={index === step ? "step" : undefined}
                className={cn(
                  "min-h-11 w-full rounded-md border px-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  index === step ? "bg-primary text-primary-foreground" : index < step ? "bg-muted" : "hover:bg-accent",
                )}
              >
                {label}
              </button>
            </li>
          ))}
        </ol>
      </header>

      {/* ---- 1. result ---------------------------------------------------- */}
      {step === 0 ? (
        <section className="space-y-4" aria-label="Sonuç">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="opponent">Rakip</Label>
              <Input id="opponent" value={debrief.opponentName} onChange={(event) => setDebrief((c) => ({ ...c, opponentName: event.target.value }))} className="h-11" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="played-on">Tarih</Label>
              <Input id="played-on" type="date" value={debrief.playedOn} onChange={(event) => setDebrief((c) => ({ ...c, playedOn: event.target.value || c.playedOn }))} className="h-11" />
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="venue">Saha</Label>
              <Input id="venue" value={debrief.venue ?? ""} onChange={(event) => setDebrief((c) => ({ ...c, venue: event.target.value || null }))} className="h-11" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <ScoreStepper label={ourName} value={us} onChange={(value) => setScore({ us: value, them })} />
            <ScoreStepper label={debrief.opponentName || theirName} value={them} onChange={(value) => setScore({ us, them: value })} />
          </div>
          {props.confirmedScore ? (
            <p className="text-xs text-muted-foreground">
              Sistemde onaylı sonuç {props.confirmedScore.home}–{props.confirmedScore.away}. Özet bunu değiştirmez; resmî skor yalnızca maç sayfasından bildirilir.
            </p>
          ) : null}
        </section>
      ) : null}

      {/* ---- 2. key events ------------------------------------------------ */}
      {step === 1 ? (
        <section className="space-y-3" aria-label="Anlar">
          {squad.length === 0 ? (
            <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
              Kadro yok. <Link href={`/matches/${props.matchId}/plan`} className="underline underline-offset-4">Planda kadro oluştur</Link> ki oyuncu bazlı olayları kaydedebilesin.
            </p>
          ) : (
            <ul className="grid gap-2 sm:grid-cols-2">
              {squad.map((player) => (
                <li key={player.id} className="rounded-md border p-3">
                  <p className="text-sm font-medium">{displayName(player)}</p>
                  <div className="mt-2 grid grid-cols-5 gap-1">
                    <CountButton label="Gol" short="⚽" count={countFor(debrief.scorers, player.id)} onUp={() => bump("scorers", player.id, 1)} onDown={() => bump("scorers", player.id, -1)} />
                    <CountButton label="Asist" short="🎯" count={countFor(debrief.assists, player.id)} onUp={() => bump("assists", player.id, 1)} onDown={() => bump("assists", player.id, -1)} />
                    <CountButton label="Kurtarış" short="🧤" count={countFor(debrief.saves, player.id)} onUp={() => bump("saves", player.id, 1)} onDown={() => bump("saves", player.id, -1)} />
                    <CountButton label="Sarı" short="🟨" count={countFor(debrief.yellowCards, player.id)} onUp={() => bump("yellowCards", player.id, 1)} onDown={() => bump("yellowCards", player.id, -1)} />
                    <CountButton label="Kırmızı" short="🟥" count={countFor(debrief.redCards, player.id)} onUp={() => bump("redCards", player.id, 1)} onDown={() => bump("redCards", player.id, -1)} />
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-muted-foreground">
            Toplam gol {debrief.scorers.reduce((sum, entry) => sum + entry.count, 0)} · skorda {us}. Dokun: +1, uzun basmak yerine küçük “–” ile geri al.
          </p>
        </section>
      ) : null}

      {/* ---- 3. minutes --------------------------------------------------- */}
      {step === 2 ? (
        <section className="space-y-3" aria-label="Süreler">
          <p className="text-sm text-muted-foreground">
            Plandaki süreler hazır. Sapma olduysa ±5 dk ile düzelt.{" "}
            <span className={cn("font-medium", fair.earned ? "text-teal" : "text-gold")}>
              {fair.playerCount > 1 ? `Fark ${fair.spreadMinutes} dk — ${fair.earned ? "adil süre rozeti kazanıldı." : "rozet için farkı bir blok içine çek."}` : ""}
            </span>
          </p>
          {squad.length === 0 ? (
            <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">Kadro olmadan süre girilemez.</p>
          ) : (
            <ul className="divide-y rounded-md border">
              {squad.map((player) => {
                const planned = debrief.plannedMinutes[player.id] ?? 0
                const delta = debrief.playerMinutesAdjustments[player.id] ?? 0
                const actual = Math.max(0, planned + delta)
                return (
                  <li key={player.id} className="flex items-center gap-2 p-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{displayName(player)}</p>
                      <p className="text-xs text-muted-foreground">
                        plan {planned} dk{delta !== 0 ? ` · ${delta > 0 ? "+" : ""}${delta}` : ""}
                      </p>
                    </div>
                    <Button type="button" variant="outline" size="icon" className="size-11" aria-label={`${player.name} 5 dakika azalt`} onClick={() => setDebrief((c) => ({ ...c, playerMinutesAdjustments: { ...c.playerMinutesAdjustments, [player.id]: delta - 5 } }))}>
                      <Minus />
                    </Button>
                    <span className="w-14 text-center font-mono text-lg font-bold tabular-nums">{actual}</span>
                    <Button type="button" variant="outline" size="icon" className="size-11" aria-label={`${player.name} 5 dakika artır`} onClick={() => setDebrief((c) => ({ ...c, playerMinutesAdjustments: { ...c.playerMinutesAdjustments, [player.id]: delta + 5 } }))}>
                      <Plus />
                    </Button>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      ) : null}

      {/* ---- 4. reflection ------------------------------------------------ */}
      {step === 3 ? (
        <section className="space-y-4" aria-label="Değerlendirme">
          <div className="space-y-2">
            <p className="text-sm font-medium">Takım performansı</p>
            <div className="grid grid-cols-5 gap-1 sm:grid-cols-10" role="radiogroup" aria-label="1 ile 10 arası puan">
              {Array.from({ length: 10 }, (_, index) => index + 1).map((value) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={debrief.matchRating === value}
                  onClick={() => setDebrief((c) => ({ ...c, matchRating: value }))}
                  className={cn(
                    "min-h-11 rounded-md border font-mono text-sm font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    debrief.matchRating === value ? "bg-primary text-primary-foreground" : "hover:bg-accent",
                  )}
                >
                  {value}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-3">
            <p className="text-sm font-medium">İki yıldız, bir dilek</p>
            {[0, 1].map((index) => (
              <div key={index} className="space-y-1">
                <Label htmlFor={`star-${index}`}>⭐ İyi giden {index + 1}</Label>
                <Input
                  id={`star-${index}`}
                  value={debrief.coachNotes.strengths[index] ?? ""}
                  maxLength={280}
                  onChange={(event) =>
                    setDebrief((c) => {
                      const strengths = [...c.coachNotes.strengths]
                      while (strengths.length < 2) strengths.push("")
                      strengths[index] = event.target.value
                      return { ...c, coachNotes: { ...c.coachNotes, strengths } }
                    })
                  }
                  className="h-11"
                />
              </div>
            ))}
            <div className="space-y-1">
              <Label htmlFor="wish">🎯 Sonraki antrenmanın odağı</Label>
              <Input id="wish" value={debrief.coachNotes.improve} maxLength={280} onChange={(event) => setDebrief((c) => ({ ...c, coachNotes: { ...c.coachNotes, improve: event.target.value } }))} className="h-11" />
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor="private">Özel notlar (yalnızca sen görürsün)</Label>
            <Textarea id="private" value={debrief.coachNotes.privateNotes} maxLength={4000} rows={4} onChange={(event) => setDebrief((c) => ({ ...c, coachNotes: { ...c.coachNotes, privateNotes: event.target.value } }))} />
            <p className="text-xs text-muted-foreground">Paylaşılan hiçbir kart ya da metne girmez; bu cihazda kalır.</p>
          </div>
        </section>
      ) : null}

      {/* ---- 5. share ----------------------------------------------------- */}
      {step === 4 ? (
        <Shareables debrief={debrief} plan={plan} players={plan?.squad ?? []} teamName={ourName} events={record.liveSession?.events ?? []} />
      ) : null}

      {/* ---- nav ---------------------------------------------------------- */}
      <div className="flex items-center justify-between gap-2 border-t pt-4">
        <Button type="button" variant="ghost" className="h-12" disabled={step === 0} onClick={() => setStep((current) => Math.max(0, current - 1))}>
          <ChevronLeft />
          Geri
        </Button>
        {step < 3 ? (
          <Button type="button" className="h-12" onClick={() => setStep((current) => current + 1)}>
            İleri
            <ChevronRight />
          </Button>
        ) : step === 3 ? (
          <Button type="button" className="h-12" onClick={finish}>
            Bitir ve paylaş
            <ChevronRight />
          </Button>
        ) : (
          <Button asChild variant="outline" className="h-12">
            <Link href={`/matches/${props.matchId}`}>Maç sayfası</Link>
          </Button>
        )}
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */

function countFor(counts: PlayerCount[], playerId: string): number {
  return counts.find((entry) => entry.playerId === playerId)?.count ?? 0
}

function adjustCount(counts: PlayerCount[], playerId: string, delta: 1 | -1): PlayerCount[] {
  const current = countFor(counts, playerId)
  const next = Math.max(0, current + delta)
  const without = counts.filter((entry) => entry.playerId !== playerId)
  return next === 0 ? without : [...without, { playerId, count: next }].sort((a, b) => b.count - a.count)
}

function ScoreStepper({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <div className="space-y-2 rounded-md border p-3 text-center">
      <p className="truncate text-sm font-medium" title={label}>
        {label}
      </p>
      <p className="font-mono text-5xl font-bold tabular-nums" aria-live="polite">
        {value}
      </p>
      <div className="grid grid-cols-2 gap-2">
        <Button type="button" variant="outline" className="h-12" aria-label={`${label} gol azalt`} onClick={() => onChange(value - 1)} disabled={value === 0}>
          <Minus />
        </Button>
        <Button type="button" className="h-12" aria-label={`${label} gol ekle`} onClick={() => onChange(value + 1)}>
          <Plus />
        </Button>
      </div>
    </div>
  )
}

function CountButton({ label, short, count, onUp, onDown }: { label: string; short: string; count: number; onUp: () => void; onDown: () => void }) {
  return (
    <div className="flex flex-col items-center gap-0.5">
      <button
        type="button"
        onClick={onUp}
        aria-label={`${label} ekle (şu an ${count})`}
        className={cn(
          "flex min-h-11 w-full flex-col items-center justify-center rounded-md border text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          count > 0 ? "border-primary bg-primary/10 font-semibold" : "hover:bg-accent",
        )}
      >
        <span aria-hidden="true">{short}</span>
        <span className="font-mono tabular-nums">{count}</span>
      </button>
      <button type="button" onClick={onDown} disabled={count === 0} aria-label={`${label} azalt`} className="min-h-6 text-[11px] text-muted-foreground disabled:opacity-30">
        –
      </button>
    </div>
  )
}
