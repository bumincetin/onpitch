/**
 * app/teams.tsx
 *
 * The squads you play for. Read-only in the app for now.
 *
 * Three queries, never one per team: your active memberships, the teams themselves, then every
 * active roster row for those teams so each card can carry a real squad size. `teams_select_public_
 * or_member` is what decides which of those rows come back — `is_public or owner_id = auth.uid() or
 * is_team_member(id) or is_admin()` — so the `.in()` below is a narrowing, not the access check.
 *
 * Nothing here writes. Creating a team, inviting a player, changing a captain and leaving a squad
 * all carry consequences for other people's fixtures, and none of them has a confirmation flow in
 * this app yet. Shipping a half-built roster editor would be worse than saying where the full one
 * lives, which is what the note at the bottom does.
 */

import { useRouter } from 'expo-router'
import * as React from 'react'
import { RefreshControl, View } from 'react-native'

import type { Enums } from '@halisaha/shared/database'

import { Avatar, Badge, Card, EmptyState, Notice, Screen, Text } from '@/components/ui'
import { ScreenHeader } from '@/components/profile'
import { dataError } from '@/lib/data-error'
import { formatDayLabel } from '@/lib/format'
import { supabase, useSession } from '@/lib/supabase'
import { useTheme } from '@/lib/theme'

const TEAM_COLUMNS = 'id, name, slug, owner_id, city, crest_url, description, is_public'

type TeamRole = Enums<'team_member_role'>

const ROLE_LABEL: Readonly<Record<TeamRole, string>> = {
  captain: 'Captain',
  vice_captain: 'Vice captain',
  member: 'Member',
}

interface TeamCard {
  id: string
  name: string
  city: string | null
  crestUrl: string | null
  description: string | null
  isPublic: boolean
  isOwner: boolean
  role: TeamRole
  jerseyNumber: number | null
  joinedAt: string
  /** Active members, including you. Null when the roster read came back empty for this team. */
  squadSize: number | null
}

export default function TeamsScreen(): React.ReactElement {
  const theme = useTheme()
  const router = useRouter()
  const { user } = useSession()

  const [teams, setTeams] = React.useState<readonly TeamCard[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [refreshing, setRefreshing] = React.useState(false)

  const userId = user?.id ?? null

  const load = React.useCallback(async (id: string | null): Promise<void> => {
    if (id === null) {
      setTeams([])
      setLoading(false)
      return
    }

    setError(null)
    try {
      const { data: memberships, error: membershipError } = await supabase
        .from('team_members')
        .select('team_id, role, jersey_number, joined_at')
        .eq('player_id', id)
        .is('left_at', null)

      if (membershipError) {
        throw dataError('Could not read your memberships.', membershipError)
      }

      const rows = memberships ?? []
      if (rows.length === 0) {
        setTeams([])
        return
      }

      const teamIds = rows.map((row) => row.team_id)

      const [teamResult, rosterResult] = await Promise.all([
        supabase.from('teams').select(TEAM_COLUMNS).in('id', teamIds),
        supabase.from('team_members').select('team_id').in('team_id', teamIds).is('left_at', null),
      ])

      if (teamResult.error) throw dataError('Could not load your teams.', teamResult.error)
      if (rosterResult.error) {
        throw dataError('Could not count the squads.', rosterResult.error)
      }

      const squadSizes = new Map<string, number>()
      for (const row of rosterResult.data ?? []) {
        squadSizes.set(row.team_id, (squadSizes.get(row.team_id) ?? 0) + 1)
      }

      const membershipById = new Map(rows.map((row) => [row.team_id, row]))

      const cards: TeamCard[] = []
      for (const team of teamResult.data ?? []) {
        const membership = membershipById.get(team.id)
        // A team without a matching membership row cannot happen — the ids came from that very
        // list — but `Map.get` is optional and inventing a role would be worse than skipping.
        if (!membership) continue

        cards.push({
          id: team.id,
          name: team.name,
          city: team.city,
          crestUrl: team.crest_url,
          description: team.description,
          isPublic: team.is_public,
          isOwner: team.owner_id === id,
          role: membership.role,
          jerseyNumber: membership.jersey_number,
          joinedAt: membership.joined_at,
          squadSize: squadSizes.get(team.id) ?? null,
        })
      }

      cards.sort((a, b) => a.name.localeCompare(b.name))
      setTeams(cards)
    } catch (caught) {
      setTeams([])
      setError(caught instanceof Error ? caught.message : 'Takımların yüklenemedi.')
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    setLoading(userId !== null)
    void load(userId)
  }, [load, userId])

  const refresh = React.useCallback(async (): Promise<void> => {
    setRefreshing(true)
    await load(userId)
    setRefreshing(false)
  }, [load, userId])

  const header = <ScreenHeader title="Takımlarım" subtitle="Şu an oynadığın kadrolar" />

  if (loading && teams.length === 0) {
    return (
      <Screen
        edges={['top', 'left', 'right', 'bottom']}
        header={header}
        loading
        loadingLabel="Loading your teams"
      />
    )
  }

  if (error && teams.length === 0) {
    return (
      <Screen
        edges={['top', 'left', 'right', 'bottom']}
        header={header}
        error={error}
        onRetry={() => void load(userId)}
      />
    )
  }

  return (
    <Screen
      edges={['top', 'left', 'right', 'bottom']}
      scroll
      header={header}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => void refresh()}
          tintColor={theme.colors.mutedForeground}
          colors={[theme.colors.primary]}
        />
      }
    >
      {error ? (
        <Notice tone="warning" title="Elimizdeki liste gösteriliyor" description={error} live />
      ) : null}

      {teams.length === 0 ? (
        <EmptyState
          title="Henüz bir takımda değilsin"
          description="Bir kaptan seni kadrosuna ekler ve takım burada görünür. Takımın olmadan da saha tutabilir, maça katılabilirsin."
          action={{ label: 'Maç bul', onPress: () => router.replace('/(tabs)') }}
        />
      ) : (
        teams.map((team) => <TeamRow key={team.id} team={team} />)
      )}

      {teams.length > 0 ? (
        <Notice tone="info" title="Burada salt okunur">
          <Text variant="body" tone="muted">
            Oyuncu eklemek ya da çıkarmak, kadroyu yeniden adlandırmak ve kaptanlığı devretmek başkalarının maçlarını da değiştirir; bu yüzden şimdilik web uygulamasından yapılır. Bu liste onunla eşzamanlı kalır.
          </Text>
        </Notice>
      ) : null}
    </Screen>
  )
}

function TeamRow({ team }: { team: TeamCard }): React.ReactElement {
  const theme = useTheme()

  return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.lg }}>
        <Avatar uri={team.crestUrl} name={team.name} size="lg" />

        <View style={{ flex: 1, gap: theme.spacing.xs }}>
          <Text variant="heading" numberOfLines={2}>
            {team.name}
          </Text>
          <Text variant="caption" tone="muted">
            {[
              team.city,
              team.squadSize === null
                ? null
                : `${team.squadSize} ${team.squadSize === 1 ? 'player' : 'players'}`,
            ]
              .filter(Boolean)
              .join(' · ') || 'No city set'}
          </Text>
        </View>
      </View>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm }}>
        <Badge tone={team.role === 'member' ? 'outline' : 'primary'} size="sm">
          {ROLE_LABEL[team.role]}
        </Badge>
        {team.isOwner ? (
          <Badge tone="neutral" size="sm">
            Kurucusu sensin
          </Badge>
        ) : null}
        <Badge tone="outline" size="sm">
          {team.isPublic ? 'Public' : 'Invite only'}
        </Badge>
        {team.jerseyNumber !== null ? (
          <Badge tone="outline" size="sm">{`Shirt ${team.jerseyNumber}`}</Badge>
        ) : null}
      </View>

      {team.description ? (
        <Text variant="body" tone="muted" numberOfLines={3}>
          {team.description}
        </Text>
      ) : null}

      <Text variant="caption" tone="muted">
        {`In the squad since ${formatDayLabel(team.joinedAt)}`}
      </Text>
    </Card>
  )
}
