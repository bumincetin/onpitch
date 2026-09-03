import Link from "next/link"

import { formatXp, rankForLevel, type LeaderboardEntry, type LeaderboardScope } from "@onpitch/shared/gamification"
import { cn } from "@/lib/utils"

/**
 * The ranking, as a printed table.
 *
 * Three deliberate choices:
 *
 *   * The measure column changes with the scope, and its heading changes with it. A table
 *     sorted by streak that still shows XP as the headline number is a table nobody can read.
 *   * The viewer's own row is marked rather than pinned to the top. Where you actually stand
 *     is the information; moving the row would destroy it.
 *   * Ranks are printed with the position, not the index. A leaderboard page at offset 25
 *     starts at 26, and `leaderboard_page()` already numbers the rows for exactly this reason.
 */

export interface LeaderboardTableProps {
  entries: readonly LeaderboardEntry[]
  scope: LeaderboardScope
  /** Marks the viewer's own row. */
  currentUserId?: string | null
  className?: string
}

const MEASURE_HEADING: Record<LeaderboardScope, string> = {
  xp: "Tecrübe",
  rating: "Reyting",
  streak: "Seri",
}

function measureOf(entry: LeaderboardEntry, scope: LeaderboardScope): string {
  if (scope === "rating") return entry.conservativeRating.toFixed(1)
  if (scope === "streak") return `${entry.currentStreakWeeks} hf`
  return formatXp(entry.xp)
}

export function LeaderboardTable({
  entries,
  scope,
  currentUserId,
  className,
}: LeaderboardTableProps) {
  if (entries.length === 0) {
    return (
      <p className={cn("text-sm text-muted-foreground", className)}>
        Bu sıralamada henüz kimse yok. Sıralamada görünmek için profilini herkese açık yapman ve
        en az bir maç oynaman gerekiyor.
      </p>
    )
  }

  return (
    <div className={cn("overflow-x-auto", className)}>
      <table className="w-full min-w-[34rem] border-collapse text-sm">
        <thead>
          <tr className="border-b border-foreground/20">
            <th scope="col" className="label-eyebrow w-12 py-2 text-left">
              #
            </th>
            <th scope="col" className="label-eyebrow py-2 text-left">
              Oyuncu
            </th>
            <th scope="col" className="label-eyebrow hidden py-2 text-left sm:table-cell">
              Şehir
            </th>
            <th scope="col" className="label-eyebrow py-2 text-right">
              Maç
            </th>
            <th scope="col" className="label-eyebrow py-2 text-right">
              {MEASURE_HEADING[scope]}
            </th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => {
            const isViewer = currentUserId !== null && currentUserId === entry.playerId
            const rank = rankForLevel(entry.level)

            return (
              <tr
                key={entry.playerId}
                aria-current={isViewer ? "true" : undefined}
                className={cn(
                  "border-b border-foreground/10 last:border-b-0",
                  isViewer && "bg-gold/10",
                )}
              >
                <td className="nums py-3 font-mono text-xs text-muted-foreground">
                  {String(entry.rank).padStart(2, "0")}
                </td>
                <td className="py-3">
                  <Link
                    href={`/players/${entry.playerId}`}
                    className="underline decoration-transparent underline-offset-4 transition-colors hover:decoration-gold"
                  >
                    {entry.displayName}
                  </Link>
                  <span className="ml-2 font-mono text-[0.625rem] uppercase tracking-[0.12em] text-muted-foreground">
                    {rank.tr} · {entry.level}
                  </span>
                  {isViewer ? <span className="sr-only"> (sen)</span> : null}
                </td>
                <td className="hidden py-3 text-muted-foreground sm:table-cell">
                  {entry.city ?? "—"}
                </td>
                <td className="nums py-3 text-right text-muted-foreground">
                  {entry.matchesPlayed}
                </td>
                <td className="nums py-3 text-right font-mono">{measureOf(entry, scope)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
