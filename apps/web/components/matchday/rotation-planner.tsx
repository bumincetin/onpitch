"use client"

/**
 * components/matchday/rotation-planner.tsx
 *
 * Settings for the rotation engine and the schedule it produces. Every change re-runs
 * `planRotations` through the plan helpers, so what is shown is always what the cheat sheet will
 * print.
 */

import { type PreMatchPlan } from "@onpitch/shared/matchday"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { displayName, formationOf, playerById, rotationOf, slotLabel, withRotations } from "@/lib/matchday/plan"
import { cn } from "@/lib/utils"

export interface RotationPlannerProps {
  plan: PreMatchPlan
  onChange: (plan: PreMatchPlan) => void
}

const DURATIONS = [30, 40, 50, 60, 70, 80, 90]
const PERIODS = [1, 2, 3, 4]
const INTERVALS = [5, 8, 10, 12, 15, 20]

export function RotationPlanner({ plan, onChange }: RotationPlannerProps) {
  const formation = formationOf(plan)
  const rotation = rotationOf(plan)
  const available = plan.squad.filter((player) => player.status === "available")
  const swapBlocks = rotation.blocks.filter((block) => block.swaps.length > 0)

  function set<K extends keyof PreMatchPlan>(key: K, value: PreMatchPlan[K]) {
    onChange(withRotations({ ...plan, [key]: value }))
  }

  const spreadOk = rotation.fairness.spreadMinutes <= plan.rotationIntervalMinutes

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Maç süresi" id="duration">
          <Select value={String(plan.durationMinutes)} onValueChange={(value) => set("durationMinutes", Number(value))}>
            <SelectTrigger id="duration" className="h-11">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[...new Set([...DURATIONS, plan.durationMinutes])]
                .sort((a, b) => a - b)
                .map((minutes) => (
                  <SelectItem key={minutes} value={String(minutes)}>
                    {minutes} dk
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </Field>

        <Field label="Devre sayısı" id="periods">
          <Select value={String(plan.periods)} onValueChange={(value) => set("periods", Number(value))}>
            <SelectTrigger id="periods" className="h-11">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PERIODS.map((count) => (
                <SelectItem key={count} value={String(count)}>
                  {count === 1 ? "Tek devre" : count === 2 ? "2 devre" : `${count} çeyrek`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field label="Değişiklik aralığı" id="interval">
          <Select value={String(plan.rotationIntervalMinutes)} onValueChange={(value) => set("rotationIntervalMinutes", Number(value))}>
            <SelectTrigger id="interval" className="h-11">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[...new Set([...INTERVALS, plan.rotationIntervalMinutes])]
                .sort((a, b) => a - b)
                .map((minutes) => (
                  <SelectItem key={minutes} value={String(minutes)}>
                    Her {minutes} dk
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
        </Field>

        <Field label="Kaleci" id="keeper-mode">
          <div role="group" aria-label="Kaleci modu" className="grid grid-cols-2 gap-1">
            {(["dedicated", "rotating"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={plan.goalkeeperMode === mode}
                onClick={() => set("goalkeeperMode", mode)}
                className={cn(
                  "min-h-11 rounded-md border px-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  plan.goalkeeperMode === mode ? "bg-primary text-primary-foreground" : "hover:bg-accent",
                )}
              >
                {mode === "dedicated" ? "Sabit kaleci" : "Dönüşümlü"}
              </button>
            ))}
          </div>
        </Field>

        {plan.goalkeeperMode === "dedicated" ? (
          <Field label="Sabit kaleci" id="keeper">
            <Select value={plan.dedicatedGoalkeeperId ?? "none"} onValueChange={(value) => set("dedicatedGoalkeeperId", value === "none" ? null : value)}>
              <SelectTrigger id="keeper" className="h-11">
                <SelectValue placeholder="Kaleci seç" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Seçilmedi</SelectItem>
                {available.map((player) => (
                  <SelectItem key={player.id} value={player.id}>
                    {displayName(player)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        ) : null}
      </div>

      {/* ---- fairness ---------------------------------------------------- */}
      <div
        className={cn(
          "rounded-md border p-3 text-sm",
          spreadOk ? "border-teal/40 bg-teal/5" : "border-gold/50 bg-gold/5",
        )}
        role="status"
      >
        <p className="font-medium">
          {available.length} hazır oyuncu · hedef {Math.round(rotation.fairness.targetMinutes)} dk/oyuncu ·{" "}
          {rotation.fairness.minMinutes}–{rotation.fairness.maxMinutes} dk arası
        </p>
        <p className="text-muted-foreground">
          {spreadOk
            ? "Herkes birbirinin bir değişiklik bloğu içinde: adil süre rozeti hedefte."
            : "Fark bir bloktan büyük. Aralığı kısalt ya da kadroyu gözden geçir."}
        </p>
      </div>

      {/* ---- per-player minutes ------------------------------------------ */}
      <ul className="space-y-1.5" aria-label="Planlanan süreler">
        {available.map((player) => {
          const minutes = rotation.minutesByPlayer[player.id] ?? 0
          const keeperMinutes = rotation.goalkeeperMinutesByPlayer[player.id] ?? 0
          const width = plan.durationMinutes > 0 ? Math.round((minutes / plan.durationMinutes) * 100) : 0
          return (
            <li key={player.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 text-sm">
              <div className="min-w-0">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate">{displayName(player)}</span>
                  <span className="shrink-0 font-mono tabular-nums">
                    {minutes} dk{keeperMinutes > 0 ? <span className="text-muted-foreground"> · {keeperMinutes} KL</span> : null}
                  </span>
                </div>
                <div className="mt-1 h-1.5 w-full overflow-hidden rounded-sm bg-muted" aria-hidden="true">
                  <div className="h-full bg-teal" style={{ width: `${width}%` }} />
                </div>
              </div>
            </li>
          )
        })}
      </ul>

      {/* ---- schedule ---------------------------------------------------- */}
      <section aria-labelledby="schedule-heading" className="space-y-2">
        <h3 id="schedule-heading" className="text-sm font-medium">
          Değişiklik programı{" "}
          <span className="font-normal text-muted-foreground">
            ({rotation.blocks.length} blok, {swapBlocks.length} değişiklik anı)
          </span>
        </h3>
        {swapBlocks.length === 0 ? (
          <p className="rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
            Planlı değişiklik yok — herkes maç boyu sahada.
          </p>
        ) : (
          <ol className="space-y-2">
            {swapBlocks.map((block) => (
              <li key={block.index} className="rounded-md border p-3">
                <p className="flex items-baseline gap-2 text-sm">
                  <span className="font-mono text-base font-bold tabular-nums text-teal">{block.startMinute}&apos;</span>
                  <span className="text-muted-foreground">
                    {block.period}. devre · {block.startMinute}–{block.endMinute} dk
                  </span>
                </p>
                <ul className="mt-2 space-y-1 text-sm">
                  {block.swaps.map((swap) => (
                    <li key={`${block.index}-${swap.slotId}`} className="flex flex-wrap items-center gap-x-2">
                      <span className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
                        {slotLabel(formation, swap.slotId)}
                      </span>
                      <span className="text-destructive">ÇIKAN {displayName(playerById(plan, swap.out))}</span>
                      <span aria-hidden="true">›</span>
                      <span className="font-medium text-teal">GİREN {displayName(playerById(plan, swap.in))}</span>
                    </li>
                  ))}
                  {plan.goalkeeperMode === "rotating" && block.goalkeeperId ? (
                    <li className="text-gold">Kaleci: {displayName(playerById(plan, block.goalkeeperId))}</li>
                  ) : null}
                </ul>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  )
}

function Field({ label, id, children }: { label: string; id: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  )
}
