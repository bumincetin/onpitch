/**
 * components/ui/night-band.tsx
 *
 * The band at the top of a screen: the floodlit pitch, held as a strip — and, on the phone,
 * moving.
 *
 * The web puts a live WebGL pitch behind the headline with a camera that drifts for forty
 * seconds. The phone has no shader, so it has three things instead, all on the UI thread:
 *
 *   * a PITCH IN PERSPECTIVE — the markings drawn from borders, laid flat with `rotateX` and a
 *     vanishing point, drifting sideways very slowly the way the web camera does;
 *   * FLOODLIGHT POOLS that breathe — a six-second swell in scale and opacity, out of phase
 *     with each other, so the light never looks painted on;
 *   * the CONTENT rising into place when the screen mounts.
 *
 * Every timing carries `ReduceMotion.System`, so a person who asked the OS for less motion
 * gets the composition still. Structure mirrors the web's `NightBand`: an eyebrow, a light
 * headline, an optional lede, an optional aside on the trailing edge, then children.
 */

import * as React from 'react'
import { View, type StyleProp, type ViewStyle } from 'react-native'
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated'

import { EASE_OUT, riseIn } from '@/lib/motion'
import { useTheme } from '@/lib/theme'

import { Text } from './text'

const NIGHT = '#05070C'
const FLOOD = 'rgba(255, 201, 120, 1)'
const PAPER = '#F6F1E7'
const LINE = 'rgba(246, 241, 231, 0.28)'

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

      <PerspectivePitch compact={compact} />

      {/* Four floodlight pools, breathing out of phase. */}
      <Pool x="50%" y="74%" size={520} color={FLOOD} opacity={0.11} phase={0} />
      <Pool x="50%" y="74%" size={300} color={FLOOD} opacity={0.08} phase={0.3} />
      <Pool x="12%" y="64%" size={260} color={FLOOD} opacity={0.08} phase={0.55} />
      <Pool x="88%" y="64%" size={260} color={FLOOD} opacity={0.08} phase={0.8} />
      <Pool x="74%" y="100%" size={340} color="rgba(255,178,96,1)" opacity={0.1} phase={0.15} />
      {/* And one in the person's own colour, top-left, where a card's light sits. */}
      <Pool x="8%" y="0%" size={300} color={theme.colors.user} opacity={0.14} phase={0.45} />

      {/* The ruled grid, faint enough to suggest a fixture sheet without drawing one. */}
      <View style={{ pointerEvents: 'none', position: 'absolute', inset: 0 }}>
        {Array.from({ length: 6 }, (_, index) => (
          <View key={index} style={{ position: 'absolute', left: 0, right: 0, top: `${(index + 1) * 14}%`, height: 1, backgroundColor: 'rgba(246,241,231,0.035)' }} />
        ))}
      </View>

      <Animated.View
        entering={riseIn(0)}
        style={{ paddingHorizontal: padX, paddingTop: compact ? theme.spacing.lg : theme.spacing.xl, paddingBottom: compact ? theme.spacing.lg : theme.spacing.xl, gap: theme.spacing.lg }}
      >
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

        {children ? (
          <Animated.View entering={riseIn(2)} style={{ gap: theme.spacing.lg }}>
            {children}
          </Animated.View>
        ) : null}
      </Animated.View>
    </View>
  )
}

/* -------------------------------------------------------------------------- */
/*  Light                                                                     */
/* -------------------------------------------------------------------------- */

const BREATH_MS = 6000

function Pool({ x, y, size, color, opacity, phase }: { x: `${number}%`; y: `${number}%`; size: number; color: string; opacity: number; phase: number }): React.ReactElement {
  // 0 → 1 → 0, forever. The phase offset starts each pool part-way so they never pulse together.
  const t = useSharedValue(phase)
  React.useEffect(() => {
    t.value = withRepeat(
      withTiming(1, { duration: BREATH_MS * (1 - phase), easing: Easing.inOut(Easing.sin), reduceMotion: ReduceMotion.System }),
      -1,
      true,
    )
  }, [phase, t])

  const breathing = useAnimatedStyle(() => ({
    opacity: opacity * (0.85 + 0.3 * t.value),
    transform: [{ scale: 1 + 0.12 * t.value }],
  }))

  return (
    <Animated.View
      style={[
        {
          pointerEvents: 'none',
          position: 'absolute',
          left: x,
          top: y,
          width: size,
          height: size * 0.55,
          marginLeft: -size / 2,
          marginTop: -(size * 0.55) / 2,
          borderRadius: size,
          backgroundColor: color,
        },
        breathing,
      ]}
    />
  )
}

/* -------------------------------------------------------------------------- */
/*  The pitch, laid flat                                                      */
/* -------------------------------------------------------------------------- */

const DRIFT_MS = 40_000

/**
 * The markings of a pitch — touchlines, halfway line, centre circle, both boxes — drawn from
 * borders and rotated about X with a vanishing point, so the band looks down the length of a
 * pitch the way the web's `stands` shot does. It drifts sideways over forty seconds and back.
 */
function PerspectivePitch({ compact }: { compact: boolean }): React.ReactElement {
  const drift = useSharedValue(0)
  React.useEffect(() => {
    drift.value = withRepeat(
      withTiming(1, { duration: DRIFT_MS, easing: Easing.inOut(Easing.sin), reduceMotion: ReduceMotion.System }),
      -1,
      true,
    )
  }, [drift])

  const plane = useAnimatedStyle(() => ({
    transform: [
      { perspective: 520 },
      { translateX: -14 + 28 * drift.value },
      { rotateX: '62deg' },
      { translateY: 8 * drift.value },
    ],
  }));

  const height = compact ? 190 : 260

  return (
    <Animated.View
      style={[
        {
          pointerEvents: 'none',
          position: 'absolute',
          left: '-30%',
          right: '-30%',
          bottom: -height * 0.28,
          height,
          opacity: 0.55,
        },
        plane,
      ]}
    >
      <View style={{ flex: 1, borderWidth: 1, borderColor: LINE, borderRadius: 2 }}>
        {/* Halfway line and centre circle. */}
        <View style={{ position: 'absolute', left: 0, right: 0, top: '50%', height: 1, backgroundColor: LINE }} />
        <View style={{ position: 'absolute', left: '50%', top: '50%', width: 90, height: 90, marginLeft: -45, marginTop: -45, borderRadius: 45, borderWidth: 1, borderColor: LINE }} />
        {/* Penalty boxes and goals at both ends. */}
        <View style={{ position: 'absolute', left: '22%', right: '22%', top: -1, height: '18%', borderWidth: 1, borderTopWidth: 0, borderColor: LINE }} />
        <View style={{ position: 'absolute', left: '36%', right: '36%', top: -1, height: '7%', borderWidth: 1, borderTopWidth: 0, borderColor: LINE }} />
        <View style={{ position: 'absolute', left: '22%', right: '22%', bottom: -1, height: '18%', borderWidth: 1, borderBottomWidth: 0, borderColor: LINE }} />
        <View style={{ position: 'absolute', left: '36%', right: '36%', bottom: -1, height: '7%', borderWidth: 1, borderBottomWidth: 0, borderColor: LINE }} />
        {/* Turf stripes: alternating bands a shade apart, which is what sells the perspective. */}
        {Array.from({ length: 8 }, (_, index) => (
          <View
            key={index}
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: `${index * 12.5}%`,
              height: '12.5%',
              backgroundColor: index % 2 === 0 ? 'rgba(29, 90, 58, 0.22)' : 'rgba(29, 90, 58, 0.12)',
            }}
          />
        ))}
      </View>
    </Animated.View>
  )
}
