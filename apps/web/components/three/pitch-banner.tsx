"use client"

import * as React from "react"

import type { BannerShot, NightPitchHandle } from "./scene"

/**
 * The live pitch behind a page header.
 *
 * This is the product's ground, not a decoration on one page. Every signed-in surface opens on a
 * floodlit pitch, framed differently depending on what the page is about — the ranking looks down
 * from the stand, a match page stands in the goalmouth, team creation waits in the tunnel.
 *
 * Four things it is careful about:
 *
 *  1. **The page works without it.** The CSS floodlight gradient underneath is the design, not a
 *     loading state. A blocklisted driver, a failed context, a slow chunk — all land on the same
 *     legible header.
 *  2. **It stops when nobody is looking.** An IntersectionObserver pauses the render loop once the
 *     banner scrolls away, which on most pages is within one screen height. `document.hidden`
 *     covers the backgrounded tab.
 *  3. **One context per page.** WebGL contexts are a scarce browser resource and a page that
 *     mounted three of these would start losing them. Layouts render exactly one banner; a page
 *     that wants a different shot passes `shot`, it does not add a second canvas.
 *  4. **`prefers-reduced-motion` gets one still frame**, not a slower drift.
 */

export interface PitchBannerProps {
  /** Which composed shot to hold. See `BANNER_SHOTS` in `scene.ts`. */
  shot?: BannerShot
  /** Height of the strip. Tailwind classes, so it can differ per breakpoint. */
  className?: string
}

export function PitchBanner({ shot = "stands", className }: PitchBannerProps) {
  const hostRef = React.useRef<HTMLDivElement | null>(null)
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null)
  const [live, setLive] = React.useState(false)

  React.useEffect(() => {
    const canvas = canvasRef.current
    const host = hostRef.current
    if (!canvas || !host) return

    let handle: NightPitchHandle | null = null
    let cancelled = false
    let visible = true

    // Kept in a ref-like closure rather than in state: the render loop reads it every frame, and
    // a state update per intersection change would re-render the tree for something no DOM node
    // depends on.
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) visible = entry.isIntersecting
      },
      { rootMargin: "120px" },
    )
    observer.observe(host)

    const reducedMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches

    void import("./scene").then(({ createNightPitch }) => {
      if (cancelled) return
      handle = createNightPitch(canvas, {
        mode: "banner",
        shot,
        reducedMotion,
        isVisible: () => visible,
        onReady: () => {
          if (!cancelled) setLive(true)
        },
      })
    })

    return () => {
      cancelled = true
      observer.disconnect()
      handle?.dispose()
      handle = null
    }
  }, [shot])

  return (
    <div
      ref={hostRef}
      aria-hidden="true"
      className={className ?? "absolute inset-0 overflow-hidden"}
    >
      <div className="night-fallback absolute inset-0" />
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full transition-opacity duration-[1200ms] ease-out"
        style={{ opacity: live ? 1 : 0 }}
      />
      {/*
        The scrim. Type sits directly on this picture, and a floodlit pitch is the brightest
        thing in the palette — without a wash the headline would be reading against grass. It is
        a gradient rather than a flat tint so the far side of the frame still shows through.
      */}
      <div className="night-veil-y pointer-events-none absolute inset-0" />
      <div className="night-veil pointer-events-none absolute inset-0" />
    </div>
  )
}
