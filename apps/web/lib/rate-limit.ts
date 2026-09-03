import "server-only"

import { z } from "zod"

import { fail } from "@/lib/api-response"
import { createRouteClient } from "@/lib/supabase/server"
import { API_ERROR_CODES } from "@onpitch/shared/domain"

/**
 * lib/rate-limit.ts
 *
 * Per-caller request budgets, counted in Postgres.
 *
 * IN THE DATABASE, NOT IN MEMORY. This app runs on serverless instances that do not share a
 * heap, so an in-process counter limits each cold-started lambda separately — which is to say it
 * does not limit anything. `public.consume_rate_limit()` (0010) is one statement against one row,
 * shared by every instance and by the mobile client's traffic alike.
 *
 * The RPC reads `auth.uid()` itself and takes no subject, so a caller cannot spend somebody
 * else's budget or claim to be somebody it is not.
 *
 * FAIL-OPEN, DELIBERATELY. If the limiter itself errors — the database is unreachable, the
 * function is missing on an un-migrated deployment — the request is ALLOWED and the failure is
 * logged. A limiter that fails closed converts a database blip into a total outage of every
 * route it guards, and these limits exist to slow abuse down, not to be the thing standing
 * between a paying customer and their booking. The exception is a limiter guarding something
 * irreversible, which should check the outcome itself rather than relying on this default.
 */

const resultSchema = z.object({
  allowed: z.boolean(),
  limit: z.number().int(),
  remaining: z.number().int(),
  resetAt: z.string(),
  retryAfterSeconds: z.number().int(),
})

export type RateLimitResult = z.infer<typeof resultSchema>

/**
 * The budgets, in one place so they can be read as a policy rather than hunted for.
 *
 * Each is "how often could a person plausibly do this on purpose", rounded up generously. They
 * are not tuned for load; they are tuned so that a runaway client or a script is refused long
 * before it costs anybody money or floods anybody's inbox.
 */
export const RATE_LIMITS = {
  /** Creating a reservation holds a slot and opens a PaymentIntent. */
  checkout: { limit: 8, windowSeconds: 300 },
  /** Cancelling can move money. */
  booking_cancel: { limit: 10, windowSeconds: 600 },
  /** A score report is append-only and cannot be withdrawn. */
  score_report: { limit: 12, windowSeconds: 600 },
  /** A consensus vote is signed and permanent. */
  consensus_vote: { limit: 20, windowSeconds: 600 },
  /** Claiming is cheap, but it is a write and it is worth XP. */
  claim_challenge: { limit: 30, windowSeconds: 300 },
  /** Building a GDPR export walks most of the schema for one person. */
  gdpr_export: { limit: 3, windowSeconds: 3600 },
  /** Adding somebody to a squad emails a stranger. */
  team_invite: { limit: 20, windowSeconds: 3600 },
  /** Creating a match, and creating a team, are both cheap to spam and awkward to clean up. */
  create_match: { limit: 15, windowSeconds: 3600 },
  create_team: { limit: 10, windowSeconds: 3600 },
} as const

export type RateLimitBucket = keyof typeof RATE_LIMITS

/**
 * Spends one unit of the caller's budget for `bucket`.
 *
 * @returns the limiter's answer, or `null` when the limiter itself could not be consulted — see
 *          the fail-open note above. A `null` is not "allowed"; it is "unknown", and callers
 *          treat it as allowed on purpose.
 */
export async function consumeRateLimit(bucket: RateLimitBucket): Promise<RateLimitResult | null> {
  const { limit, windowSeconds } = RATE_LIMITS[bucket]

  try {
    const supabase = await createRouteClient()
    const { data, error } = await supabase.rpc("consume_rate_limit", {
      p_bucket: bucket,
      p_limit: limit,
      p_window_seconds: windowSeconds,
    })

    if (error) {
      // 28000 is the function's own "not authenticated". That is the caller's problem, not the
      // limiter's, and the route's own auth check will already have answered 401 — so it is not
      // logged as an outage.
      if (error.code !== "28000") {
        console.error("[rate-limit] consume failed", { bucket, code: error.code })
      }
      return null
    }

    const parsed = resultSchema.safeParse(data)
    if (!parsed.success) {
      console.error("[rate-limit] unexpected shape", { bucket })
      return null
    }
    return parsed.data
  } catch (caught) {
    console.error("[rate-limit] consume threw", { bucket, caught })
    return null
  }
}

/**
 * The whole guard, for a route that just wants one line at the top.
 *
 * @returns a ready-to-return 429 `Response` when the caller is over budget, or `null` to carry on.
 *
 * @example
 * const limited = await enforceRateLimit("checkout")
 * if (limited) return limited
 */
export async function enforceRateLimit(bucket: RateLimitBucket): Promise<Response | null> {
  const result = await consumeRateLimit(bucket)
  if (!result || result.allowed) return null

  const body = fail(
    API_ERROR_CODES.RATE_LIMITED,
    "Çok fazla deneme yaptın. Biraz bekleyip tekrar dene.",
    429,
    { retryAfterSeconds: result.retryAfterSeconds, resetAt: result.resetAt },
  )

  // `Retry-After` is the header a well-behaved client already honours without being taught to,
  // and the same number is in the body for the ones that do not. The response is rebuilt rather
  // than mutated because a constructed Response's headers are guarded.
  const headers = new Headers(body.headers)
  headers.set("Retry-After", String(result.retryAfterSeconds))
  headers.set("X-RateLimit-Limit", String(result.limit))
  headers.set("X-RateLimit-Remaining", String(result.remaining))
  headers.set("X-RateLimit-Reset", result.resetAt)

  return new Response(body.body, { status: 429, headers })
}
