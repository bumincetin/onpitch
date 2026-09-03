import Link from "next/link"

import { cn } from "@/lib/utils"
import {
  DIVISION_COLORS,
  DIVISION_LABELS,
  daysLeft,
  zoneFor,
  type MyLeagueEntry,
} from "@onpitch/shared/leagues"

/**
 * One of the caller's teams, and where it stands.
 *
 * The zone line is the whole point of the card: a captain opening the dashboard wants to know
 * whether they are going up, going down, or safe, and a bare position tells them none of that
 * without also knowing how many teams are in the division and what the rules are. So the card
 * says it in words.
 */

export interface MyLeagueCardProps {
  entry: MyLeagueEntry
  className?: string
}

export function MyLeagueCard({ entry, className }: MyLeagueCardProps) {
  const tint = DIVISION_COLORS[entry.division]
  const zone = zoneFor(entry.position, entry.teamsInDivision, entry.division)
  const remaining = daysLeft(entry.endsOn)

  const zoneCopy =
    zone === "promotion"
      ? "Çıkma hattında"
      : zone === "relegation"
        ? "Düşme hattında"
        : "Güvende"

  const zoneClass =
    zone === "promotion" ? "text-teal" : zone === "relegation" ? "text-vermilion" : "text-muted-foreground"

  return (
    <div className={cn("flex flex-col bg-background p-5", className)}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden="true"
            className="block h-2.5 w-2.5 rotate-45 border"
            style={{ borderColor: tint, backgroundColor: tint }}
          />
          <Link
            href={`/teams/${entry.teamSlug}`}
            className="text-base font-normal underline decoration-transparent underline-offset-4 transition-colors hover:decoration-gold"
          >
            {entry.teamName}
          </Link>
        </div>
        <span
          className="shrink-0 font-mono text-[0.625rem] uppercase tracking-[0.12em]"
          style={{ color: tint }}
        >
          {DIVISION_LABELS[entry.division]}
        </span>
      </div>

      <div className="mt-5 flex items-baseline gap-3">
        <span className="nums text-4xl font-light leading-none">{entry.position}</span>
        <span className="label-eyebrow nums">/ {entry.teamsInDivision} takım</span>
        <span className={cn("label-eyebrow ml-auto", zoneClass)}>{zoneCopy}</span>
      </div>

      <dl className="mt-5 grid grid-cols-4 gap-x-4 gap-y-3">
        {[
          { label: "O", value: entry.played },
          { label: "G", value: entry.won },
          { label: "B", value: entry.drawn },
          { label: "M", value: entry.lost },
        ].map((cell) => (
          <div key={cell.label} className="border-t border-foreground/15 pt-2">
            <dt className="label-eyebrow">{cell.label}</dt>
            <dd className="nums mt-1 text-lg font-light">{cell.value}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-5 flex items-baseline justify-between gap-3 border-t border-foreground/15 pt-3">
        <span className="label-eyebrow">
          {entry.city} · {entry.seasonName}
        </span>
        <span className="label-eyebrow nums" style={{ color: tint }}>
          {entry.points} puan
        </span>
      </div>

      <p className="mt-2 text-xs text-muted-foreground">
        {remaining > 0
          ? `Sezonun bitmesine ${remaining} gün var.`
          : "Sezon kapanıyor; sıralama son maçlarla belirlenecek."}
      </p>
    </div>
  )
}
