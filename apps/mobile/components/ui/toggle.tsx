/**
 * components/ui/toggle.tsx
 *
 * A labelled switch, and the house pattern for a control a minor is not allowed to change.
 *
 * `location_sharing_enabled`, `profile_visibility` and `marketing_opt_in` are pinned for under-16
 * accounts by a CHECK constraint and a trigger. Hiding those rows would leave the user wondering
 * where a setting went; sending the write anyway earns a 23514 from Postgres. So the row stays,
 * the switch is disabled, and `lockedReason` says who decided and why.
 */

import * as React from 'react'
import { Switch, View, type StyleProp, type ViewStyle } from 'react-native'

import { useTheme } from '@/lib/theme'

import { Text } from './text'

export interface ToggleProps {
  label: string
  value: boolean
  onValueChange: (next: boolean) => void
  /** Explains what the setting does. */
  hint?: string
  disabled?: boolean
  /**
   * Why the control cannot be changed. Renders in place of `hint` and disables the switch, so a
   * locked row can never be flipped into a write the database will reject.
   */
  lockedReason?: string | null
  style?: StyleProp<ViewStyle>
}

export function Toggle({
  label,
  value,
  onValueChange,
  hint,
  disabled = false,
  lockedReason = null,
  style,
}: ToggleProps): React.ReactElement {
  const theme = useTheme()
  const locked = Boolean(lockedReason)
  const inactive = disabled || locked

  return (
    <View
      accessible
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityHint={lockedReason ?? hint}
      accessibilityState={{ checked: value, disabled: inactive }}
      style={[
        {
          flexDirection: 'row',
          alignItems: 'flex-start',
          gap: theme.spacing.lg,
          opacity: inactive ? 0.7 : 1,
        },
        style,
      ]}
    >
      <View style={{ flex: 1, gap: theme.spacing.xs }}>
        <Text variant="label">{label}</Text>
        {lockedReason ? (
          <Text variant="caption" tone="muted">
            {lockedReason}
          </Text>
        ) : hint ? (
          <Text variant="caption" tone="muted">
            {hint}
          </Text>
        ) : null}
      </View>

      <Switch
        value={value}
        onValueChange={onValueChange}
        disabled={inactive}
        // The row above already carries the accessible name and state; leaving the switch in the
        // reading order would announce the same control twice.
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        trackColor={{ false: theme.colors.border, true: theme.colors.primary }}
        thumbColor={theme.colors.background}
        ios_backgroundColor={theme.colors.border}
      />
    </View>
  )
}
