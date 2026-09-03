/**
 * components/match/match-card.tsx
 *
 * One match, as a card. Presentational and server-renderable — no `'use client'`, no hooks, no
 * data fetching. Every page that lists matches renders this so a fixture looks and reads the same
 * everywhere.
 *
 * It also owns the shared vocabulary for talking about a match — {@link MATCH_STATUS_META},
 * {@link MATCH_FORMAT_LABEL}, {@link formatKickoff} — because those strings must not drift
 * between the list, the detail page and the live screen.
 */

import Link from "next/link"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import type { Enums } from "@onpitch/shared/database"

/* ========================================================================== */
/*  Shared vocabulary                                                         */
/* ========================================================================== */

type BadgeVariant = "default" | "secondary" | "destructive" | "outline"

export interface MatchStatusMeta {
  /** Two or three words, sentence case. Shown on the badge. */
  label: string
  /** One sentence a player can act on. Shown under a heading, never in a badge. */
  description: string
  variant: BadgeVariant
  /** Extra classes for the badge, so `live` can pulse without a bespoke component. */
  className?: string
}

/**
 * `public.match_status` in human terms.
 *
 * The copy is deliberately about what happens NEXT, not about internal state. "requires_consensus"
 * is a database word; "your team-mates and opponents have to agree the score" is what the player
 * actually needs to know.
 */
export const MATCH_STATUS_META: Record<Enums<"match_status">, MatchStatusMeta> = {
  scheduled: {
    label: "Planlandı",
    description: "Henüz başlamadı.",
    variant: "secondary",
  },
  live: {
    label: "Canlı",
    description: "Şu anda oynanıyor.",
    variant: "destructive",
    className: "animate-pulse",
  },
  awaiting_report: {
    label: "Skor bekleniyor",
    description: "Maç bitti. Her iki taraftan birinin skoru bildirmesi gerekiyor.",
    variant: "outline",
  },
  requires_consensus: {
    label: "Uzlaşma gerekiyor",
    description:
      "Bildirilen skorlar çelişiyor; sayılması için kadronun birini onaylaması gerekiyor.",
    variant: "destructive",
  },
  disputed: {
    label: "İtirazlı",
    description: "Karara bağlanmak üzere yöneticiye gönderildi. O zamana kadar reytingler beklemede.",
    variant: "destructive",
  },
  finalized: {
    label: "Kesin",
    description: "Sonuç onaylandı ve reytingler işlendi.",
    variant: "default",
  },
  cancelled: {
    label: "İptal edildi",
    description: "Bu maç oynanmayacak.",
    variant: "outline",
  },
}

/** `public.match_format` as people say it out loud. */
export const MATCH_FORMAT_LABEL: Record<Enums<"match_format">, string> = {
  five_a_side: "5 kişilik",
  six_a_side: "6 kişilik",
  seven_a_side: "7 kişilik",
  eight_a_side: "8 kişilik",
  eleven_a_side: "11 kişilik",
}

/** Nominal squad size per side, used for "6/14 in" style capacity copy. */
export const MATCH_FORMAT_PLAYERS_PER_SIDE: Record<Enums<"match_format">, number> = {
  five_a_side: 5,
  six_a_side: 6,
  seven_a_side: 7,
  eight_a_side: 8,
  eleven_a_side: 11,
}

/**
 * Kickoff, rendered in the venue's timezone.
 *
 * Every timestamp in this system is `timestamptz`, i.e. an instant. An instant has no timezone —
 * the venue does. Rendering with the *viewer's* locale but the *venue's* zone is what stops a
 * player in Berlin reading a 21:00 Istanbul kickoff as 19:00 and turning up two hours late.
 */
export function formatKickoff(
  isoInstant: string,
  timeZone = "Europe/Istanbul",
  locale?: string,
): { date: string; time: string; full: string } {
  const instant = new Date(isoInstant)
  if (Number.isNaN(instant.getTime())) {
    return { date: "—", time: "—", full: "Unknown kickoff time" }
  }

  const date = new Intl.DateTimeFormat(locale, {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(instant)

  const time = new Intl.DateTimeFormat(locale, {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(instant)

  const full = new Intl.DateTimeFormat(locale, {
    timeZone,
    dateStyle: "full",
    timeStyle: "short",
  }).format(instant)

  return { date, time, full }
}

/** "in 2 hours" / "3 days ago". Falls back to an empty string when the input is unusable. */
export function formatRelative(isoInstant: string, now: Date = new Date(), locale?: string): string {
  const instant = new Date(isoInstant)
  if (Number.isNaN(instant.getTime())) return ""

  const deltaSeconds = Math.round((instant.getTime() - now.getTime()) / 1000)
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" })

  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["week", 604_800],
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ]

  for (const [unit, seconds] of units) {
    if (Math.abs(deltaSeconds) >= seconds) {
      return formatter.format(Math.round(deltaSeconds / seconds), unit)
    }
  }
  return formatter.format(deltaSeconds, "second")
}

/* ========================================================================== */
/*  The card                                                                  */
/* ========================================================================== */

export interface MatchCardMatch {
  id: string
  kickoff_at: string
  duration_minutes: number
  format: Enums<"match_format">
  status: Enums<"match_status">
  home_score: number | null
  away_score: number | null
  is_ranked: boolean
  requires_consensus: boolean
}

export interface MatchCardProps {
  match: MatchCardMatch
  homeTeamName?: string | null
  awayTeamName?: string | null
  venueName?: string | null
  pitchName?: string | null
  city?: string | null
  /** Confirmed + unconfirmed rows in `match_participants`. */
  participantCount?: number | null
  /** Venue timezone, from `venues.timezone`. */
  timeZone?: string
  /** Set when this viewer is in the line-up — drives the "You're in" affordance. */
  isParticipant?: boolean
  /** Something the viewer must do: report a score, cast a consensus vote. */
  actionRequired?: string | null
  className?: string
}

export function MatchCard({
  match,
  homeTeamName,
  awayTeamName,
  venueName,
  pitchName,
  city,
  participantCount,
  timeZone = "Europe/Istanbul",
  isParticipant = false,
  actionRequired = null,
  className,
}: MatchCardProps) {
  const status = MATCH_STATUS_META[match.status]
  const kickoff = formatKickoff(match.kickoff_at, timeZone)
  const hasScore = match.home_score !== null && match.away_score !== null
  const squad = MATCH_FORMAT_PLAYERS_PER_SIDE[match.format] * 2
  const isLive = match.status === "live"

  const home = homeTeamName ?? "Home"
  const away = awayTeamName ?? "Away"

  const place = [pitchName, venueName].filter(Boolean).join(" · ") || venueName || city || null

  return (
    <Card
      className={cn(
        "relative transition-colors focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2",
        "hover:border-foreground/20",
        className,
      )}
    >
      <CardHeader className="gap-2 pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={status.variant} className={status.className}>
            {status.label}
          </Badge>
          <Badge variant="outline">{MATCH_FORMAT_LABEL[match.format]}</Badge>
          {match.is_ranked ? (
            <Badge variant="outline" title="Reytingine sayılır">
              Reytingli
            </Badge>
          ) : (
            <Badge variant="outline" title="Hazırlık — reyting değişmez">
              Hazırlık
            </Badge>
          )}
          {isParticipant ? <Badge variant="secondary">İçindesin</Badge> : null}
        </div>

        <CardTitle className="text-base leading-snug">
          {/*
            The whole card is clickable via this stretched link rather than by wrapping the card in
            an <a>. Wrapping would swallow any button inside it and produce nested interactive
            elements, which screen readers announce as one unusable blob.
          */}
          <Link
            href={isLive ? `/matches/${match.id}/live` : `/matches/${match.id}`}
            className="after:absolute after:inset-0 after:content-[''] focus-visible:outline-none"
          >
            <span className="sr-only">
              {home} versus {away}, {kickoff.full}.{" "}
            </span>
            <span aria-hidden="true">
              {home} <span className="text-muted-foreground">vs</span> {away}
            </span>
          </Link>
        </CardTitle>
      </CardHeader>

      <CardContent className="pb-3">
        <dl className="grid gap-1.5 text-sm">
          <div className="flex items-baseline gap-2">
            <dt className="sr-only">Başlangıç</dt>
            <dd className="font-medium tabular-nums">
              <time dateTime={match.kickoff_at} title={kickoff.full}>
                {kickoff.date}, {kickoff.time}
              </time>
            </dd>
            <span className="text-muted-foreground" aria-hidden="true">
              ·
            </span>
            <dd className="text-muted-foreground">{match.duration_minutes} dk</dd>
          </div>

          {place ? (
            <div>
              <dt className="sr-only">Nerede</dt>
              <dd className="truncate text-muted-foreground">{place}</dd>
            </div>
          ) : null}

          {typeof participantCount === "number" ? (
            <div>
              <dt className="sr-only">Kadro</dt>
              <dd className="text-muted-foreground">
                {squad} kişilik kadronun {participantCount} kişisi hazır
              </dd>
            </div>
          ) : null}
        </dl>
      </CardContent>

      <CardFooter className="flex items-center justify-between gap-3 border-t pt-3">
        {hasScore ? (
          <p className="text-2xl font-semibold tabular-nums">
            <span className="sr-only">Skor: </span>
            {match.home_score}
            <span className="px-1 text-muted-foreground" aria-hidden="true">
              –
            </span>
            {match.away_score}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">{status.description}</p>
        )}

        {actionRequired ? (
          // Sits above the stretched link so it reads as its own affordance, not part of the title.
          <span className="relative z-10 rounded-md bg-destructive/10 px-2 py-1 text-xs font-medium text-destructive">
            {actionRequired}
          </span>
        ) : null}
      </CardFooter>
    </Card>
  )
}

/* ========================================================================== */
/*  Skeleton                                                                  */
/* ========================================================================== */

/** Matches the card's real height so a list does not jump when it resolves. */
export function MatchCardSkeleton() {
  return (
    <Card aria-hidden="true">
      <CardHeader className="gap-2 pb-3">
        <div className="flex gap-2">
          <div className="h-5 w-16 animate-pulse rounded-full bg-muted" />
          <div className="h-5 w-20 animate-pulse rounded-full bg-muted" />
        </div>
        <div className="h-5 w-2/3 animate-pulse rounded bg-muted" />
      </CardHeader>
      <CardContent className="space-y-2 pb-3">
        <div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
        <div className="h-4 w-1/3 animate-pulse rounded bg-muted" />
      </CardContent>
      <CardFooter className="border-t pt-3">
        <div className="h-6 w-24 animate-pulse rounded bg-muted" />
      </CardFooter>
    </Card>
  )
}
