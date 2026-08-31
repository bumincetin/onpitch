/// <reference types="https://esm.sh/@supabase/functions-js@2/src/edge-runtime.d.ts" />

/**
 * supabase/functions/_shared/cors.ts
 *
 * CORS + response helpers shared by every Edge Function in this project.
 *
 * Note for the Next.js build: everything under `supabase/functions/` is Deno,
 * not Node. It uses `Deno.serve`, `jsr:` specifiers and Deno's own globals, and
 * must be excluded from the app's `tsconfig.json` (`"exclude": ["supabase/functions"]`)
 * or `tsc` will try to resolve `jsr:@supabase/supabase-js@2` as an npm package
 * and fail. It is deployed with the Supabase CLI, never bundled by Next.
 *
 * ── On the wildcard origin ──────────────────────────────────────────────────
 * `Access-Control-Allow-Origin: *` is safe here and only here, because these
 * functions are not cookie-authenticated. Every one of them authenticates from
 * an `Authorization` header (a user JWT, the service-role key, or the internal
 * token) and `Allow-Credentials` is never sent, so a browser will not attach
 * ambient credentials to a cross-origin call. If a future function ever reads a
 * cookie, this must become an origin allow-list on the same day.
 */

export const corsHeaders: Readonly<Record<string, string>> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-internal-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
}

/**
 * Answer a CORS pre-flight. Returns `null` for anything that is not an
 * `OPTIONS`, so a handler reads as:
 *
 *     const preflight = handlePreflight(req)
 *     if (preflight) return preflight
 */
export function handlePreflight(request: Request): Response | null {
  if (request.method !== "OPTIONS") return null
  return new Response(null, { status: 204, headers: corsHeaders })
}

/**
 * A JSON response in the same `{ ok, data } | { ok, error }` envelope the
 * Next.js routes use, so a caller does not have to learn two shapes.
 */
export function jsonOk<T>(data: T, status = 200): Response {
  return new Response(JSON.stringify({ ok: true, data }), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  })
}

export function jsonError(code: string, message: string, status = 400, details?: unknown): Response {
  const error: Record<string, unknown> = { code, message }
  if (details !== undefined) error.details = details
  return new Response(JSON.stringify({ ok: false, error }), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  })
}

/**
 * Thrown by the shared helpers to abort with a specific status. Its message
 * reaches the caller, so only construct it with text that is safe to show.
 */
export class EdgeError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status = 400) {
    super(message)
    this.name = "EdgeError"
    this.code = code
    this.status = status
  }
}

/**
 * Wrap a handler so nothing escapes as an unhandled rejection (which the Edge
 * runtime renders as an opaque 500 with no body).
 */
export async function handleEdge(
  request: Request,
  fn: () => Promise<Response>,
): Promise<Response> {
  const preflight = handlePreflight(request)
  if (preflight) return preflight

  try {
    return await fn()
  } catch (error) {
    if (error instanceof EdgeError) {
      return jsonError(error.code, error.message, error.status)
    }
    console.error("[edge] unhandled error", error)
    return jsonError("INTERNAL", "Something went wrong.", 500)
  }
}
