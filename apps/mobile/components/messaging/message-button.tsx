/**
 * components/messaging/message-button.tsx
 *
 * "Mesaj gönder". Pushes `/messages/with/[userId]`, which opens or finds the thread and replaces
 * itself with it — the phone's version of the web's redirecting link, so a profile, a booking
 * or a venue page needs one line to offer a conversation.
 *
 * Render it only after `canMessage()` said yes. The target checks again.
 */

import { useRouter } from 'expo-router'
import * as React from 'react'

import { Button, type ButtonProps } from '@/components/ui'

export interface MessageButtonProps extends Partial<Omit<ButtonProps, 'onPress' | 'title'>> {
  userId: string
  title?: string
}

export function MessageButton({ userId, title = 'Mesaj gönder', variant = 'primary', ...rest }: MessageButtonProps): React.ReactElement {
  const router = useRouter()
  return <Button title={title} variant={variant} onPress={() => router.push(`/messages/with/${userId}`)} {...rest} />
}
