/**
 * lib/leagues.ts
 *
 * The mobile app's reads for the city leagues.
 *
 * Both go through the Next.js routes rather than through Supabase directly, for the same reason
 * `lib/progress.ts` does: `my_leagues()` WRITES before it reads — it opens the season for every
 * city the caller's teams belong to, so a squad that has not played yet appears in a table rather
 * than nowhere. Putting that behind the route the web app already uses means one definition of
 * "where does my team stand", not two.
 *
 * Payloads are parsed with the schemas from `@halisaha/shared/leagues`, the same ones the server
 * validates against. `apiFetch` verifies the envelope; what is inside it is still the server's
 * claim until something checks it.
 */

import { z } from 'zod'

import {
  leagueTableRowSchema,
  myLeaguesSchema,
  toLeagueStanding,
  type Division,
  type LeagueStanding,
  type MyLeagueEntry,
} from '@halisaha/shared/leagues'

import { apiFetch } from '@/lib/api'
import { DataError } from '@/lib/data-error'

export interface LeagueCity {
  city: string
  seasonId: string
  seasonName: string
  endsOn: string
  teams: number
}

const citySchema = z.object({
  city: z.string(),
  seasonId: z.string().uuid(),
  seasonName: z.string(),
  endsOn: z.string(),
  teams: z.number().int().nonnegative(),
})

const leaguesPayloadSchema = z.object({
  mine: myLeaguesSchema,
  cities: z.array(citySchema),
})

export interface LeaguesPayload {
  mine: MyLeagueEntry[]
  cities: LeagueCity[]
}

export async function loadMyLeagues(): Promise<LeaguesPayload> {
  const raw = await apiFetch<unknown>('/api/leagues')
  const parsed = leaguesPayloadSchema.safeParse(raw)
  if (!parsed.success) {
    throw new DataError('Lig bilgileri bu sürümün okuyamadığı bir biçimde geldi.')
  }
  return parsed.data
}

const tablePayloadSchema = z.object({
  city: z.string(),
  division: z.string(),
  standings: z.array(z.unknown()),
})

export async function loadLeagueTable(
  city: string,
  division: Division,
): Promise<LeagueStanding[]> {
  const params = new URLSearchParams({ city, division })
  const raw = await apiFetch<unknown>(`/api/leagues/table?${params.toString()}`)
  const parsed = tablePayloadSchema.safeParse(raw)
  if (!parsed.success) {
    throw new DataError('Puan durumu bu sürümün okuyamadığı bir biçimde geldi.')
  }

  // A malformed row is dropped rather than blanking the table: a standings page with a gap is
  // still readable, an empty one says nothing.
  const standings: LeagueStanding[] = []
  for (const row of parsed.data.standings) {
    const entry = leagueTableRowSchema.safeParse(row)
    if (entry.success) standings.push(toLeagueStanding(entry.data))
  }
  return standings
}
