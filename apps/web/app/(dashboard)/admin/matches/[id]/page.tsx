/**
 * app/(dashboard)/admin/matches/[id]/page.tsx
 *
 * One contested match, with everything the decision rests on: every score report side by side,
 * every consensus vote, every anomaly flag and its reasons, both rosters, and the audit trail
 * this match has accumulated so far.
 *
 * ---------------------------------------------------------------------------
 * ONE QUERY FOR THE EVIDENCE
 * ---------------------------------------------------------------------------
 * Reports, votes, flags and rosters arrive as embedded resources on a single request. Each of
 * those tables carries its own RLS policy and each admits an admin through a different route —
 * `can_view_match` for reports and votes, `can_manage_match` for anomaly flags — so the shape
 * of the page is decided in Postgres, per table, for this operator.
 *
 * ---------------------------------------------------------------------------
 * WHICH VOTES ACTUALLY COUNT
 * ---------------------------------------------------------------------------
 * `finalize_consensus` counts a vote only when it was cast against BOTH the current round
 * nonce and the current canonical payload digest, so a late score report retires votes that are
 * still sitting in the table. This page marks the ones whose nonce matches the round that is
 * open now. It does not recompute the digest — that is the RPC's job, and duplicating the
 * canonicalisation here would be a third implementation of bytes that must match exactly.
 *
 * ---------------------------------------------------------------------------
 * THE FORM
 * ---------------------------------------------------------------------------
 * A Server Action, not a fetch: a ruling is a form post that ends in a revalidation of the page
 * it was submitted from, and this way it works without JavaScript. It delegates to
 * `applyMatchRuling`, the same function `POST /api/admin/matches/[id]/resolve` calls, so the
 * ordering guarantees — consensus first, audit second, score third, ratings last — hold
 * whichever door the ruling comes through.
 */

import { revalidatePath } from "next/cache"
import { notFound, redirect } from "next/navigation"
import { z } from "zod"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Textarea } from "@/components/ui/textarea"
import { AnomalyTable, decodeReasons, type AnomalyRow } from "@/components/admin/anomaly-table"
import { AuditTrail } from "@/components/admin/audit-trail"
import { formatDateTime, formatFormat, StatusBadge } from "@/components/admin/dispute-queue"
import { applyMatchRuling, listAuditEntries, type AuditEntry } from "@/lib/admin/metrics"
import { requireRole } from "@/lib/rbac"
import { createClient } from "@/lib/supabase/server"
import { cn } from "@/lib/utils"
import type { Enums, Json } from "@onpitch/shared/database"

export const dynamic = "force-dynamic"

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_GOALS = 30

const MATCH_SELECT =
  "id, status, format, kickoff_at, duration_minutes, home_score, away_score," +
  "score_confirmed_at, requires_consensus, consensus_deadline, consensus_nonce," +
  "anomaly_score, is_ranked, rating_applied_at," +
  // `timezone` so kickoff, confirmation and deadline render on the venue's clock rather than
  // the Node process's; see `formatDateTime` in components/admin/dispute-queue.
  "venue:venues(name,city,timezone)," +
  "score_reports(id,reported_by,team_side,home_score,away_score,reported_at," +
  "reporter:profiles(display_name,full_name))," +
  "consensus_approvals(id,approver_id,decision,approved_at,nonce," +
  "approver:profiles(display_name,full_name))," +
  "match_anomaly_flags(id,source,anomaly_score,is_anomalous,reasons,model_version," +
  "leaf_depth,average_path_length,created_at)," +
  "match_participants(id,player_id,team_side,is_confirmed," +
  "player:profiles(display_name,full_name))"

interface NamedProfile {
  display_name: string | null
  full_name: string | null
}

/** Hand-written to match `MATCH_SELECT`; keep the two in step. */
interface MatchDetail {
  id: string
  status: Enums<"match_status">
  format: Enums<"match_format">
  kickoff_at: string
  duration_minutes: number
  home_score: number | null
  away_score: number | null
  score_confirmed_at: string | null
  requires_consensus: boolean
  consensus_deadline: string | null
  consensus_nonce: string | null
  anomaly_score: number | null
  is_ranked: boolean
  rating_applied_at: string | null
  venue: { name: string; city: string | null; timezone: string } | null
  score_reports: Array<{
    id: string
    reported_by: string
    team_side: string | null
    home_score: number
    away_score: number
    reported_at: string
    reporter: NamedProfile | null
  }>
  consensus_approvals: Array<{
    id: string
    approver_id: string
    decision: string
    approved_at: string
    nonce: string
    approver: NamedProfile | null
  }>
  match_anomaly_flags: Array<{
    id: string
    source: string
    anomaly_score: number | null
    is_anomalous: boolean
    reasons: Json
    model_version: string | null
    leaf_depth: number | null
    average_path_length: number | null
    created_at: string
  }>
  match_participants: Array<{
    id: string
    player_id: string
    team_side: string
    is_confirmed: boolean
    player: NamedProfile | null
  }>
}

/* -------------------------------------------------------------------------- */
/*  The ruling                                                                 */
/* -------------------------------------------------------------------------- */

/** Empty inputs arrive as `""`; zod should see "absent", not "not a number". */
function optionalField(value: FormDataEntryValue | null): string | undefined {
  const text = typeof value === "string" ? value.trim() : ""
  return text.length > 0 ? text : undefined
}

const rulingFormSchema = z
  .object({
    outcome: z.enum(["finalize", "void"]),
    homeScore: z.coerce.number().int().min(0).max(MAX_GOALS).optional(),
    awayScore: z.coerce.number().int().min(0).max(MAX_GOALS).optional(),
    reason: z.string().trim().min(10).max(1000),
    acknowledgeOverwrite: z.boolean(),
  })
  .superRefine((value, context) => {
    if (value.outcome !== "finalize") return
    if (value.homeScore === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["homeScore"], message: "Zorunlu." })
    }
    if (value.awayScore === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["awayScore"], message: "Zorunlu." })
    }
  })

/**
 * Apply a ruling and come back to this page with the outcome in the query string.
 *
 * `requireRole('admin')` runs inside the action because a Server Action is a POST endpoint like
 * any other: the layout's gate protects the render that produced this form, not the submission.
 */
async function ruleOnMatch(formData: FormData): Promise<void> {
  "use server"

  const { user } = await requireRole("admin")

  const matchId = String(formData.get("matchId") ?? "")
  if (!UUID_PATTERN.test(matchId)) {
    redirect("/admin/disputes?error=bad_reference")
  }

  const parsed = rulingFormSchema.safeParse({
    outcome: formData.get("outcome"),
    homeScore: optionalField(formData.get("homeScore")),
    awayScore: optionalField(formData.get("awayScore")),
    reason: formData.get("reason") ?? "",
    acknowledgeOverwrite: formData.get("acknowledgeOverwrite") === "on",
  })

  if (!parsed.success) {
    redirect(`/admin/matches/${matchId}?error=invalid`)
  }

  const supabase = await createClient()
  const result = await applyMatchRuling({
    supabase,
    actorId: user.id,
    matchId,
    outcome: parsed.data.outcome,
    homeScore: parsed.data.homeScore,
    awayScore: parsed.data.awayScore,
    reason: parsed.data.reason,
    acknowledgeOverwrite: parsed.data.acknowledgeOverwrite,
  })

  if (result.status === "applied") {
    revalidatePath(`/admin/matches/${matchId}`)
    revalidatePath("/admin/disputes")
    redirect(`/admin/matches/${matchId}?done=1`)
  }

  if (result.status === "not_found") {
    redirect("/admin/disputes?error=not_found")
  }

  if (result.status === "needs_acknowledgement") {
    redirect(`/admin/matches/${matchId}?error=confirm_required`)
  }

  redirect(`/admin/matches/${matchId}?error=${result.stage}`)
}

const ERROR_COPY: Record<string, { title: string; body: string }> = {
  invalid: {
    title: "Bu karar kabul edilmedi",
    body:
      "Kesinleşmiş sonuç için iki skor da gerekir ve her karar en az on " +
      "characters. Hiçbir şey değişmedi.",
  },
  confirm_required: {
    title: "Bu maç zaten kesinleşmiş",
    body:
      "Onaylanmış sonucu değiştirmek için üzerine yazma kutusunu işaretle. Oyuncular sonucu onaylamış " +
      "while you were reading — check the scoreline below before you do.",
  },
  read: {
    title: "Maç okunamadı",
    body: "Hiçbir şey değişmedi. Reload and try again.",
  },
  audit: {
    title: "Karar reddedildi",
    body:
      "Denetim kaydı yazılamadı, bu yüzden hiçbir şey değişmedi. İz bırakmayan bir " +
      "trace is not allowed. Tell an engineer.",
  },
  update: {
    title: "Karar işlenemedi",
    body: "Veritabanı yazmayı reddetti. Deneme denetim kaydında duruyor.",
  },
}

/* -------------------------------------------------------------------------- */
/*  The page                                                                   */
/* -------------------------------------------------------------------------- */

interface PageProps {
  params: { id: string }
  searchParams: { error?: string; done?: string }
}

export default async function AdminMatchReviewPage({ params, searchParams }: PageProps) {
  await requireRole("admin")

  if (!UUID_PATTERN.test(params.id)) notFound()

  const supabase = await createClient()

  const [matchResponse, auditEntries] = await Promise.all([
    supabase.from("matches").select(MATCH_SELECT).eq("id", params.id).maybeSingle(),
    safeAudit(params.id),
  ])

  if (matchResponse.error) {
    console.error("[admin/match] query failed", { code: matchResponse.error.code })
    return (
      <Alert variant="destructive">
        <AlertTitle>Bu maç yüklenemedi</AlertTitle>
        <AlertDescription>
          Veritabanı sorguyu reddetti. Sayfayı yenile; sürerse yönetici rolünün mevcut oturum jetonunda olduğunu kontrol et.
        </AlertDescription>
      </Alert>
    )
  }

  if (!matchResponse.data) notFound()

  const match = matchResponse.data as unknown as MatchDetail
  const failure = searchParams.error ? ERROR_COPY[searchParams.error] : undefined
  const alreadyConfirmed = match.score_confirmed_at !== null || match.status === "finalized"

  const home = match.match_participants.filter((row) => row.team_side === "home")
  const away = match.match_participants.filter((row) => row.team_side === "away")

  // Null when the venue embed came back empty; `formatDateTime` then falls back to the
  // explicit console default rather than to the Node process's zone.
  const venueTimeZone = match.venue?.timezone ?? null

  const anomalyRows: AnomalyRow[] = match.match_anomaly_flags
    .map((flag) => ({
      flagId: flag.id,
      matchId: match.id,
      source: flag.source,
      anomalyScore: flag.anomaly_score,
      isAnomalous: flag.is_anomalous,
      reasons: decodeReasons(flag.reasons),
      modelVersion: flag.model_version,
      leafDepth: flag.leaf_depth,
      averagePathLength: flag.average_path_length,
      createdAt: flag.created_at,
      matchStatus: match.status,
      kickoffAt: match.kickoff_at,
      venueTimeZone,
      requiresConsensus: match.requires_consensus,
    }))
    .sort((a, b) => (b.anomalyScore ?? -1) - (a.anomalyScore ?? -1))

  const scorelines = new Map<string, number>()
  for (const report of match.score_reports) {
    const key = `${report.home_score}-${report.away_score}`
    scorelines.set(key, (scorelines.get(key) ?? 0) + 1)
  }
  const mostReported = [...scorelines.entries()].sort((a, b) => b[1] - a[1])[0]

  return (
    <div className="space-y-6">
      {failure ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>{failure.title}</AlertTitle>
          <AlertDescription>{failure.body}</AlertDescription>
        </Alert>
      ) : null}

      {searchParams.done ? (
        <Alert>
          <AlertTitle>Karar uygulandı</AlertTitle>
          <AlertDescription>
            Aşağıdaki sonuç resmî olandır ve bu sayfanın altındaki denetim izi senin gerekçeni taşır.
          </AlertDescription>
        </Alert>
      ) : null}

      {/* ---------- header ---------- */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="text-lg">
                {match.venue?.name ?? "Venue withheld"}
                {match.venue?.city ? (
                  <span className="text-muted-foreground"> · {match.venue.city}</span>
                ) : null}
              </CardTitle>
              <CardDescription>
                {formatDateTime(match.kickoff_at, venueTimeZone)} · {formatFormat(match.format)} ·{" "}
                {match.duration_minutes} minutes · {match.is_ranked ? "ranked" : "unranked"}
              </CardDescription>
            </div>
            <div className="flex flex-wrap gap-1">
              <StatusBadge status={match.status} />
              {match.requires_consensus ? <Badge variant="warning">tur açık</Badge> : null}
              {match.rating_applied_at ? <Badge variant="secondary">reyting işlendi</Badge> : null}
            </div>
          </div>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          <Fact
            label="Kayıtlı skor"
            value={
              match.home_score !== null && match.away_score !== null
                ? `${match.home_score} – ${match.away_score}`
                : "none"
            }
            hint={
              match.score_confirmed_at
                ? `Confirmed ${formatDateTime(match.score_confirmed_at, venueTimeZone)}`
                : "Not confirmed"
            }
          />
          <Fact
            label="En çok bildirilen"
            value={mostReported ? mostReported[0].replace("-", " – ") : "no reports"}
            hint={
              mostReported
                ? `${mostReported[1]} of ${match.score_reports.length} reports`
                : "Nobody filed a score"
            }
          />
          <Fact
            label="Anomali skoru"
            value={match.anomaly_score === null ? "not checked" : match.anomaly_score.toFixed(3)}
            hint={
              match.consensus_deadline
                ? `Deadline ${formatDateTime(match.consensus_deadline, venueTimeZone)}`
                : "No consensus deadline"
            }
          />
        </CardContent>
      </Card>

      {/* ---------- reports ---------- */}
      <section aria-labelledby="reports-heading" className="space-y-3">
        <h2 id="reports-heading" className="text-sm font-semibold text-muted-foreground">
          Skor bildirimleri
        </h2>
        {match.score_reports.length === 0 ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Kimse skor bildirmedi</CardTitle>
              <CardDescription>
                Onaylanacak bildirilmiş bir skor yok. Burada belirlediğin her sonuç senin kendi bulgundur; gerekçede neye dayandığını yaz.
              </CardDescription>
            </CardHeader>
          </Card>
        ) : (
          <div className="rounded-lg border border-border">
            <Table>
              <caption className="sr-only">
                Bu maç için gönderilmiş bütün skor bildirimleri. Bildirimler yalnızca eklenir; düzeltilemez ya da geri çekilemez.
              </caption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Bildiren</TableHead>
                  <TableHead scope="col">Taraf</TableHead>
                  <TableHead scope="col" className="text-right">
                    Skor
                  </TableHead>
                  <TableHead scope="col">Bildirildi</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...match.score_reports]
                  .sort((a, b) => a.reported_at.localeCompare(b.reported_at))
                  .map((report) => {
                    const key = `${report.home_score}-${report.away_score}`
                    const isMajority = mostReported !== undefined && key === mostReported[0]
                    return (
                      <TableRow key={report.id}>
                        <TableCell>
                          <div className="font-medium">{displayName(report.reporter)}</div>
                          <div className="font-mono text-xs text-muted-foreground">
                            {report.reported_by.slice(0, 8)}
                          </div>
                        </TableCell>
                        <TableCell>
                          {report.team_side ? (
                            <Badge variant="outline">{report.team_side}</Badge>
                          ) : (
                            <span className="text-xs text-muted-foreground">nötr</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <span
                            className={cn(
                              "text-base tabular-nums",
                              isMajority ? "font-semibold" : "text-muted-foreground",
                            )}
                          >
                            {report.home_score} – {report.away_score}
                          </span>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          <time dateTime={report.reported_at}>
                            {formatDateTime(report.reported_at)}
                          </time>
                        </TableCell>
                      </TableRow>
                    )
                  })}
              </TableBody>
            </Table>
          </div>
        )}
      </section>

      {/* ---------- votes ---------- */}
      <section aria-labelledby="votes-heading" className="space-y-3">
        <h2 id="votes-heading" className="text-sm font-semibold text-muted-foreground">
          Uzlaşma oyları
        </h2>
        {match.consensus_approvals.length === 0 ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Oy kullanılmadı</CardTitle>
              <CardDescription>
                Ya tur açılmadı ya da açık turda kimse oy vermedi.
              </CardDescription>
            </CardHeader>
          </Card>
        ) : (
          <>
            <div className="rounded-lg border border-border">
              <Table>
                <caption className="sr-only">
                  İmzalı onaylar ve retler; her birinin şu an açık olan tura ait olup olmadığıyla birlikte
                </caption>
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">Oy veren</TableHead>
                    <TableHead scope="col">Taraf</TableHead>
                    <TableHead scope="col">Karar</TableHead>
                    <TableHead scope="col">Tur</TableHead>
                    <TableHead scope="col">Oy</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {[...match.consensus_approvals]
                    .sort((a, b) => a.approved_at.localeCompare(b.approved_at))
                    .map((vote) => {
                      const side = match.match_participants.find(
                        (participant) => participant.player_id === vote.approver_id,
                      )?.team_side
                      const currentRound =
                        match.consensus_nonce !== null && vote.nonce === match.consensus_nonce
                      return (
                        <TableRow key={vote.id}>
                          <TableCell>
                            <div className="font-medium">{displayName(vote.approver)}</div>
                            <div className="font-mono text-xs text-muted-foreground">
                              {vote.approver_id.slice(0, 8)}
                            </div>
                          </TableCell>
                          <TableCell>
                            {side ? (
                              <Badge variant="outline">{side}</Badge>
                            ) : (
                              <span className="text-xs text-muted-foreground">kadroda değil</span>
                            )}
                          </TableCell>
                          <TableCell>
                            <Badge variant={vote.decision === "approve" ? "success" : "destructive"}>
                              {vote.decision}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-xs">
                            {currentRound ? (
                              <span className="text-foreground">güncel</span>
                            ) : (
                              <span className="text-muted-foreground">geçersiz</span>
                            )}
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            <time dateTime={vote.approved_at}>
                              {formatDateTime(vote.approved_at)}
                            </time>
                          </TableCell>
                        </TableRow>
                      )
                    })}
                </TableBody>
              </Table>
            </div>
            <p className="text-xs text-muted-foreground">
              Bir oy, yeter sayıya ancak hem mevcut tur nonce&apos;una hem de mevcut kanonik veriye karşı imzalandıysa sayılır. Bu sayfa nonce&apos;u kontrol eder; veri özeti tur kapanırken veritabanının içinde yeniden kontrol edilir, bu yüzden güncel görünen bir oy geç gelen bir bildirimle geçersiz kalabilir.
            </p>
          </>
        )}
      </section>

      {/* ---------- anomaly ---------- */}
      <section aria-labelledby="anomaly-heading" className="space-y-3">
        <h2 id="anomaly-heading" className="text-sm font-semibold text-muted-foreground">
          Anomali işaretleri
        </h2>
        <AnomalyTable rows={anomalyRows} />
      </section>

      {/* ---------- rosters ---------- */}
      <section aria-labelledby="roster-heading" className="space-y-3">
        <h2 id="roster-heading" className="text-sm font-semibold text-muted-foreground">
          Kadrolar
        </h2>
        <div className="grid gap-4 md:grid-cols-2">
          <Roster title="Ev sahibi" rows={home} />
          <Roster title="Deplasman" rows={away} />
        </div>
        <p className="text-xs text-muted-foreground">
          Yeter sayı, ONAYLI kadronun üçte ikisidir; yukarı yuvarlanır, ikiden az olamaz ve her iki taraftan en az bir onay gerekir. Kimse sahaya gelmediyse tüm kadro seçmen sayılır.
        </p>
      </section>

      <Separator />

      {/* ---------- the ruling ---------- */}
      <section aria-labelledby="ruling-heading" className="space-y-3">
        <h2 id="ruling-heading" className="text-sm font-semibold text-muted-foreground">
          Kararın
        </h2>

        {alreadyConfirmed ? (
          <Alert variant="destructive">
            <AlertTitle>Bu maçın onaylanmış bir sonucu zaten var</AlertTitle>
            <AlertDescription>
              {match.home_score} – {match.away_score}, confirmed{" "}
              {match.score_confirmed_at
                ? formatDateTime(match.score_confirmed_at, venueTimeZone)
                : "earlier"}
              .
              {match.rating_applied_at
                ? " Ratings have been applied and will not be recomputed: a new scoreline changes the record, not anybody's mu or sigma."
                : " No ratings have been applied yet."}
            </AlertDescription>
          </Alert>
        ) : null}

        <Card>
          <CardContent className="pt-6">
            <form action={ruleOnMatch} className="space-y-4">
              <input type="hidden" name="matchId" value={match.id} />

              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">Resmî skor</legend>
                <div className="flex flex-wrap items-end gap-3">
                  <div className="space-y-1">
                    <Label htmlFor="homeScore">Ev sahibi</Label>
                    <Input
                      id="homeScore"
                      name="homeScore"
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={MAX_GOALS}
                      defaultValue={match.home_score ?? ""}
                      className="w-24"
                    />
                  </div>
                  <span aria-hidden="true" className="pb-2 text-muted-foreground">
                    –
                  </span>
                  <div className="space-y-1">
                    <Label htmlFor="awayScore">Deplasman</Label>
                    <Input
                      id="awayScore"
                      name="awayScore"
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={MAX_GOALS}
                      defaultValue={match.away_score ?? ""}
                      className="w-24"
                    />
                  </div>
                </div>
              </fieldset>

              <div className="space-y-1">
                <Label htmlFor="reason">Gerekçe</Label>
                <Textarea
                  id="reason"
                  name="reason"
                  rows={3}
                  required
                  minLength={10}
                  maxLength={1000}
                  placeholder="Bu kararın dayanağı. Denetim kaydında kalıcı olarak saklanır."
                  aria-describedby="reason-help"
                />
                <p id="reason-help" className="text-xs text-muted-foreground">
                  En az on karakter ve herhangi bir şey değişmeden önce hesabına yazılarak denetim kaydına işlenir.
                </p>
              </div>

              {alreadyConfirmed ? (
                <div className="flex items-start gap-2 rounded-md border border-destructive/40 p-3">
                  <input
                    id="acknowledgeOverwrite"
                    name="acknowledgeOverwrite"
                    type="checkbox"
                    className="mt-1 h-4 w-4 rounded border-input"
                  />
                  <Label htmlFor="acknowledgeOverwrite" className="text-sm font-normal">
                    Onaylanmış bir sonucu değiştiriyorum ve bunun geçersiz kılma olarak kaydedildiğini biliyorum.
                  </Label>
                </div>
              ) : null}

              <div className="flex flex-wrap gap-3">
                <Button type="submit" name="outcome" value="finalize">
                  Resmî skoru belirle
                </Button>
                <Button type="submit" name="outcome" value="void" variant="outline">
                  Maçı iptal et
                </Button>
              </div>

              <p className="text-xs text-muted-foreground">
                Skor belirlemek önce açık uzlaşma turunu kapatır; bu yüzden sen bunu okurken oluşan bir yeter sayı geçerli olur. İptal etmek maçı kaldırır ve daha önce işlenmiş reytingleri yerinde bırakır.
              </p>
            </form>
          </CardContent>
        </Card>
      </section>

      <AuditTrail
        entries={auditEntries}
        title="Bu maça ne oldu"
        emptyMessage="Nothing has been recorded against this match yet."
      />
    </div>
  )
}

function Fact({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold tabular-nums">{value}</p>
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  )
}

function Roster({
  title,
  rows,
}: {
  title: string
  rows: MatchDetail["match_participants"]
}) {
  const confirmed = rows.filter((row) => row.is_confirmed).length

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>
          {rows.length} on the sheet, {confirmed} checked in
        </CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">Bu tarafta kimse yok.</p>
        ) : (
          <ul className="space-y-1">
            {rows.map((row) => (
              <li key={row.id} className="flex items-center justify-between gap-2 text-sm">
                <span>{displayName(row.player)}</span>
                {row.is_confirmed ? (
                  <Badge variant="success">onaylı</Badge>
                ) : (
                  <Badge variant="outline">onaysız</Badge>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

function displayName(profile: NamedProfile | null): string {
  return profile?.display_name ?? profile?.full_name ?? "Unnamed account"
}

/** A failed audit read degrades one panel; it must not take the review page down. */
async function safeAudit(matchId: string): Promise<AuditEntry[]> {
  try {
    return await listAuditEntries({ entityId: matchId, limit: 20 })
  } catch (error) {
    console.error("[admin/match] audit read failed", { code: (error as { code?: unknown }).code })
    return []
  }
}
