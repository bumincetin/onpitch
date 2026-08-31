/**
 * lib/rbac.ts
 *
 * Server-side identity and the application's permission matrix.
 *
 * Three layers of authorisation exist in this codebase and they answer different questions:
 *
 *   * `middleware.ts`   — "may this role open this URL?"      Cheap, JWT-only, routing.
 *   * `canAccess()`     — "may this role do this at all?"     Pure, testable, coarse.
 *   * RLS (0002_rls.sql)— "may this user touch THIS row?"     The actual security boundary.
 *
 * `canAccess()` is a capability gate, not an ownership check. It answers whether a venue owner
 * may update pitches in general; whether they may update *pitch #42* is `private.owns_pitch()`
 * in Postgres, and nothing here can weaken or replace it. Use it to render UI honestly (hide a
 * button the user can never use) and to fail fast in a route handler before doing expensive
 * work — never as the last line of defence.
 *
 * Both transports land here. A browser presents Supabase auth cookies, the Expo app presents
 * `Authorization: Bearer <access token>`; `createRouteClient()` resolves either into a client
 * bound to the same Supabase user, so everything below is transport-agnostic. `lib/auth/bearer.ts`
 * has the details.
 */

import { headers } from "next/headers"
import { redirect } from "next/navigation"
import type { User } from "@supabase/supabase-js"

import { createRouteClient } from "@/lib/supabase/server"
import { hasAuthorizationHeader, resolveBearerToken, verifyBearerToken } from "@/lib/auth/bearer"
import { ApiRouteError } from "@/lib/api-response"
import { PATHNAME_HEADER } from "@/lib/supabase/middleware"
import { API_ERROR_CODES } from "@halisaha/shared/domain"
import type { Tables } from "@halisaha/shared/database"

export type AppRole = "admin" | "venue_owner" | "player"

/** Every role, in descending order of privilege. Useful for sorting and for tests. */
export const APP_ROLES: readonly AppRole[] = ["admin", "venue_owner", "player"]

export interface SessionUser {
  user: User
  profile: Tables<"profiles">
}

/* -------------------------------------------------------------------------- */
/*  Errors                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Thrown by {@link requireRole} when an authenticated user holds the wrong role.
 *
 * Deliberately an exception rather than a redirect: a wrong-role request is a programming or
 * link-sharing error, and swallowing it into a redirect hides it from error reporting. The
 * nearest `error.tsx` boundary renders it; route handlers map it with {@link isForbiddenError}.
 */
export class ForbiddenError extends Error {
  readonly status = 403 as const
  readonly code = "FORBIDDEN" as const
  readonly requiredRoles: readonly AppRole[]
  readonly actualRole: AppRole | null

  constructor(requiredRoles: readonly AppRole[], actualRole: AppRole | null) {
    super(
      `Forbidden: this action requires ${requiredRoles.join(" or ")}, but the current user is ` +
        `${actualRole ?? "unauthenticated"}.`,
    )
    this.name = "ForbiddenError"
    this.requiredRoles = requiredRoles
    this.actualRole = actualRole
  }
}

export function isForbiddenError(error: unknown): error is ForbiddenError {
  return error instanceof ForbiddenError
}

/* -------------------------------------------------------------------------- */
/*  The permission matrix                                                     */
/* -------------------------------------------------------------------------- */

export const RESOURCES = [
  "profiles",
  "venues",
  "pitches",
  "bookings",
  "matches",
  "stats",
] as const
export type Resource = (typeof RESOURCES)[number]

export const ACTIONS = ["read", "create", "update", "delete"] as const
export type Action = (typeof ACTIONS)[number]

const ALL_ACTIONS: readonly Action[] = ACTIONS

/**
 * Role x resource -> allowed actions.
 *
 * Exported so it can be asserted against directly in unit tests, and so a reviewer can read the
 * entire authorisation surface of the product on one screen.
 *
 * Design notes, each of which mirrors a decision already made in SQL:
 *
 *  * NOBODY but an admin gets `delete`. Profiles are erased by soft-delete
 *    (`request_account_erasure`), bookings are cancelled and refunded rather than removed, and
 *    matches keep their financial and rating history. `0002_rls.sql` grants no DELETE on
 *    `profiles` to anyone at all.
 *  * `venue_owner` cannot `create` a booking. Facility owners block time via
 *    `pitch_availability_blocks`; a booking is always a customer transaction, and letting an
 *    owner mint one would put a charge on a card nobody presented.
 *  * `player` may `create` stats — that is filing a score report, which the anomaly and
 *    consensus layers then police. Players may not `update` stats: a filed report is evidence.
 *  * `player` may `update` a match (join, confirm attendance, cancel their own), gated per-row
 *    by `private.can_manage_match()`.
 */
export const PERMISSION_MATRIX: Readonly<
  Record<AppRole, Readonly<Record<Resource, readonly Action[]>>>
> = {
  admin: {
    profiles: ALL_ACTIONS,
    venues: ALL_ACTIONS,
    pitches: ALL_ACTIONS,
    bookings: ALL_ACTIONS,
    matches: ALL_ACTIONS,
    stats: ALL_ACTIONS,
  },
  venue_owner: {
    profiles: ["read", "update"],
    venues: ["read", "create", "update"],
    pitches: ["read", "create", "update"],
    bookings: ["read", "update"],
    matches: ["read", "update"],
    stats: ["read"],
  },
  player: {
    profiles: ["read", "update"],
    venues: ["read"],
    pitches: ["read"],
    bookings: ["read", "create", "update"],
    matches: ["read", "create", "update"],
    stats: ["read", "create"],
  },
}

/**
 * Pure capability check. Reads no session and touches no database, so a unit test needs no
 * fixture beyond its arguments.
 *
 * @example
 * canAccess('venue_owner', 'pitches', 'create') // true
 * canAccess('player', 'venues', 'update')       // false
 * canAccess('admin', 'profiles', 'delete')      // true
 */
export function canAccess(role: AppRole | null | undefined, resource: Resource, action: Action): boolean {
  if (!role) return false
  const resourcePermissions = PERMISSION_MATRIX[role]
  if (!resourcePermissions) return false
  return resourcePermissions[resource]?.includes(action) ?? false
}

/** Every `${resource}:${action}` pair a role holds. Handy for shipping capabilities to the client. */
export function capabilitiesFor(role: AppRole): readonly `${Resource}:${Action}`[] {
  const capabilities: `${Resource}:${Action}`[] = []
  for (const resource of RESOURCES) {
    for (const action of PERMISSION_MATRIX[role][resource]) {
      capabilities.push(`${resource}:${action}`)
    }
  }
  return capabilities
}

/* -------------------------------------------------------------------------- */
/*  Session helpers                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The pathname the middleware stamped onto this request, for building `?next=`.
 * Falls back to the dashboard when the header is absent (e.g. a route the matcher excludes).
 */
async function currentPath(): Promise<string> {
  try {
    const headerList = await headers()
    const pathname = headerList.get(PATHNAME_HEADER)
    if (pathname && pathname.startsWith("/")) return pathname
  } catch {
    // `headers()` is unavailable outside a request scope (a script, a test). Fall through.
  }
  return "/dashboard"
}

/**
 * True when the caller presented an `Authorization` header, sound or not.
 *
 * Distinguishes an API client from a browser navigation. Deliberately keyed on the header being
 * PRESENT rather than valid, so a mobile client holding an expired token gets a 401 instead of a
 * redirect into an HTML login page it has no way to render.
 */
async function callerSentAuthorizationHeader(): Promise<boolean> {
  try {
    const headerList = await headers()
    return hasAuthorizationHeader(headerList)
  } catch {
    // No request scope; there is no header and therefore no API client.
    return false
  }
}

/**
 * The narrow slice of the client that `public.my_profile()` needs.
 *
 * The RPC is defined in `0002_rls.sql` (5.1a) but is absent from the generated
 * `Database["public"]["Functions"]` map, so the typed `rpc()` overload does not accept its name.
 * A structural interface is used rather than `as any` so the call site keeps a checked shape.
 */
interface MyProfileRpcClient {
  rpc(fn: "my_profile"): PromiseLike<{
    data: unknown
    error: { message: string; code?: string } | null
  }>
}

/**
 * Resolves the caller's auth user AND their profile row, or `null` when signed out.
 *
 * `getUser()` is used rather than `getSession()` because it revalidates the token against the
 * Auth server; `getSession()` returns whatever is in the cookie, which a client could have
 * forged. This costs one round trip and is the correct trade in a server context. Bearer callers
 * get the same treatment for the same reason: the token is passed to `getUser(token)` so GoTrue
 * checks the signature and the revocation state. Nothing here trusts a JWT payload it decoded
 * itself.
 *
 * The profile lookup then runs on the transport's own client, so it is RLS-filtered as that user
 * whether the session arrived in a cookie or a header.
 *
 * A soft-deleted profile (GDPR Art. 17 erasure) resolves to `null`: the auth user may still
 * technically exist until the retention job hard-deletes it, but the person is gone and must not
 * be able to keep using the app.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  // Both reads hit the same in-memory header bag for this request, so they always agree on which
  // transport is in play; `createRouteClient()` resolves the token again to build the client.
  const bearerToken = await resolveBearerToken()
  const supabase = await createRouteClient()

  let user: User | null = null
  if (bearerToken) {
    // Verified against the Auth server, never decoded and believed. See lib/auth/bearer.ts.
    user = await verifyBearerToken(supabase, bearerToken)
  } else {
    const { data, error } = await supabase.auth.getUser()
    user = error ? null : data.user
  }

  if (!user) return null

  // NOT `select("*")`. 0002_rls.sql revokes table-wide SELECT on public.profiles from
  // `authenticated` and re-grants ten columns; `*` expands past that list, and a column
  // privilege covers a WHERE-clause reference too, so a `deleted_at` predicate is refused as
  // well — the statement would always fail with 42501 and sign everybody out. `my_profile()` is
  // the SECURITY DEFINER accessor for the caller's OWN full row, keyed on auth.uid(), and it
  // already filters soft-deleted rows itself.
  const { data: profileData, error: profileError } = await (
    supabase as unknown as MyProfileRpcClient
  ).rpc("my_profile")

  if (profileError) {
    // A refused or failed read must be visible in the logs, not silently indistinguishable from
    // "signed out".
    // eslint-disable-next-line no-console
    console.error("[rbac] my_profile() failed:", profileError.code, profileError.message)
    return null
  }

  // `returns public.profiles` on a scalar RPC: PostgREST answers with the row object, or `null`
  // when the row is missing or soft-deleted. Some deployments hand back a one-element array
  // instead, so both shapes are accepted rather than one being assumed.
  const profile = (Array.isArray(profileData) ? profileData[0] : profileData) as
    | Tables<"profiles">
    | null
    | undefined

  if (!profile) {
    // Either the `handle_new_user` trigger has not committed yet (a race on the very first
    // request after signup) or the account has been erased. Both are "no usable session".
    return null
  }

  return { user, profile }
}

/**
 * Gate for Server Components, Server Actions and Route Handlers.
 *
 * @param roles roles allowed through. Passing none means "any authenticated user".
 * @returns the session user, narrowed to one of `roles`.
 * @throws {ForbiddenError} when signed in with a role that is not in `roles`.
 *
 * Unauthenticated BROWSER callers are REDIRECTED to `/login?next=…` rather than thrown at,
 * because that is the normal way a logged-out person meets a protected page.
 * `redirect()` throws a `NEXT_REDIRECT` control-flow signal, so nothing after this call runs.
 *
 * An unauthenticated caller that presented an `Authorization` header gets a 401 instead. The
 * mobile app cannot do anything with a 302 to an HTML page; a `UNAUTHENTICATED` body tells it to
 * refresh its token or send the user back to sign-in. `handleRoute()` renders the thrown
 * `ApiRouteError` as the standard `ApiResponse` failure.
 *
 * @example
 * const { profile } = await requireRole('venue_owner', 'admin')
 */
export async function requireRole(...roles: AppRole[]): Promise<SessionUser> {
  const session = await getSessionUser()

  if (!session) {
    if (await callerSentAuthorizationHeader()) {
      throw new ApiRouteError(
        API_ERROR_CODES.UNAUTHENTICATED,
        "Oturumun sona erdi. Devam etmek için tekrar giriş yap.",
        401,
      )
    }
    redirect(`/login?next=${encodeURIComponent(await currentPath())}`)
  }

  if (roles.length === 0) return session

  const role = session.profile.role as AppRole
  if (!roles.includes(role)) {
    throw new ForbiddenError(roles, role)
  }

  return session
}

/**
 * Capability-flavoured sibling of {@link requireRole}: "whoever you are, may you do this?".
 *
 * @throws {ForbiddenError} when the caller's role lacks the capability.
 */
export async function requireCapability(resource: Resource, action: Action): Promise<SessionUser> {
  const session = await requireRole()
  const role = session.profile.role as AppRole

  if (!canAccess(role, resource, action)) {
    throw new ForbiddenError(
      APP_ROLES.filter((candidate) => canAccess(candidate, resource, action)),
      role,
    )
  }

  return session
}
