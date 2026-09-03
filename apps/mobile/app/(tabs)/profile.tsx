/**
 * app/(tabs)/profile.tsx
 *
 * Your own profile: who you are, what the rating model thinks of you, and the matches behind it.
 *
 * The name declared in `(tabs)/_layout.tsx` is `profile`, so this filename is load-bearing —
 * renaming it drops the tab from the bar.
 *
 * Two things this screen owns beyond rendering:
 *
 *   * The unread count, for the "Notifications" row below. The TAB BADGE is not published from
 *     here: `lazy` defaults to true in @react-navigation/bottom-tabs, so this screen does not
 *     mount until the tab is first opened and a badge set here never appears on a cold launch.
 *     `(tabs)/_layout.tsx` owns it. The count is a shared subscription, so asking for it in both
 *     places costs one channel.
 *   * The consent banner. It appears for `pending` and `revoked` and says what is blocked; the
 *     blocking itself is `private.assert_consented()` in Postgres, not anything here.
 */

import { useFocusEffect, useRouter } from 'expo-router'
import * as React from 'react'
import { RefreshControl, View } from 'react-native'

import {
  Avatar,
  Badge,
  Button,
  Card,
  Notice,
  Screen,
  Separator,
  Text,
} from '@/components/ui'
import {
  ConsentBanner,
  FormStrip,
  HISTORY_LIMIT,
  MatchHistory,
  ProfileCard,
  RatingCard,
  StatsGrid,
  displayNameOf,
  loadPlayerHistory,
  useMyProfile,
  type PlayerHistory,
} from '@/components/profile'
import { profileStyleOf } from '@onpitch/shared/profile'
import { useUnreadNotifications } from '@/lib/hooks/use-notifications'
import { useSession } from '@/lib/supabase'
import { useTheme } from '@/lib/theme'

export default function ProfileScreen(): React.ReactElement {
  const theme = useTheme()
  const router = useRouter()

  const { user, signOut } = useSession()
  const { profile, loading: profileLoading, error: profileError, refresh: refreshProfile } =
    useMyProfile()
  const unread = useUnreadNotifications()

  const [history, setHistory] = React.useState<PlayerHistory | null>(null)
  const [historyLoading, setHistoryLoading] = React.useState(true)
  const [historyError, setHistoryError] = React.useState<string | null>(null)
  const [refreshing, setRefreshing] = React.useState(false)

  const userId = user?.id ?? null

  /* -------------------------------------------------------------- history -- */

  const loadHistory = React.useCallback(async (id: string | null): Promise<void> => {
    if (id === null) {
      setHistory(null)
      setHistoryLoading(false)
      return
    }

    try {
      setHistoryError(null)
      const next = await loadPlayerHistory(id, HISTORY_LIMIT)
      setHistory(next)
    } catch (caught) {
      setHistory(null)
      setHistoryError(
        caught instanceof Error ? caught.message : 'Maçların yüklenemedi. Yenilemek için aşağı çek.',
      )
    } finally {
      setHistoryLoading(false)
    }
  }, [])

  React.useEffect(() => {
    setHistoryLoading(userId !== null)
    void loadHistory(userId)
  }, [loadHistory, userId])

  // Coming back from settings or from a match should not show a stale rating. `useFocusEffect`
  // fires on the FIRST focus too, which the effect above has already covered, so the first run is
  // skipped rather than firing the same two queries twice on mount.
  const focusedOnceRef = React.useRef(false)
  useFocusEffect(
    React.useCallback(() => {
      if (!focusedOnceRef.current) {
        focusedOnceRef.current = true
        return
      }
      void loadHistory(userId)
    }, [loadHistory, userId]),
  )

  const refreshUnread = unread.refresh

  const refreshAll = React.useCallback(async (): Promise<void> => {
    setRefreshing(true)
    await Promise.all([refreshProfile(), loadHistory(userId), refreshUnread()])
    setRefreshing(false)
  }, [loadHistory, refreshProfile, refreshUnread, userId])

  /* --------------------------------------------------------------- render -- */

  const name = displayNameOf(profile, user?.email ?? 'Your profile')
  const entries = history?.entries ?? []

  if (profileLoading && profile === null && historyLoading) {
    return <Screen loading loadingLabel="Loading your profile" />
  }

  return (
    <Screen
      scroll
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => void refreshAll()}
          tintColor={theme.colors.mutedForeground}
          colors={[theme.colors.primary]}
        />
      }
    >
      {profileError ? (
        <Notice tone="destructive" title="Hesap bilgilerin yüklenemedi" live>
          <Text variant="body" tone="muted">
            {profileError}
          </Text>
          <Button title="Tekrar dene" size="sm" variant="outline" onPress={() => void refreshProfile()} />
        </Notice>
      ) : null}

      {/* ------------------------------------------------------------ the card -- */}
      <ProfileCard
        name={name}
        avatarUrl={profile?.avatar_url ?? null}
        style={profileStyleOf(profile ?? {})}
        city={profile?.city}
        position={profile?.preferred_position}
        role={profile?.role}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm, flexWrap: 'wrap' }}>
          <Badge tone="outline" size="sm">
            {roleLabel(profile?.role ?? null)}
          </Badge>
          {profile?.is_minor === true ? (
            <Badge tone="neutral" size="sm">
              16 yaş altı
            </Badge>
          ) : null}
          <View style={{ flex: 1 }} />
          <Button title="Kartını düzenle" size="sm" variant="outline" onPress={() => router.push('/settings/style')} />
        </View>
      </ProfileCard>

      {profile ? (
        <ConsentBanner
          status={profile.parental_consent_status}
          guardianName={profile.guardian_name}
          guardianEmail={profile.guardian_email}
        />
      ) : null}

      {/* -------------------------------------------------------------- form -- */}
      <Card title="Form" subtitle="Son beş kesinleşmiş sonucun, en yenisi önce">
        <FormStrip entries={entries} />
      </Card>

      <RatingCard rating={history?.rating ?? null} />

      <StatsGrid
        matchesPlayed={history?.rating?.matches_played ?? 0}
        wins={history?.rating?.wins ?? 0}
        draws={history?.rating?.draws ?? 0}
        losses={history?.rating?.losses ?? 0}
        goals={history?.goals ?? null}
        assists={history?.assists ?? null}
        windowLabel={
          history && history.window > 0 ? `In your last ${history.window} matches` : undefined
        }
      />

      <MatchHistory
        entries={entries}
        loading={historyLoading}
        error={historyError}
        onRetry={() => void loadHistory(userId)}
        emptyTitle="No matches yet"
        emptyDescription="Join a match from the Matches tab and it turns up here with the rating it moved."
      />

      {/* ------------------------------------------------------------- links -- */}
      <Card flush contentStyle={{ gap: 0 }}>
        <NavRow label="Kartın" hint="Rengin, karen, numaran, sloganın" onPress={() => router.push('/settings/style')} />
        <Separator inset={theme.spacing.lg} />
        <NavRow label="Mesajlar" hint="Takım arkadaşların ve işletmelerle" onPress={() => router.push('/(tabs)/messages')} />
        <Separator inset={theme.spacing.lg} />
        <NavRow label="Takımlarım" hint="Oynadığın kadrolar" onPress={() => router.push('/teams')} />
        <Separator inset={theme.spacing.lg} />
        <NavRow
          label="Bildirimler"
          hint={unread.count === 0 ? 'Nothing unread' : `${unread.count} unread`}
          onPress={() => router.push('/settings/notifications')}
        />
        <Separator inset={theme.spacing.lg} />
        <NavRow
          label="Gizlilik ve veri"
          hint="Görünürlük, onay, dışa aktarma ve silme"
          onPress={() => router.push('/settings/privacy')}
        />
        <Separator inset={theme.spacing.lg} />
        <NavRow
          label="Hesap ayarları"
          hint="Ad, şehir, mevki ve hakkında"
          onPress={() => router.push('/settings')}
        />
      </Card>

      <Button title="Çıkış yap" variant="outline" fullWidth onPress={() => void signOut()} />
    </Screen>
  )
}

function roleLabel(role: string | null): string {
  if (role === 'admin') return 'Yönetici'
  if (role === 'venue_owner') return 'İşletme sahibi'
  return 'Oyuncu'
}

interface NavRowProps {
  label: string
  hint: string
  onPress: () => void
}

/** A settings row: label, one line of context, and a chevron. */
function NavRow({ label, hint, onPress }: NavRowProps): React.ReactElement {
  const theme = useTheme()

  return (
    <Card
      flush
      onPress={onPress}
      accessibilityLabel={`${label}. ${hint}.`}
      style={{ borderWidth: 0, borderRadius: 0, backgroundColor: 'transparent' }}
      contentStyle={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.md,
        paddingHorizontal: theme.spacing.lg,
        paddingVertical: theme.spacing.md,
      }}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="body" weight="600">
          {label}
        </Text>
        <Text variant="caption" tone="muted">
          {hint}
        </Text>
      </View>
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{
          width: 9,
          height: 9,
          borderRightWidth: 2,
          borderTopWidth: 2,
          borderColor: theme.colors.mutedForeground,
          transform: [{ rotate: '45deg' }],
        }}
      />
    </Card>
  )
}
