/**
 * app/(dashboard)/admin/page.tsx
 *
 * The platform overview: money, supply, and how much of the result pipeline is stuck.
 *
 * Every aggregate runs on the operator's own cookie-bound client, so RLS decides what the
 * numbers cover. The one exception is the audit strip at the bottom: `audit_log` has zero
 * grants for `authenticated` by design (`0002_rls.sql` §4.8 — the accountability trail must not
 * be readable by the subjects it records, admins included), so it is read with the service-role
 * client after `requireRole('admin')` has already passed. That check is the only thing standing
 * between this panel and the trail; there is no RLS underneath it.
 */

import Link from "next/link"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { AuditTrail } from "@/components/admin/audit-trail"
import { PlatformMetricsPanel } from "@/components/admin/platform-metrics"
import { requireRole } from "@/lib/rbac"
import { createClient } from "@/lib/supabase/server"
import {
  adminMetricsQuerySchema,
  computePlatformMetrics,
  listAuditEntries,
  type AuditEntry,
  type PlatformMetrics,
} from "@/lib/admin/metrics"

export const dynamic = "force-dynamic"

interface PageProps {
  searchParams: { days?: string }
}

export default async function AdminOverviewPage({ searchParams }: PageProps) {
  await requireRole("admin")

  const parsedQuery = adminMetricsQuerySchema.safeParse({ days: searchParams.days })
  const days = parsedQuery.success ? parsedQuery.data.days : undefined

  const supabase = await createClient()

  let metrics: PlatformMetrics | null = null
  let metricsFailed = false
  try {
    metrics = await computePlatformMetrics({ supabase, days })
  } catch (error) {
    console.error("[admin/overview] metrics failed", { code: (error as { code?: unknown }).code })
    metricsFailed = true
  }

  // A failed audit read must not take the whole page down: the numbers above it are still
  // useful, and an empty strip with an explanation beats a 500.
  let auditEntries: AuditEntry[] = []
  let auditFailed = false
  try {
    auditEntries = await listAuditEntries({ limit: 8, actionPrefix: "admin." })
  } catch (error) {
    console.error("[admin/overview] audit read failed", { code: (error as { code?: unknown }).code })
    auditFailed = true
  }

  return (
    <div className="space-y-8">
      {!parsedQuery.success ? (
        <Alert>
          <AlertTitle>Bu aralık raporlanmıyor</AlertTitle>
          <AlertDescription>
            Aralık 1 ile 365 gün arasında olmalı. Varsayılan gösteriliyor.
          </AlertDescription>
        </Alert>
      ) : null}

      {metricsFailed || !metrics ? (
        <Alert variant="destructive">
          <AlertTitle>Platform metrikleri hesaplanamadı</AlertTitle>
          <AlertDescription>
            Toplamlardan biri veritabanı tarafından reddedildi. Sayfayı yenile; sürerse yönetici rolünün mevcut oturum jetonunda olup olmadığını kontrol et — RLS, profil satırını okumadan önce JWT talebini okur.
          </AlertDescription>
        </Alert>
      ) : (
        <>
          <PlatformMetricsPanel metrics={metrics} basePath="/admin" />

          {metrics.openDisputes + metrics.openConsensusRounds > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  {metrics.openDisputes} disputed, {metrics.openConsensusRounds} rounds open
                </CardTitle>
                <CardDescription>
                  İtirazlı maçlar seni bekliyor. Açık turlar oyuncularını bekliyor ve yeter sayıda ya da süre dolunca kendiliğinden kapanıyor.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-3">
                <Link
                  href="/admin/disputes"
                  className="inline-flex h-9 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  Kuyruğu aç
                </Link>
                <Link
                  href="/admin/anomalies"
                  className="inline-flex h-9 items-center rounded-md border border-input bg-background px-3 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  Anomali kararları
                </Link>
              </CardContent>
            </Card>
          ) : null}
        </>
      )}

      {auditFailed ? (
        <Alert>
          <AlertTitle>Denetim şeridi açılamıyor</AlertTitle>
          <AlertDescription>
            Denetim izi okunamadı. Yazılmaya devam ediyor — etkilenen tek şey bu panel.
          </AlertDescription>
        </Alert>
      ) : (
        <AuditTrail
          entries={auditEntries}
          title="Son yönetici işlemleri"
          emptyMessage="Henüz hiçbir yönetici karar vermedi veya rol değiştirmedi."
        />
      )}
    </div>
  )
}
