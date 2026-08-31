/**
 * lib/supabase.ts
 *
 * The one Supabase client in the app, plus the session context every screen reads.
 *
 * WHY ASYNCSTORAGE AND NOT SECURESTORE
 * ------------------------------------
 * gotrue persists the whole session object — access token, refresh token, user payload — as one
 * JSON string. expo-secure-store is the wrong home for it on three counts:
 *
 *   * Size. SecureStore refuses values over 2048 bytes on Android. A Supabase session with a
 *     populated `user_metadata` clears that easily, the write fails, and the user is silently
 *     signed out on the next launch.
 *   * Shape. Supabase's storage adapter is async, which SecureStore satisfies — but it puts a
 *     Keychain round trip on every token refresh, every hour, for a value that is re-read on
 *     every request.
 *   * Threat model. The refresh token is a rotating bearer credential, not a long-lived secret:
 *     it changes on every refresh and the server can revoke it. AsyncStorage already sits inside
 *     the app sandbox, which is the boundary that matters for it.
 *
 * expo-secure-store stays configured in app.json for values that ARE long-lived secrets — the
 * device signing key behind `ConsensusApprovalInput.signature`, when that ships. Nothing writes to
 * it yet, and for the reasons above the session is not what should change that.
 */

// Must come before anything that touches a URL. supabase-js parses the project URL and builds
// query strings with `URL` and `URLSearchParams`, and Hermes ships neither.
import 'react-native-url-polyfill/auto'

import AsyncStorage from '@react-native-async-storage/async-storage'
import { createClient, type Session, type SupabaseClient, type User } from '@supabase/supabase-js'
import * as React from 'react'
import { AppState, type AppStateStatus } from 'react-native'

import type { Database, Tables } from '@halisaha/shared/database'

import { env } from '@/lib/env'

export type Profile = Tables<'profiles'>

export const supabase: SupabaseClient<Database> = createClient<Database>(
  env.supabaseUrl,
  env.supabaseAnonKey,
  {
    auth: {
      storage: AsyncStorage,
      autoRefreshToken: true,
      persistSession: true,
      // There is no URL bar to read a token out of. Leaving this on makes gotrue inspect
      // `window.location`, which does not exist here.
      detectSessionInUrl: false,
      flowType: 'pkce',
    },
    global: {
      headers: { 'x-client-info': 'halisaha-mobile' },
    },
  },
)

/* -------------------------------------------------------------------------- */
/*  Token refresh follows the app lifecycle                                    */
/* -------------------------------------------------------------------------- */

/**
 * gotrue's refresh timer is an interval. iOS and Android suspend timers for a backgrounded app, so
 * the refresh due at minute 55 fires late, hits an expired token, and drops the user on a
 * signed-out screen after they switch back from another app. Stopping the loop on background and
 * starting it on foreground turns the resume path into a single deliberate refresh.
 */
let autoRefreshRunning = false

function syncAutoRefresh(state: AppStateStatus): void {
  const shouldRun = state === 'active'
  if (shouldRun === autoRefreshRunning) return
  autoRefreshRunning = shouldRun
  if (shouldRun) {
    void supabase.auth.startAutoRefresh()
  } else {
    void supabase.auth.stopAutoRefresh()
  }
}

syncAutoRefresh(AppState.currentState)
AppState.addEventListener('change', syncAutoRefresh)

/* -------------------------------------------------------------------------- */
/*  Session context                                                            */
/* -------------------------------------------------------------------------- */

export interface SessionValue {
  session: Session | null
  user: User | null
  /**
   * The caller's own `profiles` row, or null while signed out. Read through `my_profile()`, which
   * is keyed on `auth.uid()`, so the database is what scopes it — there is nothing to pass in.
   */
  profile: Profile | null
  /** True until the stored session AND the first profile read have both settled. */
  loading: boolean
  /** Set when the profile read failed. The session is still usable; the row just is not loaded. */
  profileError: string | null
  /** Re-read the profile row. Call after any write that changes it. */
  refresh: () => Promise<void>
  signOut: () => Promise<void>
}

const SessionContext = React.createContext<SessionValue | null>(null)

interface ProfileRead {
  profile: Profile | null
  error: string | null
}

/**
 * The narrow slice of the Supabase client this module needs.
 *
 * `my_profile()` is missing from the generated `Database['public']['Functions']` map in
 * @halisaha/shared/database, and this package may not edit that file, so the call is made through a
 * minimal structural view of the client. See components/profile/use-my-profile.tsx for the longer
 * version of this note.
 */
interface MyProfileRpcClient {
  rpc(fn: 'my_profile'): PromiseLike<{ data: unknown; error: { message: string } | null }>
}

/**
 * The caller's own row, in full.
 *
 * Deliberately NOT a `from('profiles').select(...)`. `0002_rls.sql` §4.1 grants `authenticated`
 * SELECT on ten columns of `public.profiles` and no more, and PostgreSQL checks that privilege for
 * every column referenced — in the projection and in the WHERE clause alike. `email`, `is_minor`,
 * `parental_consent_status` and `location_sharing_enabled`, all of which this session profile's
 * consumers read, sit outside that grant, so a direct table read is a guaranteed 42501 for every
 * signed-in user. §5.1a's `public.my_profile()` runs as the table owner instead: SECURITY
 * DEFINER, no argument, selecting on `auth.uid()`. It is scoped to the caller and already returns no
 * row for a soft-deleted profile, which is why neither an id filter nor a `deleted_at` filter
 * appears here.
 */
async function fetchProfile(): Promise<ProfileRead> {
  const client = supabase as unknown as MyProfileRpcClient
  const { data, error } = await client.rpc('my_profile')

  if (error) return { profile: null, error: error.message || 'Could not load your profile.' }

  // `returns public.profiles` on a scalar RPC: PostgREST answers with the row object, or `null`
  // when the row is soft-deleted or missing. Some deployments hand back a one-element array
  // instead, so both shapes are accepted rather than one being assumed.
  const row: unknown = Array.isArray(data) ? (data.length > 0 ? data[0] : null) : data
  if (row === null || row === undefined) return { profile: null, error: null }
  return { profile: row as Profile, error: null }
}

/**
 * Owns the session for the whole app. Mounted once, in `app/_layout.tsx`, above the navigator.
 */
export function SessionProvider({ children }: React.PropsWithChildren): React.ReactElement {
  const [session, setSession] = React.useState<Session | null>(null)
  const [sessionResolved, setSessionResolved] = React.useState(false)
  const [profile, setProfile] = React.useState<Profile | null>(null)
  const [profileResolved, setProfileResolved] = React.useState(false)
  const [profileError, setProfileError] = React.useState<string | null>(null)

  const userId = session?.user.id ?? null

  React.useEffect(() => {
    let active = true

    supabase.auth
      .getSession()
      .then(({ data }) => {
        if (active) setSession(data.session)
      })
      .catch(() => {
        // Treat an unreadable store as a signed-out app rather than a crash.
        if (active) setSession(null)
      })
      .finally(() => {
        if (active) setSessionResolved(true)
      })

    // This callback runs inside gotrue's own lock. Awaiting anything in here deadlocks the next
    // auth call, so it only sets state; the profile read happens in the effect below.
    const { data: subscription } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next)
      setSessionResolved(true)
    })

    return () => {
      active = false
      subscription.subscription.unsubscribe()
    }
  }, [])

  // Guards against an out-of-order response overwriting a newer one: sign out and back in as a
  // different user quickly enough and the first read can land after the second.
  const readIdRef = React.useRef(0)

  const loadProfile = React.useCallback(async (id: string | null): Promise<void> => {
    const readId = ++readIdRef.current

    if (id === null) {
      setProfile(null)
      setProfileError(null)
      setProfileResolved(true)
      return
    }

    setProfileResolved(false)
    try {
      const result = await fetchProfile()
      if (readIdRef.current !== readId) return
      setProfile(result.profile)
      setProfileError(result.error)
    } catch (caught) {
      if (readIdRef.current !== readId) return
      setProfile(null)
      setProfileError(caught instanceof Error ? caught.message : 'Profilin yüklenemedi.')
    } finally {
      if (readIdRef.current === readId) setProfileResolved(true)
    }
  }, [])

  React.useEffect(() => {
    void loadProfile(userId)
  }, [userId, loadProfile])

  const refresh = React.useCallback(async (): Promise<void> => {
    await loadProfile(userId)
  }, [loadProfile, userId])

  const signOut = React.useCallback(async (): Promise<void> => {
    await supabase.auth.signOut()
    setSession(null)
    setProfile(null)
    setProfileError(null)
  }, [])

  const value = React.useMemo<SessionValue>(
    () => ({
      session,
      user: session?.user ?? null,
      profile,
      loading: !sessionResolved || !profileResolved,
      profileError,
      refresh,
      signOut,
    }),
    [session, profile, sessionResolved, profileResolved, profileError, refresh, signOut],
  )

  // No JSX, so this file stays a .ts module — the provider is the only element it renders.
  return React.createElement(SessionContext.Provider, { value }, children)
}

/**
 * The signed-in session, the matching auth user, and their profile row.
 *
 * @example
 * const { user, profile, loading } = useSession()
 */
export function useSession(): SessionValue {
  const value = React.useContext(SessionContext)
  if (!value) {
    throw new Error(
      'useSession() must be called inside <SessionProvider>, which app/_layout.tsx mounts.',
    )
  }
  return value
}

/** Shorthand for `useSession().profile`. Null while signed out or while the row is loading. */
export function useProfile(): Profile | null {
  return useSession().profile
}
