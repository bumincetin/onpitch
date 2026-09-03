/**
 * GET /api/admin/metrics
 *
 * Platform-wide numbers for the admin overview, so the window picker can change `?days=`
 * without re-rendering the whole RSC tree, and so an on-call dashboard can poll them.
 *
 * ---------------------------------------------------------------------------
 * AUTHORISATION
 * ---------------------------------------------------------------------------
 * `requireRole('admin')` runs here even though `middleware.ts` already refused non-admins on
 * `/admin/*` and `app/(dashboard)/admin/layout.tsx` gates the pages. Three reasons it is not
 * redundant:
 *
 *   * the middleware matcher covers `/admin`, not `/api/admin` — this path is reachable
 *     directly;
 *   * the middleware decides on a JWT claim that can be an hour stale, while `requireRole`
 *     re-reads the profile row;
 *   * a layout gates a render, not a fetch. Nothing stops a browser calling this URL.
 *
 * Underneath all of that, every read in `computePlatformMetrics` goes through the CALLER'S
 * cookie-bound client, so RLS re-derives the role in Postgres per row. Delete the check above
 * and a player still gets their own bookings back, not the platform's.
 */

import { fail, handleRoute, ok } from "@/lib/api-response"
import { requireRole } from "@/lib/rbac"
import { createClient } from "@/lib/supabase/server"
import {
  adminMetricsQuerySchema,
  computePlatformMetrics,
  type PlatformMetrics,
} from "@/lib/admin/metrics"
import { API_ERROR_CODES } from "@onpitch/shared/domain"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export interface AdminMetricsResponse {
  metrics: PlatformMetrics
  generatedAt: string
}

export async function GET(request: Request): Promise<Response> {
  return handleRoute<AdminMetricsResponse>(async () => {
    await requireRole("admin")

    const url = new URL(request.url)
    const parsed = adminMetricsQuerySchema.safeParse({
      days: url.searchParams.get("days") ?? undefined,
    })

    if (!parsed.success) {
      return fail(API_ERROR_CODES.VALIDATION_FAILED, "Raporlama aralığı geçersizdi.", 422, {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      })
    }

    const supabase = await createClient()

    try {
      const metrics = await computePlatformMetrics({ supabase, days: parsed.data.days })
      return ok<AdminMetricsResponse>({ metrics, generatedAt: new Date().toISOString() })
    } catch (error) {
      // A refused count and an empty platform look identical to a reader, so an aggregate that
      // failed is reported as a failure rather than folded into a zero.
      console.error("[admin/metrics] aggregate failed", {
        code: (error as { code?: unknown }).code,
      })
      return fail(API_ERROR_CODES.INTERNAL, "Platform metrikleri hesaplanamadı.", 500)
    }
  })
}
