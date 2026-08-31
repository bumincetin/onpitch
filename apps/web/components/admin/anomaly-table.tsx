/**
 * components/admin/anomaly-table.tsx
 *
 * `match_anomaly_flags` joined to the match it judged, worst score first.
 *
 * ---------------------------------------------------------------------------
 * READING AN ISOLATION FOREST VERDICT
 * ---------------------------------------------------------------------------
 * The forest scores a match by how FEW splits it takes to isolate it: a short average path
 * length means the point fell out of the tree early, which is what makes it anomalous, and the
 * score rises as that path shortens. `leaf_depth` is where this particular match landed;
 * `average_path_length` is the expected depth for a sample of that size, so the interesting
 * number is the gap between them.
 *
 * That is a lead, not a verdict. The forest is unsupervised and knows nothing about football:
 * a 12-0 in a mismatched friendly is genuinely unusual and entirely honest. The reason codes
 * are what make a flag actionable, which is why they are rendered in full rather than summed
 * into a badge.
 *
 * A server component: nothing here is interactive, and the row's action lives on the match's
 * own page.
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
import { formatDateTime, StatusBadge } from "@/components/admin/dispute-queue"
import type { Enums } from "@halisaha/shared/database"

export interface AnomalyRow {
  flagId: string
  matchId: string
  /** `rule_engine` | `isolation_forest` | `manual` (CHECK constraint, not an enum). */
  source: string
  anomalyScore: number | null
  isAnomalous: boolean
  /** Machine-readable reason codes, already decoded from the `reasons` jsonb array. */
  reasons: readonly string[]
  modelVersion: string | null
  leafDepth: number | null
  averagePathLength: number | null
  createdAt: string
  matchStatus: Enums<"match_status"> | null
  kickoffAt: string | null
  /**
   * The venue's IANA zone, when the caller had a venue to hand. Kickoff reads on it; omitted
   * timestamps fall back to `ADMIN_DEFAULT_TIME_ZONE`, which is labelled either way.
   */
  venueTimeZone?: string | null
  requiresConsensus: boolean
}

export interface AnomalyTableProps {
  rows: readonly AnomalyRow[]
  /** The cut at which a flag opens a consensus round. `anomaly_score_threshold()`, default 0.62. */
  threshold?: number
  className?: string
}

export function AnomalyTable({ rows, threshold = 0.62, className }: AnomalyTableProps) {
  if (rows.length === 0) {
    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle className="text-base">Kayıtlı anomali işareti yok</CardTitle>
          <CardDescription>
            Dedektör puanladığı her maç için bir satır yazar. Boş tablo, Isolation Forest servisinin çalışmadığı ya da henüz ona hiçbir maçın ulaşmadığı anlamına gelir.
          </CardDescription>
        </CardHeader>
      </Card>
    )
  }

  return (
    <div className={cn("rounded-lg border border-border", className)}>
      <Table>
        <caption className="sr-only">
          Anomali kararları, en anormali önce. Yüksek skor, maçı ayırmak için daha az bölme gerektiği anlamına gelir.
        </caption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col" className="text-right">
              Skor
            </TableHead>
            <TableHead scope="col">Maç</TableHead>
            <TableHead scope="col">Kaynak</TableHead>
            <TableHead scope="col" className="text-right">
              Yol
            </TableHead>
            <TableHead scope="col">Gerekçeler</TableHead>
            <TableHead scope="col">
              <span className="sr-only">Aç</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.flagId}>
              <TableCell className="text-right align-top">
                <div
                  className={cn(
                    "text-base tabular-nums",
                    row.isAnomalous ? "font-semibold text-destructive" : "text-muted-foreground",
                  )}
                >
                  {row.anomalyScore === null ? "—" : row.anomalyScore.toFixed(3)}
                </div>
                <div className="text-xs text-muted-foreground">
                  {row.isAnomalous ? `over ${threshold}` : `under ${threshold}`}
                </div>
              </TableCell>

              <TableCell className="align-top">
                <div className="text-sm">
                  {row.kickoffAt ? formatDateTime(row.kickoffAt, row.venueTimeZone) : "kickoff unknown"}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  {row.matchStatus ? <StatusBadge status={row.matchStatus} /> : null}
                  {row.requiresConsensus ? <Badge variant="warning">tur açık</Badge> : null}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  flagged {formatDateTime(row.createdAt)}
                </div>
              </TableCell>

              <TableCell className="align-top">
                <div className="text-sm">{row.source.replace(/_/g, " ")}</div>
                <div className="text-xs text-muted-foreground">{row.modelVersion ?? "no version"}</div>
              </TableCell>

              <TableCell className="text-right align-top tabular-nums">
                <PathLength leafDepth={row.leafDepth} averagePathLength={row.averagePathLength} />
              </TableCell>

              <TableCell className="align-top">
                {row.reasons.length === 0 ? (
                  <span className="text-xs text-muted-foreground">gerekçe kodu yok</span>
                ) : (
                  <ul className="flex flex-wrap gap-1">
                    {row.reasons.map((reason) => (
                      <li key={reason}>
                        <Badge variant="outline" className="font-mono text-[11px]">
                          {reason}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                )}
              </TableCell>

              <TableCell className="align-top text-right">
                <Link
                  href={`/admin/matches/${row.matchId}`}
                  className="inline-flex h-9 items-center rounded-md border border-input bg-background px-3 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  İncele
                  <span className="sr-only"> işaretlenen maç</span>
                </Link>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

/**
 * Depth reached vs depth expected. The gap is the signal: landing at 4 when the average is 9
 * means the forest separated this match from the rest of the sample in less than half the
 * usual number of questions.
 */
function PathLength({
  leafDepth,
  averagePathLength,
}: {
  leafDepth: number | null
  averagePathLength: number | null
}) {
  if (leafDepth === null && averagePathLength === null) {
    return <span className="text-xs text-muted-foreground">—</span>
  }

  const gap =
    leafDepth !== null && averagePathLength !== null ? averagePathLength - leafDepth : null

  return (
    <div>
      <div className="text-sm">
        {leafDepth ?? "—"}
        <span className="text-muted-foreground"> / {averagePathLength?.toFixed(2) ?? "—"}</span>
      </div>
      <div className="text-xs text-muted-foreground">
        {gap === null ? "leaf / average" : gap > 0 ? `${gap.toFixed(2)} shallower` : "no shortfall"}
      </div>
    </div>
  )
}

/**
 * Decodes `match_anomaly_flags.reasons`, which is `jsonb` and therefore `Json` at the type
 * level: anything at all. Only strings survive, so a malformed row degrades to "no reason
 * codes" instead of rendering `[object Object]`.
 */
export function decodeReasons(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((entry): entry is string => typeof entry === "string")
}
