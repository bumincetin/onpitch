/**
 * lib/progress.ts
 *
 * The mobile app's reads for the progression system.
 *
 * Everything goes through `/api/progress`, `/api/leaderboard` and `/api/challenges/:id/claim`
 * rather than through Supabase directly. That is not the usual choice in this app — the match
 * list, for instance, reads tables straight under RLS — and the reason it is right here is that
 * `my_progress()` WRITES before it reads: it opens the week's challenges and captures the
 * caller's baseline. Putting that behind the same route the web dashboard uses means there is
 * one definition of "a player's progress", and the phone cannot end up with a different one.
 *
 * The payload is parsed with the schemas from `@onpitch/shared/gamification`, the same ones the
 * server validates against. `apiFetch` verifies the envelope; what is inside it is still the
 * server's claim until something checks it.
 */

import { z } from 'zod'

import {
  leaderboardRowSchema,
  playerProgressSchema,
  toLeaderboardEntry,
  type LeaderboardEntry,
  type LeaderboardScope,
  type PlayerProgress,
} from '@onpitch/shared/gamification'

import { apiFetch } from '@/lib/api'
import { DataError } from '@/lib/data-error'

/* ========================================================================== */
/*  Progress                                                                  */
/* ========================================================================== */

const formResultSchema = z.enum(['win', 'draw', 'loss'])
export type FormResult = z.infer<typeof formResultSchema>

const nextFixtureSchema = z.object({
  matchId: z.string().uuid(),
  kickoffAt: z.string(),
  durationMinutes: z.number().int(),
  status: z.string(),
  venueName: z.string().nullable(),
  city: z.string().nullable(),
  timezone: z.string().nullable(),
  side: z.enum(['home', 'away']).nullable(),
  isConfirmed: z.boolean(),
})
export type NextFixture = z.infer<typeof nextFixtureSchema>

const progressPayloadSchema = z.object({
  progress: playerProgressSchema,
  form: z.array(formResultSchema),
  nextFixture: nextFixtureSchema.nullable(),
})

export interface ProgressPayload {
  progress: PlayerProgress
  form: FormResult[]
  nextFixture: NextFixture | null
}

export async function loadProgress(): Promise<ProgressPayload> {
  const raw = await apiFetch<unknown>('/api/progress')
  const parsed = progressPayloadSchema.safeParse(raw)

  if (!parsed.success) {
    throw new DataError(
      'İlerlemen bu sürümün okuyamadığı bir biçimde geldi. Uygulamayı güncellemen gerekebilir.',
    )
  }

  return parsed.data
}

/* ========================================================================== */
/*  Leaderboard                                                               */
/* ========================================================================== */

const leaderboardPayloadSchema = z.object({
  scope: z.string(),
  city: z.string().nullable(),
  entries: z.array(z.unknown()),
})

export interface LeaderboardQuery {
  scope?: LeaderboardScope
  city?: string | null
  limit?: number
}

export async function loadLeaderboard(query: LeaderboardQuery = {}): Promise<LeaderboardEntry[]> {
  const params = new URLSearchParams()
  if (query.scope) params.set('scope', query.scope)
  if (query.city) params.set('city', query.city)
  params.set('limit', String(query.limit ?? 25))

  const raw = await apiFetch<unknown>(`/api/leaderboard?${params.toString()}`)
  const parsed = leaderboardPayloadSchema.safeParse(raw)
  if (!parsed.success) {
    throw new DataError('Sıralama bu sürümün okuyamadığı bir biçimde geldi.')
  }

  // One malformed row is dropped rather than blanking the table. A ranking with a gap is still
  // a useful ranking; an empty one tells the reader nothing.
  const entries: LeaderboardEntry[] = []
  for (const row of parsed.data.entries) {
    const entry = leaderboardRowSchema.safeParse(row)
    if (entry.success) entries.push(toLeaderboardEntry(entry.data))
  }
  return entries
}

/* ========================================================================== */
/*  Claiming                                                                  */
/* ========================================================================== */

const claimResultSchema = z.object({
  claimed: z.boolean(),
  xp: z.number().int(),
  code: z.string().optional(),
})

export interface ClaimResult {
  claimed: boolean
  xp: number
}

/**
 * Collects a completed challenge's reward.
 *
 * `claimed: false` is a normal answer, not an error: it means the reward was already taken —
 * most likely by this person on another device — or the challenge is not finished. The caller
 * reconciles rather than showing a failure.
 */
export async function claimChallenge(challengeId: string): Promise<ClaimResult> {
  const raw = await apiFetch<unknown>(`/api/challenges/${challengeId}/claim`, { method: 'POST' })
  const parsed = claimResultSchema.safeParse(raw)
  if (!parsed.success) {
    throw new DataError('Ödül alındı ama sunucunun yanıtı okunamadı. Sayfayı yenile.')
  }
  return { claimed: parsed.data.claimed, xp: parsed.data.xp }
}
