/**
 * app/player/[id].tsx
 *
 * Somebody else's profile: the card they designed, whether you can write to them, the rating
 * the model holds, and the matches behind it.
 *
 * WHAT IS VISIBLE IS DECIDED IN POSTGRES, AND THE TWO TABLES DISAGREE ON PURPOSE
 * -----------------------------------------------------------------------------
 * `profiles_select_self_or_visible` admits you, admins, active teammates, and adults whose
 * `profile_visibility` is `public` or `members`. A minor's profile is never visible to a stranger.
 * `player_ratings`, by contrast, is world-readable to any signed-in user — mu and sigma are not
 * identifying. So the honest outcome for a private account is "rating visible, person not", and
 * that is what this screen renders: an explained partial state, not an error.
 *
 * "Mesaj gönder" appears only when `can_message()` says so; the block control is always there
 * for a visible stranger, because being able to shut somebody out must not depend on whether
 * they could reach you in the first place.
 */

import { useLocalSearchParams, useRouter } from 'expo-router'
import * as React from 'react'
import { Alert, RefreshControl, View } from 'react-native'

import { isUuid } from '@onpitch/shared/channels'
import { profileStyleOf } from '@onpitch/shared/profile'

import { MessageButton } from '@/components/messaging'
import { Badge, Button, Card, EmptyState, Notice, Screen, Text } from '@/components/ui'
import {
  FormStrip,
  HISTORY_LIMIT,
  MatchHistory,
  ProfileCard,
  RatingCard,
  ScreenHeader,
  StatsGrid,
  loadPlayerHistory,
  type PlayerHistory,
} from '@/components/profile'
import { dataError } from '@/lib/data-error'
import { formatDayLabel } from '@/lib/format'
import { MessagingError, blockUser, canMessage, isBlocked, unblockUser } from '@/lib/messaging'
import { supabase, useSession } from '@/lib/supabase'
import { useTheme } from '@/lib/theme'

const PROFILE_COLUMNS =
  'id, display_name, full_name, avatar_url, role, city, preferred_position, bio, profile_visibility, created_at, accent_color, banner_shot, tagline, jersey_number, dominant_foot'

interface VisibleProfile {
  id: string
  display_name: string | null
  full_name: string | null
  avatar_url: string | null
  role: string
  city: string | null
  preferred_position: string | null
  bio: string | null
  profile_visibility: string
  created_at: string
  accent_color: string
  banner_shot: string
  tagline: string | null
  jersey_number: number | null
  dominant_foot: string | null
}

interface PlayerPageData {
  profile: VisibleProfile | null
  history: PlayerHistory
  canMessage: boolean
  blocked: boolean
}

export default function PlayerScreen(): React.ReactElement {
  const theme = useTheme()
  const router = useRouter()
  const { user } = useSession()

  const params = useLocalSearchParams()
  const raw = Array.isArray(params.id) ? params.id[0] : params.id
  const playerId = typeof raw === 'string' && isUuid(raw) ? raw.toLowerCase() : null
  const isSelf = user?.id?.toLowerCase() === playerId

  const [data, setData] = React.useState<PlayerPageData | null>(null)
  const [loading, setLoading] = React.useState(playerId !== null)
  const [error, setError] = React.useState<string | null>(null)
  const [refreshing, setRefreshing] = React.useState(false)
  const [blockBusy, setBlockBusy] = React.useState(false)

  const load = React.useCallback(
    async (id: string | null): Promise<void> => {
      if (id === null) {
        setLoading(false)
        return
      }
      setError(null)
      try {
        const [profileResult, history, allowed, blocked] = await Promise.all([
          supabase.from('profiles').select(PROFILE_COLUMNS).eq('id', id).maybeSingle(),
          loadPlayerHistory(id, HISTORY_LIMIT),
          isSelf ? Promise.resolve(false) : canMessage(id),
          isSelf || !user?.id ? Promise.resolve(false) : isBlocked(user.id, id),
        ])
        if (profileResult.error) throw dataError('Could not load that player.', profileResult.error)
        setData({ profile: profileResult.data as VisibleProfile | null, history, canMessage: allowed, blocked })
      } catch (caught) {
        setData(null)
        setError(caught instanceof Error ? caught.message : 'Bu oyuncu yüklenemedi.')
      } finally {
        setLoading(false)
      }
    },
    [isSelf, user?.id],
  )

  React.useEffect(() => {
    setLoading(playerId !== null)
    void load(playerId)
  }, [load, playerId])

  const goBack = React.useCallback((): void => {
    if (router.canGoBack()) router.back()
    else router.replace('/(tabs)')
  }, [router])

  const refresh = React.useCallback(async (): Promise<void> => {
    setRefreshing(true)
    await load(playerId)
    setRefreshing(false)
  }, [load, playerId])

  const toggleBlock = React.useCallback(async (): Promise<void> => {
    if (!data || playerId === null) return
    const name = data.profile?.display_name ?? data.profile?.full_name ?? 'Bu kişi'
    const run = async (): Promise<void> => {
      setBlockBusy(true)
      try {
        if (data.blocked) await unblockUser(playerId)
        else await blockUser(playerId)
        setData((current) => (current ? { ...current, blocked: !current.blocked } : current))
      } catch (caught) {
        Alert.alert('Olmadı', caught instanceof MessagingError ? caught.message : 'Bu işlem tamamlanamadı.')
      } finally {
        setBlockBusy(false)
      }
    }
    if (data.blocked) {
      void run()
      return
    }
    Alert.alert(`${name} engellensin mi?`, 'Sana yazamaz, sen de ona yazamazsın. İstediğin zaman kaldırabilirsin.', [
      { text: 'Vazgeç', style: 'cancel' },
      { text: 'Engelle', style: 'destructive', onPress: () => void run() },
    ])
  }, [data, playerId])

  /* ------------------------------------------------------------ states -- */

  if (playerId === null) {
    return (
      <Screen edges={['top', 'left', 'right', 'bottom']} header={<ScreenHeader title="Oyuncu" />}>
        <EmptyState title="Bu bir oyuncu bağlantısı değil" description="Bağlantıdaki kimlik geçerli bir oyuncu kimliği değil." action={{ label: 'Geri dön', onPress: goBack }} />
      </Screen>
    )
  }
  if (loading && data === null) {
    return <Screen edges={['top', 'left', 'right', 'bottom']} header={<ScreenHeader title="Oyuncu" />} loading loadingLabel="Oyuncu yükleniyor" />
  }
  if (error && data === null) {
    return <Screen edges={['top', 'left', 'right', 'bottom']} header={<ScreenHeader title="Oyuncu" />} error={error} onRetry={() => void load(playerId)} />
  }

  const profile = data?.profile ?? null
  const history = data?.history ?? null
  const rating = history?.rating ?? null
  const entries = history?.entries ?? []

  if (profile === null && rating === null) {
    return (
      <Screen edges={['top', 'left', 'right', 'bottom']} header={<ScreenHeader title="Oyuncu" />}>
        <EmptyState title="Burada oyuncu yok" description="Bu hesap ya yok ya da silinmiş." action={{ label: 'Geri dön', onPress: goBack }} />
      </Screen>
    )
  }

  const name = profile?.display_name?.trim() || profile?.full_name?.trim() || 'Gizli profil'
  const isPrivate = profile === null

  return (
    <Screen
      edges={['top', 'left', 'right', 'bottom']}
      scroll
      header={<ScreenHeader title={isPrivate ? 'Oyuncu' : name} />}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={theme.colors.mutedForeground} colors={[theme.colors.user]} />}
    >
      {/* ------------------------------------------------------------ the card -- */}
      <ProfileCard
        name={name}
        avatarUrl={profile?.avatar_url ?? null}
        style={profileStyleOf(profile ?? {})}
        city={profile?.city}
        position={profile?.preferred_position}
        role={profile?.role}
      >
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: theme.spacing.sm }}>
          {isSelf ? <Badge tone="neutral" size="sm">Bu sensin</Badge> : null}
          {profile ? <Badge tone="outline" size="sm">{`Üye · ${formatDayLabel(profile.created_at)}`}</Badge> : null}
          <View style={{ flex: 1 }} />
          {isSelf ? (
            <Button title="Kartını düzenle" size="sm" variant="outline" onPress={() => router.push('/settings/style')} />
          ) : profile && data ? (
            <>
              {data.canMessage && !data.blocked ? <MessageButton userId={playerId} size="sm" /> : null}
              <Button title={data.blocked ? 'Engeli kaldır' : 'Engelle'} size="sm" variant={data.blocked ? 'outline' : 'ghost'} loading={blockBusy} onPress={() => void toggleBlock()} />
            </>
          ) : null}
        </View>
        {profile && data && !isSelf && !data.canMessage && !data.blocked ? (
          <Text variant="caption" style={{ color: 'rgba(246,241,231,0.6)' }}>
            Bu kişi tanımadığı üyelerden mesaj almıyor. Aynı takımda oynadığınızda yazabilirsin.
          </Text>
        ) : null}
      </ProfileCard>

      {isPrivate ? (
        <Notice tone="info" title="Bu profil gizli">
          <Text variant="body" tone="muted">
            Bu oyuncu profilini görünür yapmamış. Reytingi yine de görünür; çünkü mu ve sigma tek başına kimseyi tanımlamaz. Aynı takımda bir maç oyna; profili sana otomatik olarak açılır.
          </Text>
        </Notice>
      ) : profile?.bio ? (
        <Card title="Hakkında">
          <Text variant="body">{profile.bio}</Text>
        </Card>
      ) : null}

      <Card title="Form" subtitle="Son beş kesinleşmiş sonuç, en yenisi önce">
        <FormStrip entries={entries} />
      </Card>

      <RatingCard rating={rating} playerName={isPrivate ? 'Bu oyuncu' : name} />

      <StatsGrid
        matchesPlayed={rating?.matches_played ?? 0}
        wins={rating?.wins ?? 0}
        draws={rating?.draws ?? 0}
        losses={rating?.losses ?? 0}
        goals={history ? history.goals : null}
        assists={history ? history.assists : null}
        windowLabel={history && history.window > 0 ? `Son ${history.window} maçta` : undefined}
      />

      <MatchHistory
        entries={entries}
        title="Son maçlar"
        emptyTitle="Görebildiğin maç yok"
        emptyDescription="Bu oyuncu ya henüz oynamamış ya da maçları hesabının açamadığı maçlar."
      />
    </Screen>
  )
}
