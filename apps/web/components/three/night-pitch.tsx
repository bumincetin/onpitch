"use client"

import * as React from "react"

import type { NightPitchHandle } from "./scene"

/**
 * The fixed WebGL layer behind the landing page.
 *
 * Three things this component is careful about, in order of how badly each one bites:
 *
 *  1. **The page has to work without it.** The gradient underneath is not a loading state — it
 *     is the design, and the canvas fades in over it when and if WebGL is available. A
 *     blocklisted driver, a context-creation failure or a slow chunk all land on the same
 *     legible page rather than on black.
 *
 *  2. **Three.js never reaches the server, or the rest of the app.** `scene.ts` is imported
 *     dynamically inside an effect, so it compiles to its own chunk that only this route pays
 *     for, and nothing in it is evaluated during SSR.
 *
 *  3. **`prefers-reduced-motion` is answered honestly.** Not a slower camera — no camera. One
 *     composed frame is painted and the render loop never starts, so the reader gets the
 *     picture and none of the movement.
 */

export interface NightPitchProps {
  /**
   * Attribute marking the chapter sections, in scroll order. Each one owns a camera waypoint.
   */
  shotAttribute?: string
  className?: string
}

export function NightPitch({ shotAttribute = "data-shot", className }: NightPitchProps) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null)
  const [live, setLive] = React.useState(false)

  React.useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    let handle: NightPitchHandle | null = null
    let cancelled = false

    const sections = Array.from(
      document.querySelectorAll<HTMLElement>(`[${shotAttribute}]`),
    ).sort((a, b) => {
      const ai = Number(a.getAttribute(shotAttribute) ?? 0)
      const bi = Number(b.getAttribute(shotAttribute) ?? 0)
      return ai - bi
    })
    if (sections.length === 0) return

    const reducedMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches

    void import("./scene").then(({ createNightPitch }) => {
      if (cancelled) return
      handle = createNightPitch(canvas, {
        sections,
        // The first element of opaque content; past it there is nothing of the scene to see.
        coverAt: () => {
          const end = document.querySelector<HTMLElement>("[data-canvas-end]")
          return end ? end.offsetTop : null
        },
        reducedMotion,
        onReady: () => {
          if (!cancelled) setLive(true)
        },
      })
    })

    return () => {
      cancelled = true
      handle?.dispose()
      handle = null
    }
  }, [shotAttribute])

  return (
    <div className={className} aria-hidden="true">
      {/* The floor. Always painted, never removed — the canvas composites over it. */}
      <div className="night-fallback fixed inset-0 z-0" />
      <canvas
        ref={canvasRef}
        className="fixed inset-0 z-0 h-full w-full transition-opacity duration-[1400ms] ease-out"
        style={{ opacity: live ? 1 : 0 }}
      />
    </div>
  )
}
