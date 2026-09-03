/**
 * app/messages/with/[userId].tsx
 *
 * The target of every "Mesaj gönder" button: opens or finds the pair's thread through
 * `open_conversation()` and REPLACES itself with it, so the back gesture from the thread goes to
 * wherever the button was, not to this screen.
 *
 * A refusal shows one sentence and offers the way back. The reason is deliberately not surfaced
 * — a block is the blocker's business.
 */

import { useLocalSearchParams, useRouter } from 'expo-router'
import * as React from 'react'

import { isUuid } from '@onpitch/shared/channels'

import { ScreenHeader } from '@/components/profile'
import { EmptyState, Screen } from '@/components/ui'
import { MessagingError, openConversation } from '@/lib/messaging'

export default function OpenConversationScreen(): React.ReactElement {
  const router = useRouter()
  const params = useLocalSearchParams()
  const raw = Array.isArray(params.userId) ? params.userId[0] : params.userId
  const userId = typeof raw === 'string' && isUuid(raw) ? raw : null
  const [refused, setRefused] = React.useState<string | null>(null)

  React.useEffect(() => {
    let cancelled = false
    if (userId === null) {
      setRefused('Bu bir oyuncu bağlantısı değil.')
      return
    }
    openConversation(userId)
      .then((conversationId) => {
        if (!cancelled) router.replace(`/messages/${conversationId}`)
      })
      .catch((caught: unknown) => {
        if (cancelled) return
        setRefused(
          caught instanceof MessagingError && caught.code === 'PT429'
            ? 'Kısa sürede çok fazla yeni sohbet başlattın. Biraz sonra tekrar dene.'
            : 'Bu kişi şu an senden mesaj kabul etmiyor. Takım arkadaşların ve rezervasyon yaptığın işletmelerle her zaman yazışabilirsin.',
        )
      })
    return () => {
      cancelled = true
    }
  }, [router, userId])

  const goBack = (): void => {
    if (router.canGoBack()) router.back()
    else router.replace('/(tabs)/messages')
  }

  if (refused) {
    return (
      <Screen edges={['top', 'left', 'right', 'bottom']} header={<ScreenHeader title="Sohbet" fallbackHref="/(tabs)/messages" />}>
        <EmptyState title="Sohbet açılamadı" description={refused} action={{ label: 'Geri dön', onPress: goBack }} />
      </Screen>
    )
  }

  return <Screen edges={['top', 'left', 'right', 'bottom']} loading loadingLabel="Sohbet açılıyor" />
}
