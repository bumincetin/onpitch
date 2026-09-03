/**
 * components/profile/privacy-toggle.tsx
 *
 * One privacy switch, saved the moment it moves.
 *
 * WHY IT WRITES SUPABASE DIRECTLY AND NOT AN API ROUTE
 * ---------------------------------------------------
 * `0002_rls.sql` §4.1 grants `authenticated` UPDATE on exactly these columns — including
 * `location_sharing_enabled`, `profile_visibility` and `marketing_opt_in` — and
 * `profiles_update_self` restricts the row to `id = auth.uid()`. That is the whole authorisation,
 * evaluated in Postgres. Routing the same statement through a Next.js handler would add a hop and
 * a second copy of the rules without adding a check, so this goes straight to PostgREST with the
 * user's own client. The `.eq('id', userId)` below is the row filter PostgREST needs in order to
 * accept an UPDATE at all; it is not the access check.
 *
 * WHY A LOCKED SWITCH NEVER SENDS ANYTHING
 * ----------------------------------------
 * For an under-16 account `enforce_minor_privacy` and `profiles_minor_privacy_locked_check` pin
 * all three values. A locked switch renders disabled with `lockedReason` next to it — visible, so
 * the setting is discoverable and its absence reads as policy rather than as a bug — and there is
 * no code path from a disabled switch to a write. Sending one anyway would earn a 23514 and show a
 * constraint violation to a fifteen-year-old.
 *
 * Each switch saves alone. A Save button under three toggles leaves a privacy setting looking
 * changed while it is not, and this is the one screen where that gap is unacceptable.
 */

import * as React from 'react'
import { View, type StyleProp, type ViewStyle } from 'react-native'

import type { TablesUpdate } from '@onpitch/shared/database'

import { Text, Toggle } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { useTheme } from '@/lib/theme'

export interface PrivacyToggleProps {
  label: string
  /** What the setting does, in the second person. Replaced by `lockedReason` when locked. */
  hint: string
  /** The switch position. Owned by the screen so the three switches stay in step. */
  value: boolean
  /** `auth.users.id` of the signed-in person. */
  userId: string
  /**
   * The `profiles` update a new switch position implies. Called only for an unlocked switch, and
   * only with the position the user just chose.
   */
  patchFor: (next: boolean) => TablesUpdate<'profiles'>
  /** Non-null when the database pins this setting. Renders the switch disabled and explained. */
  lockedReason?: string | null
  /** Called once the write has committed, so the screen can adopt the value. */
  onChanged: (next: boolean) => void
  style?: StyleProp<ViewStyle>
}

/** Postgres codes worth translating; anything else falls through to the driver's message. */
function messageFor(code: string | undefined, fallback: string): string {
  if (code === '23514') {
    return 'The database refused that change. This account is registered as under 16, so the setting stays pinned until you turn 16.'
  }
  if (code === '42501') {
    return 'You are not allowed to change that setting. Sign out and back in, and if it keeps happening let us know.'
  }
  return fallback
}

export function PrivacyToggle({
  label,
  hint,
  value,
  userId,
  patchFor,
  lockedReason = null,
  onChanged,
  style,
}: PrivacyToggleProps): React.ReactElement {
  const theme = useTheme()

  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const locked = lockedReason !== null && lockedReason.length > 0

  const handleChange = React.useCallback(
    (next: boolean): void => {
      if (locked || saving) return

      setError(null)
      setSaving(true)
      // Optimistic: the switch has already animated, and holding it at the old position until the
      // round trip finishes makes a working control feel broken.
      onChanged(next)

      void (async () => {
        const { error: writeError } = await supabase
          .from('profiles')
          .update(patchFor(next))
          .eq('id', userId)

        if (writeError) {
          onChanged(!next)
          setError(
            messageFor(
              writeError.code,
              writeError.message || 'Could not save that. Nothing was changed.',
            ),
          )
        }
        setSaving(false)
      })()
    },
    [locked, onChanged, patchFor, saving, userId],
  )

  return (
    <View style={[{ gap: theme.spacing.sm }, style]}>
      <Toggle
        label={label}
        value={value}
        onValueChange={handleChange}
        hint={hint}
        disabled={saving}
        lockedReason={lockedReason}
      />

      {saving ? (
        <Text variant="caption" tone="muted" accessibilityLiveRegion="polite">
          Saving…
        </Text>
      ) : null}

      {error ? (
        <Text variant="caption" tone="destructive" accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : null}
    </View>
  )
}
