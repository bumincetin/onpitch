/**
 * app/match/[id]/index.tsx
 *
 * One match, in full. The hub the deep link `onpitch://match/<uuid>` lands on.
 *
 * Everything here is read with the USER's client, so `matches_select_involved` is what decides
 * whether this person may see the row at all. A match that does not exist and a match this viewer
 * may not read produce the same empty result and the same screen — telling a stranger that a match
 * id is real is itself a disclosure.
 *
 * No socket is opened here. This screen reads the row; `live.tsx` holds the subscription. One
 * channel per topic per client is a hard Realtime limit, and two screens in the same stack both
 * subscribing to `match:<id>` would leave the second one erroring forever.
 */

import { Redirect, Stack, useLocalSearchParams, useRouter } from 'expo-router'
import * as React from 'react'
import { RefreshControl, View } from 'react-native'

import { isUuid } from '@onpitch/shared/channels'
import type { Enums, Tables } from '@onpitch/shared/database'
import {
  defaultRating,
  outcomeProbabilities,
  type Rating,
} from '@onpitch/shared/trueskill'

import {
  MATCH_FORMAT_LABEL,
  MATCH_STATUS_META,
  RatingDelta,
  RosterList,
  Scoreboard,
  describeErrorText,
  teamSizeFor,
  type RosterPlayer,
} from '@/components/match'
import { Badge, Button, EmptyState, Notice, Screen, Separator, Text } from '@/components/ui'
import { apiFetch } from '@/lib/api'
import { dataError } from '@/lib/data-error'
import { formatDuration, formatKickoff, formatRelative } from '@/lib/format'
import { supabase, useSession } from '@/lib/supabase'
import { useTheme } from '@/lib/theme'

/** `report_window_hours` in `0005_integrity_consensus.sql`. Mirrored to render an honest button. */
const REPORT_WINDOW_HOURS = 48

/* ========================================================================== */
/*  Loaded shape                                                              */
/* ========================================================================== */

interface MatchDetail {
  id: string
  kickoffAt: string
  durationMinutes: number
  format: Enums<'match_format'>
  status: Enums<'match_status'>
  homeScore: number | null
  awayScore: number | null
  isRanked: boolean
  requiresConsensus: boolean
  consensusDeadline: string | null
  scoreConfirmedAt: string | null
  matchQuality: number | null
  createdBy: string | null
  venue: { name: string; city: string | null; district: string | null; timezone: string } | null
  pitch: { name: string; surface: string; isIndoor: boolean } | null
  homeTeamName: string | null
  awayTeamName: string | null
  players: RosterPlayer[]
  /** Ratings keyed by player id, for the live balance forecast. */
  ratings: Map<string, Rating>
  /** The viewer's own before/after, once `apply_match_rating` has run. */
  ownStats: Pick<
    Tables<'player_stats'>,
    'mu_before' | 'sigma_before' | 'mu_after' | 'sigma_after'
  > | null
  viewerSide: 'home' | 'away' | null
  viewerIsParticipant: boolean
  viewerHasReported: boolean
}

/* ========================================================================== */
/*  Screen                                                                    */
/* ========================================================================== */

export default function MatchDetailScreen(): React.ReactElement {
  const params = useLocalSearchParams<{ id?: string }>()
  const router = useRouter()
  const theme = useTheme()
  const { user } = useSession()

  const matchId = typeof params.id === 'string' ? params.id : null
  const viewerId = user?.id ?? null

  const [detail, setDetail] = React.useState<MatchDetail | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [refreshing, setRefreshing] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [joining, setJoining] = React.useState(false)

  const load = React.useCallback(
    async (mode: 'initial' | 'refresh'): Promise<void> => {
      if (!matchId || !isUuid(matchId) || !viewerId) {
        setLoading(false)
        setRefreshing(false)
        return
      }

      if (mode === 'initial') setLoading(true)
      else setRefreshing(true)
      setError(null)

      try {
        setDetail(await loadMatchDetail(matchId, viewerId))
      } catch (caught) {
        setError(describeErrorText(caught, 'This match could not be loaded.'))
      } finally {
        setLoading(false)
        setRefreshing(false)
      }
    },
    [matchId, viewerId],
  )

  React.useEffect(() => {
    void load('initial')
  }, [load])

  // `/match/[id]` sits outside the `(tabs)` group, so the tab layout's session guard does not
  // cover it — and a push notification or an emailed link lands here directly. The root layout
  // has already resolved the stored session by the time this renders, so this is a decision and
  // not a race.
  if (!viewerId) {
    return <Redirect href="/(auth)/sign-in" />
  }

  const header = (
    <Stack.Screen
      options={{
        headerShown: true,
        title: 'Maç',
        headerBackTitle: 'Back',
        headerShadowVisible: false,
        headerStyle: { backgroundColor: theme.colors.background },
        headerTintColor: theme.colors.foreground,
      }}
    />
  )

  if (!matchId || !isUuid(matchId)) {
    return (
      <>
        {header}
        <Screen>
          <EmptyState
            tone="destructive"
            title="Bu maç bağlantısı geçerli değil"
            description="Adreste maç kimliği yok, bu yüzden yüklenecek bir şey yok."
            action={{ label: 'Maçlara dön', onPress: () => router.replace('/(tabs)') }}
          />
        </Screen>
      </>
    )
  }

  if (loading && !detail) {
    return (
      <>
        {header}
        <Screen loading loadingLabel="Loading the match" />
      </>
    )
  }

  if (!detail) {
    return (
      <>
        {header}
        <Screen>
          <EmptyState
            tone={error ? 'destructive' : 'default'}
            title={error ? 'That did not load' : 'Match not found'}
            description={
              error ??
              'It has been removed, or it is not one you can see. Matches are visible to the people playing in them and to the venue.'
            }
            action={{ label: 'Tekrar dene', onPress: () => void load('initial') }}
            secondaryAction={{ label: 'Bütün maçlar', onPress: () => router.replace('/(tabs)') }}
          />
        </Screen>
      </>
    )
  }

  const statusMeta = MATCH_STATUS_META[detail.status]
  const teamSize = teamSizeFor(detail.format)
  const homeLabel = detail.homeTeamName ?? 'Home'
  const awayLabel = detail.awayTeamName ?? 'Away'

  const kickoffMs = Date.parse(detail.kickoffAt)
  const reportWindowClosesMs = kickoffMs + REPORT_WINDOW_HOURS * 3_600_000
  const now = Date.now()

  /*
   * Whether to OFFER the report form. Every condition here is re-checked by
   * `trg_score_reports_validate` inside the writing transaction, which is the only place any of it
   * is enforced. This exists so the screen does not dangle a button that can only be refused.
   */
  const canReport =
    detail.viewerIsParticipant &&
    !detail.viewerHasReported &&
    detail.scoreConfirmedAt === null &&
    detail.status !== 'cancelled' &&
    detail.status !== 'finalized' &&
    now >= kickoffMs &&
    now <= reportWindowClosesMs

  const canVote =
    detail.viewerIsParticipant &&
    (detail.requiresConsensus || detail.status === 'requires_consensus')

  const filled = detail.players.length
  const canJoin =
    !detail.viewerIsParticipant && detail.status === 'scheduled' && filled < teamSize * 2

  const forecast = forecastFor(detail)

  async function join(): Promise<void> {
    // A hoisted declaration is not covered by the `if (!detail) return` above — TypeScript keeps
    // the narrowing for closures created after it, not for a function that could be called before.
    if (!detail || joining) return

    setJoining(true)
    setError(null)
    try {
      // The body is empty on purpose: with no `teamSide`, the handler asks the balancer which side
      // keeps the fixture even and puts the joiner there.
      await apiFetch<unknown>(`/api/matches/${detail.id}/join`, { method: 'POST', json: {} })
      await load('refresh')
    } catch (caught) {
      setError(describeErrorText(caught, 'You could not be added to this match.'))
    } finally {
      setJoining(false)
    }
  }

  return (
    <>
      {header}
      <Screen
        scroll
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void load('refresh')}
            tintColor={theme.colors.mutedForeground}
            colors={[theme.colors.primary]}
            progressBackgroundColor={theme.colors.card}
          />
        }
      >
        {error ? (
          <Notice tone="destructive" title="İşlem tamamlanamadı" description={error} live />
        ) : null}

        <Scoreboard
          homeLabel={homeLabel}
          awayLabel={awayLabel}
          homeScore={detail.homeScore}
          awayScore={detail.awayScore}
          status={detail.status}
          yourSide={detail.viewerSide}
        />

        <Text variant="body" tone="muted">
          {statusMeta.description}
        </Text>

        {/* ---- when and where ------------------------------------------------ */}

        <View
          style={{
            gap: theme.spacing.md,
            padding: theme.spacing.lg,
            borderRadius: theme.radius.xl,
            borderWidth: 1,
            borderColor: theme.colors.border,
            backgroundColor: theme.colors.card,
          }}
        >
          <DetailRow
            label="Başlangıç"
            value={formatKickoff(detail.kickoffAt, detail.venue?.timezone)}
            hint={`${formatRelative(detail.kickoffAt)} · ${formatDuration(detail.durationMinutes)}${
              detail.venue ? ` · venue time (${detail.venue.timezone})` : ''
            }`}
          />
          <Separator />
          <DetailRow
            label="Nerede"
            value={detail.venue?.name ?? 'Venue to be confirmed'}
            hint={[
              detail.venue?.district,
              detail.venue?.city,
              detail.pitch ? `${detail.pitch.name} · ${describePitch(detail.pitch)}` : null,
            ]
              .filter((part): part is string => Boolean(part))
              .join(' · ')}
          />
          <Separator />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm }}>
            <Badge tone="outline" size="sm">
              {MATCH_FORMAT_LABEL[detail.format]}
            </Badge>
            <Badge tone={detail.isRanked ? 'primary' : 'outline'} size="sm">
              {detail.isRanked ? 'Ranked' : 'Friendly'}
            </Badge>
            <Badge tone="outline" size="sm">
              {filled} of {teamSize * 2} in
            </Badge>
            {detail.createdBy === viewerId ? (
              <Badge tone="neutral" size="sm">
                Bu maçı sen kurdun
              </Badge>
            ) : null}
          </View>
        </View>

        {/* ---- balance -------------------------------------------------------- */}

        {forecast ? (
          <View
            style={{
              gap: theme.spacing.md,
              padding: theme.spacing.lg,
              borderRadius: theme.radius.xl,
              borderWidth: 1,
              borderColor: theme.colors.border,
              backgroundColor: theme.colors.card,
            }}
          >
            <Text variant="heading" accessibilityRole="header">
              Ne kadar denk görünüyor
            </Text>

            <View style={{ flexDirection: 'row', gap: theme.spacing.lg }}>
              <Figure label="Denge" value={`${Math.round(forecast.quality * 100)}%`} />
              <Figure label={homeLabel} value={`${Math.round(forecast.homeWinProbability * 100)}%`} />
              <Figure label="Beraberlik" value={`${Math.round(forecast.drawProbability * 100)}%`} />
              <Figure label={awayLabel} value={`${Math.round(forecast.awayWinProbability * 100)}%`} />
            </View>

            <Text variant="caption" tone="muted">
              Worked out on this device from the line-up as it stands, using the same TrueSkill maths
              the server runs. Balance is 100% when both sides are as evenly matched as the model can
              tell; a player with no rating yet counts as an average newcomer.
              {typeof detail.matchQuality === 'number'
                ? ` The organiser's fixture was stored at ${Math.round(detail.matchQuality * 100)}%.`
                : ''}
            </Text>
          </View>
        ) : null}

        {/* ---- line-up -------------------------------------------------------- */}

        <RosterList
          players={detail.players}
          teamSize={teamSize}
          homeLabel={homeLabel}
          awayLabel={awayLabel}
          onSelectPlayer={(playerId) => router.push(`/player/${playerId}`)}
        />

        {/* ---- your rating ---------------------------------------------------- */}

        {detail.ownStats &&
        typeof detail.ownStats.mu_before === 'number' &&
        typeof detail.ownStats.sigma_before === 'number' &&
        typeof detail.ownStats.mu_after === 'number' &&
        typeof detail.ownStats.sigma_after === 'number' ? (
          <RatingDelta
            before={{ mu: detail.ownStats.mu_before, sigma: detail.ownStats.sigma_before }}
            after={{ mu: detail.ownStats.mu_after, sigma: detail.ownStats.sigma_after }}
            variant="applied"
          />
        ) : null}

        {/* ---- what you can do ------------------------------------------------ */}

        <View style={{ gap: theme.spacing.md }}>
          {canVote ? (
            <Button
              title="Sonuca oy ver"
              size="lg"
              fullWidth
              onPress={() => router.push(`/match/${detail.id}/consensus`)}
            />
          ) : null}

          {canReport ? (
            <Button
              title="Skoru bildir"
              variant={canVote ? 'outline' : 'primary'}
              size="lg"
              fullWidth
              onPress={() => router.push(`/match/${detail.id}/report`)}
            />
          ) : null}

          {canJoin ? (
            <Button
              title="Bu maça katıl"
              size="lg"
              fullWidth
              loading={joining}
              onPress={() => void join()}
            />
          ) : null}

          <Button
            title="Canlı tabloyu aç"
            variant="outline"
            size="lg"
            fullWidth
            onPress={() => router.push(`/match/${detail.id}/live`)}
          />
        </View>

        {detail.viewerIsParticipant && detail.viewerHasReported ? (
          <Text variant="caption" tone="muted">
            Zaten bir skor bildirdin. Bildirimler düzeltilemez; çünkü anlaşmazlık, her tarafın gönderdiğine bakılarak karara bağlanır.
          </Text>
        ) : null}

        {detail.consensusDeadline ? (
          <Text variant="caption" tone="muted">
            Voting closes {formatRelative(detail.consensusDeadline)}.
          </Text>
        ) : null}
      </Screen>
    </>
  )
}

/* ========================================================================== */
/*  Small pieces                                                              */
/* ========================================================================== */

function DetailRow({
  label,
  value,
  hint,
}: {
  label: string
  value: string
  hint?: string
}): React.ReactElement {
  const theme = useTheme()

  return (
    <View accessible accessibilityLabel={`${label}: ${value}. ${hint ?? ''}`} style={{ gap: theme.spacing.xs }}>
      <Text variant="label" tone="muted">
        {label}
      </Text>
      <Text variant="body" weight="600">
        {value}
      </Text>
      {hint ? (
        <Text variant="caption" tone="muted">
          {hint}
        </Text>
      ) : null}
    </View>
  )
}

function Figure({ label, value }: { label: string; value: string }): React.ReactElement {
  const theme = useTheme()

  return (
    <View accessible accessibilityLabel={`${label} ${value}`} style={{ flex: 1, gap: theme.spacing.xs }}>
      <Text variant="heading" weight="700" style={{ fontVariant: ['tabular-nums'] }}>
        {value}
      </Text>
      <Text variant="caption" tone="muted" numberOfLines={2}>
        {label}
      </Text>
    </View>
  )
}

function describePitch(pitch: { surface: string; isIndoor: boolean }): string {
  const surface = pitch.surface.replace(/_/g, ' ')
  return pitch.isIndoor ? `${surface}, indoor` : surface
}

/**
 * Draw and win probabilities for the line-up as it currently stands.
 *
 * `outcomeProbabilities` is the mirror of the SQL the server uses, so this is the same forecast the
 * organiser saw when the fixture was created — recomputed live, because people join and leave.
 * Returns null while a side is empty, which is when the number would be meaningless rather than
 * merely uncertain.
 */
function forecastFor(detail: MatchDetail): {
  quality: number
  drawProbability: number
  homeWinProbability: number
  awayWinProbability: number
} | null {
  const home: Rating[] = []
  const away: Rating[] = []

  for (const player of detail.players) {
    // A player with no `player_ratings` row is a newcomer, and the prior is exactly what the
    // server would use for them.
    const rating = detail.ratings.get(player.playerId) ?? defaultRating()
    if (player.teamSide === 'away') away.push(rating)
    else home.push(rating)
  }

  if (home.length === 0 || away.length === 0) return null
  return outcomeProbabilities(home, away)
}

/* ========================================================================== */
/*  Loader                                                                    */
/* ========================================================================== */

async function loadMatchDetail(matchId: string, viewerId: string): Promise<MatchDetail | null> {
  const { data: match, error: matchError } = await supabase
    .from('matches')
    .select(
      // One long literal: postgrest-js derives the row type from the select string as a literal
      // type, and "a" + "b" widens to `string`, which loses the typing entirely.
      'id, kickoff_at, duration_minutes, format, status, home_score, away_score, is_ranked, requires_consensus, consensus_deadline, score_confirmed_at, match_quality, venue_id, pitch_id, home_team_id, away_team_id, created_by',
    )
    .eq('id', matchId)
    .maybeSingle()

  if (matchError) throw dataError('Could not load this match.', matchError)
  // No row means "does not exist" or "you may not see it", and the screen must not distinguish
  // between the two.
  if (!match) return null

  const teamIds = [match.home_team_id, match.away_team_id].filter(
    (id): id is string => typeof id === 'string',
  )

  const [venueResult, pitchResult, teamsResult, participantsResult, ownReportResult, ownStatsResult] =
    await Promise.all([
      match.venue_id
        ? supabase
            .from('venues')
            .select('id, name, city, district, timezone')
            .eq('id', match.venue_id)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      match.pitch_id
        ? supabase
            .from('pitches')
            .select('id, name, surface, is_indoor')
            .eq('id', match.pitch_id)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      teamIds.length > 0
        ? supabase.from('teams').select('id, name').in('id', teamIds)
        : Promise.resolve({ data: null, error: null }),
      supabase
        .from('match_participants')
        .select('player_id, team_side, is_confirmed')
        .eq('match_id', matchId),
      supabase
        .from('score_reports')
        .select('id')
        .eq('match_id', matchId)
        .eq('reported_by', viewerId)
        .maybeSingle(),
      supabase
        .from('player_stats')
        .select('mu_before, sigma_before, mu_after, sigma_after')
        .eq('match_id', matchId)
        .eq('player_id', viewerId)
        .maybeSingle(),
    ])

  if (participantsResult.error) throw dataError('Could not load the line-up.', participantsResult.error)

  const participants = participantsResult.data ?? []
  const playerIds = participants.map((row) => row.player_id)

  /*
   * Profiles and ratings for the whole line-up in two reads.
   *
   * `player_ratings` is world-readable to signed-in users by design (0002 §5.10); the NAME attached
   * to a rating is what the `profiles` policies protect. So a display name can legitimately come
   * back missing for someone whose profile this viewer may not see, and the roster renders them as
   * "Player" with their rating intact.
   */
  const [profilesResult, ratingsResult] = await Promise.all([
    playerIds.length > 0
      ? supabase.from('profiles').select('id, display_name, full_name, avatar_url').in('id', playerIds)
      : Promise.resolve({ data: null, error: null }),
    playerIds.length > 0
      ? supabase.from('player_ratings').select('player_id, mu, sigma').in('player_id', playerIds)
      : Promise.resolve({ data: null, error: null }),
  ])

  const profiles = new Map<string, { name: string | null; avatarUrl: string | null }>()
  for (const row of profilesResult.data ?? []) {
    profiles.set(row.id, {
      name: row.display_name ?? row.full_name ?? null,
      avatarUrl: row.avatar_url,
    })
  }

  const ratings = new Map<string, Rating>()
  for (const row of ratingsResult.data ?? []) {
    ratings.set(row.player_id, { mu: row.mu, sigma: row.sigma })
  }

  const teams = new Map<string, string>()
  for (const row of teamsResult.data ?? []) {
    teams.set(row.id, row.name)
  }

  const players: RosterPlayer[] = participants.map((row) => {
    const profile = profiles.get(row.player_id)
    const rating = ratings.get(row.player_id)
    return {
      playerId: row.player_id,
      displayName: profile?.name ?? null,
      avatarUrl: profile?.avatarUrl ?? null,
      teamSide: row.team_side === 'away' ? 'away' : 'home',
      isConfirmed: row.is_confirmed,
      conservativeRating: rating ? rating.mu - 3 * rating.sigma : null,
      isSelf: row.player_id === viewerId,
    }
  })

  const own = participants.find((row) => row.player_id === viewerId)
  const venue = venueResult.data
  const pitch = pitchResult.data

  return {
    id: match.id,
    kickoffAt: match.kickoff_at,
    durationMinutes: match.duration_minutes,
    format: match.format,
    status: match.status,
    homeScore: match.home_score,
    awayScore: match.away_score,
    isRanked: match.is_ranked,
    requiresConsensus: match.requires_consensus,
    consensusDeadline: match.consensus_deadline,
    scoreConfirmedAt: match.score_confirmed_at,
    matchQuality: match.match_quality,
    createdBy: match.created_by,
    venue: venue
      ? {
          name: venue.name,
          city: venue.city,
          district: venue.district,
          timezone: venue.timezone,
        }
      : null,
    pitch: pitch ? { name: pitch.name, surface: pitch.surface, isIndoor: pitch.is_indoor } : null,
    homeTeamName: match.home_team_id ? (teams.get(match.home_team_id) ?? null) : null,
    awayTeamName: match.away_team_id ? (teams.get(match.away_team_id) ?? null) : null,
    players,
    ratings,
    ownStats: ownStatsResult.data,
    viewerSide: own ? (own.team_side === 'away' ? 'away' : 'home') : null,
    viewerIsParticipant: Boolean(own),
    viewerHasReported: Boolean(ownReportResult.data),
  }
}
