/**
 * lib/api-response.ts
 *
 * The only way a route handler is allowed to produce a body.
 *
 * Every handler in `app/api/**` returns the `ApiResponse<T>` discriminated union from
 * `@onpitch/shared/domain`, so the client narrows on `ok` instead of guessing. This module is the single
 * place that union is serialised, which buys three things:
 *
 *   1. One JSON shape. A sibling cannot accidentally ship `{ error: "..." }` at the top level.
 *   2. One redaction point. `handleRoute()` turns thrown exceptions — Zod failures, Postgres
 *      SQLSTATEs, Stripe API errors, anything unexpected — into a *stable error code* and a
 *      generic message. The interesting detail goes to the server log, never onto the wire.
 *   3. One cache policy. Authenticated JSON is `no-store` unconditionally; a cached
 *      `/api/stripe/connect/status` body replayed to the wrong session is a data leak.
 *
 * Deliberately tiny surface: `ok()`, `fail()`, `handleRoute()`, plus `ApiRouteError` for handlers
 * that must abort with a specific code and status from deep inside a helper.
 */

import { API_ERROR_CODES, type ApiError, type ApiResponse } from "@onpitch/shared/domain"
import type { Json } from "@onpitch/shared/database"

/* ========================================================================== */
/*  Headers                                                                   */
/* ========================================================================== */

/**
 * Handlers under `/api` are session-scoped — by the Supabase auth cookie for a browser, by an
 * `Authorization: Bearer` token for the Expo app — so any shared cache (a CDN, a browser's
 * bfcache, Next's own fetch cache) that retained one user's payload and replayed it to another
 * would be a horizontal data leak. Hence `no-store`. `Vary: Cookie` is belt-and-braces for
 * intermediaries that honour `Vary` but ignore `no-store`.
 */
const BASE_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store, no-cache, must-revalidate",
  Vary: "Cookie",
  "X-Content-Type-Options": "nosniff",
}

function buildHeaders(init?: ResponseInit): Headers {
  const headers = new Headers(init?.headers)
  for (const [key, value] of Object.entries(BASE_HEADERS)) {
    if (!headers.has(key)) headers.set(key, value)
  }
  return headers
}

/* ========================================================================== */
/*  Success                                                                   */
/* ========================================================================== */

/**
 * A 200 (or `init.status`) carrying `{ ok: true, data }`.
 *
 * `data` is serialised with `JSON.stringify`, so anything non-serialisable is normalised by the
 * same rules the client decodes with: a `Date` becomes an ISO string, an `undefined` object slot
 * disappears. Build plain ISO strings yourself so the wire shape matches the declared type.
 */
export function ok<T>(data: T, init?: ResponseInit): Response {
  const body: ApiResponse<T> = { ok: true, data }
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    statusText: init?.statusText,
    headers: buildHeaders(init),
  })
}

/* ========================================================================== */
/*  Failure                                                                   */
/* ========================================================================== */

/**
 * A non-2xx carrying `{ ok: false, error: { code, message, details? } }`.
 *
 * `code` is the contract — clients branch on it and it is safe to paste into a bug report.
 * `message` is human-facing and MUST already be safe to display: never pass a raw
 * `stripeError.message`, a Postgres error, or an arbitrary exception's `.message` through here.
 * `details` is coerced to `Json`; anything that will not round-trip is dropped rather than
 * throwing while we are already on the error path.
 */
export function fail(code: string, message: string, status = 400, details?: unknown): Response {
  const error: ApiError = { code, message }
  const json = details === undefined ? undefined : toJson(details)
  if (json !== undefined) error.details = json

  const body: ApiResponse<never> = { ok: false, error }
  return new Response(JSON.stringify(body), {
    status: normaliseStatus(status),
    headers: buildHeaders(),
  })
}

/** Clamp to a status the `Response` constructor will actually accept for an error. */
function normaliseStatus(status: number): number {
  if (!Number.isInteger(status) || status < 400 || status > 599) return 500
  return status
}

/**
 * Best-effort structural clone into `Json`. Returns `undefined` (rather than throwing) for
 * cycles, BigInts, and anything else `JSON.stringify` refuses — losing a `details` blob is always
 * preferable to a 500 raised from inside the error formatter itself.
 */
function toJson(value: unknown): Json | undefined {
  try {
    const serialised = JSON.stringify(value)
    if (serialised === undefined) return undefined
    return JSON.parse(serialised) as Json
  } catch {
    return undefined
  }
}

/* ========================================================================== */
/*  Throwable error                                                           */
/* ========================================================================== */

/**
 * Abort a handler with a specific code and status from anywhere in the call stack.
 *
 * `handleRoute()` renders this as-is, so unlike every other exception its `message` DOES reach
 * the client — only construct it with copy you are happy for a stranger to read.
 */
export class ApiRouteError extends Error {
  readonly code: string
  readonly status: number
  readonly details?: unknown

  constructor(code: string, message: string, status = 400, details?: unknown) {
    super(message)
    this.name = "ApiRouteError"
    this.code = code
    this.status = status
    this.details = details
  }
}

/* ========================================================================== */
/*  handleRoute — the catch-all                                               */
/* ========================================================================== */

/**
 * Wrap a handler body so no exception escapes as an HTML stack trace.
 *
 *     export async function POST(request: Request) {
 *       return handleRoute(async () => {
 *         const { user } = await requireRole("venue_owner", "admin")
 *         return ok({ id: user.id })
 *       })
 *     }
 *
 * The generic parameter mirrors the payload type for call-site documentation; the return is
 * always a `Response`, because `ok()` / `fail()` have already serialised it.
 */
export async function handleRoute<T = unknown>(fn: () => Promise<Response>): Promise<Response> {
  void (undefined as T | undefined) // keeps <T> a documented, non-erroring annotation
  try {
    return await fn()
  } catch (error) {
    // Next's control flow (redirect(), notFound(), dynamic bailouts) travels as an exception.
    // Swallowing it would turn requireRole()'s redirect-to-login into an opaque 500.
    if (isFrameworkControlFlow(error)) throw error

    if (error instanceof ApiRouteError) {
      return fail(error.code, error.message, error.status, error.details)
    }

    // `requireRole()` throws ForbiddenError for a signed-in caller with the wrong role. Without
    // this branch it would fall through to the catch-all and answer 500 INTERNAL. Its `message`
    // names the required roles and the caller's actual role, so it is logged, never echoed.
    const forbidden = asForbiddenError(error)
    if (forbidden) {
      return fail(
        API_ERROR_CODES.FORBIDDEN,
        "Bu işlem için yetkin yok.",
        forbidden.status,
      )
    }

    const zodIssues = asZodIssues(error)
    if (zodIssues) {
      console.error("[api] validation failed", { issues: zodIssues })
      return fail(
        API_ERROR_CODES.VALIDATION_FAILED,
        "İstek beklenen biçime uymuyor.",
        422,
        { issues: zodIssues },
      )
    }

    const pg = asPostgresError(error)
    if (pg) {
      // 23P01 = exclusion_violation. The schema has exactly two, and both are user-facing races
      // rather than bugs: bookings_no_double_booking and pitch_blocks_no_overlap.
      if (pg.code === "23P01") {
        const text = `${pg.message ?? ""} ${pg.details ?? ""}`
        if (text.includes("pitch_blocks_no_overlap")) {
          return fail(
            API_ERROR_CODES.BLOCK_OVERLAP,
            "Bu kapalı zaman aralığı mevcut bir aralıkla çakışıyor.",
            409,
          )
        }
        return fail(API_ERROR_CODES.SLOT_TAKEN, "Bu saat az önce doldu. Başka bir saat seç.", 409)
      }
      console.error("[api] database error", { code: pg.code, message: pg.message })
      return fail(API_ERROR_CODES.INTERNAL, "Bir şeyler ters gitti. Lütfen tekrar dene.", 500)
    }

    if (isStripeError(error)) {
      // Stripe messages routinely quote account ids, requirement keys, and integration hints.
      // Log them; hand the client a stable code.
      console.error("[api] stripe error", {
        type: (error as { type?: unknown }).type,
        code: (error as { code?: unknown }).code,
        requestId: (error as { requestId?: unknown }).requestId,
        message: (error as { message?: unknown }).message,
      })
      return fail(
        API_ERROR_CODES.STRIPE_ERROR,
        "Ödeme sağlayıcısı bu isteği tamamlayamadı. Lütfen tekrar dene.",
        502,
      )
    }

    console.error("[api] unhandled error", error)
    return fail(API_ERROR_CODES.INTERNAL, "Bir şeyler ters gitti. Lütfen tekrar dene.", 500)
  }
}

/* -------------------------------------------------------------------------- */
/*  Error sniffers — structural, so this module stays dependency-free          */
/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

/**
 * `redirect()` and `notFound()` throw errors carrying a `digest`; dynamic-rendering bailouts
 * throw a `DynamicServerError`. All of them must reach the framework untouched.
 */
function isFrameworkControlFlow(error: unknown): boolean {
  if (!isRecord(error)) return false
  const digest = error.digest
  if (typeof digest === "string") {
    if (digest === "NEXT_NOT_FOUND") return true
    if (digest.startsWith("NEXT_REDIRECT")) return true
    if (digest.startsWith("DYNAMIC_SERVER_USAGE")) return true
    if (digest.startsWith("BAILOUT_TO_CLIENT_SIDE_RENDERING")) return true
  }
  return error.name === "DynamicServerError"
}

/**
 * `ForbiddenError` from `@/lib/rbac`, sniffed structurally rather than imported: that module
 * pulls in `next/headers`, `next/navigation` and the server Supabase client, and this one stays
 * dependency-free on purpose.
 */
function asForbiddenError(error: unknown): { status: number } | null {
  if (!isRecord(error)) return null
  return error.name === "ForbiddenError" && error.code === "FORBIDDEN"
    ? { status: typeof error.status === "number" ? error.status : 403 }
    : null
}

/** Reduce a ZodError to a wire-safe `[{ path, message }]` without importing zod here. */
function asZodIssues(error: unknown): Array<{ path: string; message: string }> | null {
  if (!isRecord(error)) return null
  if (error.name !== "ZodError") return null
  const issues = error.issues
  if (!Array.isArray(issues)) return null
  return issues.map((issue) => {
    const record = isRecord(issue) ? issue : {}
    const path = Array.isArray(record.path) ? record.path.join(".") : ""
    const message = typeof record.message === "string" ? record.message : "invalid value"
    return { path, message }
  })
}

/** postgrest-js surfaces Postgres failures as `{ code, message, details, hint }`. */
function asPostgresError(
  error: unknown,
): { code: string; message?: string; details?: string } | null {
  if (!isRecord(error)) return null
  const code = error.code
  // SQLSTATEs are exactly five alphanumerics; Node's own errors use codes like ECONNRESET.
  if (typeof code !== "string" || !/^[0-9A-Z]{5}$/.test(code)) return null
  if (!("message" in error) && !("details" in error)) return null
  return {
    code,
    message: typeof error.message === "string" ? error.message : undefined,
    details: typeof error.details === "string" ? error.details : undefined,
  }
}

/** Every error class in stripe-node sets `type` to a `Stripe*Error` discriminator. */
function isStripeError(error: unknown): boolean {
  if (!isRecord(error)) return false
  const type = error.type
  if (typeof type === "string" && type.startsWith("Stripe")) return true
  return typeof error.name === "string" && error.name.startsWith("Stripe")
}
