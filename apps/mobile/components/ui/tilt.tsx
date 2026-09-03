/**
 * components/ui/tilt.tsx
 *
 * A surface that tilts toward your finger.
 *
 * Perspective plus two rotations, driven by a pan gesture on the UI thread, springing back to
 * flat on release. A specular highlight slides the opposite way so the card reads as a lit
 * object rather than a flat picture being skewed. This is the one "3D" the phone can do
 * without a native module, and it is exactly what a card should do when you pick it up.
 *
 * Under reduced motion the gesture is inert and the card lies flat.
 */

import * as React from 'react'
import { View, type StyleProp, type ViewStyle } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated'

import { useReducedMotion } from '@/lib/motion'

export interface TiltProps {
  children: React.ReactNode
  /** Degrees at the edges. 8 reads as a card in a hand; 15 as a toy. */
  maxDegrees?: number
  /** Colour of the moving highlight. Defaults to paper. */
  highlight?: string
  style?: StyleProp<ViewStyle>
}

const SPRING = { damping: 14, stiffness: 160, mass: 0.6 }

export function Tilt({ children, maxDegrees = 8, highlight = '#F6F1E7', style }: TiltProps): React.ReactElement {
  const reduced = useReducedMotion()
  const rx = useSharedValue(0)
  const ry = useSharedValue(0)
  const active = useSharedValue(0)
  const size = useSharedValue({ w: 1, h: 1 })

  const pan = React.useMemo(
    () =>
      Gesture.Pan()
        .enabled(!reduced)
        .minDistance(0)
        .onBegin((event) => {
          active.value = withSpring(1, SPRING)
          const { w, h } = size.value
          ry.value = withSpring(((event.x / w) * 2 - 1) * maxDegrees, SPRING)
          rx.value = withSpring(-((event.y / h) * 2 - 1) * maxDegrees, SPRING)
        })
        .onUpdate((event) => {
          const { w, h } = size.value
          ry.value = ((event.x / w) * 2 - 1) * maxDegrees
          rx.value = -((event.y / h) * 2 - 1) * maxDegrees
        })
        .onFinalize(() => {
          rx.value = withSpring(0, SPRING)
          ry.value = withSpring(0, SPRING)
          active.value = withSpring(0, SPRING)
        }),
    [active, maxDegrees, reduced, rx, ry, size],
  )

  const surface = useAnimatedStyle(() => ({
    transform: [
      { perspective: 900 },
      { rotateX: `${rx.value}deg` },
      { rotateY: `${ry.value}deg` },
      { scale: 1 + active.value * 0.015 },
    ],
  }))

  // The highlight moves against the tilt: tilt right, the light slides left, as it would.
  const gleam = useAnimatedStyle(() => ({
    opacity: active.value * 0.12,
    transform: [{ translateX: -ry.value * 6 }, { translateY: rx.value * 6 }],
  }))

  return (
    <GestureDetector gesture={pan}>
      <Animated.View
        style={[surface, style]}
        onLayout={(event) => {
          size.value = { w: Math.max(1, event.nativeEvent.layout.width), h: Math.max(1, event.nativeEvent.layout.height) }
        }}
      >
        {children}
        <Animated.View
          style={[
            { position: 'absolute', left: '-20%', top: '-40%', width: '140%', height: '120%', borderRadius: 999, backgroundColor: highlight },
            { pointerEvents: 'none' },
            gleam,
          ]}
        />
        <View style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />
      </Animated.View>
    </GestureDetector>
  )
}
