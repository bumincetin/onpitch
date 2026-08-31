/**
 * app/(dashboard)/admin/anomalies/page.tsx
 *
 * `match_anomaly_flags` joined to the matches they judged, worst score first.
 *
 * The threshold is read from `anomaly_score_threshold()` rather than hard-coded, because that
 * function is what actually decides whether a flag opens a consensus round. Printing a
 * different number here than the one the pipeline uses would make every borderline row a lie.
 *
 * `match_anomaly_flags` is deliberately invisible to ordinary participants — `0002_rls.sql`
 * §5.13 says showing a player the score and reason codes computed about their own result hands
 * a cheater the model's decision boundary — so this read goes through the operator's own
 * client and the `can_manage_match` policy decides what comes back.
 */

import Link from "next/link"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { AnomalyTable, decodeReasons, type AnomalyRow } from "@/components/admin/anomaly-table"
import { requireRole } from "@/lib/rbac"
import { createClient } from "@/lib/supabase/server"
import { cn } from "@/lib/utils"
import type { Enums, Json } from "@halisaha/shared/database"

export const dynamic = "force-dynamic"

const FLAG_SELECT =
  "id, match_id, source, anomaly_score, is_anomalous, reasons, model_version," +
  "leaf_depth, average_path_length, created_at," +
  "match:matches!inner(status,kickoff_at,requires_consensus)"

/** Hand-written because the select is a concatenated string; keep the two in step. */
interface FlagRow {
  id: string
  match_id: string
  source: string
  anomaly_score: number | null
  is_anomalous: boolean
  reasons: Json
  model_version: string | null
  leaf_depth: number | null
  average_path_length: number | null
  created_at: string
  match: {
    status: Enums<"match_status">
    kickoff_at: string
    requires_consensus: boolean
  } | null
}

const FILTERS = [
  { key: "flagged", label: "Yalnızca işaretliler" },
  { key: "all", label: "Bütün kararlar" },
] as const

type FilterKey = (typeof FILTERS)[number]["key"]

function parseFilter(raw: string | undefined): FilterKey {
  return raw === "all" ? "all" : "flagged"
}

interface PageProps {
  searchParams: { view?: string }
}

export default async function AdminAnomaliesPage({ searchParams }: PageProps) {
  await requireRole("admin")

  const view = parseFilter(searchParams.view)
  const supabase = await createClient()

  let query = supabase
    .from("match_anomaly_flags")
    .select(FLAG_SELECT)
    .order("anomaly_score", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(100)

  if (view === "flagged") query = query.eq("is_anomalous", true)

  const [flagsResponse, thresholdResponse] = await Promise.all([
    query,
    supabase.rpc("anomaly_score_threshold", {}),
  ])

  if (flagsResponse.error) {
    console.error("[admin/anomalies] query failed", { code: flagsResponse.error.code })
    return (
      <Alert variant="destructive">
        <AlertTitle>Anomali kararları yüklenemedi</AlertTitle>
        <AlertDescription>
          Veritabanı sorguyu reddetti. Sayfayı yenile; sürerse yönetici rolünün mevcut oturum jetonunda olduğunu kontrol et.
        </AlertDescription>
      </Alert>
    )
  }

  // A refused threshold is not worth failing the page over, but it must not be invented either:
  // fall back to the schema default and say so.
  const threshold =
    !thresholdResponse.error && typeof thresholdResponse.data === "number"
      ? thresholdResponse.data
      : null

  const flags = (flagsResponse.data ?? []) as unknown as FlagRow[]
  const rows: AnomalyRow[] = flags.map((flag) => ({
    flagId: flag.id,
    matchId: flag.match_id,
    source: flag.source,
    anomalyScore: flag.anomaly_score,
    isAnomalous: flag.is_anomalous,
    reasons: decodeReasons(flag.reasons),
    modelVersion: flag.model_version,
    leafDepth: flag.leaf_depth,
    averagePathLength: flag.average_path_length,
    createdAt: flag.created_at,
    matchStatus: flag.match?.status ?? null,
    kickoffAt: flag.match?.kickoff_at ?? null,
    requiresConsensus: flag.match?.requires_consensus ?? false,
  }))

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Bunlar nasıl okunur</CardTitle>
          <CardDescription>
            Isolation Forest, bir maçı örneklemin geri kalanından ayırmak için kaç bölme gerektiğine bakarak puanlar; kısa ortalama yol uzunluğu, noktanın kolay ayrıldığı anlamına gelir — anormal yapan da tam olarak budur.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            A score at or above{" "}
            <span className="font-semibold text-foreground tabular-nums">
              {threshold === null ? "the configured threshold" : threshold.toFixed(2)}
            </span>{" "}
            opens a peer-consensus round.{" "}
            {threshold === null
              ? "The exact value could not be read from the database just now."
              : "Below it the verdict is recorded and nothing else happens."}
          </p>
          <p>
            Model gözetimsizdir ve futboldan hiç anlamaz. Dengesiz bir hazırlık maçındaki 12-0 sıra dışıdır ama tamamen dürüsttür. Bir işareti bulgu değil, bildirimleri okumak için gerekçe say.
          </p>
        </CardContent>
      </Card>

      <nav aria-label="Kararları filtrele" className="flex flex-wrap gap-1">
        {FILTERS.map((filter) => {
          const active = filter.key === view
          return (
            <Link
              key={filter.key}
              href={`/admin/anomalies?view=${filter.key}`}
              aria-current={active ? "true" : undefined}
              className={cn(
                "rounded-md border px-3 py-1.5 text-sm transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                active
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              )}
            >
              {filter.label}
            </Link>
          )
        })}
      </nav>

      <AnomalyTable rows={rows} threshold={threshold ?? undefined} />

      {rows.length === 100 ? (
        <p className="text-xs text-muted-foreground">
          En anormal 100 karar gösteriliyor. Bir kısmını sonuçlandır ya da filtreyi değiştir.
        </p>
      ) : null}
    </div>
  )
}
