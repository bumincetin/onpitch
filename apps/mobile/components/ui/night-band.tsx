/**
 * components/ui/night-band.tsx
 *
 * The band at the top of a screen: the floodlit pitch, held as a strip.
 *
 * The web puts a live WebGL pitch behind the headline. The phone paints what the web paints
 * BEFORE the canvas arrives — `.night-fallback`: four floodlight pools over a horizon that goes
 * warm at the bottom — from stacked translucent Views, plus the faint ruled grid, plus the
 * hairline under the lot. Same composition, no shader, and it is what every signed-in screen
 * opens on so the app feels like standing at a pitch at night rather than at a settings form.
 *
 * Structure mirrors the web's `NightBand`: an eyebrow, a light headline, an optional lede, an
 * optional aside on the trailing edge, then children under a rule.
 */

import * as React from 'react'
import { View, type StyleProp, type ViewStyle } from 'react-native'

import { useTheme } from '@/lib/theme'

import { Text } from './text'

const NIGHT = '#05070C'
const FLOOD = 'rgba(255, 201, 120, 1)'
const PAPER = '#F6F1E7'

export interface NightBandProps {
  eyebrow?: string
  title: React.ReactNode
  lede?: string
  /** Trailing edge, beside the title. A number, a plate, a button. */
  aside?: React.ReactNode
  children?: React.ReactNode
  /**
   * Bleed to the screen edges when rendered inside a padded container. Pass the container's
   * horizontal padding; the band pulls itself out by that much and pads its content back in.
   */
  bleed?: number
  /** A shorter band for list screens. */
  compact?: boolean
  style?: StyleProp<ViewStyle>
}

export function NightBand({ eyebrow, title, lede, aside, children, bleed = 0, compact = false, style }: NightBandProps): React.ReactElement {
  const theme = useTheme()
  const padX = theme.spacing.lg + bleed

  return (
    <View
      style={[
        {
          backgroundColor: NIGHT,
          marginHorizontal: -bleed,
          borderBottomWidth: 1,
          borderBottomColor: 'rgba(246,241,231,0.15)',
          overflow: 'hidden',
        },
        style,
      ]}
    >
      {/* The horizon: warm at the bottom, the way a city sky sits over a lit pitch. */}
      <View style={{ pointerEvents: 'none', position: 'absolute', left: 0, right: 0, bottom: 0, height: '55%', backgroundColor: '#131C2B', opacity: 0.9 }} />
      <View style={{ pointerEvents: 'none', position: 'absolute', left: 0, right: 0, bottom: 0, height: '28%', backgroundColor: '#1D2739', opacity: 0.9 }} />

      {/* Four floodlight pools. Stacked circles at falling opacity read as soft light. */}
      <Pool x="50%" y="74%" size={520} color={FLOOD} opacity={0.11} />
      <Pool x="50%" y="74%" size={300} color={FLOOD} opacity={0.08} />
      <Pool x="12%" y="64%" size={260} color={FLOOD} opacity={0.08} />
      <Pool x="88%" y="64%" size={260} color={FLOOD} opacity={0.08} />
      <Pool x="74%" y="100%" size={340} color="rgba(255,178,96,1)" opacity={0.1} />
      {/* And one in the person's own colour, top-left, where a card's light sits. */}
      <Pool x="8%" y="0%" size={300} color={theme.colors.user} opacity={0.14} />

      {/* The ruled grid, faint enough to suggest a fixture sheet without drawing one. */}
      <View style={{ pointerEvents: 'none', position: 'absolute', inset: 0 }}>
        {Array.from({ length: 6 }, (_, index) => (
          <View key={index} style={{ position: 'absolute', left: 0, right: 0, top: `${(index + 1) * 14}%`, height: 1, backgroundColor: 'rgba(246,241,231,0.035)' }} />
        ))}
      </View>

      <View style={{ paddingHorizontal: padX, paddingTop: compact ? theme.spacing.lg : theme.spacing.xl, paddingBottom: compact ? theme.spacing.lg : theme.spacing.xl, gap: theme.spacing.lg }}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: theme.spacing.lg }}>
          <View style={{ flex: 1, gap: theme.spacing.sm }}>
            {eyebrow ? (
              <Text variant="caption" weight="600" style={{ color: 'rgba(246,241,231,0.62)', letterSpacing: 1.6, textTransform: 'uppercase', fontSize: 11 }}>
                {eyebrow}
              </Text>
            ) : null}
            <Text
              accessibilityRole="header"
              weight="300"
              style={{ color: PAPER, fontSize: compact ? 26 : 32, lineHeight: compact ? 30 : 36, letterSpacing: -0.6 }}
            >
              {title}
            </Text>
            {lede ? (
              <Text variant="body" style={{ color: 'rgba(246,241,231,0.7)', lineHeight: 22 }}>
                {lede}
              </Text>
            ) : null}
          </View>
          {aside ? <View>{aside}</View> : null}
        </View>

        {children ? <View style={{ gap: theme.spacing.lg }}>{children}</View> : null}
      </View>
    </View>
  )
}

function Pool({ x, y, size, color, opacity }: { x: `${number}%`; y: `${number}%`; size: number; color: string; opacity: number }): React.ReactElement {
  return (
    <View
      style={{ pointerEvents: 'none',
        position: 'absolute',
        left: x,
        top: y,
        width: size,
        height: size * 0.55,
        marginLeft: -size / 2,
        marginTop: -(size * 0.55) / 2,
        borderRadius: size,
        backgroundColor: color,
        opacity,
      }}
    />
  )
}
