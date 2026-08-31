import { cn } from "@/lib/utils"
import type { FormResult } from "@/lib/progress"

/**
 * Two small readouts that answer "how am I doing" without a chart.
 *
 * `StreakStrip` shows the weekly run as marks rather than as a number, because a run of six
 * is a shape you can see at a glance and "6" is a number you have to read. `FormRow` is the
 * last five results in the notation a Turkish football page already uses — G/B/M — which
 * saves a legend.
 */

export interface StreakStripProps {
  weeks: number
  longest: number
  /** Null when the player has never played; renders as an invitation rather than a zero. */
  lastPlayedOn: string | null
  className?: string
}

/** Marks drawn per week, capped so a long run stays one line on a phone. */
const MAX_MARKS = 8

export function StreakStrip({ weeks, longest, lastPlayedOn, className }: StreakStripProps) {
  const marks = Math.min(weeks, MAX_MARKS)
  const overflow = Math.max(0, weeks - MAX_MARKS)

  return (
    <div className={cn("border-t border-foreground/15 pt-3", className)}>
      <div className="flex items-baseline justify-between gap-4">
        <p className="label-eyebrow">Seri</p>
        <p className="label-eyebrow nums">en uzun {longest}</p>
      </div>

      {weeks === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">
          {lastPlayedOn
            ? "Serin bitti. Bu hafta bir maç yaparsan yeniden başlar."
            : "İlk maçını oynadığında serin başlar."}
        </p>
      ) : (
        <div className="mt-3 flex items-end gap-3">
          <div className="flex items-end gap-1" aria-hidden="true">
            {Array.from({ length: marks }, (_, i) => (
              <span
                key={i}
                className="block w-1.5 bg-gold"
                /* The bars grow toward the present, so the most recent week is the tallest
                   mark and the run reads as a direction rather than as a fence. */
                style={{ height: `${10 + (i / Math.max(1, marks - 1)) * 14}px` }}
              />
            ))}
          </div>
          <p className="nums text-2xl font-light leading-none">
            {weeks}
            <span className="ml-1.5 text-sm text-muted-foreground">hafta</span>
            {overflow > 0 ? <span className="sr-only"> (grafikte ilk {MAX_MARKS} hafta gösteriliyor)</span> : null}
          </p>
        </div>
      )}
    </div>
  )
}

export interface FormRowProps {
  /** Oldest first, so it reads left to right like a fixture list. */
  results: readonly FormResult[]
  className?: string
}

const FORM_LETTER: Record<FormResult, string> = { win: "G", draw: "B", loss: "M" }

const FORM_STYLE: Record<FormResult, string> = {
  win: "border-teal/60 text-teal",
  draw: "border-foreground/25 text-muted-foreground",
  loss: "border-vermilion/60 text-vermilion",
}

export function FormRow({ results, className }: FormRowProps) {
  return (
    <div className={cn("border-t border-foreground/15 pt-3", className)}>
      <p className="label-eyebrow">Form</p>

      {results.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">Henüz sonuçlanmış maçın yok.</p>
      ) : (
        <div className="mt-3 flex items-center gap-1.5">
          {results.slice(-5).map((result, i) => (
            <span
              key={`${result}-${i}`}
              className={cn(
                "flex h-7 w-7 items-center justify-center border font-mono text-[0.6875rem] font-medium",
                FORM_STYLE[result],
              )}
              title={result === "win" ? "Galibiyet" : result === "draw" ? "Beraberlik" : "Mağlubiyet"}
            >
              {FORM_LETTER[result]}
            </span>
          ))}
          <span className="sr-only">
            Son {Math.min(5, results.length)} maç, eskiden yeniye:{" "}
            {results
              .slice(-5)
              .map((r) => (r === "win" ? "galibiyet" : r === "draw" ? "beraberlik" : "mağlubiyet"))
              .join(", ")}
            .
          </span>
        </div>
      )}
    </div>
  )
}
