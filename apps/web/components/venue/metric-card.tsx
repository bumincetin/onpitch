/**
 * components/venue/metric-card.tsx
 *
 * One headline number on the venue dashboard, plus its period-over-period movement.
 *
 * Deliberately NOT a client component: it holds no state and runs no effects, so keeping it in
 * the server graph means the whole overview page ships zero JavaScript for its most-repeated
 * element.
 *
 * A note on the delta colouring, because it is the easy thing to get wrong: "up" is not "good".
 * A rising cancellation rate is bad news in exactly the same green a rising revenue figure would
 * deserve, so the caller declares `goodDirection` and the component colours the trend against
 * that intent. `MetricCardSkeleton` mirrors this layout so the Suspense fallback does not shift
 * the page when the real numbers land.
 */

import type { ReactNode } from "react"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

export type MetricDirection = "up" | "down" | "neutral"

export interface MetricCardProps {
  /** Short label, e.g. "Occupancy". */
  label: string
  /** The formatted headline value — money through `formatMinor`, rates as percentages. */
  value: ReactNode
  /** One line of context under the value, e.g. "204 of 480 bookable hours". */
  hint?: ReactNode
  /** Pre-formatted movement, e.g. "+18.4%" or "+12 pts". Omit when there is no baseline. */
  delta?: string | null
  /** Sign of the movement, used only for colour and the arrow glyph. */
  deltaDirection?: MetricDirection
  /** Which direction is a good outcome for THIS metric. Defaults to "up". */
  goodDirection?: "up" | "down"
  /** What the delta is measured against, e.g. "vs previous 7 days". */
  deltaLabel?: string
  /** Optional decoration in the header. */
  icon?: ReactNode
  className?: string
}

export function MetricCard({
  label,
  value,
  hint,
  delta,
  deltaDirection = "neutral",
  goodDirection = "up",
  deltaLabel,
  icon,
  className,
}: MetricCardProps) {
  const tone = deltaTone(deltaDirection, goodDirection)

  return (
    <Card className={cn("overflow-hidden", className)}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
        {icon ? (
          <span aria-hidden="true" className="text-muted-foreground">
            {icon}
          </span>
        ) : null}
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-semibold tabular-nums tracking-tight">{value}</div>

        {delta ? (
          <p className={cn("mt-1 flex items-center gap-1 text-xs font-medium", tone)}>
            <TrendGlyph direction={deltaDirection} />
            <span className="tabular-nums">{delta}</span>
            {deltaLabel ? (
              <span className="font-normal text-muted-foreground">{deltaLabel}</span>
            ) : null}
          </p>
        ) : deltaLabel ? (
          <p className="mt-1 text-xs text-muted-foreground">{deltaLabel}</p>
        ) : null}

        {hint ? <p className="mt-2 text-xs text-muted-foreground">{hint}</p> : null}
      </CardContent>
    </Card>
  )
}

/** Loading placeholder with the same box model, so nothing reflows when data arrives. */
export function MetricCardSkeleton({ className }: { className?: string }) {
  return (
    <Card className={cn("overflow-hidden", className)} aria-hidden="true">
      <CardHeader className="pb-2">
        <Skeleton className="h-4 w-24" />
      </CardHeader>
      <CardContent>
        <Skeleton className="h-8 w-32" />
        <Skeleton className="mt-2 h-3 w-20" />
        <Skeleton className="mt-3 h-3 w-40" />
      </CardContent>
    </Card>
  )
}

/** A row of four skeletons matching the overview grid. */
export function MetricCardGridSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div
      className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"
      role="status"
      aria-label="İşletme metrikleri yükleniyor"
    >
      {Array.from({ length: count }, (_, index) => (
        <MetricCardSkeleton key={index} />
      ))}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Internals                                                                 */
/* -------------------------------------------------------------------------- */

function deltaTone(direction: MetricDirection, goodDirection: "up" | "down"): string {
  if (direction === "neutral") return "text-muted-foreground"
  const isGood = direction === goodDirection
  // Deliberately not the destructive token: a bad trend is information, not an error state, and
  // painting a quarter of the dashboard in error red trains owners to ignore it.
  return isGood ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"
}

function TrendGlyph({ direction }: { direction: MetricDirection }) {
  if (direction === "neutral") {
    return (
      <svg viewBox="0 0 12 12" className="h-3 w-3" aria-hidden="true" focusable="false">
        <path d="M2 6h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 12 12" className="h-3 w-3" aria-hidden="true" focusable="false">
      <path
        d={direction === "up" ? "M6 10V2m0 0L2.5 5.5M6 2l3.5 3.5" : "M6 2v8m0 0l3.5-3.5M6 10L2.5 6.5"}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  )
}

/** Map a signed number onto a {@link MetricDirection}; `null` means "no baseline". */
export function directionOf(value: number | null | undefined): MetricDirection {
  if (value === null || value === undefined || !Number.isFinite(value) || value === 0) {
    return "neutral"
  }
  return value > 0 ? "up" : "down"
}
