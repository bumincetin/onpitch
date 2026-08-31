/**
 * components/ui/empty-state.tsx
 *
 * What a list shows when it has nothing in it, and what a screen shows when a fetch failed.
 *
 * Both cases get a title, a sentence explaining the situation, and — when there is one — a way
 * out. An empty list with no explanation reads as a bug even when it is the correct answer.
 */

import * as React from 'react'
import { View, type StyleProp, type ViewStyle } from 'react-native'

import { useTheme } from '@/lib/theme'

import { Button } from './button'
import { Text } from './text'

export interface EmptyStateProps {
  title: string
  /** One or two sentences. Say what happened and what the reader can do next. */
  description?: string
  /** An icon or illustration above the title. */
  icon?: React.ReactNode
  action?: { label: string; onPress: () => void; loading?: boolean }
  /** Secondary action, e.g. "Retry" next to "Go back". */
  secondaryAction?: { label: string; onPress: () => void }
  /** Colours the title for a failed load rather than an empty one. */
  tone?: 'default' | 'destructive'
  style?: StyleProp<ViewStyle>
}

export function EmptyState({
  title,
  description,
  icon,
  action,
  secondaryAction,
  tone = 'default',
  style,
}: EmptyStateProps): React.ReactElement {
  const theme = useTheme()

  return (
    <View
      style={[
        {
          alignItems: 'center',
          justifyContent: 'center',
          paddingVertical: theme.spacing.xxxl,
          paddingHorizontal: theme.spacing.xl,
          gap: theme.spacing.md,
        },
        style,
      ]}
    >
      {icon ? <View style={{ marginBottom: theme.spacing.xs }}>{icon}</View> : null}

      <Text
        variant="heading"
        align="center"
        tone={tone === 'destructive' ? 'destructive' : 'default'}
        accessibilityRole="header"
      >
        {title}
      </Text>

      {description ? (
        <Text variant="body" tone="muted" align="center">
          {description}
        </Text>
      ) : null}

      {action || secondaryAction ? (
        <View style={{ flexDirection: 'row', gap: theme.spacing.md, marginTop: theme.spacing.sm }}>
          {action ? (
            <Button title={action.label} onPress={action.onPress} loading={action.loading ?? false} />
          ) : null}
          {secondaryAction ? (
            <Button title={secondaryAction.label} variant="outline" onPress={secondaryAction.onPress} />
          ) : null}
        </View>
      ) : null}
    </View>
  )
}
