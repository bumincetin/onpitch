/**
 * components/venue/bookings-table.tsx
 *
 * The venue owner's booking ledger.
 *
 * Presentational and server-renderable on purpose: it takes an already-flattened
 * {@link VenueBookingRow}, not a PostgREST embed, so the page owns the query shape and this file
 * owns the rendering. That split is what lets the same table serve the overview page's "next up"
 * preview and the full bookings page without either of them re-deriving how a status looks.
 *
 * Two states are shown side by side because they answer different questions and routinely
 * disagree: `status` is the LIFECYCLE (does this booking hold the pitch?) and `payment_status` is
 * the MONEY (has the charge settled?). A `confirmed` booking whose payment is still `processing`
 * is a real and important row — the slot is held, the money is not in yet — and collapsing the
 * two into one chip would hide exactly the case an owner needs to chase.
 *
 * Status is never colour-alone: every badge carries its own words, so the table survives
 * greyscale printing and forced-colors mode.
 */

import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import type { Enums } from "@onpitch/shared/database"
import { formatMinor } from "@onpitch/shared/domain"

/** A booking flattened for display. The page maps PostgREST rows into this. */
export interface VenueBookingRow {
  id: string
  pitchId: string
  pitchName: string
  /** ISO-8601 instant, inclusive lower bound. */
  startsAt: string
  /** ISO-8601 instant, exclusive upper bound. */
  endsAt: string
  status: Enums<"booking_status">
  paymentStatus: Enums<"payment_status">
  totalMinor: number
  platformFeeMinor: number
  refundedAmountMinor: number
  currency: string
  /**
   * The booker's display name, or `null` when their profile is not visible to this owner.
   * That is not a bug: `profiles_select_self_or_visible` defaults a profile to `private`, and a
   * venue owner is entitled to the booking, not to the person. Render the fallback, not an error.
   */
  bookedByName: string | null
  teamName: string | null
  notes: string | null
  createdAt: string
}

export interface BookingsTableProps {
  rows: readonly VenueBookingRow[]
  /** IANA zone the times are rendered in — the venue's, never the viewer's. */
  timezone: string
  /** Screen-reader caption describing what this particular table is showing. */
  caption?: string
  /** Hide the money columns for the compact "next up" variant. */
  compact?: boolean
  emptyTitle?: string
  emptyBody?: string
  className?: string
}

export function BookingsTable({
  rows,
  timezone,
  caption = "İşletmenin rezervasyonları",
  compact = false,
  emptyTitle = "No bookings yet",
  emptyBody = "Once players book one of your pitches, every reservation will appear here with its payment state.",
  className,
}: BookingsTableProps) {
  if (rows.length === 0) {
    return <BookingsEmptyState title={emptyTitle} body={emptyBody} className={className} />
  }

  return (
    <div className={cn("w-full overflow-x-auto", className)}>
      <Table>
        <TableCaption className="sr-only">{caption}</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Ne zaman</TableHead>
            <TableHead scope="col">Saha</TableHead>
            <TableHead scope="col">Rezerve eden</TableHead>
            <TableHead scope="col">Durum</TableHead>
            {!compact ? (
              <>
                <TableHead scope="col">Ödeme</TableHead>
                <TableHead scope="col" className="text-right">
                  Toplam
                </TableHead>
                <TableHead scope="col" className="text-right">
                  Senin payın
                </TableHead>
              </>
            ) : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell className="whitespace-nowrap align-top">
                <div className="font-medium">{formatDay(row.startsAt, timezone)}</div>
                <div className="text-xs tabular-nums text-muted-foreground">
                  {formatTimeRange(row.startsAt, row.endsAt, timezone)}
                </div>
              </TableCell>

              <TableCell className="align-top">
                <div className="font-medium">{row.pitchName}</div>
                {row.teamName ? (
                  <div className="text-xs text-muted-foreground">{row.teamName}</div>
                ) : null}
              </TableCell>

              <TableCell className="align-top">
                <span className={cn(!row.bookedByName && "text-muted-foreground")}>
                  {row.bookedByName ?? "Private profile"}
                </span>
                {row.notes ? (
                  <div className="mt-0.5 max-w-[24ch] truncate text-xs text-muted-foreground" title={row.notes}>
                    {row.notes}
                  </div>
                ) : null}
              </TableCell>

              <TableCell className="align-top">
                <BookingStatusBadge status={row.status} />
              </TableCell>

              {!compact ? (
                <>
                  <TableCell className="align-top">
                    <PaymentStatusBadge status={row.paymentStatus} />
                    {row.refundedAmountMinor > 0 ? (
                      <div className="mt-1 text-xs tabular-nums text-muted-foreground">
                        {formatMinor(row.refundedAmountMinor, row.currency)} refunded
                      </div>
                    ) : null}
                  </TableCell>

                  <TableCell className="whitespace-nowrap text-right align-top tabular-nums">
                    {formatMinor(row.totalMinor, row.currency)}
                  </TableCell>

                  <TableCell className="whitespace-nowrap text-right align-top tabular-nums">
                    {formatMinor(netToVenueMinor(row), row.currency)}
                    <div className="text-xs font-normal text-muted-foreground">
                      after {formatMinor(row.platformFeeMinor, row.currency)} fee
                    </div>
                  </TableCell>
                </>
              ) : null}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Badges                                                                    */
/* -------------------------------------------------------------------------- */

type BadgeVariant = "default" | "secondary" | "destructive" | "outline"

const BOOKING_STATUS_META: Readonly<
  Record<Enums<"booking_status">, { label: string; variant: BadgeVariant; dot: string }>
> = {
  pending: { label: "Bekliyor", variant: "outline", dot: "bg-muted-foreground" },
  awaiting_payment: { label: "Ödeme bekleniyor", variant: "outline", dot: "bg-amber-500" },
  confirmed: { label: "Onaylandı", variant: "default", dot: "bg-emerald-500" },
  completed: { label: "Tamamlandı", variant: "secondary", dot: "bg-sky-500" },
  cancelled: { label: "İptal edildi", variant: "secondary", dot: "bg-muted-foreground" },
  refunded: { label: "İade edildi", variant: "outline", dot: "bg-muted-foreground" },
  disputed: { label: "İtirazlı", variant: "destructive", dot: "bg-destructive" },
}

const PAYMENT_STATUS_META: Readonly<
  Record<Enums<"payment_status">, { label: string; variant: BadgeVariant; dot: string }>
> = {
  requires_payment: { label: "Ödenmedi", variant: "outline", dot: "bg-muted-foreground" },
  processing: { label: "İşleniyor", variant: "outline", dot: "bg-amber-500" },
  succeeded: { label: "Ödendi", variant: "default", dot: "bg-emerald-500" },
  failed: { label: "Başarısız", variant: "destructive", dot: "bg-destructive" },
  refunded: { label: "İade edildi", variant: "secondary", dot: "bg-muted-foreground" },
  partially_refunded: { label: "Kısmen iade", variant: "secondary", dot: "bg-sky-500" },
}

export function BookingStatusBadge({ status }: { status: Enums<"booking_status"> }) {
  const meta = BOOKING_STATUS_META[status]
  return (
    <Badge variant={meta.variant} className="gap-1.5 whitespace-nowrap">
      <span aria-hidden="true" className={cn("h-1.5 w-1.5 shrink-0 rounded-full", meta.dot)} />
      {meta.label}
    </Badge>
  )
}

export function PaymentStatusBadge({ status }: { status: Enums<"payment_status"> }) {
  const meta = PAYMENT_STATUS_META[status]
  return (
    <Badge variant={meta.variant} className="gap-1.5 whitespace-nowrap">
      <span aria-hidden="true" className={cn("h-1.5 w-1.5 shrink-0 rounded-full", meta.dot)} />
      {meta.label}
    </Badge>
  )
}

/* -------------------------------------------------------------------------- */
/*  Empty + loading                                                           */
/* -------------------------------------------------------------------------- */

export function BookingsEmptyState({
  title,
  body,
  className,
}: {
  title: string
  body: string
  className?: string
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border px-6 py-12 text-center",
        className,
      )}
    >
      <svg
        viewBox="0 0 24 24"
        className="h-8 w-8 text-muted-foreground"
        aria-hidden="true"
        focusable="false"
      >
        <rect
          x="3"
          y="5"
          width="18"
          height="16"
          rx="2"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <path d="M3 10h18M8 3v4M16 3v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      <p className="text-sm font-medium">{title}</p>
      <p className="max-w-md text-xs text-muted-foreground">{body}</p>
    </div>
  )
}

export function BookingsTableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="w-full space-y-2" role="status" aria-label="Rezervasyonlar yükleniyor">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-center gap-4 rounded-md border border-border p-3">
          <Skeleton className="h-9 w-28" />
          <Skeleton className="h-9 flex-1" />
          <Skeleton className="h-6 w-24" />
          <Skeleton className="h-6 w-20" />
        </div>
      ))}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Formatting                                                                */
/* -------------------------------------------------------------------------- */

/**
 * What the venue keeps: the customer's total, less the Stripe application fee, less anything
 * refunded. Mirrors `venueNetMinor` in `lib/payments.ts` with the refund term added, and assumes
 * the application fee is not refunded pro rata — the platform's default policy.
 */
function netToVenueMinor(row: VenueBookingRow): number {
  return Math.max(0, row.totalMinor - row.platformFeeMinor - row.refundedAmountMinor)
}

function formatDay(iso: string, timeZone: string): string {
  return safeFormat(iso, {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
  })
}

function formatTimeRange(startIso: string, endIso: string, timeZone: string): string {
  const options: Intl.DateTimeFormatOptions = {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }
  return `${safeFormat(startIso, options)}–${safeFormat(endIso, options)}`
}

/** An unparseable instant or an unknown IANA zone must degrade, never throw mid-render. */
function safeFormat(iso: string, options: Intl.DateTimeFormatOptions): string {
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return "—"
  try {
    return new Intl.DateTimeFormat("tr-TR", options).format(date)
  } catch {
    return new Intl.DateTimeFormat("tr-TR", { ...options, timeZone: "UTC" }).format(date)
  }
}

/* ========================================================================== */
/*  PostgREST → display shape                                                 */
/* ========================================================================== */
/*
 * Lives here rather than in each page so every venue screen flattens a booking the same way. The
 * module has no `'use client'` directive and no client-only imports, so a Server Component can
 * import the mapper and the table together.
 */

/** One embedded to-one relation, which postgrest-js may hand back boxed in an array. */
type Embedded<T> = T | T[] | null | undefined

function pickOne<T>(value: Embedded<T>): T | null {
  if (value === null || value === undefined) return null
  return Array.isArray(value) ? (value[0] ?? null) : value
}

/** The projection the venue pages select, plus the two optional embeds. */
export interface RawVenueBookingRow {
  id: string
  pitch_id: string
  team_id: string | null
  time_range: string
  status: Enums<"booking_status">
  payment_status: Enums<"payment_status">
  total_minor: number
  platform_fee_minor: number
  refunded_amount_minor: number
  currency: string
  notes: string | null
  created_at: string
  profiles?: Embedded<{ display_name: string | null; full_name: string | null }>
  teams?: Embedded<{ name: string | null }>
}

/**
 * Flatten PostgREST rows into {@link VenueBookingRow}.
 *
 * The booker's profile embed can legitimately be `null`, and that is a FEATURE:
 * `profiles_select_self_or_visible` defaults a profile to `private`, so a venue owner is entitled
 * to the booking, not to the person behind it. It renders as "Private profile", never as an error.
 *
 * A row whose `time_range` will not parse is dropped rather than rendered as `Invalid Date` —
 * one malformed literal must not poison a whole table.
 */
export function toVenueBookingRows(
  rows: readonly unknown[],
  pitchNames: ReadonlyMap<string, string>,
): VenueBookingRow[] {
  const result: VenueBookingRow[] = []

  for (const raw of rows) {
    const row = raw as RawVenueBookingRow
    const bounds = splitTstzRange(row.time_range)
    if (!bounds) continue

    const bookerProfile = pickOne(row.profiles)
    const team = pickOne(row.teams)

    result.push({
      id: row.id,
      pitchId: row.pitch_id,
      pitchName: pitchNames.get(row.pitch_id) ?? "Pitch",
      startsAt: bounds.startsAt,
      endsAt: bounds.endsAt,
      status: row.status,
      paymentStatus: row.payment_status,
      totalMinor: row.total_minor,
      platformFeeMinor: row.platform_fee_minor,
      refundedAmountMinor: row.refunded_amount_minor,
      currency: row.currency,
      bookedByName: bookerProfile?.display_name ?? bookerProfile?.full_name ?? null,
      teamName: team?.name ?? null,
      notes: row.notes,
      createdAt: row.created_at,
    })
  }

  return result
}

/**
 * `["2026-09-01 18:00:00+00","2026-09-01 19:00:00+00")` → two ISO instants.
 *
 * PostgREST returns the raw range literal; its space separator and truncated `+00` offset are not
 * accepted by `Date` on every runtime, so both are normalised. Commas inside the quoted bounds
 * are why this scans for the separator instead of calling `split(',')`.
 */
export function splitTstzRange(literal: string): { startsAt: string; endsAt: string } | null {
  if (typeof literal !== "string") return null
  const inner = literal.trim().replace(/^[[(]/, "").replace(/[\])]$/, "")

  let inQuotes = false
  let splitAt = -1
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index]
    if (char === '"') inQuotes = !inQuotes
    else if (char === "," && !inQuotes) {
      splitAt = index
      break
    }
  }
  if (splitAt < 0) return null

  const start = new Date(normaliseTimestamp(inner.slice(0, splitAt)))
  const end = new Date(normaliseTimestamp(inner.slice(splitAt + 1)))
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return null

  return { startsAt: start.toISOString(), endsAt: end.toISOString() }
}

function normaliseTimestamp(raw: string): string {
  const unquoted = raw.trim().replace(/^"/, "").replace(/"$/, "")
  return unquoted
    .replace(" ", "T")
    .replace(
      /T([\d:.]+)([+-]\d{2})(\d{2})?$/,
      (_all, time: string, hh: string, mm?: string) => `T${time}${hh}:${mm ?? "00"}`,
    )
}
