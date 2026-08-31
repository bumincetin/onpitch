/**
 * GET /api/gdpr/export
 *
 * GDPR Art. 15 (access) and Art. 20 (portability): hands the subject everything we hold about
 * them, as one JSON document, "in a structured, commonly used and machine-readable format".
 *
 * The whole document is assembled by `public.export_my_data()`, which runs SECURITY DEFINER and
 * scopes itself to `auth.uid()`. Nothing here chooses what to include — that decision, including
 * the deliberate omissions (live consent token digests, IP hashes), lives in the migration where
 * a reviewer can audit it against a retention policy rather than against a route handler.
 *
 * This is the one endpoint in the app that does NOT return the `ApiResponse` envelope on
 * success: Art. 20 asks for a portable document, and wrapping it in `{ ok: true, data: … }`
 * would make every consumer unwrap our envelope before they could read their own data. Errors
 * still use the envelope.
 */

import { NextResponse } from "next/server"

import { createRouteClient } from "@/lib/supabase/server"
import { consumeRateLimit } from "@/lib/rate-limit"
import { API_ERROR_CODES } from "@halisaha/shared/domain"
import type { ApiResponse } from "@halisaha/shared/domain"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

function errorResponse(body: ApiResponse<never>, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } })
}

export async function GET(request: Request): Promise<NextResponse> {
  // `createRouteClient` — not `createClient` — because the Expo app has no cookie jar and
  // authenticates with `Authorization: Bearer <access token>`. A cookie-only client would reject
  // every mobile caller with a 401 and make Art. 15 unreachable from the phone.
  const supabase = await createRouteClient(request)

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return errorResponse(
      {
        ok: false,
        error: {
          code: API_ERROR_CODES.UNAUTHENTICATED,
          message: "Verilerini indirmek için giriş yap.",
        },
      },
      401,
    )
  }

  /*
   * Building an export walks most of the schema for one person, so it gets a budget — three an
   * hour, which is more than anyone exercising Art. 15 in good faith needs and far fewer than a
   * loop can manage. This route answers with its own envelope shape, so it consults the limiter
   * directly rather than through `enforceRateLimit`.
   */
  const budget = await consumeRateLimit("gdpr_export")
  if (budget && !budget.allowed) {
    return errorResponse(
      {
        ok: false,
        error: {
          code: API_ERROR_CODES.RATE_LIMITED,
          message: "Kısa sürede çok fazla dışa aktarma istedin. Biraz sonra tekrar dene.",
        },
      },
      429,
    )
  }

  const { data, error } = await supabase.rpc("export_my_data", {})

  if (error) {
    // eslint-disable-next-line no-console
    console.error("[gdpr/export] export_my_data failed:", error.code, error.message)
    return errorResponse(
      {
        ok: false,
        error: {
          code: API_ERROR_CODES.INTERNAL,
          message: "Dışa aktarmanı şu an oluşturamadık. Lütfen tekrar dene.",
        },
      },
      500,
    )
  }

  // Pretty-printed on purpose. A data subject is a person, and Art. 12 asks for an intelligible
  // form; a 200 KB single-line JSON blob is machine-readable but not human-readable, and this
  // file exists to be read by both.
  const document = JSON.stringify(data ?? {}, null, 2)
  const filename = `halisaha-data-export-${new Date().toISOString().slice(0, 10)}.json`

  return new NextResponse(document, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      // This is the most personal payload the app can emit. It must never sit in a CDN, a
      // browser cache, or an intermediary.
      "Cache-Control": "no-store, no-cache, must-revalidate, private",
      Pragma: "no-cache",
      "X-Content-Type-Options": "nosniff",
    },
  })
}
