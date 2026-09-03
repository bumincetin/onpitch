/**
 * app/player/[id].tsx
 *
 * Somebody else's profile.
 *
 * WHAT IS VISIBLE IS DECIDED IN POSTGRES, AND THE TWO TABLES DISAGREE ON PURPOSE
 * -----------------------------------------------------------------------------
 * `profiles_select_self_or_visible` admits you, admins, active teammates, and adults whose
 * `profile_visibility` is `public` or `members`. A minor's profile is never visible to a stranger:
 * `is_minor is not true` is a conjunct of the policy, not a preference somebody can flip.
 * `player_ratings`, by contrast, is world-readable to any signed-in user — mu and sigma are not
 * identifying, and gating them per row would turn every leaderboard into a full scan plus a
 * visibility lookup. It is the NAME attached to a rating that the profiles policies protect.
 *
 * So the honest outcome for a private account is "rating visible, person not", and that is what
 * this screen renders: an explained partial state, not an error and not a 404. Pretending the row
 * does not exist would be a lie the ratings table contradicts one query later.
 *
 * The projection lists columns one at a time because §4.1 grants SELECT on ten columns of
 * `profiles` and no more, and PostgreSQL checks that privilege for every column a query mentions —
 * in the WHERE clause as well as in the projection. `select('*')` is refused, and so is a filter on
 * `deleted_at`. No such filter is needed: the policy already excludes soft-deleted rows, and a
 * policy qual is evaluated by the executor rather than against the caller's column privileges.
 */

import { useLocalSearchParams, useRouter } from 'expo-router'
import * as React from 'react'
import { RefreshControl, View } from 'react-native'

import { isUuid } from '@onpitch/shared/channels'

import { Avatar, Badge, Button, Card, EmptyState, Notice, Screen, Text } from '@/components/ui'
import {
  FormStrip,
  HISTORY_LIMIT,
  MatchHistory,
  RatingCard,
  ScreenHeader,
  StatsGrid,
  loadPlayerHistory,
  type PlayerHistory,
} from '@/components/profile'
import { dataError } from '@/lib/data-error'
import { formatDayLabel } from '@/lib/format'
import { supabase, useSession } from '@/lib/supabase'
import { useTheme } from '@/lib/theme'

const PROFILE_COLUMNS =
  'id, display_name, full_name, avatar_url, role, city, preferred_position, bio, profile_visibility, created_at'

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
}

interface PlayerPageData {
  profile: VisibleProfile | null
  history: PlayerHistory
}

export default function PlayerScreen(): React.ReactElement {
  const theme = useTheme()
  const router = useRouter()
  const { user } = useSession()

  // No generic: the default `UnknownOutputParams` is an index signature, so with
  // `noUncheckedIndexedAccess` a missing param reads as `undefined` and has to be narrowed. A
  // route param is untrusted input — `isUuid` is what turns it into an id worth querying with.
  const params = useLocalSearchParams()
  const raw = Array.isArray(params.id) ? params.id[0] : params.id
  const playerId = typeof raw === 'string' && isUuid(raw) ? raw.toLowerCase() : null

  const [data, setData] = React.useState<PlayerPageData | null>(null)
  const [loading, setLoading] = React.useState(playerId !== null)
  const [error, setError] = React.useState<string | null>(null)
  const [refreshing, setRefreshing] = React.useState(false)

  const load = React.useCallback(async (id: string | null): Promise<void> => {
    if (id === null) {
      setLoading(false)
      return
    }

    setError(null)
    try {
      const [profileResult, history] = await Promise.all([
        supabase.from('profiles').select(PROFILE_COLUMNS).eq('id', id).maybeSingle(),
        loadPlayerHistory(id, HISTORY_LIMIT),
      ])

      // A refused read is an error; an empty result is a private profile, and the two must not
      // be collapsed into one message.
      if (profileResult.error) {
        throw dataError('Could not load that player.', profileResult.error)
      }

      setData({ profile: profileResult.data, history })
    } catch (caught) {
      setData(null)
      setError(caught instanceof Error ? caught.message : 'Bu oyuncu yüklenemedi.')
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    setLoading(playerId !== null)
    void load(playerId)
  }, [load, playerId])

  /** Pop if there is a stack; a cold launch on a deep link has none. */
  const goBack = React.useCallback((): void => {
    if (router.canGoBack()) router.back()
    else router.replace('/(tabs)')
  }, [router])

  const refresh = React.useCallback(async (): Promise<void> => {
    setRefreshing(true)
    await load(playerId)
    setRefreshing(false)
  }, [load, playerId])

  /* ------------------------------------------------------------ bad route -- */

  if (playerId === null) {
    return (
      <Screen edges={['top', 'left', 'right', 'bottom']} header={<ScreenHeader title="Oyuncu" />}>
        <EmptyState
          title="Bu bir oyuncu bağlantısı değil"
          description="Bağlantıdaki kimlik geçerli bir oyuncu kimliği değil. Paylaşılırken kısalmış olabilir."
          action={{ label: 'Geri dön', onPress: goBack }}
        />
      </Screen>
    )
  }

  if (loading && data === null) {
    return (
      <Screen
        edges={['top', 'left', 'right', 'bottom']}
        header={<ScreenHeader title="Oyuncu" />}
        loading
        loadingLabel="Loading player"
      />
    )
  }

  if (error && data === null) {
    return (
      <Screen
        edges={['top', 'left', 'right', 'bottom']}
        header={<ScreenHeader title="Oyuncu" />}
        error={error}
        onRetry={() => void load(playerId)}
      />
    )
  }

  const profile = data?.profile ?? null
  const history = data?.history ?? null
  const rating = history?.rating ?? null
  const entries = history?.entries ?? []

  /* -------------------------------------------------------- nothing there -- */

  // No readable profile AND no rating: the id belongs to nobody this account can see, or to an
  // erased account. Either way there is nothing to render and nothing to explain away.
  if (profile === null && rating === null) {
    return (
      <Screen edges={['top', 'left', 'right', 'bottom']} header={<ScreenHeader title="Oyuncu" />}>
        <EmptyState
          title="Burada oyuncu yok"
          description="Bu hesap ya yok ya da silinmiş. Bağlantıyı biri paylaştıysa kontrol etmesini iste."
          action={{ label: 'Geri dön', onPress: goBack }}
        />
      </Screen>
    )
  }

  const isSelf = user?.id?.toLowerCase() === playerId
  const name = profile?.display_name?.trim() || profile?.full_name?.trim() || 'Private profile'
  const isPrivate = profile === null

  return (
    <Screen
      edges={['top', 'left', 'right', 'bottom']}
      scroll
      header={<ScreenHeader title={isPrivate ? 'Player' : name} />}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => void refresh()}
          tintColor={theme.colors.mutedForeground}
          colors={[theme.colors.primary]}
        />
      }
    >
      {isSelf ? (
        <Notice tone="info" title="Bu senin profilin">
          <Text variant="body" tone="muted">
            Bunu başkasınınkini gördüğün gibi görüyorsun. Ayarlar ve tam geçmiş kendi sekmende.
          </Text>
          <Button
            title="Profilimi aç"
            size="sm"
            variant="outline"
            onPress={() => router.replace('/(tabs)/profile')}
          />
        </Notice>
      ) : null}

      {/* ------------------------------------------------------------ header -- */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.lg }}>
        <Avatar uri={profile?.avatar_url ?? null} name={isPrivate ? null : name} size="xl" />

        <View style={{ flex: 1, gap: theme.spacing.xs }}>
          <Text variant="title" numberOfLines={2}>
            {name}
          </Text>
          {isPrivate ? (
            <Text variant="caption" tone="muted">
              Ad ve bilgiler gizli
            </Text>
          ) : (
            <>
              <Text variant="caption" tone="muted" numberOfLines={2}>
                {[profile?.city, profile?.preferred_position].filter(Boolean).join(' · ') ||
                  'No city or position listed'}
              </Text>
              {profile ? (
                <Badge tone="outline" size="sm">
                  {`Joined ${formatDayLabel(profile.created_at)}`}
                </Badge>
              ) : null}
            </>
          )}
        </View>
      </View>

      {/* ----------------------------------------------------------- private -- */}
      {isPrivate ? (
        <Notice tone="info" title="Bu profil gizli">
          <Text variant="body" tone="muted">
            Bu oyuncu profilini görünür yapmamış ya da hesabı varsayılan olarak gizli tuttuğumuz türden. Reytingi yine de görünür; çünkü mu ve sigma tek başına kimseyi tanımlamaz. Gizli kalan şey addır.
          </Text>
          <Text variant="body" tone="muted">
            Aynı takımda bir maç oyna; profili sana otomatik olarak açılır.
          </Text>
        </Notice>
      ) : profile?.bio ? (
        <Card title="Hakkında">
          <Text variant="body">{profile.bio}</Text>
        </Card>
      ) : null}

      {/* -------------------------------------------------------------- form -- */}
      <Card title="Form" subtitle="Son beş kesinleşmiş sonuç, en yenisi önce">
        <FormStrip entries={entries} />
      </Card>

      <RatingCard rating={rating} playerName={isPrivate ? 'This player' : name} />

      <StatsGrid
        matchesPlayed={rating?.matches_played ?? 0}
        wins={rating?.wins ?? 0}
        draws={rating?.draws ?? 0}
        losses={rating?.losses ?? 0}
        goals={history ? history.goals : null}
        assists={history ? history.assists : null}
        windowLabel={history && history.window > 0 ? `In their last ${history.window} matches` : undefined}
      />

      <MatchHistory
        entries={entries}
        title="Son maçlar"
        emptyTitle="No matches you can see"
        emptyDescription="Either this player has not played yet, or their matches are ones your account cannot open."
      />
    </Screen>
  )
}
