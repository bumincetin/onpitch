/**
 * GET /api/leaderboard — a page of the ranking.
 *
 * Open to signed-out callers on purpose: a ranking nobody can see before signing up is a
 * ranking that recruits nobody. `leaderboard_page()` decides what is publishable — public,
 * non-deleted, non-minor profiles that have played at least once — so this handler adds no
 * filtering of its own and has none to get wrong.
 *
 * Note what that means for the caller: a player whose profile is private is absent from every
 * scope, including their own request. The dashboard says so rather than showing them an empty
 * table and letting them wonder.
 */

import { z } from "zod"

import { fail, handleRoute, ok } from "@/lib/api-response"
import { loadLeaderboard } from "@/lib/progress"
import { API_ERROR_CODES } from "@onpitch/shared/domain"
import { LEADERBOARD_SCOPES, type LeaderboardEntry } from "@onpitch/shared/gamification"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const MAX_LIMIT = 100

const querySchema = z.object({
  scope: z.enum(LEADERBOARD_SCOPES).default("xp"),
  // Trimmed and length-capped: it goes into an equality predicate, not a LIKE, so this is
  // about keeping the query sane rather than about injection.
  city: z.string().trim().min(1).max(80).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(25),
  offset: z.coerce.number().int().min(0).max(5000).default(0),
})

export interface LeaderboardPayload {
  scope: string
  city: string | null
  entries: LeaderboardEntry[]
}

export async function GET(request: Request): Promise<Response> {
  return handleRoute<LeaderboardPayload>(async () => {
    const url = new URL(request.url)
    const parsed = querySchema.safeParse({
      scope: url.searchParams.get("scope") ?? undefined,
      city: url.searchParams.get("city") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
      offset: url.searchParams.get("offset") ?? undefined,
    })

    if (!parsed.success) {
      return fail(
        API_ERROR_CODES.VALIDATION_FAILED,
        `scope must be one of ${LEADERBOARD_SCOPES.join(", ")}, limit 1-${MAX_LIMIT}.`,
        422,
      )
    }

    const { scope, city, limit, offset } = parsed.data
    const entries = await loadLeaderboard({ scope, city: city ?? null, limit, offset })

    return ok<LeaderboardPayload>({ scope, city: city ?? null, entries })
  })
}
