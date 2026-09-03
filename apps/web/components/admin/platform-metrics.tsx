/**
 * components/admin/platform-metrics.tsx
 *
 * The headline numbers on `/admin`, plus the window picker that drives them.
 *
 * A server component with no state and no effects, so the busiest part of the overview ships
 * no JavaScript. The window picker is a set of real links rather than a client-side control:
 * `?days=` is the whole of the state, and links make it bookmarkable, shareable and
 * back-button correct for free.
 *
 * Money is rendered per currency and never added across them. A platform running TRY and EUR
 * has two revenue figures; one combined number would be arithmetic on incomparable units.
 */

import Link from "next/link"

import { MetricCard } from "@/components/venue/metric-card"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import { ADMIN_WINDOW_CHOICES, type PlatformMetrics } from "@/lib/admin/metrics"
import { formatMinor } from "@onpitch/shared/domain"

export interface PlatformMetricsProps {
  metrics: PlatformMetrics
  /** Path the window picker links back to, e.g. `/admin`. */
  basePath: string
}

export function PlatformMetricsPanel({ metrics, basePath }: PlatformMetricsProps) {
  const primary = metrics.money[0] ?? null
  const secondary = metrics.money.slice(1)

  return (
    <div className="space-y-6">
      <WindowPicker basePath={basePath} activeDays={metrics.range.days} />

      {metrics.truncated ? (
        <Alert variant="destructive">
          <AlertTitle>Bu para rakamları bir alt sınırdır, toplam değil</AlertTitle>
          <AlertDescription>
            Bu aralıkta, sayfanın tek seferde toplayabileceğinden fazla rezervasyon var. Kesin rakam için aralığı daralt. Yalnızca para toplamları etkilenir — rezervasyon, işletme, oyuncu ve maç sayıları veritabanında sayılır ve kesindir.
          </AlertDescription>
        </Alert>
      ) : null}

      <section aria-labelledby="money-heading" className="space-y-3">
        <h2 id="money-heading" className="text-sm font-semibold text-muted-foreground">
          Money over the last {metrics.range.days} days
        </h2>

        {primary ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard
              label="GMV"
              value={formatMinor(primary.grossMinor, primary.currency)}
              hint={`${primary.paidBookings.toLocaleString("tr-TR")} paid bookings`}
            />
            <MetricCard
              label="Platform komisyonu"
              value={formatMinor(primary.platformFeeMinor, primary.currency)}
              hint={`${sharePercent(primary.platformFeeMinor, primary.grossMinor)} of GMV`}
            />
            <MetricCard
              label="İade edildi"
              value={formatMinor(primary.refundedMinor, primary.currency)}
              hint={`${metrics.bookingsRefunded.toLocaleString("tr-TR")} bookings touched a refund`}
            />
            <MetricCard
              label="İşletmelere net"
              value={formatMinor(primary.netToVenuesMinor, primary.currency)}
              hint={`Average booking ${formatMinor(primary.averageBookingValueMinor, primary.currency)}`}
            />
          </div>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Bu aralıkta para hareketi olmadı</CardTitle>
              <CardDescription>
                {metrics.bookingsCreated > 0
                  ? `${metrics.bookingsCreated} bookings were created but none reached a successful payment.`
                  : "No bookings were created in this window."}
              </CardDescription>
            </CardHeader>
          </Card>
        )}

        {secondary.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            Also settled in{" "}
            {secondary
              .map((total) => `${total.currency.toUpperCase()} ${formatMinor(total.grossMinor, total.currency)}`)
              .join(", ")}
            . Currencies are reported separately and never summed.
          </p>
        ) : null}
      </section>

      <section aria-labelledby="supply-heading" className="space-y-3">
        <h2 id="supply-heading" className="text-sm font-semibold text-muted-foreground">
          Arz ve talep
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            label="Rezervasyonlar"
            value={metrics.bookingsCreated.toLocaleString("tr-TR")}
            hint={`${metrics.bookingsPaid.toLocaleString("tr-TR")} paid · ${metrics.bookingsCancelled.toLocaleString("tr-TR")} cancelled`}
          />
          <MetricCard
            label="Aktif işletme"
            value={metrics.venuesActive.toLocaleString("tr-TR")}
            hint={`${metrics.venuesPayable.toLocaleString("tr-TR")} of ${metrics.venuesTotal.toLocaleString("tr-TR")} can take payments`}
          />
          <MetricCard
            label="Aktif oyuncu"
            value={metrics.playersActive.toLocaleString("tr-TR")}
            hint={`Oynadığı at least once in the window · ${metrics.playersTotal.toLocaleString("tr-TR")} registered`}
          />
          <MetricCard
            label="Maçlar"
            value={metrics.matchesInWindow.toLocaleString("tr-TR")}
            hint={`${metrics.matchesFinalized.toLocaleString("tr-TR")} finalised · ${metrics.matchesCancelled.toLocaleString("tr-TR")} cancelled`}
          />
        </div>
      </section>

      <section aria-labelledby="integrity-heading" className="space-y-3">
        <h2 id="integrity-heading" className="text-sm font-semibold text-muted-foreground">
          Sonuç bütünlüğü
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            label="Tamamlanma oranı"
            value={formatRate(metrics.matchCompletionRate)}
            hint="İptal edilmeyen maçlar içinde kesinleşenlerin payı"
            goodDirection="up"
          />
          <MetricCard
            label="İtiraz oranı"
            value={formatRate(metrics.disputeRate)}
            hint="İtirazlı ya da uzlaşma bekleyen, aynı payda"
            goodDirection="down"
          />
          <MetricCard
            label="Açık itirazlar"
            value={metrics.openDisputes.toLocaleString("tr-TR")}
            hint="Şu anki kuyruk derinliği, tüm zamanlar"
          />
          <MetricCard
            label="Açık uzlaşma turları"
            value={metrics.openConsensusRounds.toLocaleString("tr-TR")}
            hint="Oyuncuları bekliyor, seni değil"
          />
        </div>
      </section>
    </div>
  )
}

function WindowPicker({ basePath, activeDays }: { basePath: string; activeDays: number }) {
  return (
    <nav aria-label="Rapor aralığı" className="flex flex-wrap gap-1">
      {ADMIN_WINDOW_CHOICES.map((days) => {
        const active = days === activeDays
        return (
          <Link
            key={days}
            href={`${basePath}?days=${days}`}
            aria-current={active ? "true" : undefined}
            className={cn(
              "rounded-md border px-3 py-1.5 text-sm transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
              active
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground",
            )}
          >
            {days === 365 ? "1 year" : `${days} days`}
          </Link>
        )
      })}
    </nav>
  )
}

/** Renders a [0,1] rate as a percentage, or an em dash when the denominator was zero. */
export function formatRate(rate: number | null): string {
  if (rate === null) return "—"
  return `${(rate * 100).toFixed(1)}%`
}

function sharePercent(part: number, whole: number): string {
  if (whole <= 0) return "—"
  return `${((part / whole) * 100).toFixed(1)}%`
}

export function PlatformMetricsSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">Platform metrikleri yükleniyor</span>
      {[0, 1, 2].map((section) => (
        <div key={section} className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {[0, 1, 2, 3].map((card) => (
            <Card key={card}>
              <CardHeader className="pb-2">
                <div className="h-4 w-24 animate-pulse rounded bg-muted" />
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="h-7 w-28 animate-pulse rounded bg-muted" />
                <div className="h-3 w-36 animate-pulse rounded bg-muted" />
              </CardContent>
            </Card>
          ))}
        </div>
      ))}
    </div>
  )
}
