"use client"

/**
 * components/profile/tilt-card.tsx
 *
 * A surface that tilts toward the pointer.
 *
 * Perspective plus two rotations from the pointer's position over the element, a specular
 * highlight that slides the opposite way, and a spring back to flat on leave — all as inline
 * transforms driven by pointer events, so the profile card reads as a lit object in the hand
 * rather than a flat picture. Touch works too: the first touch sets the tilt, release resets.
 *
 * `prefers-reduced-motion` turns it off entirely: the card lies flat and the highlight is gone.
 */

import { useCallback, useEffect, useRef, useState } from "react"

import { cn } from "@/lib/utils"

export interface TiltCardProps {
  children: React.ReactNode
  maxDegrees?: number
  className?: string
}

export function TiltCard({ children, maxDegrees = 6, className }: TiltCardProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [reduced, setReduced] = useState(false)
  const [active, setActive] = useState(false)
  const [tilt, setTilt] = useState({ x: 0, y: 0 })

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)")
    setReduced(query.matches)
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches)
    query.addEventListener("change", onChange)
    return () => query.removeEventListener("change", onChange)
  }, [])

  const onMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (reduced || !ref.current) return
      const rect = ref.current.getBoundingClientRect()
      const px = (event.clientX - rect.left) / rect.width
      const py = (event.clientY - rect.top) / rect.height
      setTilt({ x: -(py * 2 - 1) * maxDegrees, y: (px * 2 - 1) * maxDegrees })
      setActive(true)
    },
    [maxDegrees, reduced],
  )

  const reset = useCallback(() => {
    setTilt({ x: 0, y: 0 })
    setActive(false)
  }, [])

  return (
    <div
      ref={ref}
      onPointerMove={onMove}
      onPointerLeave={reset}
      onPointerUp={reset}
      onPointerCancel={reset}
      className={cn("relative [transform-style:preserve-3d] will-change-transform", className)}
      style={{
        transform: `perspective(1100px) rotateX(${tilt.x}deg) rotateY(${tilt.y}deg) scale(${active ? 1.008 : 1})`,
        transition: active ? "transform 90ms linear" : "transform 620ms cubic-bezier(0.16, 1, 0.3, 1)",
      }}
    >
      {children}
      {/* The highlight moves against the tilt, as light on a lifted card would. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 rounded-md"
        style={{
          opacity: active && !reduced ? 1 : 0,
          transition: "opacity 320ms ease",
          backgroundImage: `radial-gradient(40rem 18rem at ${50 - tilt.y * 6}% ${50 + tilt.x * 6}%, hsl(var(--accent-user) / 0.16), transparent 62%)`,
        }}
      />
    </div>
  )
}
