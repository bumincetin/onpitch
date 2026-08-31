/**
 * GET /api/progress — the caller's progression state.
 *
 * The web dashboard reads `my_progress()` directly from a Server Component; this route exists
 * for the Expo app, which has no server rendering and would otherwise have to know the RPC
 * name, its argument shape and its privacy rules. Both transports land on the same function,
 * so there is exactly one definition of "what a player's progress is".
 *
 * No authorisation logic lives here. `my_progress()` reads `auth.uid()` itself and takes no
 * arguments, which means there is nothing a caller could point at somebody else — the worst a
 * forged request achieves is reading its own row.
 */

import { fail, handleRoute, ok } from "@/lib/api-response"
import { getSessionUser } from "@/lib/rbac"
import { loadMyProgress, loadNextFixture, loadRecentForm } from "@/lib/progress"
import { API_ERROR_CODES } from "@halisaha/shared/domain"
import type { PlayerProgress } from "@halisaha/shared/gamification"
import type { FormResult, NextFixture } from "@/lib/progress"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export interface ProgressPayload {
  progress: PlayerProgress
  form: FormResult[]
  nextFixture: NextFixture | null
}

export async function GET(): Promise<Response> {
  return handleRoute<ProgressPayload>(async () => {
    const session = await getSessionUser()
    if (!session) {
      return fail(API_ERROR_CODES.UNAUTHENTICATED, "Gelişimini görmek için giriş yap.", 401)
    }

    // Three independent reads. Sequential would put the slowest phone on three round trips
    // for a screen that is the app's home.
    const [progress, form, nextFixture] = await Promise.all([
      loadMyProgress(),
      loadRecentForm(session.user.id),
      loadNextFixture(session.user.id),
    ])

    if (!progress) {
      return fail(API_ERROR_CODES.INTERNAL, "Gelişimin yüklenemedi.", 500)
    }

    return ok<ProgressPayload>({ progress, form: form.results, nextFixture })
  })
}
