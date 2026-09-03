/**
 * app/leaderboard.tsx
 *
 * The full ranking, in three scopes.
 *
 * A modal-ish stack screen rather than a tab: it is somewhere you go from the Panel tab and
 * come back from, not somewhere you live. The scope switch is local state here rather than a
 * query parameter — the web version uses the URL so a ranking can be pasted into a group chat,
 * and a phone has no URL bar to paste from.
 *
 * `/api/leaderboard` decides who is publishable — public, non-deleted, non-minor profiles with
 * at least one match — so this screen does no filtering and has none to get wrong. What it does
 * add is the explanation, because somebody missing from their own city's table needs to be told
 * it is a privacy setting rather than a bug.
 */

import { useRouter } from 'expo-router'
import * as React from 'react'
import { FlatList, Pressable, RefreshControl, View } from 'react-native'

import { Eyebrow, LeaderboardRow } from '@/components/progress'
import { EmptyState, Screen, Spinner, Text } from '@/components/ui'
import { ScreenHeader } from '@/components/profile'
import { describeErrorText } from '@/components/match'
import { loadLeaderboard } from '@/lib/progress'
import { useSession } from '@/lib/supabase'
import { useTheme } from '@/lib/theme'
import {
  LEADERBOARD_SCOPES,
  LEADERBOARD_SCOPE_LABELS,
  type LeaderboardEntry,
  type LeaderboardScope,
} from '@onpitch/shared/gamification'

const SCOPE_BLURB: Record<LeaderboardScope, string> = {
  xp: 'Toplam tecrübe puanı. Oynamak, kazanmak, gol atmak ve sonucu bildirmek puan kazandırır.',
  rating:
    'TrueSkill güven alt sınırı: ortalama beceriden belirsizliğin üç katı düşülür. Az maç oynayan yukarı çıkamaz.',
  streak: 'Üst üste maç yapılan hafta sayısı. Bir hafta boş geçerse sıfırlanır.',
}

export default function LeaderboardScreen(): React.ReactElement {
  const theme = useTheme()
  const router = useRouter()
  const { user } = useSession()

  const [scope, setScope] = React.useState<LeaderboardScope>('xp')
  const [entries, setEntries] = React.useState<LeaderboardEntry[]>([])
  const [loading, setLoading] = React.useState(true)
  const [refreshing, setRefreshing] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const load = React.useCallback(
    async (which: LeaderboardScope, mode: 'initial' | 'refresh') => {
      if (mode === 'initial') setLoading(true)
      else setRefreshing(true)
      setError(null)

      try {
        setEntries(await loadLeaderboard({ scope: which, limit: 50 }))
      } catch (caught) {
        setError(describeErrorText(caught, 'Sıralama yüklenemedi.'))
      } finally {
        setLoading(false)
        setRefreshing(false)
      }
    },
    [],
  )

  React.useEffect(() => {
    void load(scope, 'initial')
  }, [load, scope])

  return (
    <Screen padded={false} header={<ScreenHeader title="Sıralama" subtitle="Tecrübe, reyting ve seri" fallbackHref="/(tabs)/progress" />}>
      <View
        style={{
          paddingHorizontal: theme.spacing.lg,
          paddingTop: theme.spacing.md,
          gap: theme.spacing.md,
        }}
      >
        <View style={{ flexDirection: 'row', gap: theme.spacing.sm }} accessibilityRole="tablist">
          {LEADERBOARD_SCOPES.map((option) => {
            const selected = option === scope
            return (
              <Pressable
                key={option}
                accessibilityRole="tab"
                accessibilityState={{ selected }}
                onPress={() => setScope(option)}
                style={{
                  paddingVertical: theme.spacing.sm,
                  paddingHorizontal: theme.spacing.md,
                  borderBottomWidth: 2,
                  borderBottomColor: selected ? theme.colors.gold : 'transparent',
                }}
              >
                <Text
                  variant="caption"
                  weight="600"
                  tone={selected ? 'default' : 'muted'}
                  style={{ letterSpacing: 1.2, textTransform: 'uppercase' }}
                >
                  {LEADERBOARD_SCOPE_LABELS[option]}
                </Text>
              </Pressable>
            )
          })}
        </View>

        <Text variant="caption" tone="muted">
          {SCOPE_BLURB[scope]}
        </Text>
      </View>

      {loading && entries.length === 0 ? (
        <Spinner centred label="Sıralama yükleniyor" />
      ) : error !== null && entries.length === 0 ? (
        <EmptyState
          tone="destructive"
          title="Yüklenemedi"
          description={error}
          action={{ label: 'Tekrar dene', onPress: () => void load(scope, 'initial') }}
        />
      ) : (
        <FlatList
          style={{ flex: 1 }}
          data={entries}
          keyExtractor={(item) => item.playerId}
          renderItem={({ item }) => (
            <LeaderboardRow
              entry={item}
              scope={scope}
              isViewer={item.playerId === user?.id}
              onPress={(playerId) => router.push(`/player/${playerId}`)}
            />
          )}
          contentContainerStyle={{
            paddingHorizontal: theme.spacing.lg,
            paddingBottom: theme.spacing.xxxl,
            flexGrow: 1,
          }}
          ListHeaderComponent={
            <Eyebrow style={{ paddingVertical: theme.spacing.md }}>
              {LEADERBOARD_SCOPE_LABELS[scope]} · ilk {entries.length}
            </Eyebrow>
          }
          ListEmptyComponent={
            <EmptyState
              title="Sıralamada kimse yok"
              description="Görünmek için profilin herkese açık olmalı ve en az bir maçın sonuçlanmış olmalı."
            />
          }
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => void load(scope, 'refresh')}
              tintColor={theme.colors.mutedForeground}
              colors={[theme.colors.primary]}
              progressBackgroundColor={theme.colors.card}
            />
          }
          showsVerticalScrollIndicator={false}
        />
      )}
    </Screen>
  )
}
