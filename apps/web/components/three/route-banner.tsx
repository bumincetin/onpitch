"use client"

import * as React from "react"
import { usePathname } from "next/navigation"

import { PitchBanner } from "@/components/three/pitch-banner"
import type { BannerShot } from "@/components/three/scene"

/**
 * The pitch behind every page in the signed-in browsing surface.
 *
 * One component in the layout rather than a band on each page, for two reasons. WebGL contexts
 * are a scarce browser resource and one per route is the budget; and putting it here means a new
 * page gets the treatment by existing, instead of by remembering to opt in.
 *
 * The SHOT changes with the route, which is the point. A header that was the same picture on
 * twenty screens would stop being a place and start being wallpaper — so the ranking looks down
 * from the stand, a match page stands in the goalmouth, team creation waits in the tunnel, and
 * the calendar looks straight down at the markings.
 *
 * Prefix-matched longest-first, so `/teams/new` gets the tunnel while `/teams` gets the stands.
 */

const SHOTS: readonly (readonly [prefix: string, shot: BannerShot])[] = [
  ["/teams/new", "tunnel"],
  ["/matches", "centre"],
  ["/venues", "touchline"],
  ["/checkout", "touchline"],
  ["/bookings", "goalmouth"],
  ["/teams", "tunnel"],
  ["/players", "stands"],
  ["/notifications", "aerial"],
  ["/account", "aerial"],
]

function shotFor(pathname: string): BannerShot {
  let best: BannerShot = "stands"
  let bestLength = -1
  for (const [prefix, shot] of SHOTS) {
    if (pathname.startsWith(prefix) && prefix.length > bestLength) {
      best = shot
      bestLength = prefix.length
    }
  }
  return best
}

export interface RouteBannerProps {
  className?: string
}

export function RouteBanner({ className }: RouteBannerProps) {
  const pathname = usePathname()
  const shot = shotFor(pathname)

  return (
    <div
      className={
        className ??
        "night-fallback relative -mx-4 mb-8 h-36 overflow-hidden border-b border-foreground/15 sm:-mx-6 sm:h-44"
      }
    >
      {/*
        Keyed on the shot so a route change tears the old scene down and builds the new one.
        Without the key the canvas would keep its first camera for the life of the session, and
        every page after the first would be framed for the page before it.
      */}
      <PitchBanner key={shot} shot={shot} />
      <div className="paper-grid pointer-events-none absolute inset-0 opacity-40" aria-hidden="true" />
    </div>
  )
}
