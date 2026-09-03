/**
 * components/messaging/conversation-row.tsx
 *
 * One thread in the inbox: who, what they last said, when, and whether there is anything new.
 * The avatar ring is THEIR accent; the unread count sits in YOURS.
 */

import * as React from 'react'
import { Pressable, View } from 'react-native'

import { Avatar, Text } from '@/components/ui'
import { formatDayLabel, formatTime } from '@/lib/format'
import { useTheme } from '@/lib/theme'
import type { ConversationSummary } from '@onpitch/shared/messaging'

export interface ConversationRowProps {
  item: ConversationSummary
  viewerId: string
  onPress: () => void
}

function whenLabel(iso: string | null): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const today = new Date()
  const sameDay = date.toDateString() === today.toDateString()
  return sameDay ? formatTime(iso, 'Europe/Istanbul') : formatDayLabel(iso, 'Europe/Istanbul')
}

export function ConversationRow({ item, viewerId, onPress }: ConversationRowProps): React.ReactElement {
  const theme = useTheme()
  const unread = item.unreadCount > 0
  const name = item.counterpart?.erased ? 'Silinmiş hesap' : (item.counterpart?.displayName ?? 'Oyuncu')
  const preview = item.lastMessage
    ? item.lastMessage.removed
      ? 'Mesaj kaldırıldı'
      : `${item.lastMessage.senderId === viewerId ? 'Sen: ' : ''}${item.lastMessage.body}`
    : 'Sohbet açıldı'

  return (
    <Pressable
      accessible
      accessibilityRole="button"
      accessibilityLabel={`${name}. ${preview}. ${unread ? `${item.unreadCount} okunmamış.` : ''}`}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.md,
        paddingHorizontal: theme.spacing.lg,
        paddingVertical: theme.spacing.md,
        borderLeftWidth: 2,
        borderLeftColor: unread ? theme.colors.user : 'transparent',
        backgroundColor: pressed ? theme.colors.secondary : 'transparent',
      })}
    >
      <Avatar uri={item.counterpart?.avatarUrl ?? null} name={name} size="md" accent={item.counterpart?.accentColor ?? null} />

      <View style={{ flex: 1, gap: 2 }}>
        <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: theme.spacing.sm }}>
          <Text variant="body" weight={unread ? '600' : '400'} numberOfLines={1} style={{ flex: 1 }}>
            {name}
          </Text>
          <Text variant="caption" tone="muted" style={{ letterSpacing: 0.8, textTransform: 'uppercase', fontSize: 10 }}>
            {whenLabel(item.lastMessageAt)}
          </Text>
        </View>
        <Text variant="caption" tone={unread ? 'default' : 'muted'} numberOfLines={1}>
          {preview}
          {item.mutedAt ? '  · sessiz' : ''}
        </Text>
      </View>

      {unread ? (
        <View style={{ minWidth: 20, paddingHorizontal: 6, height: 20, borderRadius: 2, backgroundColor: theme.colors.user, alignItems: 'center', justifyContent: 'center' }}>
          <Text variant="caption" weight="600" style={{ color: '#05070C', fontSize: 11 }}>
            {item.unreadCount > 9 ? '9+' : String(item.unreadCount)}
          </Text>
        </View>
      ) : null}
    </Pressable>
  )
}
