/**
 * components/messaging/message-bubble.tsx
 *
 * One message. Yours sit right in your accent; theirs sit left on the quiet surface. A removed
 * message keeps its place and says why. Long-press for the actions (unsend yours, report theirs).
 */

import * as React from 'react'
import { Pressable, View } from 'react-native'

import { Text } from '@/components/ui'
import { formatTime } from '@/lib/format'
import { useTheme } from '@/lib/theme'
import { removedMessageLabel, type MessageView } from '@onpitch/shared/messaging'

export interface MessageBubbleProps {
  message: MessageView
  mine: boolean
  /** Only the last bubble of a run shows the time. */
  showTime: boolean
  onLongPress?: (message: MessageView) => void
}

export function MessageBubble({ message, mine, showTime, onLongPress }: MessageBubbleProps): React.ReactElement {
  const theme = useTheme()
  const removed = removedMessageLabel(message)

  return (
    <View style={{ alignItems: mine ? 'flex-end' : 'flex-start', maxWidth: '82%', alignSelf: mine ? 'flex-end' : 'flex-start' }}>
      <Pressable
        accessibilityRole="text"
        accessibilityLabel={removed ?? message.body}
        onLongPress={onLongPress && !removed && !message.pending ? () => onLongPress(message) : undefined}
        delayLongPress={300}
        style={({ pressed }) => ({
          paddingHorizontal: theme.spacing.md,
          paddingVertical: theme.spacing.sm + 2,
          borderRadius: theme.radius.xl + 6,
          borderBottomRightRadius: mine ? 2 : theme.radius.xl + 6,
          borderBottomLeftRadius: mine ? theme.radius.xl + 6 : 2,
          backgroundColor: removed ? theme.colors.secondary : mine ? theme.colors.user : theme.colors.secondary,
          opacity: message.pending ? 0.6 : pressed ? 0.85 : 1,
        })}
      >
        <Text
          variant="body"
          style={{
            color: removed ? theme.colors.mutedForeground : mine ? '#05070C' : theme.colors.foreground,
            fontStyle: removed ? 'italic' : 'normal',
          }}
        >
          {removed ?? message.body}
        </Text>
      </Pressable>
      {showTime ? (
        <Text variant="caption" tone="muted" style={{ marginTop: 2, fontSize: 10, letterSpacing: 0.8, textTransform: 'uppercase' }}>
          {message.pending ? 'gönderiliyor' : formatTime(message.createdAt, 'Europe/Istanbul')}
        </Text>
      ) : null}
    </View>
  )
}
