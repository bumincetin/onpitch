"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * The chapter rail: a fixed index of the page's five shots, marking which one the reader is
 * standing in.
 *
 * It is an orientation device, not navigation decoration — on a page where the background moves
 * continuously, the reader needs somewhere to look that says how far through this is. An
 * IntersectionObserver keyed to the same sections that drive the camera keeps the two in
 * agreement by construction: there is no second definition of "the current chapter" to drift.
 */

export interface ChapterRailItem {
  n: string
  id: string
  label: string
}

export interface ChapterRailProps {
  items: readonly ChapterRailItem[]
  className?: string
}

export function ChapterRail({ items, className }: ChapterRailProps) {
  const [active, setActive] = React.useState<string | null>(null)

  React.useEffect(() => {
    const targets = items
      .map((item) => document.getElementById(item.id))
      .filter((el): el is HTMLElement => el !== null)
    if (targets.length === 0) return

    // The band is the middle of the viewport: a chapter is current when its section crosses the
    // reader's eyeline, which is also the point the camera waypoint is composed for.
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActive(entry.target.id)
        }
      },
      { rootMargin: "-48% 0px -48% 0px", threshold: 0 },
    )
    for (const target of targets) observer.observe(target)
    return () => observer.disconnect()
  }, [items])

  return (
    <nav
      aria-label="Bölümler"
      className={cn(
        "pointer-events-none fixed right-6 top-1/2 z-30 hidden -translate-y-1/2 lg:block",
        className,
      )}
    >
      <ol className="flex flex-col items-end gap-4">
        {items.map((item) => {
          const on = active === item.id
          return (
            <li key={item.id}>
              <a
                href={`#${item.id}`}
                aria-current={on ? "true" : undefined}
                className="pointer-events-auto group flex items-center justify-end gap-3"
              >
                <span
                  className={cn(
                    "font-mono text-[0.625rem] uppercase tracking-[0.14em] transition-all duration-500",
                    on
                      ? "text-foreground opacity-100"
                      : "text-muted-foreground opacity-0 group-hover:opacity-100",
                  )}
                >
                  {item.label}
                </span>
                <span
                  className={cn(
                    "font-mono text-[0.625rem] tabular-nums transition-colors duration-500",
                    on ? "text-gold" : "text-muted-foreground/60",
                  )}
                >
                  {item.n}
                </span>
                <span
                  aria-hidden="true"
                  className={cn(
                    "block h-px transition-all duration-500",
                    on ? "w-8 bg-gold" : "w-3 bg-foreground/25",
                  )}
                />
              </a>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
