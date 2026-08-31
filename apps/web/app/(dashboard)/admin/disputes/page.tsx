/**
 * app/(dashboard)/admin/disputes/page.tsx
 *
 * Everything waiting on a human: `disputed` (a rejection quorum, or a round that timed out) and
 * `requires_consensus` (a round still open).
 *
 * ---------------------------------------------------------------------------
 * ONE QUERY, NOT ONE PER MATCH
 * ---------------------------------------------------------------------------
 * Reports, votes, roster size and venue name all arrive as embedded resources on the same
 * request. Fetching the queue and then looping to count reports would be a round trip per row,
 * and this page exists to be opened when something is on fire.
 *
 * The read goes through the operator's own client. `matches_select_involved` resolves to
 * `can_manage_match`, which has an `is_admin()` disjunct, so the same query an organiser uses
 * to see their own fixture returns the platform's when an admin runs it. An admin whose claim
 * has gone stale sees an empty queue rather than somebody else's data.
 */

import Link from "next/link"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { DisputeQueue, type DisputeQueueRow } from "@/components/admin/dispute-queue"
import { requireRole } from "@/lib/rbac"
import { createClient } from "@/lib/supabase/server"
import type { Enums } from "@halisaha/shared/database"

export const dynamic = "force-dynamic"

const QUEUE_SELECT =
  "id, status, format, kickoff_at, consensus_deadline, anomaly_score," +
  // `timezone` so kickoff and deadline render on the venue's clock rather than the Node
  // process's; see `formatDateTime` in components/admin/dispute-queue.
  "venue:venues(name,timezone)," +
  "score_reports(home_score,away_score)," +
  "consensus_approvals(decision)," +
  "match_participants(id)"

/**
 * The embedded shape of `QUEUE_SELECT`. Written by hand because postgrest-js cannot infer a
 * result type from a concatenated select string — change one and change the other.
 */
interface QueueMatch {
  id: string
  status: Enums<"match_status">
  format: Enums<"match_format">
  kickoff_at: string
  consensus_deadline: string | null
  anomaly_score: number | null
  venue: { name: string; timezone: string } | null
  score_reports: Array<{ home_score: number; away_score: number }>
  consensus_approvals: Array<{ decision: string }>
  match_participants: Array<{ id: string }>
}

const QUEUE_STATUSES: readonly Enums<"match_status">[] = ["disputed", "requires_consensus"]

export default async function AdminDisputesPage() {
  await requireRole("admin")

  const supabase = await createClient()

  const { data, error } = await supabase
    .from("matches")
    .select(QUEUE_SELECT)
    .in("status", QUEUE_STATUSES)
    // Whatever is closest to its deadline first; matches with no deadline sort after those
    // that have one, then oldest kickoff.
    .order("consensus_deadline", { ascending: true, nullsFirst: false })
    .order("kickoff_at", { ascending: true })
    .limit(100)

  if (error) {
    console.error("[admin/disputes] queue query failed", { code: error.code })
    return (
      <Alert variant="destructive">
        <AlertTitle>Kuyruk yüklenemedi</AlertTitle>
        <AlertDescription>
          Veritabanı sorguyu reddetti. Sayfayı yenile; sürerse yönetici rolünün hâlâ güncel olup olmadığını kontrol et — rol değişikliğinden eski bir jeton, eski rolü taşır.
        </AlertDescription>
      </Alert>
    )
  }

  const matches = (data ?? []) as unknown as QueueMatch[]
  const rows: DisputeQueueRow[] = matches.map(toQueueRow)

  const disputed = rows.filter((row) => row.status === "disputed").length
  const openRounds = rows.length - disputed

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Senin kararını bekliyor
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{disputed}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Oyuncular sonucu reddetti ya da turun süresi doldu.
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Hâlâ oyuncularda
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold tabular-nums">{openRounds}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Turlar açık. Yeter sayıya ulaşınca ya da süre dolunca kendiliğinden kapanır.
            </p>
          </CardContent>
        </Card>
      </div>

      <DisputeQueue rows={rows} />

      {rows.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          Vote counts are every approval and rejection ever cast on the match. Only votes bound to
          the current round nonce and the current canonical payload count toward quorum, so a late
          score report can retire votes that are still shown here. The review page for each match
          shows which ones still count.
          {rows.length === 100 ? " Showing the first 100 — settle some and reload for the rest." : ""}
        </p>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Bunlar nereden geliyor</CardTitle>
            <CardDescription>
              Bir maç buraya; uzlaşma turu ret çoğunluğuyla kapandığında, süre taraması süresi geçmiş bir tur bulduğunda ya da anomali dedektörü sonucu eşiğin üstünde puanlayıp kimsenin onaylamadığı bir tur açtığında düşer.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link href="/admin/anomalies" className="text-sm text-primary underline-offset-4 hover:underline">
              Dedektörün neyi işaretlediğine bak
            </Link>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function toQueueRow(match: QueueMatch): DisputeQueueRow {
  const scorelines = new Set(
    match.score_reports.map((report) => `${report.home_score}-${report.away_score}`),
  )

  let approvals = 0
  let rejections = 0
  for (const vote of match.consensus_approvals) {
    if (vote.decision === "approve") approvals += 1
    else if (vote.decision === "reject") rejections += 1
  }

  return {
    matchId: match.id,
    status: match.status,
    format: match.format,
    kickoffAt: match.kickoff_at,
    venueName: match.venue?.name ?? null,
    venueTimeZone: match.venue?.timezone ?? null,
    reportCount: match.score_reports.length,
    distinctScorelines: scorelines.size,
    approvals,
    rejections,
    participantCount: match.match_participants.length,
    anomalyScore: match.anomaly_score,
    consensusDeadline: match.consensus_deadline,
  }
}
