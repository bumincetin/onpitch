/**
 * app/(tabs)/messages.tsx
 *
 * The inbox tab. Threads newest first, kept current from the `conversations` stream; tapping
 * one pushes the thread onto the root stack.
 *
 * The name declared in `(tabs)/_layout.tsx` is `messages`, so this filename is load-bearing.
 */

import { useRouter } from 'expo-router'
import * as React from 'react'
import { FlatList, RefreshControl, View } from 'react-native'

import Animated from 'react-native-reanimated'

import { ConversationRow } from '@/components/messaging'
import { riseIn } from '@/lib/motion'
import { EmptyState, NightBand, Screen, Separator, Text } from '@/components/ui'
import { useConversations } from '@/lib/messaging'
import { useSession } from '@/lib/supabase'
import { useTheme } from '@/lib/theme'

export default function MessagesScreen(): React.ReactElement {
  const theme = useTheme()
  const router = useRouter()
  const { user } = useSession()
  const { items, loading, error, refresh } = useConversations()
  const [refreshing, setRefreshing] = React.useState(false)
  const viewerId = user?.id ?? ''

  const onRefresh = React.useCallback(async () => {
    setRefreshing(true)
    await refresh()
    setRefreshing(false)
  }, [refresh])

  if (loading && items.length === 0) {
    return <Screen loading loadingLabel="Sohbetler yükleniyor" />
  }

  if (error && items.length === 0) {
    return <Screen error={error} onRetry={() => void refresh()} />
  }

  return (
    <Screen padded={false}>
      <FlatList
        data={items}
        keyExtractor={(item) => item.id}
        renderItem={({ item, index }) => (
          <Animated.View entering={riseIn(index)}>
            <ConversationRow item={item} viewerId={viewerId} onPress={() => router.push(`/messages/${item.id}`)} />
          </Animated.View>
        )}
        ItemSeparatorComponent={() => <Separator inset={theme.spacing.lg + 40 + theme.spacing.md} />}
        ListHeaderComponent={
          <NightBand
            compact
            eyebrow="Mesajlar"
            title={items.length === 0 ? 'Sohbetlerin' : `${items.length} sohbet`}
            lede="Takım arkadaşların ve rezervasyon yaptığın işletmelerle. Kimlerin sana yazabileceğini Gizlilik ve veri'den seçersin."
            style={{ marginBottom: theme.spacing.sm }}
          />
        }
        ListEmptyComponent={
          <View style={{ padding: theme.spacing.lg }}>
            <EmptyState
              title="Henüz sohbet yok"
              description="Bir oyuncunun profilinden, bir kadro listesinden ya da bir rezervasyondan “Mesaj gönder” ile başla."
            />
          </View>
        }
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} tintColor={theme.colors.mutedForeground} colors={[theme.colors.user]} />
        }
        contentContainerStyle={{ paddingBottom: theme.spacing.xl }}
      />
    </Screen>
  )
}
