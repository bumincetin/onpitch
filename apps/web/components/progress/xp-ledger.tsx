import Link from "next/link"

import { XP_EVENT_LABELS, formatXp, type XpEvent } from "@onpitch/shared/gamification"
import { cn } from "@/lib/utils"

/**
 * The last dozen XP entries.
 *
 * A points system that cannot answer "where did that come from" is a slot machine. This is the
 * receipt: one line per award, with the match it came from where there is one, straight off the
 * `xp_events` ledger that `player_progress.xp` is the sum of.
 *
 * Timestamps are formatted through a FIXED locale and timezone. The viewer's local zone renders
 * differently on the server and in the browser, which is a hydration mismatch on every row —
 * the same reason `lib/notifications/format.ts` pins them.
 */

const STAMP = new Intl.DateTimeFormat("tr-TR", {
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Istanbul",
})

export interface XpLedgerProps {
  events: readonly XpEvent[]
  className?: string
}

export function XpLedger({ events, className }: XpLedgerProps) {
  if (events.length === 0) {
    return (
      <p className={cn("text-sm text-muted-foreground", className)}>
        Henüz puan hareketin yok. İlk maçından sonra burada görünür.
      </p>
    )
  }

  return (
    <ol className={className}>
      {events.map((event) => {
        const stamp = safeStamp(event.createdAt)
        const label = XP_EVENT_LABELS[event.kind]

        return (
          <li
            key={event.id}
            className="ruled-row grid grid-cols-[1fr_auto] items-baseline gap-x-4 gap-y-1 py-3"
          >
            <div className="min-w-0">
              <p className="truncate text-sm">
                {event.matchId ? (
                  <Link
                    href={`/matches/${event.matchId}`}
                    className="underline decoration-foreground/25 underline-offset-4 transition-colors hover:decoration-gold"
                  >
                    {label}
                  </Link>
                ) : (
                  label
                )}
              </p>
              {stamp ? <p className="label-eyebrow mt-0.5">{stamp}</p> : null}
            </div>

            <span
              className={cn(
                "nums shrink-0 font-mono text-sm",
                event.points >= 0 ? "text-gold" : "text-vermilion",
              )}
            >
              {event.points >= 0 ? "+" : "−"}
              {formatXp(Math.abs(event.points))}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

/** An unparseable timestamp costs a caption, never the row. */
function safeStamp(value: string): string | null {
  const at = Date.parse(value)
  if (Number.isNaN(at)) return null
  return STAMP.format(new Date(at))
}
