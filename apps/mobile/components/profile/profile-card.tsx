/**
 * components/profile/profile-card.tsx
 *
 * A person's card, on the phone.
 *
 * The web puts a live WebGL pitch behind it. Here the ground is the same night colour and the
 * "shot" is a composition of pitch markings drawn from borders — a centre circle, a goal box, a
 * halfway line — framed the way each camera would see them. No image asset, no gradient
 * library, and it tints with the person's accent like everything else.
 *
 * Same component for the profile tab (yours), a player screen (theirs) and the style editor
 * (the live preview), so what you design is what a teammate sees.
 */

import * as React from 'react'
import { View, type StyleProp, type ViewStyle } from 'react-native'

import { Avatar, Text } from '@/components/ui'
import { Eyebrow } from '@/components/progress/primitives'
import { accentHex } from '@/lib/accent'
import { useIsDark, useTheme } from '@/lib/theme'
import {
  BANNER_SHOT_LABEL,
  DOMINANT_FOOT_LABEL,
  accentColorOf,
  bannerShotOf,
  type ProfileBannerShot,
  type ProfileStyle,
} from '@onpitch/shared/profile'

const NIGHT = '#05070C'
const PAPER = '#F6F1E7'
const LINE = 'rgba(246, 241, 231, 0.32)'

export interface ProfileCardProps {
  name: string
  avatarUrl?: string | null
  style: ProfileStyle
  city?: string | null
  position?: string | null
  role?: string | null
  /** Rendered under the hairline at the bottom. */
  children?: React.ReactNode
  size?: 'hero' | 'preview'
  containerStyle?: StyleProp<ViewStyle>
}

export function ProfileCard({
  name,
  avatarUrl,
  style,
  city,
  position,
  role,
  children,
  size = 'hero',
  containerStyle,
}: ProfileCardProps): React.ReactElement {
  const theme = useTheme()
  const dark = useIsDark()
  const accentName = accentColorOf(style.accentColor)
  const accent = accentHex(accentName, true)
  const shot = bannerShotOf(style.bannerShot)
  const hero = size === 'hero'

  return (
    <View
      accessible
      accessibilityLabel={`${name} profil kartı`}
      style={[
        {
          backgroundColor: NIGHT,
          borderRadius: theme.radius.xl,
          borderWidth: 1,
          borderColor: dark ? theme.colors.border : 'rgba(27,34,48,0.25)',
          overflow: 'hidden',
        },
        containerStyle,
      ]}
    >
      <PitchMarkings shot={shot} accent={accent} />

      {/* The accent as light: three soft pools stacked, the way a floodlight lands on paper. */}
      {[0.18, 0.11, 0.06].map((opacity, index) => (
        <View
          key={opacity}
          style={{ pointerEvents: 'none',
            position: 'absolute',
            left: -120 - index * 60,
            top: -140 - index * 60,
            width: 300 + index * 120,
            height: 300 + index * 120,
            borderRadius: 999,
            backgroundColor: accent,
            opacity,
          }}
        />
      ))}

      <View
        style={{
          flexDirection: 'row',
          alignItems: 'flex-end',
          gap: theme.spacing.md,
          padding: hero ? theme.spacing.xl : theme.spacing.lg,
        }}
      >
        <Avatar uri={avatarUrl ?? null} name={name} size={hero ? 'xl' : 'lg'} accent={accentName} />

        <View style={{ flex: 1, gap: 4 }}>
          <Eyebrow style={{ opacity: 0.95 }}>
            <Text variant="caption" weight="600" style={{ color: accent, letterSpacing: 1.4, textTransform: 'uppercase', fontSize: 11 }}>
              {[role === 'venue_owner' ? 'İşletme' : 'Oyuncu', city, hero ? BANNER_SHOT_LABEL[shot].title : null]
                .filter(Boolean)
                .join(' · ')}
            </Text>
          </Eyebrow>
          <Text
            weight="300"
            numberOfLines={2}
            style={{ color: PAPER, fontSize: hero ? 28 : 22, lineHeight: hero ? 32 : 26, letterSpacing: -0.4 }}
          >
            {name}
          </Text>
          {style.tagline ? (
            <Text variant={hero ? 'body' : 'caption'} numberOfLines={2} style={{ color: 'rgba(246,241,231,0.72)' }}>
              {style.tagline}
            </Text>
          ) : null}
          {position || style.dominantFoot ? (
            <Text variant="caption" style={{ color: 'rgba(246,241,231,0.6)', letterSpacing: 1.2, textTransform: 'uppercase', fontSize: 11 }}>
              {[position, style.dominantFoot ? `${DOMINANT_FOOT_LABEL[style.dominantFoot]} ayak` : null]
                .filter(Boolean)
                .join(' · ')}
            </Text>
          ) : null}
        </View>

        {style.jerseyNumber !== null ? (
          <Text
            accessibilityLabel={`Forma numarası ${style.jerseyNumber}`}
            weight="300"
            style={{
              color: accent,
              fontSize: hero ? 72 : 48,
              lineHeight: hero ? 72 : 48,
              fontVariant: ['tabular-nums'],
              alignSelf: 'flex-start',
              textShadowColor: accent,
              textShadowRadius: 18,
              textShadowOffset: { width: 0, height: 0 },
            }}
          >
            {style.jerseyNumber}
          </Text>
        ) : null}
      </View>

      {children ? (
        <View
          style={{
            borderTopWidth: 1,
            borderTopColor: 'rgba(246,241,231,0.12)',
            paddingHorizontal: hero ? theme.spacing.xl : theme.spacing.lg,
            paddingVertical: theme.spacing.md,
            gap: theme.spacing.sm,
          }}
        >
          {children}
        </View>
      ) : null}
    </View>
  )
}

/* -------------------------------------------------------------------------- */
/*  The six shots, as pitch markings                                          */
/* -------------------------------------------------------------------------- */

/**
 * Each shot is the part of the pitch that camera would see, drawn from borders. The point is
 * that the six read as six different places, not that they are accurate.
 */
export function PitchMarkings({ shot, accent, compact = false }: { shot: ProfileBannerShot; accent: string; compact?: boolean }): React.ReactElement {
  const line = compact ? 1 : 1.5
  const common: ViewStyle = { position: 'absolute', borderColor: LINE }

  switch (shot) {
    case 'stands':
      // The whole pitch from above the corner flag: outline, halfway line, centre circle.
      return (
        <View style={{ pointerEvents: 'none', position: 'absolute', inset: 0 }}>
          <View style={[common, { left: '8%', right: '8%', top: '18%', bottom: '10%', borderWidth: line }]} />
          <View style={[common, { left: '8%', right: '8%', top: '54%', borderTopWidth: line }]} />
          <View style={[common, { left: '38%', width: '24%', top: '44%', aspectRatio: 1, borderRadius: 999, borderWidth: line }]} />
        </View>
      )
    case 'centre':
      return (
        <View style={{ pointerEvents: 'none', position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center' }}>
          <View style={[common, { width: '70%', aspectRatio: 1, borderRadius: 999, borderWidth: line, position: 'relative' }]} />
          <View style={[common, { left: 0, right: 0, top: '50%', borderTopWidth: line }]} />
          <View style={{ position: 'absolute', width: 6, height: 6, borderRadius: 3, backgroundColor: accent, opacity: 0.9 }} />
        </View>
      )
    case 'goalmouth':
      return (
        <View style={{ pointerEvents: 'none', position: 'absolute', inset: 0 }}>
          <View style={[common, { left: '22%', right: '22%', bottom: 0, height: '34%', borderWidth: line, borderBottomWidth: 0 }]} />
          <View style={[common, { left: '36%', right: '36%', bottom: 0, height: '14%', borderWidth: line, borderBottomWidth: 0 }]} />
          <View style={[common, { left: '40%', right: '40%', top: '36%', aspectRatio: 2, borderRadius: 999, borderWidth: line }]} />
        </View>
      )
    case 'touchline':
      // Through the wire: a mesh of hairlines over the far touchline.
      return (
        <View style={{ pointerEvents: 'none', position: 'absolute', inset: 0, flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 4 }}>
          {Array.from({ length: compact ? 8 : 14 }, (_, index) => (
            <View key={index} style={{ width: 1, backgroundColor: 'rgba(246,241,231,0.14)' }} />
          ))}
          <View style={[common, { left: 0, right: 0, top: '62%', borderTopWidth: line }]} />
        </View>
      )
    case 'aerial':
      return (
        <View style={{ pointerEvents: 'none', position: 'absolute', inset: 0 }}>
          {Array.from({ length: compact ? 4 : 7 }, (_, index) => (
            <View key={index} style={{ position: 'absolute', left: 0, right: 0, top: `${(index + 1) * 12.5}%`, height: 1, backgroundColor: 'rgba(246,241,231,0.12)' }} />
          ))}
          <View style={[common, { left: '30%', right: '30%', top: '30%', bottom: '30%', borderWidth: line }]} />
          <View style={[common, { left: '44%', width: '12%', top: '44%', aspectRatio: 1, borderRadius: 999, borderWidth: line }]} />
        </View>
      )
    case 'tunnel':
      // Low and central, walking in: two lines converging on the light.
      return (
        <View style={{ pointerEvents: 'none', position: 'absolute', inset: 0, alignItems: 'center' }}>
          <View style={[common, { top: '20%', bottom: 0, width: '3%', borderLeftWidth: line, transform: [{ rotate: '-18deg' }], left: '30%' }]} />
          <View style={[common, { top: '20%', bottom: 0, width: '3%', borderRightWidth: line, transform: [{ rotate: '18deg' }], right: '30%' }]} />
          <View style={{ position: 'absolute', top: '16%', width: compact ? 40 : 90, height: compact ? 40 : 90, borderRadius: 999, backgroundColor: accent, opacity: 0.22 }} />
        </View>
      )
  }
}
