/**
 * components/admin/dispute-queue.tsx
 *
 * The work queue: matches sitting in `disputed` or `requires_consensus`, ordered by how long
 * they have been waiting.
 *
 * A server component. The queue is read-only — every action on a row happens on the match's
 * own resolve page, where the evidence is — so there is no reason to ship JavaScript for it.
 *
 * The columns are chosen to answer "which of these do I open first?" without opening any of
 * them: how many people filed a score, how many DIFFERENT scores they filed, whether the
 * anomaly detector had an opinion, and how close the consensus deadline is. A match with six
 * reports and one scoreline is a formality; two reports and two scorelines is a real argument.
 */

import Link from "next/link"

import { Badge } from "@/components/ui/badge"
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { cn } from "@/lib/utils"
import type { Enums } from "@onpitch/shared/database"

export interface DisputeQueueRow {
  matchId: string
  status: Enums<"match_status">
  format: Enums<"match_format">
  kickoffAt: string
  venueName: string | null
  /**
   * The venue's IANA zone, so kickoff and deadline read on the clock the players used. Null
   * when the venue is withheld, in which case {@link ADMIN_DEFAULT_TIME_ZONE} stands in.
   */
  venueTimeZone: string | null
  /** Score reports filed so far. */
  reportCount: number
  /** How many DIFFERENT scorelines those reports claim. 1 means everyone agrees. */
  distinctScorelines: number
  approvals: number
  rejections: number
  participantCount: number
  anomalyScore: number | null
  consensusDeadline: string | null
}

export interface DisputeQueueProps {
  rows: readonly DisputeQueueRow[]
  /** Rendered instead of the table when the queue is empty. */
  emptyMessage?: string
  className?: string
}

export function DisputeQueue({ rows, emptyMessage, className }: DisputeQueueProps) {
  if (rows.length === 0) {
    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle className="text-base">Seni bekleyen bir şey yok</CardTitle>
          <CardDescription>
            {emptyMessage ??
              "No match is disputed or stuck in a consensus round. Rounds that pass their deadline " +
                "arrive here on their own."}
          </CardDescription>
        </CardHeader>
      </Card>
    )
  }

  return (
    <div className={cn("rounded-lg border border-border", className)}>
      <Table>
        <caption className="sr-only">
          Yönetici kararı bekleyen maçlar, en eskisi önce
        </caption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Maç</TableHead>
            <TableHead scope="col">Durum</TableHead>
            <TableHead scope="col" className="text-right">
              Bildirim
            </TableHead>
            <TableHead scope="col" className="text-right">
              Oy
            </TableHead>
            <TableHead scope="col" className="text-right">
              Anomali
            </TableHead>
            <TableHead scope="col">Son tarih</TableHead>
            <TableHead scope="col">
              <span className="sr-only">Aç</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.matchId}>
              <TableCell>
                <div className="font-medium">{row.venueName ?? "Venue withheld"}</div>
                <div className="text-xs text-muted-foreground">
                  {formatDateTime(row.kickoffAt, row.venueTimeZone)} · {formatFormat(row.format)} ·{" "}
                  {row.participantCount} on the sheet
                </div>
              </TableCell>

              <TableCell>
                <StatusBadge status={row.status} />
              </TableCell>

              <TableCell className="text-right">
                <div>{row.reportCount}</div>
                <div
                  className={cn(
                    "text-xs",
                    row.distinctScorelines > 1 ? "text-destructive" : "text-muted-foreground",
                  )}
                >
                  {row.reportCount === 0
                    ? "none filed"
                    : row.distinctScorelines === 1
                      ? "all agree"
                      : `${row.distinctScorelines} scorelines`}
                </div>
              </TableCell>

              <TableCell className="text-right tabular-nums">
                <span className="text-success">{row.approvals}</span>
                <span className="text-muted-foreground"> / </span>
                <span className="text-destructive">{row.rejections}</span>
                <div className="text-xs text-muted-foreground">onay / ret</div>
              </TableCell>

              <TableCell className="text-right">
                <AnomalyScore score={row.anomalyScore} />
              </TableCell>

              <TableCell>
                <Deadline iso={row.consensusDeadline} timeZone={row.venueTimeZone} />
              </TableCell>

              <TableCell className="text-right">
                <Link
                  href={`/admin/matches/${row.matchId}`}
                  className="inline-flex h-9 items-center rounded-md border border-input bg-background px-3 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  İncele
                  <span className="sr-only">
                    {" "}
                    the match at {row.venueName ?? "an undisclosed venue"} on{" "}
                    {formatDateTime(row.kickoffAt, row.venueTimeZone)}
                  </span>
                </Link>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

export function StatusBadge({ status }: { status: Enums<"match_status"> }) {
  const label = status.replace(/_/g, " ")
  switch (status) {
    case "disputed":
      return <Badge variant="destructive">{label}</Badge>
    case "requires_consensus":
      return <Badge variant="warning">{label}</Badge>
    case "finalized":
      return <Badge variant="success">{label}</Badge>
    case "cancelled":
      return <Badge variant="outline">{label}</Badge>
    default:
      return <Badge variant="secondary">{label}</Badge>
  }
}

/**
 * Higher score = more anomalous. `anomaly_score_threshold()` defaults to 0.62 and is what
 * opens a consensus round, so the colour changes there rather than at an invented cut.
 */
function AnomalyScore({ score }: { score: number | null }) {
  if (score === null) {
    return <span className="text-xs text-muted-foreground">kontrol edilmedi</span>
  }
  return (
    <span className={cn("tabular-nums", score >= 0.62 ? "font-semibold text-destructive" : undefined)}>
      {score.toFixed(3)}
    </span>
  )
}

function Deadline({ iso, timeZone }: { iso: string | null; timeZone?: string | null }) {
  if (!iso) return <span className="text-xs text-muted-foreground">yok</span>

  const deadline = new Date(iso)
  const overdue = deadline.getTime() < Date.now()

  return (
    <span className={cn("text-sm", overdue ? "font-medium text-destructive" : "text-muted-foreground")}>
      <time dateTime={iso}>{formatDateTime(iso, timeZone)}</time>
      {overdue ? <span className="block text-xs">geçti</span> : null}
    </span>
  )
}

/**
 * The zone used when a timestamp has no venue to borrow one from (audit rows, a match whose
 * venue was withheld). The account and consent surfaces already pin this same zone.
 */
export const ADMIN_DEFAULT_TIME_ZONE = "Europe/Istanbul"

/**
 * Every timestamp in the console is rendered in an EXPLICIT zone and carries its label.
 *
 * These components are server-rendered — there is no "use client" here or in any caller — so
 * without a `timeZone` the string is frozen in whatever zone the Node process happens to run
 * in, which is the deploy host's business and not the operator's. `timeZoneName: "short"` puts
 * the zone on the page so a decision is never made against an implied clock.
 *
 * The components are spelled out rather than using `dateStyle`/`timeStyle`: ECMA-402 throws a
 * TypeError when either of those is combined with `timeZoneName`. This combination renders
 * identically to the old `medium`/`short` pair, plus the zone.
 *
 * `timeZone` accepts `null` as well as `undefined` so a caller can hand over a venue zone that
 * may be absent (a withheld venue, an audit row) without spelling out the fallback each time.
 */
export function formatDateTime(iso: string, timeZone?: string | null): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return "unknown"
  return new Intl.DateTimeFormat("tr-TR", {
    timeZone: timeZone ?? ADMIN_DEFAULT_TIME_ZONE,
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).format(date)
}

export function formatFormat(format: Enums<"match_format">): string {
  const sizes: Record<Enums<"match_format">, string> = {
    five_a_side: "5 kişilik",
    six_a_side: "6 kişilik",
    seven_a_side: "7 kişilik",
    eight_a_side: "8 kişilik",
    eleven_a_side: "11 kişilik",
  }
  return sizes[format]
}
