/**
 * POST /api/auth/parental-consent/verify
 *
 * GDPR Art. 8: redeems a guardian's one-time consent token.
 *
 * The caller here is a PARENT, not a user of the platform — they have no account, no session and
 * no reason to get one. The token in their email IS the credential. That is why this route is
 * the one place outside the Stripe webhook that reaches for the service-role client:
 * `public.verify_parental_consent()` is granted to `service_role` only, precisely because there
 * is no `auth.uid()` to authorise it with.
 *
 * The SQL function does the security-relevant work: it hashes the token, probes the unique index
 * on `token_hash`, compares in constant time, and answers a plain `false` for an unknown,
 * expired, already-used or erased-account token. One uniform failure, no oracle. This route must
 * not add distinctions the database deliberately refused to make.
 *
 * Two response shapes, one behaviour:
 *   * `application/json`  -> the documented `ApiResponse` envelope (docs/API.md).
 *   * a form post         -> a 303 back to `/parental-consent?state=…`, so the guardian page
 *                            works with JavaScript disabled.
 */

import { NextResponse, type NextRequest } from "next/server"

import { createAdminClient } from "@/lib/supabase/admin"
import { API_ERROR_CODES, parentalConsentVerifySchema } from "@halisaha/shared/domain"
import type { ApiResponse } from "@halisaha/shared/domain"
import type { Database } from "@halisaha/shared/database"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type VerifyArgs = Database["public"]["Functions"]["verify_parental_consent"]["Args"]

interface VerifyData {
  granted: boolean
}

/* -------------------------------------------------------------------------- */
/*  Rate limiting                                                             */
/* -------------------------------------------------------------------------- */

/**
 * A 32-byte token is not brute-forceable, so this is not the defence — it is a cheap cap on
 * someone hammering the endpoint to generate database load.
 *
 * CAVEAT, stated rather than hidden: the counter lives in the memory of one serverless instance.
 * It resets on a cold start and is not shared across instances, so it slows an attacker down
 * without stopping them. If this endpoint ever needs a real limit, it belongs at the edge
 * (Vercel WAF / Cloudflare) or in Postgres, not here.
 */
const WINDOW_MS = 10 * 60 * 1000
const MAX_ATTEMPTS_PER_WINDOW = 20
const attempts = new Map<string, { count: number; resetAt: number }>()

function rateLimited(key: string): boolean {
  const now = Date.now()
  const entry = attempts.get(key)

  if (!entry || entry.resetAt <= now) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS })
    // Opportunistic sweep so a long-lived instance does not accumulate dead keys.
    if (attempts.size > 5_000) {
      for (const [candidate, value] of attempts) {
        if (value.resetAt <= now) attempts.delete(candidate)
      }
    }
    return false
  }

  entry.count += 1
  return entry.count > MAX_ATTEMPTS_PER_WINDOW
}

/**
 * Best-effort client IP. Passed RAW to Postgres, which stores only
 * `sha256(ip || ':' || minor_id)` — evidence that a verification happened, from an identifier we
 * do not retain. Never logged, never returned.
 */
function clientIp(request: NextRequest): string | null {
  const forwarded = request.headers.get("x-forwarded-for")
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim()
    if (first) return first
  }
  return request.headers.get("x-real-ip")?.trim() || null
}

/* -------------------------------------------------------------------------- */

function json<T>(body: ApiResponse<T>, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } })
}

/** The no-JavaScript path: back to the guardian page with a state, never with the token. */
function redirectToPage(request: NextRequest, state: "granted" | "invalid" | "error"): NextResponse {
  // Behind a load balancer `nextUrl.origin` is the internal host, so prefer the configured
  // public origin and fall back to the forwarded one before trusting the request URL.
  const forwardedHost = request.headers.get("x-forwarded-host")
  const base =
    process.env.NEXT_PUBLIC_SITE_URL ??
    (process.env.NODE_ENV === "production" && forwardedHost
      ? `${request.headers.get("x-forwarded-proto") ?? "https"}://${forwardedHost}`
      : request.nextUrl.origin)

  const target = new URL(`/parental-consent?state=${state}`, base)
  const response = NextResponse.redirect(target, { status: 303 })
  response.headers.set("Cache-Control", "no-store")
  // The URL the guardian arrived from still carries the token in its query string; do not leak
  // it to anything the destination page loads.
  response.headers.set("Referrer-Policy", "no-referrer")
  return response
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const contentType = request.headers.get("content-type") ?? ""
  const isFormPost =
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")

  /* ---- read the token ---------------------------------------------------- */
  let candidateToken: unknown
  try {
    if (isFormPost) {
      const form = await request.formData()
      candidateToken = form.get("token")
    } else {
      const body = (await request.json()) as unknown
      candidateToken = (body as { token?: unknown } | null)?.token
    }
  } catch {
    return isFormPost
      ? redirectToPage(request, "invalid")
      : json(
          {
            ok: false,
            error: { code: API_ERROR_CODES.VALIDATION_FAILED, message: "JSON gövdesi bekleniyordu." },
          },
          400,
        )
  }

  const parsed = parentalConsentVerifySchema.safeParse({ token: candidateToken })
  if (!parsed.success) {
    // A malformed token is answered exactly like a wrong one — no shape oracle.
    return isFormPost
      ? redirectToPage(request, "invalid")
      : json(
          {
            ok: false,
            error: {
              code: API_ERROR_CODES.CONSENT_TOKEN_INVALID,
              message: "Bu onay bağlantısı geçerli değil.",
            },
          },
          400,
        )
  }

  /* ---- rate limit -------------------------------------------------------- */
  const ip = clientIp(request)
  if (rateLimited(ip ?? "unknown")) {
    return isFormPost
      ? redirectToPage(request, "error")
      : json(
          {
            ok: false,
            error: {
              code: API_ERROR_CODES.RATE_LIMITED,
              message: "Çok fazla deneme. Lütfen birkaç dakika bekleyip bağlantıyı tekrar aç.",
            },
          },
          429,
        )
  }

  /* ---- redeem ------------------------------------------------------------ */
  const admin = createAdminClient()

  // Argument NAMES are how PostgREST resolves an RPC, so these must match
  // `public.verify_parental_consent(p_raw_token text, p_guardian_ip text)` in
  // 0003_auth_rbac_gdpr.sql exactly — `types/database.ts` now declares the same names, so the
  // call is checked at compile time rather than discovered as a PGRST202 at run time.
  const args: VerifyArgs = { p_raw_token: parsed.data.token, p_guardian_ip: ip }
  const { data, error } = await admin.rpc("verify_parental_consent", args)

  if (error) {
    // eslint-disable-next-line no-console
    console.error("[parental-consent/verify] rpc failed:", error.code, error.message)
    return isFormPost
      ? redirectToPage(request, "error")
      : json(
          {
            ok: false,
            error: {
              code: API_ERROR_CODES.INTERNAL,
              message: "Bu onayı şu an işleyemedik. Lütfen bağlantıyı tekrar dene.",
            },
          },
          500,
        )
  }

  const granted = data === true

  if (isFormPost) {
    return redirectToPage(request, granted ? "granted" : "invalid")
  }

  if (!granted) {
    return json(
      {
        ok: false,
        error: {
          code: API_ERROR_CODES.CONSENT_TOKEN_INVALID,
          message:
            "Bu onay bağlantısının süresi dolmuş, daha önce kullanılmış ya da bizim " +
            "verdiğimiz bir bağlantı değil. Hesabın ayarlarından yenisini iste.",
        },
      },
      400,
    )
  }

  const payload: VerifyData = { granted: true }
  return json({ ok: true, data: payload }, 200)
}
