/**
 * middleware.ts — session refresh + route-level RBAC.
 *
 * Runs before every page and API request that the matcher below admits. Two jobs, in order:
 *
 *   1. Refresh the Supabase session and write the rotated cookies back (see
 *      `lib/supabase/middleware.ts`). This is the only place in a Next.js App Router app that
 *      *can* write auth cookies for a Server Component navigation.
 *
 *   2. Coarse route gating from the `user_role` JWT claim, so the common case — an authorised
 *      user opening an authorised page — costs ZERO database round trips. The claim is stamped
 *      by `public.custom_access_token_hook`; when the hook is not enabled the helper falls back
 *      to a single `profiles` lookup rather than failing open.
 *
 * RLS is the security boundary; the gating here only decides which URL a request reaches. A
 * stale JWT keeps its old role until the token refreshes (default 1h), so a demoted admin could
 * still *reach* `/admin` for up to an hour — and would then see nothing, because RLS
 * (0002_rls.sql) re-derives the role in Postgres for every single row. Never move an
 * authorisation decision here that RLS does not also make.
 */

import { NextResponse, type NextRequest } from "next/server"

import { copyAuthCookies, updateSession, type AppRoleClaim } from "@/lib/supabase/middleware"

/** Prefix -> roles allowed to enter it. `null` means "any signed-in user". */
const PROTECTED_PREFIXES: ReadonlyArray<{ prefix: string; roles: readonly AppRoleClaim[] | null }> = [
  { prefix: "/admin", roles: ["admin"] },
  { prefix: "/venue", roles: ["venue_owner", "admin"] },
  { prefix: "/dashboard", roles: null },
  { prefix: "/matches", roles: null },
]

/** Signed-in users have no business on these; bounce them to their dashboard. */
const GUEST_ONLY_PREFIXES: readonly string[] = ["/login", "/signup"]

/** `/venue` and `/venue/anything`, but not `/venues`. */
function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`)
}

/**
 * Where a role lands after a successful sign-in, or after being turned away from a wrong route.
 *
 * Admins go to `/dashboard`, not `/admin`: the app structure in docs/IMPLEMENTATION_PLAN.md §9
 * gives every session a dashboard but treats `/admin` as an optional back office, and bouncing
 * someone to a route that may not be built yet turns a permission message into a 404.
 */
function homeForRole(role: AppRoleClaim | null): string {
  return role === "venue_owner" ? "/venue" : "/dashboard"
}

/**
 * Only ever redirect to a same-origin PATH. Accepting `?next=https://evil.example` here would
 * make the login page an open redirect, which is a phishing primitive: the victim really did
 * sign in to the real site, and is then dropped on an attacker's page still trusting it.
 * `//evil.example` and `/\evil.example` are protocol-relative URLs, hence the second character
 * check rather than a bare `startsWith('/')`.
 */
function safeNextPath(candidate: string | null): string | null {
  if (!candidate) return null
  if (!candidate.startsWith("/")) return null
  if (candidate.length > 1 && (candidate[1] === "/" || candidate[1] === "\\")) return null
  return candidate
}

/**
 * Where to send a signed-in user who landed on `/login` or `/signup`.
 *
 * `next` is a path AND its query string — `lib/rbac.ts` builds it from `pathname + search`, and
 * this file does the same at the bottom — so it must be PARSED as a URL rather than assigned to
 * `target.pathname`: the pathname setter percent-encodes the `?`, turning `/matches?view=past`
 * into `/matches%3Fview=past`, which matches no route.
 *
 * Parsing against the current origin keeps `safeNextPath`'s open-redirect guarantee, and the
 * origin re-check closes the one hole parsing opens: the URL parser strips tabs and newlines, so
 * `/%09/evil.example` survives `safeNextPath` and would otherwise resolve to `//evil.example`.
 */
function resolveGuestRedirect(request: NextRequest, role: AppRoleClaim | null): URL {
  const home = request.nextUrl.clone()
  home.pathname = homeForRole(role)
  home.search = ""

  const nextPath = safeNextPath(request.nextUrl.searchParams.get("next"))
  if (!nextPath) return home

  const target = new URL(nextPath, request.nextUrl.origin)
  return target.origin === request.nextUrl.origin ? target : home
}

export async function middleware(request: NextRequest) {
  const { response, user, role } = await updateSession(request)
  const { pathname, search } = request.nextUrl

  // ---- already signed in, sitting on the auth pages ------------------------
  if (user && GUEST_ONLY_PREFIXES.some((prefix) => matchesPrefix(pathname, prefix))) {
    const target = resolveGuestRedirect(request, role)
    return copyAuthCookies(response, NextResponse.redirect(target))
  }

  const rule = PROTECTED_PREFIXES.find((entry) => matchesPrefix(pathname, entry.prefix))
  if (!rule) return response

  // ---- not signed in ------------------------------------------------------
  if (!user) {
    const login = request.nextUrl.clone()
    login.pathname = "/login"
    login.search = ""
    // Round-trip the destination so the user resumes where they were headed.
    login.searchParams.set("next", pathname + search)
    return copyAuthCookies(response, NextResponse.redirect(login))
  }

  // ---- signed in, wrong role ----------------------------------------------
  if (rule.roles && (!role || !rule.roles.includes(role))) {
    const fallback = request.nextUrl.clone()
    fallback.pathname = homeForRole(role)
    fallback.search = ""
    // Surfaced as a banner rather than a bare 403 page: the user is legitimately signed in,
    // they took a link meant for someone else.
    fallback.searchParams.set("error", "forbidden")
    fallback.searchParams.set("from", pathname)
    return copyAuthCookies(response, NextResponse.redirect(fallback))
  }

  return response
}

export const config = {
  /**
   * Everything except Next's own static output, the favicon, static assets — and the Stripe
   * webhook. Auth cookies are useless on those and the refresh round trip is not: excluding them
   * keeps navigation fast and avoids burning Auth-server calls on image requests.
   *
   * `/api/stripe/webhook` is excluded deliberately, and `app/api/stripe/webhook/route.ts`
   * documents the same invariant: that route is authenticated by signature alone, Stripe sends no
   * cookies, and building a request-scoped Supabase client per delivery is pure overhead on the
   * one endpoint whose latency budget belongs to signature verification and the ledger write.
   */
  matcher: [
    "/((?!api/stripe/webhook|_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|bmp|ttf|woff|woff2)$).*)",
  ],
}
