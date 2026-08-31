/**
 * lib/supabase/server.ts
 *
 * The COOKIE-BOUND server Supabase client, for Server Components, Server Actions and Route
 * Handlers. It authenticates with the ANON key on behalf of the signed-in user, so every query
 * it makes is still filtered by RLS — this is NOT a privileged client. For the service-role
 * escape hatch see `lib/supabase/admin.ts`.
 *
 * Two rules that the Next.js App Router imposes and that this module encodes:
 *
 *  1. The client MUST be created per request. A module-level singleton would leak one user's
 *     session into another user's render, because the cookie store it closes over is
 *     request-scoped. Hence `createClient()` is a factory, never a cached instance.
 *
 *  2. Cookies cannot be written from a Server Component. Only the middleware, a Server Action
 *     or a Route Handler may set them. `setAll` therefore swallows the write error: token
 *     refresh still happens in `middleware.ts` on every request, so dropping the write here is
 *     harmless rather than a silent session loss.
 *
 * Route handlers should call {@link createRouteClient} instead, which serves the mobile app's
 * `Authorization: Bearer` transport as well as the browser's cookies. `createClient()` keeps its
 * exact behaviour — every Server Component in the app is built on it.
 */

import { cookies } from "next/headers"
import { createServerClient } from "@supabase/ssr"
import { createClient as createSupabaseClient } from "@supabase/supabase-js"
import type { SupabaseClient } from "@supabase/supabase-js"

import { resolveBearerToken } from "@/lib/auth/bearer"
import type { Database } from "@halisaha/shared/database"

function readPublicEnv(name: "NEXT_PUBLIC_SUPABASE_URL" | "NEXT_PUBLIC_SUPABASE_ANON_KEY"): string {
  const value =
    name === "NEXT_PUBLIC_SUPABASE_URL"
      ? process.env.NEXT_PUBLIC_SUPABASE_URL
      : process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (!value) {
    throw new Error(`[supabase] ${name} is not set; the server client cannot be constructed.`)
  }
  return value
}

/**
 * Creates a request-scoped Supabase client bound to the incoming cookie jar.
 *
 * `await`ed even though `cookies()` is synchronous in Next 14 — awaiting a non-thenable is a
 * no-op, and it keeps this call site source-compatible with Next 15, where `cookies()` became
 * async. Callers already `await createClient()` per the shared module contract.
 *
 * @example
 * const supabase = await createClient()
 * const { data: { user } } = await supabase.auth.getUser()
 */
export async function createClient(): Promise<SupabaseClient<Database>> {
  const cookieStore = await cookies()

  return createServerClient<Database>(
    readPublicEnv("NEXT_PUBLIC_SUPABASE_URL"),
    readPublicEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options)
            }
          } catch {
            // Called from a Server Component, where the response headers are already sealed.
            // Safe to ignore: `middleware.ts` refreshes the session and rewrites these exact
            // cookies on every request, so the browser never ends up with a stale token.
          }
        },
      },
    },
  )
}

/**
 * Builds a client that authenticates PostgREST with a caller-supplied access token.
 *
 * The token travels as a header, with no cookie adapter and no session storage, so nothing is
 * persisted and nothing is refreshed here. The mobile app owns its own refresh cycle and sends
 * whatever token it currently holds. Because the token is the user's own Supabase JWT, `auth.uid()` in Postgres is
 * that user and RLS filters exactly as it does for a cookie session.
 *
 * The token's SHAPE has been validated by `extractBearerToken`; its SIGNATURE has not been
 * validated at this point. An invalid token still buys nothing: PostgREST rejects it, and
 * `getSessionUser()` calls `auth.getUser(token)` before anything reads or writes a row.
 */
function createBearerClient(token: string): SupabaseClient<Database> {
  return createSupabaseClient<Database>(
    readPublicEnv("NEXT_PUBLIC_SUPABASE_URL"),
    readPublicEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    {
      auth: {
        // There is no browser here and no cookie jar to write back to. Leaving any of these on
        // would have supabase-js hunt for ambient storage and start a refresh timer per request.
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: {
        headers: {
          Authorization: `Bearer ${token}`,
          // Attributes a surprising query to this codepath in the Postgres logs during an
          // incident review, the same way `createAdminClient()` tags itself.
          "x-application-name": "halisaha-bearer",
        },
      },
    },
  )
}

/**
 * The client for ROUTE HANDLERS, serving both transports the API has to answer.
 *
 * Web callers send the Supabase auth cookies; the Expo app has no cookie jar and sends
 * `Authorization: Bearer <access token>` instead. Both are the same Supabase session, so both
 * end up as the same `auth.uid()` and meet identical RLS. `lib/auth/bearer.ts` covers the rest,
 * including why the token is verified rather than decoded.
 *
 * @param request the handler's `Request`. Optional: with no argument the header is read from the
 *        ambient request via `next/headers`, which is how `getSessionUser()` supports bearer
 *        callers without a signature change.
 *
 * @example
 * export async function POST(request: Request) {
 *   return handleRoute(async () => {
 *     const supabase = await createRouteClient(request)
 *     const { data } = await supabase.from("venues").select("*")   // RLS-scoped either way
 *     return ok(data ?? [])
 *   })
 * }
 */
export async function createRouteClient(request?: Request): Promise<SupabaseClient<Database>> {
  const token = await resolveBearerToken(request)
  if (!token) return createClient()
  return createBearerClient(token)
}
