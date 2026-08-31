/**
 * components/ui/field.tsx
 *
 * A labelled text input with room for a hint and an error.
 *
 * The label is a real `<Text>` above the input AND the input's accessibility name. React Native
 * has no `htmlFor`, so a visible label that is not also passed to `accessibilityLabel` is
 * invisible to a screen reader — the field just announces "text field".
 *
 * When `error` is set the input announces itself as invalid and the message is rendered below it,
 * never as a placeholder: placeholder text vanishes the moment the user starts typing, which is
 * exactly when they need to read it.
 */

import * as React from 'react'
import {
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native'

import { useTheme } from '@/lib/theme'

import { Text } from './text'

export interface FieldProps extends Omit<TextInputProps, 'style'> {
  label: string
  /** Guidance shown under the input. Hidden while `error` is set, to avoid two competing lines. */
  hint?: string
  /** Validation message. Sets the invalid state and colours the border. */
  error?: string | null
  /** Adds the required marker to the label and sets `accessibilityRequired`. */
  required?: boolean
  /** Greys the field out and blocks input. Pair with `hint` to say why. */
  disabled?: boolean
  /** Rendered inside the input on the trailing edge — a unit, a reveal toggle. */
  right?: React.ReactNode
  containerStyle?: StyleProp<ViewStyle>
}

export function Field({
  label,
  hint,
  error,
  required = false,
  disabled = false,
  right,
  containerStyle,
  accessibilityLabel,
  ...inputProps
}: FieldProps): React.ReactElement {
  const theme = useTheme()
  const [focused, setFocused] = React.useState(false)

  const borderColor = error
    ? theme.colors.destructive
    : focused
      ? theme.colors.ring
      : theme.colors.input

  return (
    <View style={[{ gap: theme.spacing.sm }, containerStyle]}>
      <Text variant="label" tone={disabled ? 'muted' : 'default'}>
        {label}
        {required ? (
          <Text variant="label" tone="destructive">
            {' *'}
          </Text>
        ) : null}
      </Text>

      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.spacing.sm,
          minHeight: 48,
          paddingHorizontal: theme.spacing.md,
          borderRadius: theme.radius.lg,
          borderWidth: 1,
          borderColor,
          backgroundColor: disabled ? theme.colors.muted : theme.colors.background,
        }}
      >
        {/* Caller props are spread FIRST so the themed values below always win — a screen that
            passes its own `onFocus` still gets the focus ring, because ours wraps theirs. */}
        <TextInput
          {...inputProps}
          accessibilityLabel={accessibilityLabel ?? label}
          accessibilityHint={error ?? hint}
          aria-required={required}
          aria-invalid={Boolean(error)}
          editable={!disabled}
          placeholderTextColor={theme.colors.mutedForeground}
          selectionColor={theme.colors.primary}
          onFocus={(event) => {
            setFocused(true)
            inputProps.onFocus?.(event)
          }}
          onBlur={(event) => {
            setFocused(false)
            inputProps.onBlur?.(event)
          }}
          style={{
            flex: 1,
            paddingVertical: theme.spacing.md,
            fontSize: theme.type.body.fontSize,
            lineHeight: theme.type.body.lineHeight,
            color: disabled ? theme.colors.mutedForeground : theme.colors.foreground,
          }}
        />
        {right}
      </View>

      {error ? (
        <Text variant="caption" tone="destructive" accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : hint ? (
        <Text variant="caption" tone="muted">
          {hint}
        </Text>
      ) : null}
    </View>
  )
}
