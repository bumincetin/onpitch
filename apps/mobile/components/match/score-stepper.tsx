/**
 * components/match/score-stepper.tsx
 *
 * A goals counter: minus, a number, plus.
 *
 * A stepper rather than a text field. Nobody types "3" into a keyboard at the side of a pitch with
 * cold hands, and a numeric field on Android happily accepts "3.5" and an empty string, both of
 * which then have to be re-validated on the way out.
 *
 * Accessibility follows the platform's adjustable pattern: the whole control is one element with a
 * value that VoiceOver and TalkBack change by swiping up and down. The two buttons are therefore
 * hidden from assistive technology — leaving them in would announce the same control three times.
 */

import * as React from 'react'
import { Pressable, View } from 'react-native'

import { Text } from '@/components/ui'
import { useTheme } from '@/lib/theme'

export interface ScoreStepperProps {
  /** The side this counts for: a team name, or "Home". */
  label: string
  value: number
  onChange: (next: number) => void
  min?: number
  /** Defaults to 30, the `max_goals_per_team` default in 0005. The trigger is the real limit. */
  max?: number
  disabled?: boolean
}

export function ScoreStepper({
  label,
  value,
  onChange,
  min = 0,
  max = 30,
  disabled = false,
}: ScoreStepperProps): React.ReactElement {
  const theme = useTheme()

  const clamp = (next: number): number => Math.min(max, Math.max(min, Math.trunc(next)))
  const step = (by: number): void => {
    if (disabled) return
    const next = clamp(value + by)
    if (next !== value) onChange(next)
  }

  return (
    <View
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={`${label} goals`}
      accessibilityValue={{ min, max, now: value, text: `${value}` }}
      accessibilityState={{ disabled }}
      accessibilityActions={[
        { name: 'increment', label: 'Gol ekle' },
        { name: 'decrement', label: 'Gol çıkar' },
      ]}
      onAccessibilityAction={(event) => {
        if (event.nativeEvent.actionName === 'increment') step(1)
        if (event.nativeEvent.actionName === 'decrement') step(-1)
      }}
      style={{ flex: 1, gap: theme.spacing.sm, opacity: disabled ? 0.5 : 1 }}
    >
      <Text variant="label" tone="muted" align="center" numberOfLines={1}>
        {label}
      </Text>

      <View
        // Hidden as a group: the adjustable container above already carries the name, the value
        // and both actions.
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: theme.spacing.sm,
          padding: theme.spacing.xs,
          borderRadius: theme.radius.xl,
          borderWidth: 1,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.card,
        }}
      >
        <StepButton glyph="−" onPress={() => step(-1)} disabled={disabled || value <= min} />

        <Text
          variant="display"
          weight="700"
          align="center"
          style={{ flex: 1, fontVariant: ['tabular-nums'] }}
        >
          {value}
        </Text>

        <StepButton glyph="+" onPress={() => step(1)} disabled={disabled || value >= max} />
      </View>
    </View>
  )
}

function StepButton({
  glyph,
  onPress,
  disabled,
}: {
  glyph: string
  onPress: () => void
  disabled: boolean
}): React.ReactElement {
  const theme = useTheme()

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={6}
      style={({ pressed }) => ({
        width: 48,
        height: 48,
        borderRadius: theme.radius.lg,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.secondary,
        opacity: disabled ? 0.4 : pressed ? 0.8 : 1,
      })}
    >
      <Text variant="title" weight="700" style={{ color: theme.colors.secondaryForeground }}>
        {glyph}
      </Text>
    </Pressable>
  )
}
