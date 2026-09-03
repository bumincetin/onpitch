/**
 * app/(tabs)/progress.tsx
 *
 * The Panel tab: level, streak, form, this week's objectives, badges and the ranking.
 *
 * ONE REQUEST, NOT SIX. `/api/progress` wraps `my_progress()`, which is a single round trip for
 * six tables plus the two writes that have to happen first — opening the week's challenges and
 * capturing this player's baseline. A phone on a train cannot afford six sequential reads on the
 * screen it opens most, and a client-side sync would give the app its own idea of what week it
 * is.
 *
 * The claim path is deliberately not optimistic about the OUTCOME. The row flips to collected
 * when the server says it did, because the server is the only thing that knows whether this tap
 * or the one on the laptop won the race. What is optimistic is the ordering: the row updates
 * before the refetch lands.
 *
 * The filename is `progress.tsx` because `(tabs)/_layout.tsx` declares
 * `<Tabs.Screen name="progress">` for this tab. Renaming this file drops the tab.
 */

import { useRouter } from 'expo-router'
import * as React from 'react'
import { RefreshControl, ScrollView, View } from 'react-native'

import {
  AchievementCard,
  ChallengeRow,
  CounterRow,
  Eyebrow,
  FormRow,
  LeaderboardRow,
  LevelPlate,
  SectionHead,
  StreakStrip,
  XpRow,
} from '@/components/progress'
import { Button, EmptyState, NightBand, Screen, Spinner, Text } from '@/components/ui'
import { describeErrorText } from '@/components/match'
import { claimChallenge, loadLeaderboard, loadProgress, type ProgressPayload } from '@/lib/progress'
import { useSession } from '@/lib/supabase'
import { useTheme } from '@/lib/theme'
import { formatXp, rankForLevel, type ChallengeState, type LeaderboardEntry } from '@onpitch/shared/gamification'

interface ScreenState {
  data: ProgressPayload | null
  leaders: LeaderboardEntry[]
  loading: boolean
  refreshing: boolean
  error: string | null
}

const INITIAL: ScreenState = {
  data: null,
  leaders: [],
  loading: true,
  refreshing: false,
  error: null,
}

/** How many badges the tab shows before sending the reader to the full cabinet. */
const BADGE_PREVIEW = 4
const LEADER_PREVIEW = 5

export default function ProgressScreen(): React.ReactElement {
  const theme = useTheme()
  const router = useRouter()
  const { user } = useSession()
  const userId = user?.id ?? null

  const [state, setState] = React.useState<ScreenState>(INITIAL)
  const [pending, setPending] = React.useState<string | null>(null)
  const [claimed, setClaimed] = React.useState<ReadonlySet<string>>(new Set())

  const load = React.useCallback(async (mode: 'initial' | 'refresh') => {
    setState((current) => ({
      ...current,
      loading: mode === 'initial',
      refreshing: mode === 'refresh',
      error: null,
    }))

    try {
      // The ranking is a separate, unauthenticated route and is allowed to fail on its own: an
      // empty leaderboard is a worse screen than no leaderboard, but neither is worth losing the
      // level and the objectives over.
      const [payload, leaders] = await Promise.all([
        loadProgress(),
        loadLeaderboard({ scope: 'xp', limit: LEADER_PREVIEW }).catch(() => []),
      ])
      setState({ data: payload, leaders, loading: false, refreshing: false, error: null })
    } catch (caught) {
      setState((current) => ({
        ...current,
        loading: false,
        refreshing: false,
        error: describeErrorText(caught, 'İlerlemen yüklenemedi.'),
      }))
    }
  }, [])

  React.useEffect(() => {
    // A different account is a different set of everything.
    setState(INITIAL)
    setClaimed(new Set())
    void load('initial')
  }, [load, userId])

  const claim = React.useCallback(
    async (challenge: ChallengeState) => {
      setPending(challenge.id)
      try {
        const result = await claimChallenge(challenge.id)
        if (result.claimed) setClaimed((current) => new Set(current).add(challenge.id))
        await load('refresh')
      } catch {
        // Nothing is lost by a failed claim: the reward is still sitting there. A silent retry
        // on the next pull-to-refresh beats an alert the player has to dismiss.
        setState((current) => ({
          ...current,
          error: 'Ödül alınamadı. Aşağı çekip tekrar dene.',
        }))
      } finally {
        setPending(null)
      }
    },
    [load],
  )

  if (state.loading && !state.data) {
    return (
      <Screen>
        <Spinner centred label="İlerlemen yükleniyor" />
      </Screen>
    )
  }

  if (!state.data) {
    return (
      <Screen>
        <EmptyState
          tone="destructive"
          title="Yüklenemedi"
          description={state.error ?? undefined}
          action={{ label: 'Tekrar dene', onPress: () => void load('initial') }}
        />
      </Screen>
    )
  }

  const { progress, form, nextFixture } = state.data
  const rank = rankForLevel(progress.level)
  const gap = theme.spacing.xxl

  return (
    <Screen padded={false}>
      <ScrollView
        contentContainerStyle={{ padding: theme.spacing.lg, paddingBottom: theme.spacing.xxxl, gap }}
        refreshControl={
          <RefreshControl
            refreshing={state.refreshing}
            onRefresh={() => void load('refresh')}
            tintColor={theme.colors.mutedForeground}
            colors={[theme.colors.primary]}
            progressBackgroundColor={theme.colors.card}
          />
        }
        showsVerticalScrollIndicator={false}
      >
        {state.error ? (
          <Text variant="caption" tone="destructive" accessibilityLiveRegion="polite">
            {state.error}
          </Text>
        ) : null}

        {/* ------------------------------------------------------------ level */}
        <NightBand
          bleed={theme.spacing.lg}
          eyebrow={`Panel · ${rank.tr}`}
          title="Tekrar hoş geldin"
          lede={`Sonraki seviyeye ${formatXp(Math.max(0, progress.nextLevelAt - progress.xp))} XP kaldı.`}
          style={{ marginTop: -theme.spacing.lg }}
        >
          <LevelPlate xp={progress.xp} level={progress.level} />
          <CounterRow
            matches={progress.counters.matchesPlayed}
            wins={progress.counters.matchesWon}
            goals={progress.counters.goals}
            assists={progress.counters.assists}
          />
          <View style={{ flexDirection: 'row', gap: theme.spacing.lg }}>
            <View style={{ flex: 1 }}>
              <StreakStrip
                weeks={progress.currentStreakWeeks}
                longest={progress.longestStreakWeeks}
                lastPlayedOn={progress.lastPlayedOn}
              />
            </View>
            <View style={{ flex: 1 }}>
              <FormRow results={form} />
            </View>
          </View>
        </NightBand>

        {/* --------------------------------------------------------- fixture */}
        <View style={{ gap: theme.spacing.md }}>
          <SectionHead n="01" title="Sıradaki maç" />
          {nextFixture ? (
            <View style={{ gap: theme.spacing.sm }}>
              <Text variant="title" weight="300">
                {formatKickoff(nextFixture.kickoffAt, nextFixture.timezone)}
              </Text>
              <Text variant="caption" tone="muted">
                {nextFixture.venueName ?? 'Saha bilgisi yok'}
                {nextFixture.city ? ` · ${nextFixture.city}` : ''}
                {nextFixture.side ? ` · ${nextFixture.side === 'home' ? 'Ev sahibi' : 'Deplasman'}` : ''}
              </Text>
              <View style={{ alignSelf: 'flex-start', marginTop: theme.spacing.sm }}>
                <Button
                  size="sm"
                  variant="outline"
                  title="Maçı aç"
                  onPress={() => router.push(`/match/${nextFixture.matchId}`)}
                />
              </View>
            </View>
          ) : (
            <View style={{ gap: theme.spacing.md }}>
              <Text variant="caption" tone="muted">
                Takvimin boş. Saha ara, saati kilitle, kadroyu topla.
              </Text>
              <View style={{ alignSelf: 'flex-start' }}>
                <Button size="sm" title="Saha ara" onPress={() => router.push('/(tabs)/book')} />
              </View>
            </View>
          )}
        </View>

        {/* ------------------------------------------------------ challenges */}
        <View style={{ gap: theme.spacing.sm }}>
          <SectionHead
            n="02"
            title="Bu haftanın görevleri"
            aside={
              <Eyebrow>
                {progress.challenges.filter((c) => c.completedAt !== null).length} /{' '}
                {progress.challenges.length}
              </Eyebrow>
            }
          />
          {progress.challenges.length === 0 ? (
            <Text variant="caption" tone="muted">
              Bu hafta için görev açılmamış. Pazartesi yenileri gelir.
            </Text>
          ) : (
            progress.challenges.map((challenge, index) => (
              <ChallengeRow
                key={challenge.id}
                challenge={challenge}
                index={index}
                claimed={claimed.has(challenge.id)}
                pending={pending === challenge.id}
                onClaim={claim}
              />
            ))
          )}
        </View>

        {/* ----------------------------------------------------- achievements */}
        <View style={{ gap: theme.spacing.sm }}>
          <SectionHead
            n="03"
            title="Rozetler"
            aside={
              <Eyebrow>
                {progress.achievements.filter((a) => a.unlockedAt !== null).length} /{' '}
                {progress.achievements.length}
              </Eyebrow>
            }
          />
          {sortForPreview(progress.achievements)
            .slice(0, BADGE_PREVIEW)
            .map((achievement) => (
              <AchievementCard key={achievement.code} achievement={achievement} />
            ))}
          <View style={{ alignSelf: 'flex-start', marginTop: theme.spacing.sm }}>
            <Button
              size="sm"
              variant="ghost"
              title="Tüm rozetler →"
              onPress={() => router.push('/achievements')}
            />
          </View>
        </View>

        {/* ------------------------------------------------------ leaderboard */}
        <View style={{ gap: theme.spacing.sm }}>
          <SectionHead n="04" title="Sıralama" aside={<Eyebrow>Tecrübe</Eyebrow>} />
          {state.leaders.length === 0 ? (
            <Text variant="caption" tone="muted">
              Sıralamada henüz kimse yok. Görünmek için profilini herkese açık yapmalısın.
            </Text>
          ) : (
            state.leaders.map((entry) => (
              <LeaderboardRow
                key={entry.playerId}
                entry={entry}
                scope="xp"
                isViewer={entry.playerId === userId}
                onPress={(playerId) => router.push(`/player/${playerId}`)}
              />
            ))
          )}
          <View style={{ flexDirection: 'row', gap: theme.spacing.sm, marginTop: theme.spacing.sm }}>
            <Button
              size="sm"
              variant="ghost"
              title="Tüm sıralama →"
              onPress={() => router.push('/leaderboard')}
            />
            <Button
              size="sm"
              variant="ghost"
              title="Ligler →"
              onPress={() => router.push('/leagues')}
            />
          </View>
        </View>

        {/* ----------------------------------------------------------- ledger */}
        <View style={{ gap: theme.spacing.sm }}>
          <SectionHead n="05" title="Puan defteri" />
          {progress.recentEvents.length === 0 ? (
            <Text variant="caption" tone="muted">
              Henüz puan hareketin yok. İlk maçından sonra burada görünür.
            </Text>
          ) : (
            progress.recentEvents.map((event) => <XpRow key={event.id} event={event} />)
          )}
        </View>
      </ScrollView>
    </Screen>
  )
}

/* ========================================================================== */

/**
 * Unlocked first, then whatever is closest to unlocking — so the four on this tab are either a
 * reward or the next one within reach. The full cabinet groups by tier instead, because
 * somebody who opens that screen is browsing rather than checking.
 */
function sortForPreview<T extends { unlockedAt: string | null; progress: number; target: number }>(
  achievements: readonly T[],
): T[] {
  return [...achievements].sort((a, b) => {
    const aUnlocked = a.unlockedAt !== null
    const bUnlocked = b.unlockedAt !== null
    if (aUnlocked !== bUnlocked) return aUnlocked ? -1 : 1
    if (aUnlocked && bUnlocked) return (b.unlockedAt ?? '').localeCompare(a.unlockedAt ?? '')
    return b.progress / b.target - a.progress / a.target
  })
}

/**
 * The kick-off in the VENUE's zone, not the phone's. A fixture at 21:00 in Istanbul is at 21:00
 * for everyone going to it, whatever the device thinks.
 */
function formatKickoff(iso: string, timeZone: string | null): string {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return 'Tarih okunamadı'

  const options: Intl.DateTimeFormatOptions = {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  }

  try {
    return new Intl.DateTimeFormat('tr-TR', {
      ...options,
      ...(timeZone ? { timeZone } : {}),
    }).format(new Date(at))
  } catch {
    // An unknown IANA zone out of the database must not take the card down with it.
    return new Intl.DateTimeFormat('tr-TR', options).format(new Date(at))
  }
}
