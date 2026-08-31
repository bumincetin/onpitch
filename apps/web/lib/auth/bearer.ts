/**
 * lib/auth/bearer.ts
 *
 * One identity, two transports.
 *
 * The web app authenticates with the Supabase auth cookies that `@supabase/ssr` writes and
 * `middleware.ts` refreshes. React Native has no cookie jar: the Expo app holds the access token
 * that `supabase.auth.signInWithPassword()` handed it and sends it as
 * `Authorization: Bearer <jwt>`. Both transports carry the SAME Supabase access token, so both
 * resolve to the same `auth.uid()` in Postgres and every policy in `0002_rls.sql` behaves
 * identically. There is no mobile-only authorisation path and no second permission model.
 *
 *   Expo / fetch ──Authorization: Bearer <jwt>──┐
 *                                               ├──► createRouteClient()  (lib/supabase/server.ts)
 *   Browser ──────Cookie: sb-<ref>-auth-token───┘         │
 *                                                         ├─ bearer → supabase-js with the token
 *                                                         │          in global headers, no cookies
 *                                                         └─ cookie → the existing createClient()
 *                                                         │
 *                                          getSessionUser() ──► auth.getUser(token) ──► profiles
 *
 * Three rules this module exists to enforce:
 *
 *  1. A bearer token stays a claim until the Auth server confirms it. {@link verifyBearerToken}
 *     always ends in `supabase.auth.getUser(token)`, which validates the signature, the
 *     audience and the revocation state. No read and no write may be authorised from a locally
 *     decoded payload — until GoTrue answers, a JWT body is attacker-supplied base64.
 *  2. Local decoding may only ever REJECT. {@link decodeUnverifiedClaims} and
 *     {@link isExpiredByUnverifiedClaims} skip the round trip for a token that is already stale
 *     by its own `exp`. They can turn a "yes" into a "no"; they can never turn a "no" into a
 *     "yes", and deleting them would change nothing but latency.
 *  3. Shape is checked before the value goes anywhere near an outbound header. A header is
 *     arbitrary bytes from the network, so {@link extractBearerToken} accepts only a
 *     three-segment compact JWS of sane length — no whitespace, no CR/LF, no megabyte payloads.
 *
 * Tokens are never logged, not even truncated: a Supabase access token is a usable credential for
 * its full hour of life, and log aggregators are read by more people than production is.
 */

import { headers } from "next/headers"
import { z } from "zod"
import type { SupabaseClient, User } from "@supabase/supabase-js"

import type { Database } from "@halisaha/shared/database"

/** Lowercase because `Headers.get()` is case-insensitive but plain object lookups are not. */
export const AUTHORIZATION_HEADER = "authorization"

/**
 * Upper bound on an access token. Supabase tokens run roughly 700-1200 bytes once the custom
 * claims hook has stamped `user_role`, `is_minor` and `parental_consent_status` into them; 8 KB
 * is the usual proxy header limit, so anything past 4 KB is not a token we minted.
 */
const MAX_TOKEN_LENGTH = 4096

/**
 * Compact JWS serialisation: three base64url segments. Rejects the two-segment `alg: none` form
 * outright, along with any value carrying whitespace, CR/LF or a semicolon.
 */
const compactJwtSchema = z
  .string()
  .min(16)
  .max(MAX_TOKEN_LENGTH)
  .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, "not a compact JWS")

/** `Bearer <token>`, per RFC 6750 section 2.1. The scheme is case-insensitive; the token is not. */
const BEARER_PATTERN = /^Bearer[ \t]+(\S+)$/i

/* -------------------------------------------------------------------------- */
/*  Reading the header                                                        */
/* -------------------------------------------------------------------------- */

interface HeaderReader {
  get(name: string): string | null
}

/**
 * Anything that can hand us an `Authorization` value: a `Request`, a `Headers`, the
 * `ReadonlyHeaders` returned by `next/headers` (which is not an instance of `Headers`, hence the
 * structural check below), or the raw header string.
 */
export type BearerSource = Request | Headers | HeaderReader | string | null | undefined

function isHeaderReader(value: unknown): value is HeaderReader {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { get?: unknown }).get === "function"
  )
}

/** A `Request` carries its bag on `.headers`; a `Headers` is the bag. */
function headerBagOf(source: object): unknown {
  const withHeaders = source as { headers?: unknown }
  return withHeaders.headers ?? source
}

function readAuthorizationHeader(source: BearerSource): string | null {
  if (source === null || source === undefined) return null
  if (typeof source === "string") return source.length > 0 ? source : null

  const bag = headerBagOf(source)
  if (!isHeaderReader(bag)) return null

  const value = bag.get(AUTHORIZATION_HEADER)
  return typeof value === "string" && value.length > 0 ? value : null
}

/**
 * True when the caller presented an `Authorization` header of any kind, valid or not.
 *
 * "Is this an API client?" is a different question from "is this token good?". A mobile client
 * holding an expired or corrupt token needs a 401 it can act on, not a redirect to an HTML login
 * page it cannot render. `requireRole()` in `lib/rbac.ts` branches on exactly this.
 */
export function hasAuthorizationHeader(source: BearerSource): boolean {
  return readAuthorizationHeader(source) !== null
}

/**
 * Pulls a syntactically valid bearer token out of an `Authorization` header.
 *
 * @returns the raw compact JWS, or `null` for a missing header, a different scheme (Basic,
 *          Digest), or a value that is not shaped like a JWT. Never throws.
 */
export function extractBearerToken(source: BearerSource): string | null {
  const raw = readAuthorizationHeader(source)
  if (!raw) return null

  const match = BEARER_PATTERN.exec(raw.trim())
  // `noUncheckedIndexedAccess` types the capture as `string | undefined`, and it genuinely is
  // undefined when the pattern did not match. Narrow it rather than asserting it away.
  const candidate = match?.[1]
  if (!candidate) return null

  const parsed = compactJwtSchema.safeParse(candidate)
  return parsed.success ? parsed.data : null
}

/**
 * Resolves the caller's bearer token for the current request.
 *
 * @param request the route handler's `Request`, when you have one. Omitted, the token is read
 *        from the ambient request through `next/headers` — that is what lets `getSessionUser()`
 *        keep its zero-argument signature while gaining mobile support.
 */
export async function resolveBearerToken(request?: Request): Promise<string | null> {
  if (request) return extractBearerToken(request)

  try {
    // `headers()` is synchronous in Next 14; awaiting a non-thenable is a no-op and keeps this
    // call source-compatible with Next 15, matching `createClient()` in lib/supabase/server.ts.
    const headerList = await headers()
    return extractBearerToken(headerList)
  } catch {
    // Outside a request scope (a script, a unit test) there is no header bag and no bearer
    // caller. Callers then fall through to the cookie client, whose `cookies()` call raises the
    // same dynamic-rendering bailout if that is what actually happened here, so nothing is lost.
    return null
  }
}

/* -------------------------------------------------------------------------- */
/*  Unverified claims — a fast path to "no", never to "yes"                    */
/* -------------------------------------------------------------------------- */

export interface UnverifiedBearerClaims {
  /** `auth.users.id`. Present in every token GoTrue mints, and UNVERIFIED here. */
  sub: string | null
  /** Expiry, in seconds since the epoch. */
  exp: number | null
}

const claimsSchema = z.object({
  sub: z.string().uuid().optional(),
  exp: z.number().int().positive().optional(),
})

function base64UrlDecode(segment: string): string {
  const normalised = segment.replace(/-/g, "+").replace(/_/g, "/")
  const padded = normalised.padEnd(normalised.length + ((4 - (normalised.length % 4)) % 4), "=")
  const binary = atob(padded)
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

/**
 * Reads a token's payload WITHOUT verifying its signature.
 *
 * Use it to skip work, never to grant it. Anyone can mint a payload claiming `sub` is somebody
 * else's id; only `supabase.auth.getUser(token)` can say whether GoTrue signed it. Rule 2 in
 * the file header states this function's contract.
 */
export function decodeUnverifiedClaims(token: string): UnverifiedBearerClaims | null {
  const segments = token.split(".")
  const payloadSegment = segments[1]
  if (segments.length !== 3 || !payloadSegment) return null

  try {
    const decoded: unknown = JSON.parse(base64UrlDecode(payloadSegment))
    const parsed = claimsSchema.safeParse(decoded)
    if (!parsed.success) return null
    return { sub: parsed.data.sub ?? null, exp: parsed.data.exp ?? null }
  } catch {
    return null
  }
}

/** Clock skew tolerated before a token counts as stale by its own `exp`. */
const EXPIRY_SKEW_SECONDS = 60

/**
 * True when the token says it expired more than {@link EXPIRY_SKEW_SECONDS} ago.
 *
 * A forged token can lie in either direction, which is precisely why this is only ever consulted
 * to reach "no" sooner. A token that is unparseable or carries no `exp` is reported as not
 * expired, so it still goes to `getUser()` and gets a real answer.
 */
export function isExpiredByUnverifiedClaims(token: string, nowMs: number = Date.now()): boolean {
  const claims = decodeUnverifiedClaims(token)
  if (!claims?.exp) return false
  return claims.exp + EXPIRY_SKEW_SECONDS < Math.floor(nowMs / 1000)
}

/* -------------------------------------------------------------------------- */
/*  Verification — the only function here that produces a User                 */
/* -------------------------------------------------------------------------- */

/**
 * Validates a bearer token against the Supabase Auth server.
 *
 * `getUser(token)` is a network call that checks the signature, the expiry and whether the
 * session has since been revoked — sign-out, password change, admin ban. That last part is why a
 * local signature check would not do: it would happily accept a token whose session was killed a
 * minute ago.
 *
 * @param supabase any anon-key client. The token travels as the `jwt` argument, so the client's
 *        own auth state is irrelevant to the answer.
 * @returns the authenticated user, or `null` for an expired, revoked, forged or foreign-project
 *          token. Never throws, and never reports which: the caller answers 401 either way, and
 *          telling a caller "expired" versus "forged" is a free oracle.
 */
export async function verifyBearerToken(
  supabase: SupabaseClient<Database>,
  token: string,
): Promise<User | null> {
  if (isExpiredByUnverifiedClaims(token)) return null

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser(token)

  if (error || !user) return null
  return user
}
