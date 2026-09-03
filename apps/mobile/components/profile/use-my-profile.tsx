/**
 * components/profile/use-my-profile.tsx
 *
 * The signed-in person's own profile row, in full.
 *
 * WHY THIS EXISTS ALONGSIDE `useProfile()`
 * ----------------------------------------
 * `0002_rls.sql` §4.1 grants `authenticated` SELECT on ten columns of `public.profiles` and no
 * more: id, display_name, full_name, avatar_url, role, city, preferred_position, bio,
 * profile_visibility, created_at. That is a ROLE privilege, so it applies to your own row as well
 * as to strangers', and PostgreSQL checks it per column referenced — in the projection and in the
 * WHERE clause alike. `email`, `date_of_birth`, `is_minor`, `parental_consent_status`,
 * `guardian_*`, `location_sharing_enabled`, `marketing_opt_in` and `deleted_at` are all outside
 * it, which is exactly the point: a table-wide grant would hand every public profile's phone
 * number and Stripe ids to any signed-in user.
 *
 * §5.1a is the owner's way back in. `public.my_profile()` is SECURITY DEFINER, takes no argument
 * and selects on `auth.uid()`, so it can return the caller's whole row and cannot be pointed at
 * anybody else. The settings screens need the withheld columns — a privacy switch cannot render
 * its current position without them — so they read through this hook.
 *
 * THE CAST BELOW, AND WHY IT IS NOT A HOLE
 * ----------------------------------------
 * `my_profile()` is missing from the generated `Database['public']['Functions']` map in
 * @onpitch/shared/database, and this package may not edit that file. `SupabaseClient.rpc()`
 * constrains its first argument to that map, so the call is made through a minimal structural view
 * of the client. The cast buys a call signature and nothing else: the response comes back as
 * `unknown` and is parsed with zod below, so a schema drift or a PostgREST error shape lands as a
 * readable message rather than as a field that is undefined three screens later.
 */

import * as React from 'react'

import { Constants, type Expect, type Tables } from '@onpitch/shared/database'
import { profileVisibilitySchema } from '@onpitch/shared/domain'
import { z } from 'zod'

import { supabase, useSession } from '@/lib/supabase'

/** The columns this app reads off its own profile. A superset of what any one screen needs. */
export const myProfileSchema = z.object({
  id: z.string().uuid(),
  email: z.string().nullable().default(null),
  full_name: z.string().nullable().default(null),
  display_name: z.string().nullable().default(null),
  avatar_url: z.string().nullable().default(null),
  role: z.enum(Constants.public.Enums.app_role),
  date_of_birth: z.string().nullable().default(null),
  is_minor: z.boolean().nullable().default(null),
  parental_consent_status: z.enum(Constants.public.Enums.consent_status),
  parental_consent_at: z.string().nullable().default(null),
  guardian_email: z.string().nullable().default(null),
  guardian_name: z.string().nullable().default(null),
  location_sharing_enabled: z.boolean(),
  // The column is `text` with a CHECK, not an enum, so an unexpected value is possible in
  // principle. Falling back to the most private of the three is the only safe direction.
  profile_visibility: profileVisibilitySchema.catch('private'),
  marketing_opt_in: z.boolean(),
  phone: z.string().nullable().default(null),
  city: z.string().nullable().default(null),
  preferred_position: z.string().nullable().default(null),
  bio: z.string().nullable().default(null),
  // 0011. Parsed leniently: an unknown accent or shot from a newer server falls back rather
  // than failing the whole profile read.
  accent_color: z.string().catch('gold'),
  banner_shot: z.string().catch('stands'),
  tagline: z.string().nullable().default(null),
  jersey_number: z.number().int().nullable().default(null),
  dominant_foot: z.string().nullable().default(null),
  messaging_policy: z.string().catch('teammates'),
  created_at: z.string(),
})

export type MyProfile = z.infer<typeof myProfileSchema>

/**
 * Compile-time proof that every field above names a real `profiles` column. If a migration renames
 * one, this alias stops satisfying its constraint and `tsc` points here rather than at a row that
 * silently parses with a missing field.
 */
type ProfileColumn = keyof Tables<'profiles'>
export type AssertProfileColumns = Expect<keyof MyProfile extends ProfileColumn ? true : never>

/** The narrow slice of the Supabase client this module needs. See the header comment. */
interface MyProfileRpcClient {
  rpc(
    fn: 'my_profile',
  ): PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>
}

export interface MyProfileState {
  profile: MyProfile | null
  loading: boolean
  error: string | null
  /** Re-reads the row. Call after any write that changes it. */
  refresh: () => Promise<void>
  /**
   * Replaces a field locally after a committed write, so a switch does not have to wait for a
   * round trip to look right. Never call it for a write that failed.
   */
  patch: (next: Partial<MyProfile>) => void
}

async function readMyProfile(): Promise<MyProfile | null> {
  const client = supabase as unknown as MyProfileRpcClient
  const { data, error } = await client.rpc('my_profile')

  if (error) {
    throw new Error(
      // 42883 is Postgres' "function does not exist"; PGRST202 is PostgREST failing to find it
      // in its schema cache. Both mean the same thing to a user: the migrations are not applied.
      error.code === '42883' || error.code === 'PGRST202'
        ? 'This build is talking to a database that predates my_profile(). Apply the migrations in supabase/migrations.'
        : error.message || 'Could not read your profile.',
    )
  }

  // `returns public.profiles` on a scalar RPC: PostgREST answers with the row object, or `null`
  // when the row is soft-deleted or missing. Some deployments hand back a one-element array
  // instead, so both shapes are accepted rather than one being assumed.
  const row = Array.isArray(data) ? (data.length > 0 ? data[0] : null) : data
  if (row === null || row === undefined) return null

  const parsed = myProfileSchema.safeParse(row)
  if (!parsed.success) {
    throw new Error('Your profile came back in a shape this version of the app does not understand.')
  }
  return parsed.data
}

/**
 * Reads the caller's own profile, including the columns the SELECT grant withholds.
 *
 * @example
 * const { profile, loading, error, refresh } = useMyProfile()
 */
export function useMyProfile(): MyProfileState {
  const { user } = useSession()
  const userId = user?.id ?? null

  const [profile, setProfile] = React.useState<MyProfile | null>(null)
  const [loading, setLoading] = React.useState(userId !== null)
  const [error, setError] = React.useState<string | null>(null)

  // Guards against an out-of-order response: sign out and back in as somebody else quickly enough
  // and the first read can land after the second.
  const readIdRef = React.useRef(0)

  const load = React.useCallback(async (id: string | null): Promise<void> => {
    const readId = ++readIdRef.current

    if (id === null) {
      setProfile(null)
      setError(null)
      setLoading(false)
      return
    }

    setLoading(true)
    try {
      const row = await readMyProfile()
      if (readIdRef.current !== readId) return
      setProfile(row)
      setError(row === null ? 'We could not find your profile. It may have been erased.' : null)
    } catch (caught) {
      if (readIdRef.current !== readId) return
      setProfile(null)
      setError(caught instanceof Error ? caught.message : 'Profilin okunamadı.')
    } finally {
      if (readIdRef.current === readId) setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load(userId)
  }, [load, userId])

  const refresh = React.useCallback(async (): Promise<void> => {
    await load(userId)
  }, [load, userId])

  const patch = React.useCallback((next: Partial<MyProfile>): void => {
    setProfile((current) => (current === null ? current : { ...current, ...next }))
  }, [])

  return { profile, loading, error, refresh, patch }
}

/** The name to show for a profile, in the order a person would expect it. */
export function displayNameOf(
  profile: { display_name?: string | null; full_name?: string | null } | null,
  fallback = 'Player',
): string {
  const display = profile?.display_name?.trim()
  if (display) return display
  const full = profile?.full_name?.trim()
  if (full) return full
  return fallback
}
