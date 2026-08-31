/**
 * app/index.tsx
 *
 * The entry route. It renders nothing — it decides where the user actually belongs.
 *
 * This is the only place that redirects on session state at the top level. `(auth)/_layout.tsx`
 * deliberately does not: bouncing a freshly signed-up user straight into the tabs would skip the
 * screen telling a 14-year-old that their guardian has been emailed, which is the one thing they
 * need to read.
 */

import { Redirect } from 'expo-router'
import * as React from 'react'

import { useSession } from '@/lib/supabase'

export default function Index(): React.ReactElement {
  const { session } = useSession()

  // `app/_layout.tsx` holds the splash until `loading` is false, so by the time this renders the
  // answer is already known and the redirect resolves in the same frame.
  return <Redirect href={session ? '/(tabs)' : '/(auth)/sign-in'} />
}
