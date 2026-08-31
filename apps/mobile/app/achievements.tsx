/**
 * app/achievements.tsx
 *
 * The whole badge cabinet, grouped by tier.
 *
 * Grouping by tier here is the opposite of what the Panel tab does, and both are right. On the
 * tab the useful order is "what is nearly done"; on this screen it is "what is there", because
 * somebody who opens it is browsing rather than checking.
 *
 * It reads `/api/progress` again rather than being handed the tab's copy. A screen that depends
 * on another screen having loaded first breaks the moment somebody arrives here from a push
 * notification, which is exactly what `progress.achievement` notifications do.
 */

import * as React from 'react'
import { RefreshControl, ScrollView, View } from 'react-native'

import { AchievementCard, Measure, SectionHead } from '@/components/progress'
import { EmptyState, Screen, Spinner, Text } from '@/components/ui'
import { ScreenHeader } from '@/components/profile'
import { describeErrorText } from '@/components/match'
import { loadProgress } from '@/lib/progress'
import { useTheme } from '@/lib/theme'
import {
  ACHIEVEMENT_TIERS,
  TIER_LABELS,
  formatXp,
  type AchievementState,
  type AchievementTier,
} from '@halisaha/shared/gamification'

const TIER_NUMBER: Record<AchievementTier, string> = {
  bronze: '01',
  silver: '02',
  gold: '03',
  platinum: '04',
}

export default function AchievementsScreen(): React.ReactElement {
  const theme = useTheme()

  const [achievements, setAchievements] = React.useState<AchievementState[]>([])
  const [level, setLevel] = React.useState(1)
  const [loading, setLoading] = React.useState(true)
  const [refreshing, setRefreshing] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const load = React.useCallback(async (mode: 'initial' | 'refresh') => {
    if (mode === 'initial') setLoading(true)
    else setRefreshing(true)
    setError(null)

    try {
      const payload = await loadProgress()
      setAchievements(payload.progress.achievements)
      setLevel(payload.progress.level)
    } catch (caught) {
      setError(describeErrorText(caught, 'Rozetler yüklenemedi.'))
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  React.useEffect(() => {
    void load('initial')
  }, [load])

  if (loading && achievements.length === 0) {
    return (
      <Screen header={<ScreenHeader title="Rozetler" subtitle="Kazanılan ve kazanılabilecek" fallbackHref="/(tabs)/progress" />}>
        <Spinner centred label="Rozetler yükleniyor" />
      </Screen>
    )
  }

  if (achievements.length === 0) {
    return (
      <Screen header={<ScreenHeader title="Rozetler" subtitle="Kazanılan ve kazanılabilecek" fallbackHref="/(tabs)/progress" />}>
        <EmptyState
          tone="destructive"
          title="Yüklenemedi"
          description={error ?? undefined}
          action={{ label: 'Tekrar dene', onPress: () => void load('initial') }}
        />
      </Screen>
    )
  }

  const unlocked = achievements.filter((a) => a.unlockedAt !== null)
  const earnedXp = unlocked.reduce((sum, a) => sum + a.xpReward, 0)
  const availableXp = achievements.reduce((sum, a) => sum + a.xpReward, 0)

  return (
    <Screen padded={false} header={<ScreenHeader title="Rozetler" subtitle="Kazanılan ve kazanılabilecek" fallbackHref="/(tabs)/progress" />}>
      <ScrollView
        contentContainerStyle={{
          padding: theme.spacing.lg,
          paddingBottom: theme.spacing.xxxl,
          gap: theme.spacing.xxl,
        }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void load('refresh')}
            tintColor={theme.colors.mutedForeground}
            colors={[theme.colors.primary]}
            progressBackgroundColor={theme.colors.card}
          />
        }
        showsVerticalScrollIndicator={false}
      >
        {error ? (
          <Text variant="caption" tone="destructive" accessibilityLiveRegion="polite">
            {error}
          </Text>
        ) : null}

        <View style={{ flexDirection: 'row', gap: theme.spacing.lg }}>
          <Measure
            label="Kazanılan"
            value={`${unlocked.length} / ${achievements.length}`}
            style={{ flex: 1 }}
          />
          <Measure label="Rozet XP" value={formatXp(earnedXp)} tone="gold" style={{ flex: 1 }} />
          <Measure
            label="Kalan"
            value={formatXp(Math.max(0, availableXp - earnedXp))}
            style={{ flex: 1 }}
          />
          <Measure label="Seviye" value={level} style={{ flex: 1 }} />
        </View>

        {ACHIEVEMENT_TIERS.map((tier) => {
          const inTier = achievements.filter((a) => a.tier === tier)
          if (inTier.length === 0) return null
          const done = inTier.filter((a) => a.unlockedAt !== null).length

          return (
            <View key={tier} style={{ gap: theme.spacing.sm }}>
              <SectionHead
                n={TIER_NUMBER[tier]}
                title={TIER_LABELS[tier]}
                aside={
                  <Text variant="caption" tone="muted" style={{ fontVariant: ['tabular-nums'] }}>
                    {done} / {inTier.length}
                  </Text>
                }
              />
              {inTier.map((achievement) => (
                <AchievementCard key={achievement.code} achievement={achievement} />
              ))}
            </View>
          )
        })}
      </ScrollView>
    </Screen>
  )
}
