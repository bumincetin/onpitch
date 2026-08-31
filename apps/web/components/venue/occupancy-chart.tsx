/**
 * components/venue/occupancy-chart.tsx
 *
 * Daily occupancy over the selected window: booked minutes as a share of BOOKABLE minutes
 * (opening hours minus blackout windows — see `lib/venue/metrics.ts`), one bar per local day.
 *
 * ---------------------------------------------------------------------------
 * WHY IT LOOKS LIKE THIS
 * ---------------------------------------------------------------------------
 *   • Bar, not line. The measure is a magnitude per discrete bucket (a day), and a line implies
 *     interpolation between buckets that does not exist — there is no "half past Tuesday" value.
 *   • ONE series, so no legend: the heading names the measure, and a legend box for a single
 *     colour is chartjunk. Colour therefore carries no identity here and the whole chart draws
 *     from a single hue — `--primary`, straight off the shadcn CSS variables, which is what makes
 *     it theme-correct in dark mode by construction rather than by an inverted filter.
 *   • Days with NO bookable hours (venue closed, fully blacked out) are not a second series and
 *     do not get a second hue. They render as a muted track, because "nothing was on sale" is a
 *     different fact from "nothing sold" and flattening the two to a 0% bar is a lie.
 *   • The mean is a dashed reference line, direct-labelled once. Labelling every bar is the
 *     fastest way to make a 30-day chart unreadable.
 *   • DIV bars rather than SVG: they stay pixel-crisp and fully responsive without a viewBox
 *     stretching the type, they take a real `title` for the hover layer, and the whole component
 *     stays in the server graph — this chart ships zero JavaScript.
 *   • A real `<table>` sits behind a `<details>`. Colour and height are not the only route to the
 *     numbers, which is what keeps this usable with a screen reader, in forced-colors mode, and
 *     on a printout.
 */

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import type { OccupancyPoint } from "@/lib/venue/metrics"
import { formatMinor } from "@halisaha/shared/domain"

export interface OccupancyChartProps {
  points: readonly OccupancyPoint[]
  currency: string
  /** IANA zone the day labels are rendered in. */
  timezone: string
  title?: string
  description?: string
  className?: string
}

export function OccupancyChart({
  points,
  currency,
  timezone,
  title = "Günlük doluluk",
  description,
  className,
}: OccupancyChartProps) {
  if (points.length === 0) {
    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </CardHeader>
        <CardContent>
          <EmptyPlot />
        </CardContent>
      </Card>
    )
  }

  const bookableDays = points.filter((point) => point.bookableMinutes > 0)
  const meanRate =
    bookableDays.length > 0
      ? bookableDays.reduce((sum, point) => sum + point.occupancyRate, 0) / bookableDays.length
      : 0

  const totalBooked = points.reduce((sum, point) => sum + point.bookedMinutes, 0)
  const totalBookable = points.reduce((sum, point) => sum + point.bookableMinutes, 0)

  // On long windows every label collides, so thin them out to roughly a dozen ticks and keep the
  // first and last so the axis still reads as a range.
  const labelStride = Math.max(1, Math.ceil(points.length / 12))

  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>
          {description ??
            `${formatHours(totalBooked)} booked of ${formatHours(totalBookable)} bookable · times shown in ${timezone}`}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        <figure className="m-0">
          <div
            role="img"
            aria-label={buildSummary(points, meanRate, timezone)}
            className="relative h-52 w-full"
          >
            {/* Recessive gridlines. Purely decorative — the table below carries the values. */}
            <div aria-hidden="true" className="pointer-events-none absolute inset-0">
              {[0, 0.25, 0.5, 0.75, 1].map((tick) => (
                <div
                  key={tick}
                  className="absolute inset-x-0 border-t border-border/60"
                  style={{ bottom: `${tick * 100}%` }}
                >
                  <span className="absolute -top-2 left-0 bg-card pr-1 text-[10px] tabular-nums text-muted-foreground">
                    {Math.round(tick * 100)}%
                  </span>
                </div>
              ))}
            </div>

            {/* Mean reference line, labelled exactly once. */}
            {bookableDays.length > 1 ? (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-0 z-10 border-t border-dashed border-foreground/40"
                style={{ bottom: `${clampPercent(meanRate)}%` }}
              >
                <span className="absolute -top-2.5 right-0 rounded-sm bg-card px-1 text-[10px] font-medium tabular-nums text-foreground/70">
                  avg {Math.round(meanRate * 100)}%
                </span>
              </div>
            ) : null}

            {/* The marks. `gap-[2px]` is the surface gap that keeps adjacent bars separable. */}
            <div className="absolute inset-0 flex items-end gap-[2px] pl-8">
              {points.map((point) => (
                <Bar key={point.date} point={point} currency={currency} timezone={timezone} />
              ))}
            </div>
          </div>

          {/* X axis. Same left padding as the plot so ticks line up with their bars. */}
          <div aria-hidden="true" className="mt-2 flex gap-[2px] pl-8">
            {points.map((point, index) => (
              <div
                key={point.date}
                className="min-w-0 flex-1 truncate text-center text-[10px] text-muted-foreground"
              >
                {index % labelStride === 0 ? shortDayLabel(point.date) : " "}
              </div>
            ))}
          </div>
        </figure>

        <details className="group rounded-md border border-border">
          <summary className="cursor-pointer select-none list-none px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
            <span className="inline-flex items-center gap-2">
              <svg
                viewBox="0 0 12 12"
                className="h-3 w-3 transition-transform group-open:rotate-90"
                aria-hidden="true"
                focusable="false"
              >
                <path
                  d="M4.5 2.5L8 6l-3.5 3.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              Sayıları gör
            </span>
          </summary>
          <div className="max-h-64 overflow-auto border-t border-border">
            <table className="w-full text-sm">
              <caption className="sr-only">
                Seçilen dönem için günlük doluluk, dolu saat ve ciro
              </caption>
              <thead className="sticky top-0 bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th scope="col" className="px-3 py-2 text-left font-medium">
                    Gün
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    Doluluk
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    Dolu
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    Rezerve edilebilir
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    Ciro
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {points.map((point) => (
                  <tr key={point.date}>
                    <th scope="row" className="px-3 py-1.5 text-left font-normal">
                      {longDayLabel(point.date)}
                    </th>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {point.bookableMinutes > 0 ? `${Math.round(point.occupancyRate * 100)}%` : "—"}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {formatHours(point.bookedMinutes)}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {formatHours(point.bookableMinutes)}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">
                      {formatMinor(point.revenueMinor, currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </CardContent>
    </Card>
  )
}

/** Matching placeholder so the Suspense swap does not move the page. */
export function OccupancyChartSkeleton({ className }: { className?: string }) {
  return (
    <Card className={className} aria-hidden="true">
      <CardHeader>
        <Skeleton className="h-5 w-40" />
        <Skeleton className="mt-2 h-4 w-64" />
      </CardHeader>
      <CardContent>
        <div className="flex h-52 items-end gap-[2px] pl-8">
          {Array.from({ length: 14 }, (_, index) => (
            <Skeleton
              key={index}
              className="min-w-0 flex-1 rounded-t-[4px]"
              style={{ height: `${30 + ((index * 37) % 60)}%` }}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

/* -------------------------------------------------------------------------- */
/*  Marks                                                                     */
/* -------------------------------------------------------------------------- */

function Bar({
  point,
  currency,
  timezone,
}: {
  point: OccupancyPoint
  currency: string
  timezone: string
}) {
  const closed = point.bookableMinutes <= 0
  const percent = clampPercent(point.occupancyRate)

  const tooltip = closed
    ? `${longDayLabel(point.date)} — closed, nothing bookable`
    : `${longDayLabel(point.date)} — ${Math.round(point.occupancyRate * 100)}% occupied · ` +
      `${formatHours(point.bookedMinutes)} of ${formatHours(point.bookableMinutes)} · ` +
      `${point.bookingCount} booking${point.bookingCount === 1 ? "" : "s"} · ` +
      `${formatMinor(point.revenueMinor, currency)}`

  return (
    <div
      className="group/bar relative flex h-full min-w-0 flex-1 items-end"
      title={`${tooltip} (${timezone})`}
    >
      {/* The unsold remainder, so each column reads as "of what was bookable". */}
      {!closed ? (
        <div
          aria-hidden="true"
          className="absolute inset-x-0 bottom-0 rounded-t-[4px] bg-muted/60 transition-colors group-hover/bar:bg-muted"
          style={{ height: "100%" }}
        />
      ) : (
        <div
          aria-hidden="true"
          className="absolute inset-x-0 bottom-0 h-full rounded-t-[4px] border border-dashed border-border bg-transparent"
        />
      )}

      {!closed && percent > 0 ? (
        <div
          aria-hidden="true"
          className={cn(
            "relative w-full rounded-t-[4px] bg-primary transition-colors",
            "group-hover/bar:bg-primary/80",
          )}
          style={{ height: `${Math.max(percent, 1.5)}%` }}
        />
      ) : null}
    </div>
  )
}

function EmptyPlot() {
  return (
    <div className="flex h-52 flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border text-center">
      <p className="text-sm font-medium">Bu dönemde rezerve edilebilir saat yok</p>
      <p className="max-w-sm text-xs text-muted-foreground">
        Çalışma saatleri olan bir saha ekle ya da tarih aralığını genişlet; doluluk burada görünür.
      </p>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Formatting                                                                */
/* -------------------------------------------------------------------------- */

function clampPercent(rate: number): number {
  if (!Number.isFinite(rate)) return 0
  return Math.min(100, Math.max(0, rate * 100))
}

/** `375` → `"6.3h"`. Hours are the unit an owner thinks in; minutes are noise at this scale. */
function formatHours(minutes: number): string {
  if (minutes <= 0) return "0h"
  const hours = minutes / 60
  return hours >= 10 ? `${Math.round(hours)}h` : `${hours.toFixed(1)}h`
}

/**
 * `YYYY-MM-DD` is already the LOCAL calendar date in the venue timezone (metrics.ts resolved it
 * through the zone), so it is formatted as UTC here on purpose — re-applying a zone would shift
 * the label off the day it describes.
 */
function labelDate(dateKey: string): Date {
  return new Date(`${dateKey}T12:00:00.000Z`)
}

function shortDayLabel(dateKey: string): string {
  return new Intl.DateTimeFormat("tr-TR", {
    timeZone: "UTC",
    weekday: "narrow",
    day: "numeric",
  }).format(labelDate(dateKey))
}

function longDayLabel(dateKey: string): string {
  return new Intl.DateTimeFormat("tr-TR", {
    timeZone: "UTC",
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(labelDate(dateKey))
}

function buildSummary(
  points: readonly OccupancyPoint[],
  meanRate: number,
  timezone: string,
): string {
  // `noUncheckedIndexedAccess` is on, so an index is `T | undefined` even where the caller has
  // already checked the length. Narrowing here rather than asserting keeps that guarantee real.
  const first = points[0]
  const last = points[points.length - 1]
  if (!first || !last) return "Daily occupancy chart. The figures are in the table below."

  let peak = first
  for (const point of points) {
    if (point.occupancyRate > peak.occupancyRate) peak = point
  }

  return (
    `Bar chart of daily occupancy from ${longDayLabel(first.date)} to ${longDayLabel(last.date)}, ` +
    `in ${timezone}. Average ${Math.round(meanRate * 100)} percent; ` +
    `busiest day ${longDayLabel(peak.date)} at ${Math.round(peak.occupancyRate * 100)} percent. ` +
    "The full figures are in the table below."
  )
}
