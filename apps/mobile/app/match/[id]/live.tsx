/**
 * app/match/[id]/live.tsx
 *
 * The live board: the score as it stands, the running count people at the pitch are tapping in,
 * and who is here.
 *
 * ---------------------------------------------------------------------------------------------
 * TWO NUMBERS, AND WHY THEY ARE NOT THE SAME NUMBER
 * ---------------------------------------------------------------------------------------------
 *
 * `matches.home_score` / `away_score` are in no client UPDATE grant (0002_rls.sql §4). Nothing on
 * this screen can write them, by design: a result enters the system only through `score_reports`
 * and the corroboration pass that follows. So the "+1" buttons publish a BROADCAST tick — fast,
 * unofficial, stored nowhere, gone if your socket was down when it was sent.
 *
 * That is genuinely useful (everyone at the pitch watches the same number go up) and genuinely not
 * a result, and the UI has to keep those two facts apart. The scoreboard renders the official lane
 * on top and the running count underneath, labelled.
 *
 * ---------------------------------------------------------------------------------------------
 * ONE SUBSCRIPTION
 * ---------------------------------------------------------------------------------------------
 *
 * `useMatchChannel` is mounted exactly once, in {@link LiveBoard}, which is rendered only after the
 * row has loaded. Realtime allows one channel per topic per client, so this screen is the only
 * place in the app that joins `match:<id>` — the detail screen deliberately does not.
 */

import { Redirect, Stack, useLocalSearchParams, useRouter } from 'expo-router'
import * as React from 'react'
import { View } from 'react-native'

import { isUuid, type MatchPresencePayload } from '@onpitch/shared/channels'
import type { Enums } from '@onpitch/shared/database'

import { MATCH_STATUS_META, Scoreboard, describeErrorText } from '@/components/match'
import { Avatar, Badge, Button, EmptyState, Notice, Screen, Text } from '@/components/ui'
import { dataError } from '@/lib/data-error'
import { formatKickoff, formatRelative } from '@/lib/format'
import { useMatchChannel, type MatchSnapshot } from '@/lib/hooks/use-match-channel'
import { supabase, useSession } from '@/lib/supabase'
import { useTheme } from '@/lib/theme'

interface LiveMatch {
  id: string
  kickoffAt: string
  /** `venues.timezone`. The kick-off is quoted in the venue's zone, never the device's. */
  timezone: string | null
  homeLabel: string
  awayLabel: string
  snapshot: MatchSnapshot
  viewerSide: 'home' | 'away' | null
  viewerIsParticipant: boolean
}

/* ========================================================================== */
/*  Screen                                                                    */
/* ========================================================================== */

export default function LiveMatchScreen(): React.ReactElement {
  const params = useLocalSearchParams<{ id?: string }>()
  const theme = useTheme()
  const { user, profile } = useSession()

  const matchId = typeof params.id === 'string' ? params.id : null
  const viewerId = user?.id ?? null

  const [match, setMatch] = React.useState<LiveMatch | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  const load = React.useCallback(async (): Promise<void> => {
    if (!matchId || !isUuid(matchId) || !viewerId) {
      setLoading(false)
      return
    }

    setLoading(true)
    setError(null)
    try {
      setMatch(await loadLiveMatch(matchId, viewerId))
    } catch (caught) {
      setError(describeErrorText(caught, 'The live board could not be opened.'))
    } finally {
      setLoading(false)
    }
  }, [matchId, viewerId])

  React.useEffect(() => {
    void load()
  }, [load])

  if (!viewerId) return <Redirect href="/(auth)/sign-in" />

  const header = (
    <Stack.Screen
      options={{
        headerShown: true,
        title: 'Canlı',
        headerBackTitle: 'Match',
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
            description="Maç kimliği olmadan izlenecek bir şey yok."
          />
        </Screen>
      </>
    )
  }

  if (loading && !match) {
    return (
      <>
        {header}
        <Screen loading loadingLabel="Opening the live board" />
      </>
    )
  }

  if (!match) {
    return (
      <>
        {header}
        <Screen>
          <EmptyState
            tone={error ? 'destructive' : 'default'}
            title={error ? 'That did not load' : 'Match not found'}
            description={
              error ?? 'It has been removed, or it is not one you can see.'
            }
            action={{ label: 'Tekrar dene', onPress: () => void load() }}
          />
        </Screen>
      </>
    )
  }

  return (
    <>
      {header}
      <LiveBoard
        match={match}
        viewerId={viewerId}
        displayName={profile?.display_name ?? profile?.full_name ?? null}
      />
    </>
  )
}

/* ========================================================================== */
/*  The board                                                                 */
/* ========================================================================== */

function LiveBoard({
  match,
  viewerId,
  displayName,
}: {
  match: LiveMatch
  viewerId: string
  displayName: string | null
}): React.ReactElement {
  const theme = useTheme()
  const router = useRouter()

  /*
   * The presence identity, rebuilt only when one of its fields changes.
   *
   * NEVER put coordinates in here. `profiles.location_sharing_enabled` defaults to false and is
   * hard-locked off for minors by a CHECK constraint; presence is not an exemption from that, it is
   * just a place people forget it applies.
   */
  const presence = React.useMemo<MatchPresencePayload | null>(() => {
    if (!match.viewerIsParticipant) return null
    return {
      profileId: viewerId,
      displayName,
      teamSide: match.viewerSide,
      checkedInAt: new Date().toISOString(),
    }
    // `checkedInAt` is captured once per identity change on purpose: refreshing it every render
    // would re-track presence continuously and churn every other device's member list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [match.viewerIsParticipant, match.viewerSide, viewerId, displayName])

  // The socket is for a match that can still change. One that was already finished when this
  // screen opened gets the same board with the connection reported as paused, rather than a
  // channel nobody will ever send on.
  const settledOnOpen =
    match.snapshot.status === 'finalized' || match.snapshot.status === 'cancelled'

  const channel = useMatchChannel({
    matchId: match.id,
    initial: match.snapshot,
    enabled: !settledOnOpen,
    presence,
  })

  // For the UI, the live status wins: a match that finalises while you are watching should stop
  // offering the goal buttons in the same frame the result lands.
  const settled = channel.status === 'finalized' || channel.status === 'cancelled'

  const [sending, setSending] = React.useState(false)
  const [sendFailed, setSendFailed] = React.useState(false)

  // What "+1" adds to. The running count if there is one, otherwise the official score, otherwise
  // nil-nil — so the first tap of the evening starts from 1–0 and not from nowhere.
  const base = {
    home: channel.tally?.home ?? channel.score.home ?? 0,
    away: channel.tally?.away ?? channel.score.away ?? 0,
  }

  const tick = React.useCallback(
    async (side: 'home' | 'away', by: 1 | -1): Promise<void> => {
      setSending(true)
      setSendFailed(false)
      const next = {
        home: side === 'home' ? Math.max(0, base.home + by) : base.home,
        away: side === 'away' ? Math.max(0, base.away + by) : base.away,
      }
      const delivered = await channel.broadcastScore({
        ...next,
        scoredBy: by > 0 ? side : null,
      })
      setSendFailed(!delivered)
      setSending(false)
    },
    [base.home, base.away, channel],
  )

  const statusMeta = MATCH_STATUS_META[channel.status]
  const kickoffPassed = Date.parse(match.kickoffAt) <= Date.now()

  return (
    <Screen scroll>
      <Scoreboard
        homeLabel={match.homeLabel}
        awayLabel={match.awayLabel}
        homeScore={channel.score.home}
        awayScore={channel.score.away}
        status={channel.status}
        tally={channel.tally ? { home: channel.tally.home, away: channel.tally.away } : null}
        connection={channel.connection}
        lastEventAt={channel.lastEventAt}
        yourSide={match.viewerSide}
      />

      <Text variant="caption" tone="muted">
        {formatKickoff(match.kickoffAt, match.timezone ?? undefined)}
        {match.timezone ? ` · venue time (${match.timezone})` : " · your device's time"}
        {' · '}
        {statusMeta.description}
      </Text>

      {channel.error ? (
        <Notice tone="warning" title="Canlı güncellemeler kesintili" description={channel.error} live />
      ) : null}

      {sendFailed ? (
        <Notice
          tone="warning"
          live
          title="Bu dokunuş kimseye ulaşmadı"
          description="Kendi ekranında görünüyor ama başkasınınkinde yok. Yeniden gönderilmez — bağlantı gelince tekrar dokun."
        />
      ) : null}

      {/* ---- the running count controls ------------------------------------ */}

      {match.viewerIsParticipant && !settled ? (
        <View style={{ gap: theme.spacing.md }}>
          <Text variant="heading" accessibilityRole="header">
            Sayacı tut
          </Text>
          <Text variant="caption" tone="muted">
            Bu, izleyenler için ortak bir sayaçtır, sonuç değildir. Sonuç, sonrasında bildirdiğin skordur.
          </Text>

          <View style={{ flexDirection: 'row', gap: theme.spacing.md }}>
            <TickButton
              label={`Goal · ${match.homeLabel}`}
              disabled={sending}
              onPress={() => void tick('home', 1)}
            />
            <TickButton
              label={`Goal · ${match.awayLabel}`}
              disabled={sending}
              onPress={() => void tick('away', 1)}
            />
          </View>

          <View style={{ flexDirection: 'row', gap: theme.spacing.md }}>
            <Button
              title="Ev sahibini geri al"
              variant="ghost"
              size="sm"
              disabled={sending || base.home === 0}
              onPress={() => void tick('home', -1)}
              style={{ flex: 1 }}
            />
            <Button
              title="Deplasmanı geri al"
              variant="ghost"
              size="sm"
              disabled={sending || base.away === 0}
              onPress={() => void tick('away', -1)}
              style={{ flex: 1 }}
            />
          </View>

          <View style={{ flexDirection: 'row', gap: theme.spacing.md }}>
            <Button
              title="Başlat"
              variant="outline"
              size="sm"
              disabled={sending}
              onPress={() => void channel.broadcastStatus('live')}
              style={{ flex: 1 }}
            />
            <Button
              title="Maç sonu"
              variant="outline"
              size="sm"
              disabled={sending}
              onPress={() => void channel.broadcastStatus('awaiting_report')}
              style={{ flex: 1 }}
            />
          </View>

          <Text variant="caption" tone="muted">
            Başlat ve maç sonu, diğer telefonlara giden sinyallerdir. Maçın durumu ancak sunucu söylediğinde değişir.
          </Text>
        </View>
      ) : null}

      {/* ---- who is here ---------------------------------------------------- */}

      <View style={{ gap: theme.spacing.md }}>
        <Text variant="heading" accessibilityRole="header">
          Sahada
        </Text>

        {channel.members.length === 0 ? (
          <Text variant="body" tone="muted">
            {settled
              ? 'The match is over, so nobody is checked in.'
              : 'Nobody else has this screen open yet.'}
          </Text>
        ) : (
          <View style={{ gap: theme.spacing.md }}>
            {channel.members.map((member) => (
              <PresenceRow key={member.profileId} member={member} isSelf={member.profileId === viewerId} />
            ))}
          </View>
        )}

        <Text variant="caption" tone="muted">
          Şu anda bu ekranı açık tutanlar. Bu bir yoklama ya da konum bilgisi değildir.
        </Text>
      </View>

      {kickoffPassed && !settled ? (
        <Button
          title="Skoru bildir"
          size="lg"
          fullWidth
          onPress={() => router.push(`/match/${match.id}/report`)}
        />
      ) : null}

      <Button
        title="Sunucudan yenile"
        variant="ghost"
        size="sm"
        onPress={() => void channel.resync()}
      />
    </Screen>
  )
}

function TickButton({
  label,
  disabled,
  onPress,
}: {
  label: string
  disabled: boolean
  onPress: () => void
}): React.ReactElement {
  return (
    <Button
      title={label}
      size="lg"
      disabled={disabled}
      onPress={onPress}
      style={{ flex: 1 }}
      accessibilityLabel={`${label}. Adds one to the running count.`}
    />
  )
}

function PresenceRow({
  member,
  isSelf,
}: {
  member: MatchPresencePayload
  isSelf: boolean
}): React.ReactElement {
  const theme = useTheme()
  const name = member.displayName?.trim() || 'Player'

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md }}>
      <Avatar name={member.displayName} size="sm" />
      <Text variant="body" style={{ flex: 1 }} numberOfLines={1}>
        {name}
        {isSelf ? ' (you)' : ''}
      </Text>
      {member.teamSide ? (
        <Badge tone="outline" size="sm">
          {member.teamSide === 'home' ? 'Home' : 'Away'}
        </Badge>
      ) : null}
      <Text variant="caption" tone="muted">
        {formatRelative(member.checkedInAt)}
      </Text>
    </View>
  )
}

/* ========================================================================== */
/*  Loader                                                                    */
/* ========================================================================== */

async function loadLiveMatch(matchId: string, viewerId: string): Promise<LiveMatch | null> {
  const { data: match, error } = await supabase
    .from('matches')
    .select(
      'id, kickoff_at, status, home_score, away_score, home_team_id, away_team_id, updated_at, venue_id',
    )
    .eq('id', matchId)
    .maybeSingle()

  if (error) throw dataError('Could not load this match.', error)
  if (!match) return null

  const teamIds = [match.home_team_id, match.away_team_id].filter(
    (id): id is string => typeof id === 'string',
  )

  const [teamsResult, participantsResult, venueResult] = await Promise.all([
    teamIds.length > 0
      ? supabase.from('teams').select('id, name').in('id', teamIds)
      : Promise.resolve({ data: null, error: null }),
    supabase.from('match_participants').select('player_id, team_side').eq('match_id', matchId),
    // A venue the viewer cannot read costs a zone label, not the screen — so this failure is
    // swallowed the same way the team names' is.
    match.venue_id
      ? supabase.from('venues').select('timezone').eq('id', match.venue_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ])

  if (participantsResult.error) throw dataError('Could not load the line-up.', participantsResult.error)

  const teams = new Map<string, string>()
  for (const row of teamsResult.data ?? []) {
    teams.set(row.id, row.name)
  }

  const own = (participantsResult.data ?? []).find((row) => row.player_id === viewerId)

  const status: Enums<'match_status'> = match.status

  return {
    id: match.id,
    kickoffAt: match.kickoff_at,
    timezone: venueResult.data?.timezone ?? null,
    homeLabel: match.home_team_id ? (teams.get(match.home_team_id) ?? 'Home') : 'Home',
    awayLabel: match.away_team_id ? (teams.get(match.away_team_id) ?? 'Away') : 'Away',
    snapshot: {
      homeScore: match.home_score,
      awayScore: match.away_score,
      status,
      updatedAt: match.updated_at,
    },
    viewerSide: own ? (own.team_side === 'away' ? 'away' : 'home') : null,
    viewerIsParticipant: Boolean(own),
  }
}
