/**
 * lib/supabase/middleware.ts
 *
 * Session refresh for Next.js middleware, plus the zero-round-trip identity read that
 * `middleware.ts` gates routes on.
 *
 * Server Components cannot write cookies, so the middleware is the ONLY place in the app where
 * an expired access token can actually be exchanged for a fresh one and written back to the
 * browser. If this stops running, every user silently drops to logged-out an hour after signing
 * in. It therefore has to run on essentially every request — see the matcher in `middleware.ts`.
 *
 * The identity it returns comes from the JWT itself, not from the database: the custom access
 * token hook in `supabase/migrations/0003_auth_rbac_gdpr.sql` stamps `user_role`, `is_minor` and
 * `parental_consent_status` into every token GoTrue mints. Reading them costs a base64 decode
 * instead of a Postgres round trip on every navigation. The claims are a CACHE, valid until the
 * token is next refreshed (1h by default) — good enough to route on, never good enough to
 * authorise a mutation. Mutations are re-checked by RLS against `public.profiles`.
 */

import { NextResponse, type NextRequest } from "next/server"
import { createServerClient } from "@supabase/ssr"
import type { SupabaseClient, User } from "@supabase/supabase-js"

import type { Database, Enums } from "@halisaha/shared/database"

/** Request header the middleware stamps so Server Components can learn their own pathname. */
export const PATHNAME_HEADER = "x-halisaha-pathname"

export type AppRoleClaim = Enums<"app_role">
export type ConsentStatusClaim = Enums<"consent_status">

const APP_ROLES: readonly AppRoleClaim[] = ["admin", "venue_owner", "player"]
const CONSENT_STATUSES: readonly ConsentStatusClaim[] = [
  "not_required",
  "pending",
  "granted",
  "revoked",
]

/** What `middleware.ts` needs in order to decide about a request. */
export interface SessionContext {
  /** The response carrying any refreshed auth cookies. MUST be returned, or the refresh is lost. */
  response: NextResponse
  /** Verified against the Auth server by `getUser()` — safe to trust. */
  user: User | null
  /** `user_role` claim, or a `profiles` fallback when the hook is not enabled. `null` when signed out. */
  role: AppRoleClaim | null
  /** `is_minor` claim. Defaults to `false` when unknown. */
  isMinor: boolean
  /** `parental_consent_status` claim. Defaults to `'not_required'` when unknown. */
  consentStatus: ConsentStatusClaim
  /** True when the role had to be read from Postgres because the JWT hook did not fire. */
  roleFromDatabase: boolean
  /** The request-scoped client, in case a caller needs one more query. */
  supabase: SupabaseClient<Database>
}

/* -------------------------------------------------------------------------- */
/*  JWT claim decoding                                                        */
/* -------------------------------------------------------------------------- */

function base64UrlDecode(segment: string): string {
  const normalised = segment.replace(/-/g, "+").replace(/_/g, "/")
  const padded = normalised.padEnd(normalised.length + ((4 - (normalised.length % 4)) % 4), "=")
  const binary = atob(padded)
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

/**
 * Reads the payload of an access token WITHOUT verifying its signature.
 *
 * That is safe here and only here. The token was just handed to us by
 * `supabase.auth.getSession()`, which read it from the cookie jar that
 * `supabase.auth.getUser()` has already validated against the Auth server in this same request,
 * so the value being decoded has already been independently confirmed.
 *
 * Never use this to authorise anything on its own.
 */
export function decodeAccessTokenClaims(
  accessToken: string | null | undefined,
): Record<string, unknown> | null {
  if (!accessToken) return null
  const segments = accessToken.split(".")
  if (segments.length !== 3) return null

  // Indexing does not narrow under `noUncheckedIndexedAccess`, and the length check above is not
  // a tuple guard — so read the payload segment out explicitly rather than feeding a possible
  // `undefined` to `atob()`.
  const payloadSegment = segments[1]
  if (!payloadSegment) return null

  try {
    const payload: unknown = JSON.parse(base64UrlDecode(payloadSegment))
    return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** Pulls a claim from the token root, then from `app_metadata` — the hook writes it at the root. */
function readClaim(claims: Record<string, unknown> | null, key: string): unknown {
  if (!claims) return undefined
  if (claims[key] !== undefined) return claims[key]
  const appMetadata = claims["app_metadata"]
  if (appMetadata && typeof appMetadata === "object") {
    return (appMetadata as Record<string, unknown>)[key]
  }
  return undefined
}

function asRole(value: unknown): AppRoleClaim | null {
  return typeof value === "string" && (APP_ROLES as readonly string[]).includes(value)
    ? (value as AppRoleClaim)
    : null
}

function asConsentStatus(value: unknown): ConsentStatusClaim | null {
  return typeof value === "string" && (CONSENT_STATUSES as readonly string[]).includes(value)
    ? (value as ConsentStatusClaim)
    : null
}

/* -------------------------------------------------------------------------- */
/*  Session refresh                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Refreshes the Supabase session for this request and reports who the caller is.
 *
 * The cookie dance below is the shape `@supabase/ssr` prescribes, and every step of it is
 * load-bearing. When the auth library rotates the token it hands us the new cookies, which
 * must be written onto BOTH the outgoing request (so a Server Component rendering downstream in this same pass
 * sees the fresh session) and the outgoing response (so the browser stores it). Rebuilding the
 * response inside `setAll` is what propagates the mutated request headers.
 *
 * @param request the incoming middleware request
 * @returns the response that MUST be returned (or whose cookies must be copied onto a redirect,
 *          via {@link copyAuthCookies}), together with the caller's identity.
 */
export async function updateSession(request: NextRequest): Promise<SessionContext> {
  const pathnameValue = request.nextUrl.pathname + request.nextUrl.search

  /**
   * Snapshots the request headers AS THEY ARE NOW and stamps the pathname on them.
   *
   * It has to be re-read rather than captured once: `request.cookies.set()` in `setAll` below
   * rewrites the request's `cookie` header, and a stale snapshot would hand every downstream
   * Server Component the PRE-refresh cookies — the subtle version of "the session randomly
   * disappears an hour in", where the browser has the new token but the render does not.
   *
   * Next.js does not expose the pathname to Server Components at all; stamping it here is what
   * lets `requireRole()` build an accurate `?next=` for the login redirect.
   */
  const buildResponse = (): NextResponse => {
    const headers = new Headers(request.headers)
    headers.set(PATHNAME_HEADER, pathnameValue)
    return NextResponse.next({ request: { headers } })
  }

  let response = buildResponse()

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anonKey) {
    throw new Error(
      "[supabase] NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY are required in middleware.",
    )
  }

  const supabase = createServerClient<Database>(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll()
      },
      setAll(cookiesToSet) {
        // 1. onto the request, so this pass's Server Components see the fresh session,
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value)
        }
        // 2. rebuild the response from the now-updated request headers,
        response = buildResponse()
        // 3. and onto the response, so the browser stores it.
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options)
        }
      },
    },
  })

  // getUser() — never getSession() — is the authoritative check: it revalidates the token with
  // the Auth server and triggers the refresh whose cookies the adapter above captures.
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return {
      response,
      user: null,
      role: null,
      isMinor: false,
      consentStatus: "not_required",
      roleFromDatabase: false,
      supabase,
    }
  }

  // Local read of the cookie jar getUser() just validated — no network, no database.
  const {
    data: { session },
  } = await supabase.auth.getSession()

  const claims = decodeAccessTokenClaims(session?.access_token)

  let role = asRole(readClaim(claims, "user_role")) ?? asRole(user.app_metadata?.["user_role"])
  let roleFromDatabase = false

  if (!role) {
    // The JWT hook is not enabled (or the token predates it). One query, and only on this path —
    // see docs/RUNBOOK.md for enabling "Customize Access Token (JWT) Claims".
    // No `deleted_at` predicate. `role` is inside the column-scoped SELECT grant in
    // 0002_rls.sql (4.1); `deleted_at` is not, and a column privilege is checked for a
    // WHERE-clause reference too, so naming it would make the whole statement a 42501 and
    // demote every user to `player`. It is redundant anyway: profiles_select_self_or_visible
    // already carries `deleted_at is null` on every branch that could admit another user's row,
    // and a soft-deleted caller is caught downstream by `getSessionUser()` returning null.
    const { data, error } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .maybeSingle()

    if (error) {
      // Deliberately not fatal: this runs on nearly every request, so failing closed on a
      // transient PostgREST error would black out the whole site. Log it so a systematic
      // failure is visible instead of reading as "everyone is a player".
      // eslint-disable-next-line no-console
      console.error("[middleware] role lookup failed:", error.code, error.message)
    }

    role = asRole(data?.role) ?? "player"
    roleFromDatabase = true
  }

  return {
    response,
    user,
    role,
    isMinor: readClaim(claims, "is_minor") === true,
    consentStatus: asConsentStatus(readClaim(claims, "parental_consent_status")) ?? "not_required",
    roleFromDatabase,
    supabase,
  }
}

/**
 * Copies the auth cookies from the `updateSession` response onto another response.
 *
 * Required whenever the middleware answers with a redirect instead of `next()`: dropping the
 * refreshed cookies there produces the classic redirect loop where the user is bounced to
 * `/login`, signs in, and is bounced straight back because the rotated token was never stored.
 */
export function copyAuthCookies(from: NextResponse, to: NextResponse): NextResponse {
  for (const cookie of from.cookies.getAll()) {
    to.cookies.set(cookie)
  }
  return to
}
