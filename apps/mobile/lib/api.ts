/**
 * lib/api.ts
 *
 * The only way this app talks to `/api/**` on the Next.js server.
 *
 * Every route handler over there answers with the `ApiResponse<T>` envelope from
 * @onpitch/shared/domain: `{ ok: true, data }` or `{ ok: false, error: { code, message } }`.
 * `apiFetch` unwraps the success case and throws `ApiError` for the failure case, so a caller
 * writes the happy path and catches once, instead of branching on `ok` at every call site.
 *
 * The envelope itself is parsed with zod, not asserted (docs/SECURITY.md §2). A 500 that returns
 * an HTML error page, a proxy that injects a captive-portal login, a route that regresses and
 * returns a bare object — all of those become one `ApiError` with a readable message rather than
 * a `Cannot read property 'x' of undefined` three screens later.
 */

import { API_ERROR_CODES } from '@onpitch/shared/domain'
import { z } from 'zod'

import { env } from '@/lib/env'
import { supabase } from '@/lib/supabase'

/** A route handler answered `{ ok: false }`, or the request never produced a valid envelope. */
export class ApiError extends Error {
  /** One of `API_ERROR_CODES`, or a forward-compatible code a newer server introduced. */
  readonly code: string
  /** HTTP status. 0 when the request failed before a response existed (offline, DNS, timeout). */
  readonly status: number
  /** `ApiError.details` from the envelope — usually zod's `fieldErrors`. Null when absent. */
  readonly details: unknown

  constructor(code: string, message: string, status: number, details: unknown = null) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
    this.details = details
    // Hermes runs the class down-level in some release configurations; without this,
    // `err instanceof ApiError` returns false in exactly the build that is hardest to debug.
    Object.setPrototypeOf(this, ApiError.prototype)
  }
}

/** True when `error` is an `ApiError` carrying this code. Narrows in a catch block. */
export function isApiError(error: unknown, code?: string): error is ApiError {
  return error instanceof ApiError && (code === undefined || error.code === code)
}

const apiErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  details: z.unknown().optional(),
})

const envelopeSchema = z.union([
  z.object({ ok: z.literal(true), data: z.unknown() }),
  z.object({ ok: z.literal(false), error: apiErrorSchema }),
])

/** Long enough for a cold Stripe call on a slow connection, short enough to not look frozen. */
const DEFAULT_TIMEOUT_MS = 20_000

export interface ApiFetchOptions extends RequestInit {
  /** Aborts the request after this many milliseconds. Defaults to 20s; pass 0 to disable. */
  timeoutMs?: number
  /** Serialised as the JSON body, with the content-type header set. Ignored if `body` is given. */
  json?: unknown
  /** Skip the Authorization header. Nothing in the API is anonymous today. */
  anonymous?: boolean
}

/**
 * Calls a route handler and returns its `data` payload.
 *
 * @param path Absolute path on the API origin, starting with `/` — e.g. `/api/matches`.
 * @throws {ApiError} on a non-2xx status, an `ok: false` envelope, a malformed body, a timeout,
 *   or (unless `anonymous`) a missing session.
 *
 * @example
 * const quote = await apiFetch<CheckoutResult>('/api/bookings/checkout', {
 *   method: 'POST',
 *   json: { pitchId, startsAt, endsAt },
 * })
 */
export async function apiFetch<T>(path: string, init: ApiFetchOptions = {}): Promise<T> {
  if (!path.startsWith('/')) {
    throw new ApiError(
      API_ERROR_CODES.INTERNAL,
      `apiFetch expects a path beginning with "/", received ${JSON.stringify(path)}.`,
      0,
    )
  }

  const { timeoutMs = DEFAULT_TIMEOUT_MS, json, anonymous = false, ...requestInit } = init

  const headers = new Headers(requestInit.headers)
  headers.set('Accept', 'application/json')

  let body = requestInit.body
  if (body === undefined && json !== undefined) {
    body = JSON.stringify(json)
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  }

  if (!anonymous) {
    headers.set('Authorization', `Bearer ${await accessToken()}`)
  }

  // A caller-supplied signal and the timeout both have to be able to abort the request.
  const controller = new AbortController()
  const callerSignal = requestInit.signal ?? null
  const onCallerAbort = (): void => controller.abort()
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort()
    else callerSignal.addEventListener('abort', onCallerAbort)
  }
  const timer =
    timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null

  let response: Response
  try {
    response = await fetch(`${env.apiUrl}${path}`, {
      ...requestInit,
      body,
      headers,
      signal: controller.signal,
    })
  } catch (caught) {
    if (controller.signal.aborted && !(callerSignal?.aborted ?? false)) {
      throw new ApiError(
        API_ERROR_CODES.INTERNAL,
        'That took too long. Check your connection and try again.',
        0,
      )
    }
    throw new ApiError(
      API_ERROR_CODES.INTERNAL,
      caught instanceof Error && caught.message
        ? `Could not reach the server: ${caught.message}`
        : 'Could not reach the server.',
      0,
    )
  } finally {
    if (timer !== null) clearTimeout(timer)
    if (callerSignal) callerSignal.removeEventListener('abort', onCallerAbort)
  }

  const raw = await response.text()

  let parsedJson: unknown
  try {
    parsedJson = raw.length > 0 ? (JSON.parse(raw) as unknown) : null
  } catch {
    throw new ApiError(
      API_ERROR_CODES.INTERNAL,
      httpFallbackMessage(response.status),
      response.status,
    )
  }

  const envelope = envelopeSchema.safeParse(parsedJson)
  if (!envelope.success) {
    throw new ApiError(
      API_ERROR_CODES.INTERNAL,
      httpFallbackMessage(response.status),
      response.status,
    )
  }

  if (!envelope.data.ok) {
    const { code, message, details } = envelope.data.error
    throw new ApiError(code, message, response.status, details ?? null)
  }

  // The one unchecked widening in the app. `T` is the caller's claim about a payload the server
  // owns: the envelope around it has been verified, the payload itself has not. When the shape
  // matters — money, ids you are about to write back — re-parse it with a zod schema from
  // @onpitch/shared/domain rather than trusting this line.
  return envelope.data.data as T
}

/** The current access token, or an `ApiError` the UI can turn into "sign in again". */
async function accessToken(): Promise<string> {
  const { data, error } = await supabase.auth.getSession()

  if (error) {
    throw new ApiError(
      API_ERROR_CODES.UNAUTHENTICATED,
      'Your session could not be read. Sign in again.',
      401,
    )
  }

  const token = data.session?.access_token
  if (!token) {
    throw new ApiError(API_ERROR_CODES.UNAUTHENTICATED, 'Sign in to continue.', 401)
  }

  return token
}

function httpFallbackMessage(status: number): string {
  if (status === 401) return 'Your session has expired. Sign in again.'
  if (status === 403) return 'You do not have access to that.'
  if (status === 404) return 'That is not there any more.'
  if (status === 429) return 'Too many requests. Give it a moment and try again.'
  if (status >= 500) return 'The server had a problem. Try again shortly.'
  return `The server returned an unexpected response (HTTP ${status}).`
}
