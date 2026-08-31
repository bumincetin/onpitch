import {
  TIER_COLORS,
  TIER_LABELS,
  formatXp,
  type AchievementState,
} from "@halisaha/shared/gamification"

import { cn } from "@/lib/utils"

/**
 * The badge cabinet.
 *
 * Locked badges are shown, not hidden. A grid of empty slots is the reason to come back; a
 * grid that only contains what you already have is a receipt. What IS hidden is nothing —
 * every criterion is stated on the card, because a badge you cannot work out how to earn is
 * a badge nobody chases.
 *
 * The tier colour is a hairline and a small mark rather than a fill. At this density a wall of
 * coloured tiles reads as noise, and the page's own vocabulary is rules and marks.
 */

export interface AchievementGridProps {
  achievements: readonly AchievementState[]
  /** Cap the number rendered. The dashboard shows a slice; /achievements shows them all. */
  limit?: number
  className?: string
}

export function AchievementGrid({ achievements, limit, className }: AchievementGridProps) {
  // Unlocked first, then whatever is closest to unlocking — so the top of the grid is always
  // either a reward or the next one within reach.
  const ordered = [...achievements].sort((a, b) => {
    const aUnlocked = a.unlockedAt !== null
    const bUnlocked = b.unlockedAt !== null
    if (aUnlocked !== bUnlocked) return aUnlocked ? -1 : 1
    if (aUnlocked && bUnlocked) return (b.unlockedAt ?? "").localeCompare(a.unlockedAt ?? "")
    return b.progress / b.target - a.progress / a.target
  })

  const shown = typeof limit === "number" ? ordered.slice(0, limit) : ordered

  if (shown.length === 0) {
    return <p className={cn("text-sm text-muted-foreground", className)}>Rozet listesi yüklenemedi.</p>
  }

  return (
    <ul
      className={cn(
        "grid gap-px border border-foreground/15 bg-foreground/15 sm:grid-cols-2 lg:grid-cols-3",
        className,
      )}
    >
      {shown.map((achievement) => {
        const unlocked = achievement.unlockedAt !== null
        const ratio = Math.min(1, achievement.progress / achievement.target)
        const tint = TIER_COLORS[achievement.tier]

        return (
          <li
            key={achievement.code}
            className={cn("flex flex-col bg-background p-5", !unlocked && "opacity-70")}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <span
                  aria-hidden="true"
                  className="block h-2.5 w-2.5 rotate-45 border"
                  style={{
                    borderColor: tint,
                    backgroundColor: unlocked ? tint : "transparent",
                  }}
                />
                <h3 className="text-base font-normal leading-tight">{achievement.name}</h3>
              </div>
              <span
                className="shrink-0 font-mono text-[0.625rem] uppercase tracking-[0.12em]"
                style={{ color: tint }}
              >
                {TIER_LABELS[achievement.tier]}
              </span>
            </div>

            <p className="mt-2.5 flex-1 text-sm leading-relaxed text-muted-foreground">
              {achievement.description}
            </p>

            <div className="mt-4">
              {unlocked ? (
                <p className="label-eyebrow text-teal">
                  Kazanıldı · +{formatXp(achievement.xpReward)} XP
                </p>
              ) : (
                <div className="flex items-center gap-3">
                  <div
                    className="h-px flex-1 bg-foreground/15"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={achievement.target}
                    aria-valuenow={achievement.progress}
                    aria-label={achievement.name}
                  >
                    <div className="h-px" style={{ width: `${ratio * 100}%`, backgroundColor: tint }} />
                  </div>
                  <span className="label-eyebrow nums shrink-0">
                    {achievement.progress} / {achievement.target}
                  </span>
                </div>
              )}
            </div>
          </li>
        )
      })}
    </ul>
  )
}

/** "7 / 19 rozet" — the one line worth putting above the grid. */
export function AchievementSummary({ achievements }: { achievements: readonly AchievementState[] }) {
  const unlocked = achievements.filter((a) => a.unlockedAt !== null).length
  return (
    <span className="label-eyebrow nums">
      {unlocked} / {achievements.length} rozet
    </span>
  )
}
