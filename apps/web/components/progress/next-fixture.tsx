"use client"

import * as React from "react"
import Link from "next/link"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { NextFixture } from "@/lib/progress"

/**
 * The next kick-off, with a live countdown.
 *
 * A client component for one reason: the countdown. Everything else here would render fine on
 * the server, but a time remaining that was computed during SSR is wrong by the time it is
 * read, and stale by minutes on a page left open — which is exactly the page this is on.
 *
 * The countdown starts at null and fills in after mount. Rendering "3 saat 12 dakika" on the
 * server and a different number on the client is a hydration mismatch; rendering the date on
 * both and the countdown only on the client is not.
 */

export interface NextFixtureCardProps {
  fixture: NextFixture | null
  className?: string
}

export function NextFixtureCard({ fixture, className }: NextFixtureCardProps) {
  const [remaining, setRemaining] = React.useState<string | null>(null)

  const kickoffMs = fixture ? Date.parse(fixture.kickoffAt) : Number.NaN

  React.useEffect(() => {
    if (Number.isNaN(kickoffMs)) return

    const tick = () => setRemaining(formatRemaining(kickoffMs - Date.now()))
    tick()
    // A minute is the right resolution: the number is hours away, and a per-second timer on a
    // dashboard people leave open is a wake-up every second for no visible change.
    const timer = window.setInterval(tick, 60_000)
    return () => window.clearInterval(timer)
  }, [kickoffMs])

  if (!fixture) {
    return (
      <div className={cn("border-t border-foreground/15 pt-4", className)}>
        <p className="label-eyebrow">Sıradaki maç</p>
        <p className="mt-3 text-pretty leading-relaxed text-muted-foreground">
          Takvimin boş. Saha ara, saati kilitle, kadroyu topla.
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          <Button size="sm" asChild>
            <Link href="/venues">Saha ara</Link>
          </Button>
          <Button size="sm" variant="outline" asChild>
            <Link href="/matches">Açık maçlar</Link>
          </Button>
        </div>
      </div>
    )
  }

  const zone = fixture.timezone ?? "Europe/Istanbul"
  const when = formatKickoff(fixture.kickoffAt, zone)

  return (
    <div className={cn("border-t border-foreground/15 pt-4", className)}>
      <div className="flex items-baseline justify-between gap-4">
        <p className="label-eyebrow">Sıradaki maç</p>
        {fixture.status === "live" ? (
          <span className="label-eyebrow text-teal">Oynanıyor</span>
        ) : remaining ? (
          <span className="label-eyebrow nums text-gold">{remaining}</span>
        ) : null}
      </div>

      <p className="mt-3 text-2xl font-light leading-tight tracking-tight">{when.day}</p>
      <p className="nums mt-1 text-lg font-light">
        {when.time}
        <span className="ml-2 text-sm text-muted-foreground">
          · {fixture.durationMinutes} dk
          {fixture.timezone ? null : " · cihaz saati"}
        </span>
      </p>

      <p className="mt-3 text-sm text-muted-foreground">
        {fixture.venueName ?? "Saha bilgisi yok"}
        {fixture.city ? ` · ${fixture.city}` : ""}
        {fixture.side ? ` · ${fixture.side === "home" ? "Ev sahibi" : "Deplasman"}` : ""}
      </p>

      {!fixture.isConfirmed ? (
        <p className="label-eyebrow mt-3 text-gold">Katılımın henüz onaylanmadı</p>
      ) : null}

      <div className="mt-5 flex flex-wrap gap-3">
        <Button size="sm" asChild>
          <Link href={`/matches/${fixture.matchId}`}>Maçı aç</Link>
        </Button>
        {fixture.status === "live" ? (
          <Button size="sm" variant="outline" asChild>
            <Link href={`/matches/${fixture.matchId}/live`}>Canlı skor</Link>
          </Button>
        ) : null}
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */

/**
 * The kick-off in the VENUE's zone, not the reader's.
 *
 * A fixture at 21:00 in Istanbul is at 21:00 for everyone who is going to it, whatever their
 * laptop thinks. Falling back to the device zone when the venue has none is flagged in the
 * caller's copy rather than passed off as the venue's time.
 */
function formatKickoff(iso: string, timeZone: string): { day: string; time: string } {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return { day: "Tarih okunamadı", time: "—" }

  const date = new Date(at)
  try {
    return {
      day: new Intl.DateTimeFormat("tr-TR", {
        weekday: "long",
        day: "numeric",
        month: "long",
        timeZone,
      }).format(date),
      time: new Intl.DateTimeFormat("tr-TR", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone,
      }).format(date),
    }
  } catch {
    // An unknown IANA zone from the database must not take the card down with it.
    return {
      day: new Intl.DateTimeFormat("tr-TR", {
        weekday: "long",
        day: "numeric",
        month: "long",
      }).format(date),
      time: new Intl.DateTimeFormat("tr-TR", { hour: "2-digit", minute: "2-digit" }).format(date),
    }
  }
}

function formatRemaining(ms: number): string {
  if (ms <= 0) return "Başladı"
  const minutes = Math.floor(ms / 60_000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const mins = minutes % 60

  if (days > 0) return `${days} gün ${hours} sa`
  if (hours > 0) return `${hours} sa ${mins} dk`
  return `${mins} dk`
}
