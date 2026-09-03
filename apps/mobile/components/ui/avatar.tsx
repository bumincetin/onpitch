/**
 * components/ui/avatar.tsx
 *
 * A player or venue avatar, with initials as the fallback.
 *
 * `profiles.avatar_url` is nullable and points at Supabase Storage, which can 404 after an object
 * is removed. Both cases land on the same initials circle, so a broken image never leaves a hole
 * in a roster list.
 */

import * as React from 'react'
import { Image, View, type StyleProp, type ViewStyle } from 'react-native'

import { accentHex } from '@/lib/accent'
import { useIsDark, useTheme } from '@/lib/theme'

import { Text } from './text'

export type AvatarSize = 'sm' | 'md' | 'lg' | 'xl'

const DIAMETER: Record<AvatarSize, number> = { sm: 28, md: 40, lg: 56, xl: 80 }
const FONT: Record<AvatarSize, number> = { sm: 11, md: 15, lg: 20, xl: 28 }

export interface AvatarProps {
  /** `profiles.avatar_url`, or null. */
  uri?: string | null
  /** Display name. Used for the initials and for the accessibility label. */
  name?: string | null
  size?: AvatarSize
  /**
   * Draw the ring in this person's accent (their `profiles.accent_color`). `'self'` uses the
   * viewer's own accent from the theme; a name uses that palette entry; omit for no ring.
   */
  accent?: string | 'self' | null
  style?: StyleProp<ViewStyle>
}

/**
 * Up to two initials from a display name.
 *
 * Written with an explicit loop rather than `parts[0]` / `parts[1]` because
 * `noUncheckedIndexedAccess` makes every index `string | undefined`, and a name that is all
 * whitespace has no parts at all.
 */
export function initialsOf(name: string | null | undefined): string {
  if (!name) return '?'
  const letters: string[] = []
  for (const part of name.trim().split(/\s+/)) {
    const first = part.charAt(0)
    if (first.length > 0) letters.push(first.toUpperCase())
    if (letters.length === 2) break
  }
  return letters.length > 0 ? letters.join('') : '?'
}

export function Avatar({ uri, name, size = 'md', accent = null, style }: AvatarProps): React.ReactElement {
  const theme = useTheme()
  const dark = useIsDark()
  const [failed, setFailed] = React.useState(false)
  const ring = accent === 'self' ? theme.colors.user : accent ? accentHex(accent, dark) : null

  // The flag belongs to one URL, not to the component instance. A screen that keeps the same
  // Avatar mounted across a refresh (the profile tab, the player screen) would otherwise go on
  // showing initials for a perfectly good new `uri` because an earlier one 404'd.
  React.useEffect(() => {
    setFailed(false)
  }, [uri])

  const diameter = DIAMETER[size]
  const label = name?.trim() ? `${name.trim()}'s avatar` : 'Avatar'

  const frame: ViewStyle = {
    width: diameter,
    height: diameter,
    borderRadius: diameter / 2,
    backgroundColor: theme.colors.secondary,
    borderWidth: ring ? (size === 'sm' ? 1.5 : 2) : 1,
    borderColor: ring ?? theme.colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  }

  const showImage = Boolean(uri) && !failed

  return (
    <View style={[frame, style]} accessibilityRole="image" accessibilityLabel={label}>
      {showImage && uri ? (
        <Image
          source={{ uri }}
          style={{ width: diameter, height: diameter }}
          resizeMode="cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <Text
          weight="600"
          style={{ fontSize: FONT[size], lineHeight: FONT[size] * 1.2, color: theme.colors.secondaryForeground }}
        >
          {initialsOf(name)}
        </Text>
      )}
    </View>
  )
}
