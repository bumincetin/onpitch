/**
 * POST /api/challenges/[id]/claim — collect the XP for a completed weekly challenge.
 *
 * The whole transaction is `public.claim_challenge()`. It reads `auth.uid()` itself, and the
 * UPDATE that flips `claimed_at` from NULL is the lock: two taps on a slow connection award
 * once, because only the statement that actually changed the row goes on to call `award_xp`.
 * Burada bir şey yok needs to serialise anything.
 *
 * `claimed: false` is a 200, not an error. It means the reward was already collected or the
 * challenge is not finished — both of which are things a client can render, and neither of
 * which is a failure worth an error banner.
 */

import { z } from "zod"

import { fail, handleRoute, ok } from "@/lib/api-response"
import { getSessionUser } from "@/lib/rbac"
import { createRouteClient } from "@/lib/supabase/server"
import { enforceRateLimit } from "@/lib/rate-limit"
import { API_ERROR_CODES } from "@onpitch/shared/domain"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const idSchema = z.string().uuid()

/** What `claim_challenge()` answers with, once past the `jsonb` opacity. */
const claimResultSchema = z.object({
  claimed: z.boolean(),
  xp: z.number().int(),
  code: z.string().optional(),
})

export interface ClaimResult {
  claimed: boolean
  xp: number
  code?: string
}

export async function POST(
  request: Request,
  context: { params: { id: string } },
): Promise<Response> {
  return handleRoute<ClaimResult>(async () => {
    const session = await getSessionUser()
    if (!session) {
      return fail(API_ERROR_CODES.UNAUTHENTICATED, "Ödül almak için giriş yap.", 401)
    }

    // Budgets are counted in Postgres, not in this process — see lib/rate-limit.ts.
    const limited = await enforceRateLimit("claim_challenge")
    if (limited) return limited

    const parsedId = idSchema.safeParse(context.params.id)
    if (!parsedId.success) {
      return fail(API_ERROR_CODES.VALIDATION_FAILED, "Bu görev kimliği geçersiz.", 422)
    }

    // `createRouteClient`, not `createClient`: the Expo app authenticates with a bearer token
    // and `claim_challenge()` reads `auth.uid()` itself, so a cookie-only client would claim
    // the reward as `anon` — which is to say, raise 28000 and claim nothing.
    const supabase = await createRouteClient(request)
    const { data, error } = await supabase.rpc("claim_challenge", {
      p_challenge_id: parsedId.data,
    })

    if (error) {
      // P0002 is the function's own "no such challenge". Everything else is ours.
      if (error.code === "P0002") {
        return fail(API_ERROR_CODES.NOT_FOUND, "Bu görev artık mevcut değil.", 404)
      }
      console.error("[challenges] claim failed", { code: error.code })
      return fail(API_ERROR_CODES.INTERNAL, "Bu ödül alınamadı.", 500)
    }

    const parsed = claimResultSchema.safeParse(data)
    if (!parsed.success) {
      console.error("[challenges] claim returned an unexpected shape")
      return fail(API_ERROR_CODES.INTERNAL, "Bu ödül alınamadı.", 500)
    }

    return ok<ClaimResult>(parsed.data)
  })
}
