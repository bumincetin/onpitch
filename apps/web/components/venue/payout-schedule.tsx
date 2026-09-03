/**
 * components/venue/payout-schedule.tsx
 *
 * "When does the money actually arrive?" — the one question a venue owner asks about payouts.
 *
 * Two different sources are shown together and it matters which is which:
 *
 *   • The SCHEDULE (interval, delay days, anchor) comes from Stripe's `settings.payouts.schedule`
 *     on the connected account. It is a forward-looking rule, not a record.
 *   • The LEDGER comes from `venue_payouts`, our service_role-written mirror of the `payout.*`
 *     webhooks. It is the record of what Stripe has actually created.
 *
 * They can legitimately disagree — Stripe may not have created tomorrow's payout yet — so the
 * component never invents a "next payout" from the schedule. If the ledger has nothing in flight,
 * it says so and explains the rule instead of guessing a date.
 *
 * `arrival_date` is Stripe's ESTIMATE. Banks miss it. The copy says "expected" everywhere, on
 * purpose: a venue owner who plans a wage run against a date this UI presented as certain has
 * been misled by us, not by their bank.
 *
 * Presentational and server-renderable; the only client boundary is the shadcn `Tabs` primitive.
 */

import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"
import type { Enums } from "@onpitch/shared/database"
import { formatMinor, type NextPayout } from "@onpitch/shared/domain"

/** Normalised `settings.payouts.schedule` from a Stripe connected account. */
export interface PayoutScheduleInfo {
  /** `manual` | `daily` | `weekly` | `monthly`. */
  interval: string
  /** Days Stripe holds funds before paying out. `null` when Stripe did not report it. */
  delayDays: number | null
  /** Weekly schedules only, e.g. `"friday"`. */
  weeklyAnchor: string | null
  /** Monthly schedules only, 1–31. */
  monthlyAnchor: number | null
}

/** One row of the `venue_payouts` mirror, flattened for display. */
export interface PayoutRow {
  id: string
  stripePayoutId: string
  amountMinor: number
  currency: string
  status: Enums<"payout_status">
  /** `YYYY-MM-DD`, Stripe's expected settlement date. */
  arrivalDate: string | null
  createdAt: string
}

export interface PayoutScheduleProps {
  schedule: PayoutScheduleInfo | null
  payouts: readonly PayoutRow[]
  nextPayout: NextPayout | null
  currency: string
  /** False when the connected account cannot receive payouts yet. */
  payoutsEnabled: boolean
  className?: string
}

const STATUS_META: Readonly<
  Record<Enums<"payout_status">, { label: string; variant: "default" | "secondary" | "destructive" | "outline"; dot: string }>
> = {
  pending: { label: "Bekliyor", variant: "outline", dot: "bg-amber-500" },
  in_transit: { label: "Yolda", variant: "default", dot: "bg-sky-500" },
  paid: { label: "Ödendi", variant: "secondary", dot: "bg-emerald-500" },
  failed: { label: "Başarısız", variant: "destructive", dot: "bg-destructive" },
}

/** Tab order matches the lifecycle: what is coming, what is queued, what has landed. */
const TAB_ORDER: readonly Enums<"payout_status">[] = ["in_transit", "pending", "paid", "failed"]

export function PayoutSchedule({
  schedule,
  payouts,
  nextPayout,
  currency,
  payoutsEnabled,
  className,
}: PayoutScheduleProps) {
  const grouped = groupByStatus(payouts)
  // A tab with nothing in it and no lifecycle meaning is noise; `failed` only appears if it ever
  // happened, while the three normal states always show (an empty state teaches more than a
  // missing tab).
  const visibleTabs = TAB_ORDER.filter(
    (status) => status !== "failed" || (grouped.get("failed")?.length ?? 0) > 0,
  )
  const defaultTab =
    visibleTabs.find((status) => (grouped.get(status)?.length ?? 0) > 0) ?? visibleTabs[0]

  return (
    <div className={cn("space-y-6", className)}>
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Beklenen sıradaki hakediş
            </CardTitle>
          </CardHeader>
          <CardContent>
            {nextPayout ? (
              <>
                <p className="text-2xl font-semibold tabular-nums tracking-tight">
                  {formatMinor(nextPayout.amountMinor, nextPayout.currency)}
                </p>
                <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                  <PayoutStatusBadge status={nextPayout.status} />
                  <span>
                    {nextPayout.arrivalDate
                      ? `expected ${formatArrival(nextPayout.arrivalDate)}`
                      : "Stripe has not set an arrival date yet"}
                  </span>
                </p>
              </>
            ) : (
              <>
                <p className="text-2xl font-semibold tracking-tight text-muted-foreground">—</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {payoutsEnabled
                    ? "Nothing in flight. The next payout is created once settled bookings build up a balance."
                    : "Payouts are not enabled on your account yet. Finish onboarding to start receiving them."}
                </p>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Hakediş takvimi
            </CardTitle>
            <CardDescription>Bağlı hesabında Stripe tarafından belirlenir.</CardDescription>
          </CardHeader>
          <CardContent>
            {schedule ? (
              <dl className="space-y-2 text-sm">
                <div className="flex items-baseline justify-between gap-4">
                  <dt className="text-muted-foreground">Sıklık</dt>
                  <dd className="text-right font-medium">{describeInterval(schedule)}</dd>
                </div>
                <div className="flex items-baseline justify-between gap-4">
                  <dt className="text-muted-foreground">Ödeme gecikmesi</dt>
                  <dd className="text-right font-medium tabular-nums">
                    {schedule.delayDays === null
                      ? "—"
                      : `${schedule.delayDays} day${schedule.delayDays === 1 ? "" : "s"}`}
                  </dd>
                </div>
                <Separator />
                <p className="text-xs text-muted-foreground">
                  Bir rezervasyonun tutarı, ödeme gecikmesinden sonra kullanılabilir olur ve bir sonraki planlı hakedişte çıkar. Ulaşma tarihleri Stripe tahminidir, garanti değildir.
                </p>
              </dl>
            ) : (
              <p className="text-sm text-muted-foreground">
                {payoutsEnabled
                  ? "Could not read the schedule from Stripe just now. Your payouts are unaffected — try refreshing in a moment."
                  : "A schedule appears once your payout account is verified."}
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Hakediş geçmişi</CardTitle>
          <CardDescription>
            Stripe&apos;tan yansıtılır. Tutarlar, platform komisyonu her rezervasyon anında alındıktan sonra banka hesabına geçen miktarlardır.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {payouts.length === 0 ? (
            <EmptyPayouts payoutsEnabled={payoutsEnabled} />
          ) : (
            <Tabs defaultValue={defaultTab}>
              <TabsList>
                {visibleTabs.map((status) => (
                  <TabsTrigger key={status} value={status}>
                    {STATUS_META[status].label}
                    <span className="ml-1.5 tabular-nums text-muted-foreground">
                      {grouped.get(status)?.length ?? 0}
                    </span>
                  </TabsTrigger>
                ))}
              </TabsList>

              {visibleTabs.map((status) => (
                <TabsContent key={status} value={status} className="mt-4">
                  <PayoutList rows={grouped.get(status) ?? []} status={status} currency={currency} />
                </TabsContent>
              ))}
            </Tabs>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Pieces                                                                    */
/* -------------------------------------------------------------------------- */

function PayoutList({
  rows,
  status,
  currency,
}: {
  rows: readonly PayoutRow[]
  status: Enums<"payout_status">
  currency: string
}) {
  if (rows.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
        No {STATUS_META[status].label.toLowerCase()} payouts.
      </p>
    )
  }

  return (
    <ul className="divide-y divide-border rounded-md border border-border">
      {rows.map((row) => (
        <li key={row.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <p className="font-medium tabular-nums">
              {formatMinor(row.amountMinor, row.currency || currency)}
            </p>
            <p className="text-xs text-muted-foreground">
              {row.arrivalDate
                ? `${row.status === "paid" ? "Arrived" : "Expected"} ${formatArrival(row.arrivalDate)}`
                : `Created ${formatCreated(row.createdAt)}`}
              {" · "}
              <span className="font-mono" title={row.stripePayoutId}>
                {shortenPayoutId(row.stripePayoutId)}
              </span>
            </p>
          </div>
          <PayoutStatusBadge status={row.status} />
        </li>
      ))}
    </ul>
  )
}

export function PayoutStatusBadge({ status }: { status: Enums<"payout_status"> }) {
  const meta = STATUS_META[status]
  return (
    <Badge variant={meta.variant} className="gap-1.5 whitespace-nowrap">
      <span aria-hidden="true" className={cn("h-1.5 w-1.5 shrink-0 rounded-full", meta.dot)} />
      {meta.label}
    </Badge>
  )
}

function EmptyPayouts({ payoutsEnabled }: { payoutsEnabled: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border px-6 py-12 text-center">
      <svg
        viewBox="0 0 24 24"
        className="h-8 w-8 text-muted-foreground"
        aria-hidden="true"
        focusable="false"
      >
        <rect x="2.5" y="6" width="19" height="12" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M2.5 10h19" stroke="currentColor" strokeWidth="1.5" />
        <path d="M6 14h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      <p className="text-sm font-medium">Henüz hakediş yok</p>
      <p className="max-w-md text-xs text-muted-foreground">
        {payoutsEnabled
          ? "Your first payout is created automatically once a settled booking builds up a balance on your connected account."
          : "Finish Stripe onboarding to enable payouts. Until then, bookings can be taken but nothing can be paid out."}
      </p>
    </div>
  )
}

export function PayoutScheduleSkeleton() {
  return (
    <div className="space-y-6" role="status" aria-label="Hakedişler yükleniyor">
      <div className="grid gap-4 md:grid-cols-2">
        {[0, 1].map((index) => (
          <Card key={index} aria-hidden="true">
            <CardHeader className="pb-3">
              <Skeleton className="h-4 w-36" />
            </CardHeader>
            <CardContent className="space-y-2">
              <Skeleton className="h-8 w-40" />
              <Skeleton className="h-4 w-56" />
            </CardContent>
          </Card>
        ))}
      </div>
      <Card aria-hidden="true">
        <CardHeader>
          <Skeleton className="h-5 w-36" />
        </CardHeader>
        <CardContent className="space-y-2">
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} className="h-14 w-full" />
          ))}
        </CardContent>
      </Card>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Formatting                                                                */
/* -------------------------------------------------------------------------- */

function groupByStatus(
  payouts: readonly PayoutRow[],
): Map<Enums<"payout_status">, PayoutRow[]> {
  const map = new Map<Enums<"payout_status">, PayoutRow[]>()
  for (const status of TAB_ORDER) map.set(status, [])
  for (const payout of payouts) {
    const bucket = map.get(payout.status)
    if (bucket) bucket.push(payout)
  }
  return map
}

function describeInterval(schedule: PayoutScheduleInfo): string {
  switch (schedule.interval) {
    case "manual":
      return "Manual — you trigger each payout"
    case "daily":
      return "Every business day"
    case "weekly":
      return schedule.weeklyAnchor
        ? `Weekly, every ${capitalise(schedule.weeklyAnchor)}`
        : "Weekly"
    case "monthly":
      return schedule.monthlyAnchor
        ? `Monthly, on day ${schedule.monthlyAnchor}`
        : "Monthly"
    default:
      return capitalise(schedule.interval)
  }
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

/** `arrival_date` is a bare calendar date; formatting it in UTC keeps it on the day Stripe meant. */
function formatArrival(dateKey: string): string {
  const date = new Date(`${dateKey}T12:00:00.000Z`)
  if (!Number.isFinite(date.getTime())) return dateKey
  return new Intl.DateTimeFormat("tr-TR", {
    timeZone: "UTC",
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date)
}

function formatCreated(iso: string): string {
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return "—"
  return new Intl.DateTimeFormat("tr-TR", { day: "numeric", month: "short", year: "numeric" }).format(
    date,
  )
}

/** `po_1AbCdEfGhIjKlMnO` → `po_…lMnO`. Enough to match against a Stripe dashboard row. */
function shortenPayoutId(id: string): string {
  if (id.length <= 12) return id
  return `${id.slice(0, 3)}…${id.slice(-6)}`
}
