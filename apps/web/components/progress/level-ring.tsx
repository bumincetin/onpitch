import { levelProgress, rankForLevel, formatXp } from "@onpitch/shared/gamification"

import { cn } from "@/lib/utils"

/**
 * The level ring.
 *
 * An SVG arc rather than a `<progress>` or a div with a width, because the number in the
 * middle and the arc around it are one object: the level is what the ring is FOR, and putting
 * it inside removes the need for a label saying which number the bar belongs to.
 *
 * Drawn with `pathLength={100}` so the dash array is literally "percent complete" — no
 * circumference arithmetic to get wrong when somebody changes the radius, and no dependency
 * between the geometry and the maths.
 *
 * Server component. Nothing here is interactive and the value only changes on a reload or a
 * realtime push, which the parent handles.
 */

export interface LevelRingProps {
  xp: number
  /** Overrides the derived level. Pass the database's `level` so the ring can never disagree with it. */
  level?: number
  size?: number
  className?: string
}

export function LevelRing({ xp, level, size = 132, className }: LevelRingProps) {
  const progress = levelProgress(xp)
  // The stored level wins if given: it is GENERATED from xp in Postgres, so a mismatch here
  // would mean the client curve has drifted, and the honest thing is to show the real one.
  const shownLevel = level ?? progress.level
  const rank = rankForLevel(shownLevel)
  const percent = Math.round(progress.ratio * 100)

  return (
    <div
      className={cn("relative shrink-0", className)}
      style={{ width: size, height: size }}
      role="img"
      aria-label={`Seviye ${shownLevel}, ${rank.tr}. ${formatXp(progress.into)} / ${formatXp(
        progress.span,
      )} tecrübe puanı.`}
    >
      <svg viewBox="0 0 120 120" width={size} height={size} aria-hidden="true">
        {/* The track. Ink at low opacity so it reads as a rule, not as a second value. */}
        <circle
          cx="60"
          cy="60"
          r="52"
          fill="none"
          stroke="hsl(var(--foreground) / 0.14)"
          strokeWidth="2"
        />
        <circle
          cx="60"
          cy="60"
          r="52"
          fill="none"
          stroke="hsl(var(--gold))"
          strokeWidth="3"
          strokeLinecap="butt"
          pathLength={100}
          strokeDasharray={`${percent} ${100 - percent}`}
          /* Start at twelve o'clock rather than at three, which is where a reader expects a
             dial to begin. */
          transform="rotate(-90 60 60)"
        />
        {/* Tick at the top: the boundary the arc is running toward. */}
        <line x1="60" y1="4" x2="60" y2="12" stroke="hsl(var(--gold))" strokeWidth="1.5" />
      </svg>

      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="label-eyebrow leading-none">Seviye</span>
        <span className="nums mt-1 text-4xl font-light leading-none tracking-tight">
          {shownLevel}
        </span>
        <span className="mt-1.5 font-mono text-[0.625rem] uppercase tracking-[0.14em] text-gold">
          {rank.tr}
        </span>
      </div>
    </div>
  )
}

/** The line under the ring: where this level started, where it ends, and what is left. */
export function LevelCaption({ xp, level }: { xp: number; level?: number }) {
  const progress = levelProgress(xp)
  const shownLevel = level ?? progress.level

  return (
    <dl className="grid grid-cols-3 gap-4">
      <div className="border-t border-foreground/15 pt-2">
        <dt className="label-eyebrow">Toplam</dt>
        <dd className="nums mt-1 text-lg font-light">{formatXp(xp)}</dd>
      </div>
      <div className="border-t border-foreground/15 pt-2">
        <dt className="label-eyebrow">Bu seviyede</dt>
        <dd className="nums mt-1 text-lg font-light">
          {formatXp(progress.into)}
          <span className="text-muted-foreground"> / {formatXp(progress.span)}</span>
        </dd>
      </div>
      <div className="border-t border-foreground/15 pt-2">
        <dt className="label-eyebrow">Sonraki seviye</dt>
        <dd className="nums mt-1 text-lg font-light">
          {formatXp(progress.remaining)}
          <span className="text-muted-foreground"> XP</span>
        </dd>
      </div>
      <span className="sr-only">Seviye {shownLevel}</span>
    </dl>
  )
}
