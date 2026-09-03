/**
 * lib/motion.ts
 *
 * The motion vocabulary, in one place.
 *
 * Three rules every animation in the app follows:
 *
 *   1. It runs on the UI thread. Reanimated worklets, never a JS `setInterval` driving layout —
 *      a dropped frame in a list is the difference between "lit" and "laggy".
 *   2. It respects the OS. `prefers-reduced-motion` on the web is `ReduceMotion.System` here;
 *      every timing and every entering animation carries it, and the JS-driven pieces (the
 *      count-up) ask `useReducedMotion()` and skip to the end.
 *   3. It says something. Things rise into place because they arrived; a card tilts because you
 *      touched it; light breathes because floodlights do. Nothing wiggles for the sake of it.
 */

import * as React from 'react'
import { AccessibilityInfo } from 'react-native'
import { Easing, FadeIn, FadeInUp, ReduceMotion } from 'react-native-reanimated'

/** The web's `cubic-bezier(0.16, 1, 0.3, 1)`: fast out, long settle. */
export const EASE_OUT = Easing.bezier(0.16, 1, 0.3, 1)

/** True when the OS asks for less motion. Subscribes, so a change mid-session is honoured. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = React.useState(false)
  React.useEffect(() => {
    let alive = true
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => alive && setReduced(value))
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced)
    return () => {
      alive = false
      subscription.remove()
    }
  }, [])
  return reduced
}

/**
 * A row arriving: rises a little and fades in, staggered by its index so a list reads as
 * "dealt", not "dumped". Capped so a long list does not keep the reader waiting on row 40.
 */
export function riseIn(index = 0): FadeInUp {
  return FadeInUp.duration(520)
    .delay(Math.min(index, 8) * 45)
    .easing(EASE_OUT)
    .reduceMotion(ReduceMotion.System)
}

/** A bubble or a badge appearing where it is: fade only, no travel. */
export function appear(delayMs = 0): FadeIn {
  return FadeIn.duration(320).delay(delayMs).easing(EASE_OUT).reduceMotion(ReduceMotion.System)
}

/**
 * Counts from 0 to `target` over `durationMs` on mount, then follows `target` exactly. Used for
 * the level number and the counters — the one animation that has to be JS-driven because it
 * changes text. Skips straight to the end under reduced motion.
 */
export function useCountUp(target: number, durationMs = 900): number {
  const reduced = useReducedMotion()
  const [value, setValue] = React.useState(reduced ? target : 0)
  React.useEffect(() => {
    if (reduced) {
      setValue(target)
      return
    }
    let frame = 0
    const start = Date.now()
    const from = 0
    const tick = (): void => {
      const t = Math.min(1, (Date.now() - start) / durationMs)
      // The same ease-out as everything else, applied by hand because this runs off-thread.
      const eased = 1 - Math.pow(1 - t, 3)
      setValue(Math.round(from + (target - from) * eased))
      if (t < 1) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [durationMs, reduced, target])
  return value
}
