/**
 * POST /api/auth/parental-consent/request
 *
 * GDPR Art. 8: mints a one-time guardian consent token and emails the link.
 *
 * THE ONE INVARIANT OF THIS ROUTE: the raw token never travels anywhere except into the email
 * body. It is returned by `public.request_parental_consent()` exactly once, held in a local
 * variable inside `issueGuardianConsent`, handed to the mail transport, and dropped. It is never
 * in the response, never in a log line, never in an error message, and Postgres only ever stored
 * `digest(token,'sha256')`. A database dump yields no usable consent links, and neither does an
 * application log.
 *
 * Called with the MINOR's own session — the RPC issues a token for `auth.uid()`, so this
 * endpoint cannot be used to send a consent email about somebody else's account. That is why the
 * route uses the cookie-bound client and not the admin client.
 */

import { NextResponse } from "next/server"

import { createRouteClient } from "@/lib/supabase/server"
import { issueGuardianConsent } from "@/lib/gdpr"
import { API_ERROR_CODES, parentalConsentRequestSchema } from "@halisaha/shared/domain"
import type { ApiResponse } from "@halisaha/shared/domain"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

interface ConsentRequestData {
  requestId: string | null
  /** Masked so a stolen session cannot read the guardian's full address back out. */
  guardianEmailMasked: string
  expiresAt: string
  /** False when the mail provider failed. The request row is still valid for its full 7 days. */
  delivered: boolean
}

function json<T>(body: ApiResponse<T>, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } })
}

export async function POST(request: Request): Promise<NextResponse> {
  // `createRouteClient` — not `createClient` — because the Expo app has no cookie jar and
  // authenticates with `Authorization: Bearer <access token>`. Still the caller's own,
  // RLS-scoped client either way: the RPC below issues a token for `auth.uid()` and nothing
  // here is privileged.
  const supabase = await createRouteClient(request)

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return json(
      {
        ok: false,
        error: {
          code: API_ERROR_CODES.UNAUTHENTICATED,
          message: "Önce giriş yap — onay isteği her zaman kendi hesabın için oluşturulur.",
        },
      },
      401,
    )
  }

  let rawBody: unknown
  try {
    rawBody = await request.json()
  } catch {
    return json(
      {
        ok: false,
        error: { code: API_ERROR_CODES.VALIDATION_FAILED, message: "JSON gövdesi bekleniyordu." },
      },
      400,
    )
  }

  // Parsed, never cast — docs/SECURITY.md §2.
  const parsed = parentalConsentRequestSchema.safeParse(rawBody)
  if (!parsed.success) {
    return json(
      {
        ok: false,
        error: {
          code: API_ERROR_CODES.VALIDATION_FAILED,
          message: "Velinin adına ve geçerli bir e-posta adresine ihtiyacımız var.",
          details: parsed.error.flatten().fieldErrors,
        },
      },
      422,
    )
  }

  // No `deleted_at` predicate: 0002_rls.sql grants `authenticated` SELECT on ten columns only,
  // and a column privilege is checked for WHERE-clause references too, so naming `deleted_at`
  // here would make the whole statement a 42501 and leave the guardian email unaddressed. It is
  // redundant anyway — `request_parental_consent()` below is keyed on auth.uid() and refuses an
  // erased account.
  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("full_name, display_name")
    .eq("id", user.id)
    .maybeSingle()

  if (profileError) {
    // Not fatal: the consent email still goes out, it just cannot name the child.
    // eslint-disable-next-line no-console
    console.warn(
      "[parental-consent/request] minor name lookup failed:",
      profileError.code,
      profileError.message,
    )
  }

  const result = await issueGuardianConsent(supabase, {
    guardianEmail: parsed.data.guardianEmail,
    guardianName: parsed.data.guardianName,
    minorName: profile?.full_name ?? profile?.display_name ?? null,
    origin: new URL(request.url).origin,
  })

  if (!result.ok) {
    switch (result.reason) {
      case "unauthenticated":
        return json(
          { ok: false, error: { code: API_ERROR_CODES.UNAUTHENTICATED, message: result.message } },
          401,
        )
      case "not_a_minor":
        return json(
          {
            ok: false,
            error: {
              code: API_ERROR_CODES.FORBIDDEN,
              message:
                "Bu hesap için veli onayı gerekmiyor — 16 yaş altı olarak kayıtlı değil.",
            },
          },
          403,
        )
      case "invalid_email":
        return json(
          {
            ok: false,
            error: {
              code: API_ERROR_CODES.VALIDATION_FAILED,
              message: "Bu veli e-posta adresi doğru görünmüyor.",
            },
          },
          422,
        )
      case "rate_limited":
        return json(
          {
            ok: false,
            error: {
              code: API_ERROR_CODES.RATE_LIMITED,
              message:
                "Bu hesap için zaten üç onay e-postası bekliyor. Velinden en son gelenini " +
                "kullanmasını iste — bağlantılar yedi gün geçerli.",
            },
          },
          429,
        )
      default:
        // eslint-disable-next-line no-console
        console.error("[parental-consent/request]", result.reason, result.message)
        return json(
          {
            ok: false,
            error: {
              code: API_ERROR_CODES.INTERNAL,
              message: "Onay isteğini oluşturamadık. Lütfen tekrar dene.",
            },
          },
          500,
        )
    }
  }

  const data: ConsentRequestData = {
    requestId: result.requestId,
    guardianEmailMasked: result.guardianEmailMasked,
    expiresAt: result.expiresAt,
    delivered: result.delivery.delivered,
  }

  // 200 even when delivery failed: Postgres has committed the request and the link is live for
  // seven days. Reporting 500 here would tell the user to retry, which would burn one of their
  // three allowed open requests for nothing.
  return json({ ok: true, data }, 200)
}
