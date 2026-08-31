/// <reference types="https://esm.sh/@supabase/functions-js@2/src/edge-runtime.d.ts" />

/**
 * supabase/functions/_shared/supabase.ts
 *
 * Client factories and request authentication for the Edge Functions.
 *
 * ── Environment ─────────────────────────────────────────────────────────────
 * Supabase injects `SUPABASE_URL`, `SUPABASE_ANON_KEY` and
 * `SUPABASE_SERVICE_ROLE_KEY` into every function automatically, so they do not
 * need to be set with `supabase secrets set`. Everything else does:
 *
 *     supabase secrets set \
 *       ANOMALY_SERVICE_URL=https://anomaly.internal \
 *       ANOMALY_SERVICE_SECRET=<shared with services/anomaly> \
 *       INTERNAL_API_TOKEN=<shared with the Next.js app>
 *
 * ── Two clients, two privilege levels ───────────────────────────────────────
 * `createServiceClient()` bypasses RLS entirely. It is what the rating and
 * anomaly RPCs need — `apply_match_rating`, `record_anomaly_verdict` and
 * `matches_pending_anomaly_check` are all granted to `service_role` only — and
 * it must never be handed a value that came from the request body without a
 * check in front of it.
 *
 * `createUserClient(request)` forwards the caller's `Authorization` header, so
 * `auth.uid()` resolves and RLS applies exactly as it does from the browser. Use
 * it for anything that should be judged as the calling user.
 */

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2"

import { EdgeError } from "./cors.ts"

/* ========================================================================== */
/*  Environment                                                               */
/* ========================================================================== */

export function env(name: string): string | undefined {
  return Deno.env.get(name)
}

/** Read a variable that the function cannot run without. */
export function requireEnv(name: string): string {
  const value = Deno.env.get(name)
  if (!value) {
    console.error(`[edge] missing required environment variable: ${name}`)
    throw new EdgeError("INTERNAL", "This function is not configured.", 503)
  }
  return value
}

/* ========================================================================== */
/*  Clients                                                                   */
/* ========================================================================== */

/**
 * Service-role client. Bypasses RLS.
 *
 * `persistSession: false` and `autoRefreshToken: false` matter in a serverless
 * runtime: there is no browser storage to persist into and a refresh timer would
 * keep the isolate alive past the response.
 */
export function createServiceClient(): SupabaseClient {
  return createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

/**
 * A client that acts as the caller. RLS applies; `auth.uid()` is their id.
 * Throws when the request carries no `Authorization` header.
 */
export function createUserClient(request: Request): SupabaseClient {
  const authorization = request.headers.get("Authorization")
  if (!authorization) {
    throw new EdgeError("UNAUTHENTICATED", "Authorization header is required.", 401)
  }

  return createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_ANON_KEY"), {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

/* ========================================================================== */
/*  Request authentication                                                    */
/* ========================================================================== */

export interface Caller {
  /** True when the bearer token is the service-role key (cron, another server). */
  isServiceRole: boolean
  /** True when the caller presented `INTERNAL_API_TOKEN`. */
  isInternal: boolean
  /** The authenticated user id, when a real user JWT was presented. */
  userId: string | null
}

/** The bearer token on a request, or null. */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get("Authorization")
  if (!header) return null
  if (!header.toLowerCase().startsWith("bearer ")) return null
  const token = header.slice(7).trim()
  return token.length > 0 ? token : null
}

/**
 * Constant-time string comparison.
 *
 * Deno's `crypto.subtle` has no synchronous compare, so this is the classic
 * accumulate-the-XOR loop. The early length check is not a leak worth worrying
 * about here (both secrets are fixed-length), and comparing unequal-length
 * buffers byte-by-byte would be worse.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a)
  const right = new TextEncoder().encode(b)
  if (left.length !== right.length) return false
  let diff = 0
  for (const [i, byte] of left.entries()) diff |= byte ^ (right[i] ?? 0)
  return diff === 0
}

/**
 * Work out who is calling.
 *
 * Three accepted identities, in decreasing order of power:
 *   1. the service-role key — pg_cron, Supabase scheduled functions, another
 *      trusted server;
 *   2. `INTERNAL_API_TOKEN` in `X-Internal-Token` — the Next.js app;
 *   3. a user JWT — verified by asking GoTrue, never by decoding the token
 *      locally. A locally-decoded JWT is unverified input; `auth.getUser()`
 *      checks the signature against the project's keys.
 *
 * Deploy these functions WITHOUT `--no-verify-jwt` so the platform rejects
 * unauthenticated calls before the isolate even starts; this is the second
 * layer, and the one that distinguishes a player from the cron job.
 */
export async function identifyCaller(request: Request): Promise<Caller> {
  const token = bearerToken(request)
  const internalHeader = request.headers.get("x-internal-token")
  const internalToken = env("INTERNAL_API_TOKEN")
  const serviceKey = env("SUPABASE_SERVICE_ROLE_KEY")

  const isServiceRole = Boolean(token && serviceKey && constantTimeEquals(token, serviceKey))
  const isInternal = Boolean(
    internalToken &&
      ((internalHeader && constantTimeEquals(internalHeader, internalToken)) ||
        (token && constantTimeEquals(token, internalToken))),
  )

  if (isServiceRole || isInternal) {
    return { isServiceRole, isInternal, userId: null }
  }

  if (!token) {
    return { isServiceRole: false, isInternal: false, userId: null }
  }

  const client = createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_ANON_KEY"), {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  })

  const { data, error } = await client.auth.getUser()
  if (error || !data.user) {
    return { isServiceRole: false, isInternal: false, userId: null }
  }

  return { isServiceRole: false, isInternal: false, userId: data.user.id }
}

/** Reject anything that is not a trusted server-side caller. */
export function requireMachineCaller(caller: Caller): void {
  if (!caller.isServiceRole && !caller.isInternal) {
    throw new EdgeError(
      "FORBIDDEN",
      "This function may only be invoked with the service-role key or the internal token.",
      403,
    )
  }
}

/* ========================================================================== */
/*  Body parsing                                                              */
/* ========================================================================== */

/** Parse a JSON body, treating an empty body as `{}`. */
export async function readJson(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text()
  if (text.trim().length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new EdgeError("VALIDATION_FAILED", "The request body must be a JSON object.", 422)
    }
    return parsed as Record<string, unknown>
  } catch (error) {
    if (error instanceof EdgeError) throw error
    throw new EdgeError("VALIDATION_FAILED", "The request body was not valid JSON.", 400)
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Read a required uuid field, with a message a human can act on. */
export function requireUuid(body: Record<string, unknown>, key: string): string {
  const value = body[key]
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new EdgeError("VALIDATION_FAILED", `"${key}" must be a uuid.`, 422)
  }
  return value.toLowerCase()
}

/* ========================================================================== */
/*  Errors from PostgREST                                                     */
/* ========================================================================== */

export interface PostgrestLikeError {
  code?: string | null
  message?: string | null
  details?: string | null
  hint?: string | null
}

/**
 * Turn a PostgREST error into an `EdgeError`.
 *
 * Migration 0005 raises PostgREST-style SQLSTATEs (`PT401` … `PT429`) whose
 * messages are written to be read by a human, so those are forwarded verbatim,
 * which is what the convention exists for. Everything else gets a generic
 * message and the detail goes to the log.
 */
export function toEdgeError(error: PostgrestLikeError, fallback: string): EdgeError {
  const code = typeof error.code === "string" ? error.code : ""
  const message = typeof error.message === "string" ? error.message : null

  const statuses: Record<string, number> = {
    PT401: 401,
    PT403: 403,
    PT404: 404,
    PT409: 409,
    PT422: 422,
    PT429: 429,
  }

  const status = statuses[code]
  if (status !== undefined) {
    return new EdgeError(code, message ?? fallback, status)
  }

  console.error("[edge] database error", { code, message, details: error.details })
  return new EdgeError("INTERNAL", fallback, 500)
}
