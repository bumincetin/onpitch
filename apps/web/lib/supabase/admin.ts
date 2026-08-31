/**
 * lib/supabase/admin.ts
 *
 * The SERVICE-ROLE Supabase client. It BYPASSES ROW LEVEL SECURITY ENTIRELY.
 *
 * docs/SECURITY.md §1 calls the service-role key "the crown jewel": anything holding it can
 * read and write every row of every table for every user. Three defences are stacked here:
 *
 *   1. `import 'server-only'` — importing this module from a Client Component fails the build
 *      rather than shipping the key.
 *   2. A runtime `typeof window` guard, in case the module is reached through a path that
 *      escapes the React Server Components graph (a bundler alias, a test harness, a stray
 *      dynamic import).
 *   3. `SUPABASE_SERVICE_ROLE_KEY` has no `NEXT_PUBLIC_` prefix, so Next.js will never inline
 *      it into a browser bundle even if defence 1 and 2 were both removed.
 *
 * Legitimate callers, and only these:
 *   * the Stripe webhook (no user session exists — Stripe is the caller);
 *   * connected-account persistence (`venues.stripe_account_id` must not be client-writable);
 *   * rating / consensus finalisation (must see every participant's rows);
 *   * `POST /api/auth/parental-consent/verify` — the guardian following an emailed link is
 *     deliberately NOT a user of the platform, and `public.verify_parental_consent` is granted
 *     to `service_role` only.
 *
 * Never hand this client a value that came from a request body. Every identifier it acts on
 * must be derived server-side from an authenticated session or from a verified webhook payload.
 */

import "server-only"

import { createClient as createSupabaseClient } from "@supabase/supabase-js"
import type { SupabaseClient } from "@supabase/supabase-js"

import type { Database } from "@halisaha/shared/database"

/**
 * Builds a fresh service-role client.
 *
 * Deliberately NOT memoised across requests: the client is stateless (no session to persist)
 * and keeping module state out of it makes it obvious that nothing user-specific can leak
 * between two concurrent requests on the same warm lambda.
 *
 * @throws if evaluated in a browser, or if `SUPABASE_SERVICE_ROLE_KEY` is missing.
 */
export function createAdminClient(): SupabaseClient<Database> {
  if (typeof window !== "undefined") {
    throw new Error(
      "[supabase] createAdminClient() was called in a browser context. The service-role key " +
        "bypasses RLS and must never leave the server. This is a bug — use " +
        "@/lib/supabase/client for browser code.",
    )
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url) {
    throw new Error("[supabase] NEXT_PUBLIC_SUPABASE_URL is not set; the admin client cannot be constructed.")
  }
  if (!serviceRoleKey) {
    throw new Error(
      "[supabase] SUPABASE_SERVICE_ROLE_KEY is not set. It is a SERVER-ONLY secret: set it in " +
        "the deployment environment, never in a NEXT_PUBLIC_* variable.",
    )
  }

  return createSupabaseClient<Database>(url, serviceRoleKey, {
    auth: {
      // There is no end user behind this client, so there is nothing to persist and nothing to
      // refresh. Leaving either on would have the client try to write auth state into whatever
      // ambient storage it finds.
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: {
        // Shows up in Postgres logs / pg_stat_statements, so a surprising service-role query is
        // attributable to this codepath during an incident review.
        "x-application-name": "halisaha-admin",
      },
    },
  })
}
