/**
 * lib/supabase/client.ts
 *
 * The BROWSER Supabase client. Safe to import from any `'use client'` component.
 *
 * It is built on `createBrowserClient` from `@supabase/ssr`, which persists the session in
 * cookies (not localStorage) so that the very same session is readable by the middleware,
 * Server Components and Route Handlers. One session lives in one place and every rendering
 * context reads it, which is what `@supabase/ssr` exists to arrange.
 *
 * This client authenticates with the ANON key and is therefore fully governed by RLS
 * (supabase/migrations/0002_rls.sql). The anon key is public by design — see docs/SECURITY.md §1.
 */

import { createBrowserClient } from "@supabase/ssr"
import type { SupabaseClient } from "@supabase/supabase-js"

import type { Database } from "@onpitch/shared/database"

/**
 * One instance per browsing context.
 *
 * `createBrowserClient` is cheap but not free, and more importantly a second instance would
 * spin up a second `onAuthStateChange`/token-refresh timer against the same cookie jar. React
 * Strict Mode double-invokes effects, so components calling `createClient()` in a render or an
 * effect would otherwise churn clients on every mount.
 */
let browserClient: SupabaseClient<Database> | undefined

function readPublicEnv(name: "NEXT_PUBLIC_SUPABASE_URL" | "NEXT_PUBLIC_SUPABASE_ANON_KEY"): string {
  // NOTE: these must be written as literal `process.env.NEXT_PUBLIC_*` member expressions for
  // Next.js to inline them into the client bundle at build time. Do not refactor into a dynamic
  // lookup such as `process.env[name]` — that silently yields `undefined` in the browser.
  const value =
    name === "NEXT_PUBLIC_SUPABASE_URL"
      ? process.env.NEXT_PUBLIC_SUPABASE_URL
      : process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (!value) {
    throw new Error(
      `[supabase] ${name} is not set. Add it to .env.local (and to the deployment's environment) — ` +
        "the browser client cannot be constructed without it.",
    )
  }
  return value
}

/**
 * Returns the memoised browser Supabase client.
 *
 * @example
 * 'use client'
 * import { createClient } from '@/lib/supabase/client'
 * const supabase = createClient()
 * await supabase.auth.signInWithPassword({ email, password })
 */
export function createClient(): SupabaseClient<Database> {
  if (browserClient) return browserClient

  browserClient = createBrowserClient<Database>(
    readPublicEnv("NEXT_PUBLIC_SUPABASE_URL"),
    readPublicEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
  )

  return browserClient
}
