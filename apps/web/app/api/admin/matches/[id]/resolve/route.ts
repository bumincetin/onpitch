/**
 * POST /api/admin/matches/[id]/resolve
 *
 * The end of the line for a result the players could not settle: an admin writes the official
 * score, or voids the fixture.
 *
 * This handler is transport only — parse, authorise, delegate, serialise. The ruling itself is
 * `applyMatchRuling` in `@/lib/admin/metrics`, which the Server Action behind the form on
 * `/admin/matches/[id]` also calls. Two entry points, one implementation, so the
 * audit-before-mutate ordering cannot drift between them. The order and its reasoning are
 * documented at that function.
 *
 * `requireRole('admin')` runs here even though `middleware.ts` guards `/admin/*`: the matcher
 * tests the literal prefix `/admin`, which `/api/admin/...` does not match, so this URL is
 * reachable directly by anyone with a session. The middleware also decides on a JWT claim that
 * can be an hour stale, while `requireRole` re-reads the profile row.
 */

import { z } from "zod"

import { fail, handleRoute, ok } from "@/lib/api-response"
import { requireRole } from "@/lib/rbac"
import { createClient } from "@/lib/supabase/server"
import { applyMatchRuling, type MatchRulingApplied } from "@/lib/admin/metrics"
import { API_ERROR_CODES } from "@onpitch/shared/domain"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Same ceiling `validate_score_report` enforces on a player-filed report. */
const MAX_GOALS = 30

const resolveSchema = z
  .object({
    outcome: z.enum(["finalize", "void"]),
    homeScore: z.number().int().min(0).max(MAX_GOALS).optional(),
    awayScore: z.number().int().min(0).max(MAX_GOALS).optional(),
    reason: z
      .string()
      .trim()
      .min(10, "Give a reason of at least 10 characters — it goes into the audit trail.")
      .max(1000, "Keep the reason under 1000 characters."),
    /**
     * Required once the match is already finalised. A client learns it needs this from the 409
     * below, which carries the scoreline currently on the record.
     */
    acknowledgeOverwrite: z.boolean().optional(),
  })
  .superRefine((value, context) => {
    if (value.outcome !== "finalize") return
    if (value.homeScore === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["homeScore"], message: "Zorunlu." })
    }
    if (value.awayScore === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["awayScore"], message: "Zorunlu." })
    }
  })

export type MatchResolutionResponse = MatchRulingApplied

export async function POST(
  request: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  return handleRoute<MatchResolutionResponse>(async () => {
    const { user } = await requireRole("admin")

    const matchId = params.id
    if (!UUID_PATTERN.test(matchId)) {
      return fail(API_ERROR_CODES.VALIDATION_FAILED, "Geçersiz maç referansı.", 422)
    }

    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      return fail(API_ERROR_CODES.VALIDATION_FAILED, "JSON gövdesi gönder.", 422)
    }

    const parsed = resolveSchema.safeParse(rawBody)
    if (!parsed.success) {
      return fail(API_ERROR_CODES.VALIDATION_FAILED, "Karar geçersizdi.", 422, {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      })
    }

    const supabase = await createClient()
    const result = await applyMatchRuling({
      supabase,
      actorId: user.id,
      matchId,
      outcome: parsed.data.outcome,
      homeScore: parsed.data.homeScore,
      awayScore: parsed.data.awayScore,
      reason: parsed.data.reason,
      acknowledgeOverwrite: parsed.data.acknowledgeOverwrite,
    })

    if (result.status === "not_found") {
      return fail(API_ERROR_CODES.NOT_FOUND, "Böyle bir maç yok.", 404)
    }

    if (result.status === "needs_acknowledgement") {
      return fail(API_ERROR_CODES.REPORT_REJECTED, result.message, 409, {
        requiresAcknowledgement: true,
        currentStatus: result.currentStatus,
        currentScore: result.currentScore,
        ratingsAlreadyApplied: result.ratingsAlreadyApplied,
        consensusDecision: result.consensusDecision,
      })
    }

    if (result.status === "failed") {
      return fail(API_ERROR_CODES.INTERNAL, result.message, 500, { stage: result.stage })
    }

    return ok<MatchResolutionResponse>(result)
  })
}
