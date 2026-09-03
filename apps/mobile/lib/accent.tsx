/**
 * lib/accent.tsx
 *
 * The person's chosen colour, on the phone.
 *
 * The web sets `--accent-user` once on the shell and every `text-user` reads it. React Native
 * has no cascade, so the equivalent is a context: `AccentProvider` reads `profiles.accent_color`
 * for the signed-in user once, `useTheme()` folds it into `colors.user`, and every screen that
 * wants the person's colour asks the theme for it exactly as it asks for `gold`.
 *
 * `setAccent` exists so the editor can show the new colour on the tab bar before the write has
 * come back; the provider re-reads on the next sign-in regardless.
 */

import * as React from 'react'

import { ACCENT_COLORS, accentColorOf, type AccentColor } from '@onpitch/shared/profile'

import { supabase, useSession } from '@/lib/supabase'

/** The eight accents, at the two luminances the two palettes need. Mirrors lib/profile/accent.ts. */
export const ACCENT_HEX: Record<AccentColor, { light: string; dark: string }> = {
  gold: { light: '#B8902E', dark: '#E0B352' },
  teal: { light: '#178F9A', dark: '#2FB2BC' },
  vermilion: { light: '#CF2734', dark: '#EA4A3F' },
  azure: { light: '#1F5FA8', dark: '#4D8FD6' },
  violet: { light: '#7A4FC0', dark: '#A97FE0' },
  lime: { light: '#5E8F2A', dark: '#96D04F' },
  coral: { light: '#D65A32', dark: '#F2845C' },
  ice: { light: '#2489B0', dark: '#7FD3F2' },
}

export const ACCENT_CHOICES = ACCENT_COLORS.map((name) => ({ name, swatch: ACCENT_HEX[name].dark }))

interface AccentState {
  accent: AccentColor
  setAccent: (next: AccentColor) => void
}

const AccentContext = React.createContext<AccentState>({ accent: 'gold', setAccent: () => undefined })

export function AccentProvider({ children }: React.PropsWithChildren): React.ReactElement {
  const { user } = useSession()
  const userId = user?.id ?? null
  const [accent, setAccent] = React.useState<AccentColor>('gold')

  React.useEffect(() => {
    let cancelled = false
    if (userId === null) {
      setAccent('gold')
      return
    }
    void supabase
      .from('profiles')
      .select('accent_color')
      .eq('id', userId)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled) setAccent(accentColorOf(data?.accent_color))
      })
    return () => {
      cancelled = true
    }
  }, [userId])

  const value = React.useMemo(() => ({ accent, setAccent }), [accent])
  return <AccentContext.Provider value={value}>{children}</AccentContext.Provider>
}

export function useAccent(): AccentState {
  return React.useContext(AccentContext)
}

/** A named accent as a hex for the current scheme. For OTHER people's colours (an avatar ring). */
export function accentHex(name: string | null | undefined, dark: boolean): string {
  return ACCENT_HEX[accentColorOf(name)][dark ? 'dark' : 'light']
}
