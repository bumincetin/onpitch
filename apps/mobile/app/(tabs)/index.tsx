/**
 * app/(tabs)/index.tsx
 *
 * The Matches tab: games you can join, and games you are in.
 *
 * THE TWO LANES ARE DIFFERENT QUERIES ON PURPOSE, and they are not interchangeable.
 *
 *   OPEN   `GET /api/matches`. Discovery cannot go through RLS: `matches_select_involved` limits
 *          SELECT to participants, the organiser, the venue owner and admins — correct for a match
 *          page, useless for finding a game, since somebody looking for one is by definition not
 *          in it yet. That route is the authorisation boundary instead, and it answers with counts
 *          and no participant identities.
 *
 *   MINE   read directly with the user's client, where RLS is exactly the right filter: the rows
 *          it returns are the matches this person is entitled to see, with the scores attached.
 *
 * The filename is `index.tsx` because `(tabs)/_layout.tsx` declares `<Tabs.Screen name="index">`
 * for the Matches tab. Renaming this file drops the tab.
 */

import { useRouter } from 'expo-router'
import * as React from 'react'
import { FlatList, Pressable, RefreshControl, View } from 'react-native'
import { z } from 'zod'

import { matchFormatSchema, matchStatusSchema } from '@halisaha/shared/domain'

import { MatchCard, describeErrorText, type MatchCardMatch } from '@/components/match'
import { EmptyState, Screen, Spinner, Text } from '@/components/ui'
import { apiFetch } from '@/lib/api'
import { DataError, dataError } from '@/lib/data-error'
import { supabase, useSession } from '@/lib/supabase'
import { useTheme } from '@/lib/theme'

type Lane = 'open' | 'mine'

/* ========================================================================== */
/*  The discovery payload                                                     */
/* ========================================================================== */

/**
 * `GET /api/matches` answers with a `MatchListItem[]` declared inside the route handler rather
 * than in @halisaha/shared, so it is parsed here. `apiFetch` verifies the envelope; the payload
 * inside it is still the server's claim until something checks it.
 */
const discoveryItemSchema = z.object({
  id: z.string().uuid(),
  kickoffAt: z.string(),
  durationMinutes: z.number().int(),
  format: matchFormatSchema,
  status: matchStatusSchema,
  isRanked: z.boolean(),
  venueName: z.string().nullable(),
  city: z.string().nullable(),
  homeCount: z.number().int(),
  awayCount: z.number().int(),
  matchQuality: z.number().nullable(),
})

const discoveryResultSchema = z.object({
  matches: z.array(discoveryItemSchema),
})

/* ========================================================================== */
/*  Screen                                                                    */
/* ========================================================================== */

interface LaneState {
  items: MatchCardMatch[]
  loading: boolean
  refreshing: boolean
  error: string | null
}

const INITIAL: LaneState = { items: [], loading: true, refreshing: false, error: null }

export default function MatchesScreen(): React.ReactElement {
  const router = useRouter()
  const theme = useTheme()
  const { user } = useSession()
  const userId = user?.id ?? null

  const [lane, setLane] = React.useState<Lane>('open')
  const [open, setOpen] = React.useState<LaneState>(INITIAL)
  const [mine, setMine] = React.useState<LaneState>(INITIAL)

  const state = lane === 'open' ? open : mine

  const load = React.useCallback(
    async (which: Lane, mode: 'initial' | 'refresh'): Promise<void> => {
      const apply = which === 'open' ? setOpen : setMine
      apply((current) => ({
        ...current,
        loading: mode === 'initial',
        refreshing: mode === 'refresh',
        error: null,
      }))

      try {
        const items = which === 'open' ? await loadOpenMatches() : await loadMyMatches(userId)
        apply({ items, loading: false, refreshing: false, error: null })
      } catch (caught) {
        apply((current) => ({
          ...current,
          loading: false,
          refreshing: false,
          error: describeErrorText(caught, 'The match list could not be loaded.'),
        }))
      }
    },
    [userId],
  )

  /*
   * Which lanes have been asked for, held in a ref rather than in state.
   *
   * A "have I loaded this yet?" flag kept in state would put the lane's own state object in the
   * effect's dependency list, and the effect's first action is to change that object — which
   * re-runs the effect, which starts another load. The ref is read and written outside React's
   * update cycle, so the guard cannot chase its own tail.
   */
  const requested = React.useRef<Set<Lane>>(new Set())

  React.useEffect(() => {
    // A different account means different rows in both lanes.
    requested.current = new Set()
    setOpen(INITIAL)
    setMine(INITIAL)
  }, [userId])

  React.useEffect(() => {
    if (requested.current.has(lane)) return
    requested.current.add(lane)
    void load(lane, 'initial')
  }, [lane, load])

  const retry = React.useCallback(() => {
    requested.current.add(lane)
    void load(lane, 'initial')
  }, [lane, load])

  const openMatch = React.useCallback(
    (matchId: string) => {
      router.push(`/match/${matchId}`)
    },
    [router],
  )

  const showSpinner = state.loading && state.items.length === 0
  const showError = state.error !== null && state.items.length === 0

  return (
    <Screen
      padded={false}
      header={
        <View style={{ paddingHorizontal: theme.spacing.lg, paddingTop: theme.spacing.md }}>
          <LaneSwitch value={lane} onChange={setLane} />
        </View>
      }
    >
      {showSpinner ? (
        <Spinner centred label={lane === 'open' ? 'Finding matches' : 'Loading your matches'} />
      ) : showError ? (
        <EmptyState
          tone="destructive"
          title="Bu yüklenemedi"
          description={state.error ?? undefined}
          action={{ label: 'Tekrar dene', onPress: retry }}
        />
      ) : (
        <FlatList
          style={{ flex: 1 }}
          data={state.items}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => <MatchCard match={item} onPress={openMatch} />}
          contentContainerStyle={{
            padding: theme.spacing.lg,
            paddingTop: theme.spacing.sm,
            gap: theme.spacing.md,
            flexGrow: 1,
          }}
          refreshControl={
            <RefreshControl
              refreshing={state.refreshing}
              onRefresh={() => void load(lane, 'refresh')}
              tintColor={theme.colors.mutedForeground}
              colors={[theme.colors.primary]}
              progressBackgroundColor={theme.colors.card}
            />
          }
          // A stale list plus a warning beats replacing rows the user can still act on.
          ListHeaderComponent={
            state.error ? (
              <Text variant="caption" tone="destructive" accessibilityLiveRegion="polite">
                {state.error} Showing the last list that loaded.
              </Text>
            ) : null
          }
          ListEmptyComponent={
            lane === 'open' ? (
              <EmptyState
                title="Şu an açık maç yok"
                description="Yaklaşan maçlarda boş yer yok. Yenilemek için aşağı çek ya da bir saha tutup kendin başlat."
              />
            ) : (
              <EmptyState
                title="Henüz bir maçta değilsin"
                description="Açık bir maça katıl; burada görünür ve oynandıktan sonra sonucu da gelir."
                action={{ label: 'Maç bul', onPress: () => setLane('open') }}
              />
            )
          }
          showsVerticalScrollIndicator={false}
        />
      )}
    </Screen>
  )
}

/* ========================================================================== */
/*  Lane switch                                                               */
/* ========================================================================== */

function LaneSwitch({
  value,
  onChange,
}: {
  value: Lane
  onChange: (next: Lane) => void
}): React.ReactElement {
  const theme = useTheme()

  const options: ReadonlyArray<{ id: Lane; label: string }> = [
    { id: 'open', label: 'Aç' },
    { id: 'mine', label: 'Maçlarım' },
  ]

  return (
    <View
      accessibilityRole="tablist"
      style={{
        flexDirection: 'row',
        padding: 3,
        gap: 3,
        borderRadius: theme.radius.lg,
        backgroundColor: theme.colors.muted,
      }}
    >
      {options.map((option) => {
        const selected = option.id === value
        return (
          <Pressable
            key={option.id}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onPress={() => onChange(option.id)}
            style={{
              flex: 1,
              minHeight: 40,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: theme.radius.md,
              backgroundColor: selected ? theme.colors.card : 'transparent',
            }}
          >
            <Text variant="label" weight="600" tone={selected ? 'default' : 'muted'}>
              {option.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

/* ========================================================================== */
/*  Loaders                                                                   */
/* ========================================================================== */

/** Open matches with a free spot, from the discovery route. */
async function loadOpenMatches(): Promise<MatchCardMatch[]> {
  const raw = await apiFetch<unknown>('/api/matches?openOnly=true&limit=25')
  const parsed = discoveryResultSchema.safeParse(raw)

  if (!parsed.success) {
    throw new DataError('The match list came back in a shape this version of the app cannot read.')
  }

  return parsed.data.matches.map((item) => ({
    id: item.id,
    kickoffAt: item.kickoffAt,
    durationMinutes: item.durationMinutes,
    format: item.format,
    status: item.status,
    isRanked: item.isRanked,
    venueName: item.venueName,
    city: item.city,
    // `GET /api/matches` is deliberately identity-free and answers with no venue id, so there is
    // nothing to look a timezone up with. The card renders in the device zone and labels it as
    // such rather than passing off a device-local time as the venue's.
    timezone: null,
    // Discovery never carries a result: every row is a future, non-cancelled match.
    homeScore: null,
    awayScore: null,
    homeCount: item.homeCount,
    awayCount: item.awayCount,
    matchQuality: item.matchQuality,
    yourSide: null,
    isConfirmed: null,
  }))
}

const DAY_MS = 24 * 60 * 60 * 1000

/** How far back "your matches" reaches. Everything after this point, including every future one. */
const MY_MATCH_HORIZON_DAYS = 90

/** Ceiling on the id list the follow-up queries send. The horizon above is the real bound. */
const MY_MATCH_LIMIT = 100

/**
 * Matches the caller is in, read under RLS.
 *
 * Four small queries rather than one embedded select. Each row set is scoped by its own policy and
 * typed on its own, and a venue the viewer may not read costs a missing name instead of failing
 * the whole screen.
 */
async function loadMyMatches(userId: string | null): Promise<MatchCardMatch[]> {
  if (!userId) return []

  // BOUNDED ON PURPOSE. Every id this read returns goes back out in an `id=in.(...)` list on the
  // next two queries, so an unbounded read here means a query string that grows with the caller's
  // lifetime participation until PostgREST rejects the URL. The horizon is the real bound and the
  // limit is only a ceiling behind it: `kickoff_at >= now - 90 days` has no upper edge, so no
  // FUTURE fixture is ever filtered out — which is the mistake a plain `order by joined_at limit n`
  // would make. This tab shows the next fixture and recent form; older history lives on the
  // profile screen, which pages it properly.
  const horizon = new Date(Date.now() - MY_MATCH_HORIZON_DAYS * DAY_MS).toISOString()

  const { data: mine, error: mineError } = await supabase
    .from('match_participants')
    .select('match_id, team_side, is_confirmed, matches!inner(kickoff_at)')
    .eq('player_id', userId)
    .gte('matches.kickoff_at', horizon)
    .order('joined_at', { ascending: false })
    .limit(MY_MATCH_LIMIT)

  if (mineError) throw dataError('Could not load the matches you are in.', mineError)

  const sides = new Map<string, { side: 'home' | 'away' | null; confirmed: boolean }>()
  for (const row of mine ?? []) {
    sides.set(row.match_id, {
      side: row.team_side === 'home' || row.team_side === 'away' ? row.team_side : null,
      confirmed: row.is_confirmed,
    })
  }

  const matchIds = [...sides.keys()]
  if (matchIds.length === 0) return []

  const { data: matches, error: matchError } = await supabase
    .from('matches')
    .select(
      // One long literal: postgrest-js derives the row type from the select string as a literal
      // type, and "a" + "b" widens to `string`, which loses the typing entirely.
      'id, kickoff_at, duration_minutes, format, status, is_ranked, venue_id, home_score, away_score, match_quality',
    )
    .in('id', matchIds)

  if (matchError) throw dataError('Could not load your fixtures.', matchError)

  const rows = matches ?? []
  if (rows.length === 0) return []

  const venueIds = unique(rows.map((row) => row.venue_id))
  const venues = new Map<string, { name: string; city: string | null; timezone: string }>()

  if (venueIds.length > 0) {
    const { data: venueRows, error: venueError } = await supabase
      .from('venues')
      // `timezone` is what the card quotes the kick-off in. Without it a fixture in another zone
      // reads at the device's offset and disagrees with the match detail screen.
      .select('id, name, city, timezone')
      .in('id', venueIds)

    if (!venueError) {
      for (const venue of venueRows ?? []) {
        venues.set(venue.id, { name: venue.name, city: venue.city, timezone: venue.timezone })
      }
    }
  }

  const { data: participants, error: participantError } = await supabase
    .from('match_participants')
    .select('match_id, team_side')
    .in('match_id', matchIds)

  if (participantError) throw dataError('Could not count who is in your matches.', participantError)

  const counts = new Map<string, { home: number; away: number }>()
  for (const row of participants ?? []) {
    const entry = counts.get(row.match_id) ?? { home: 0, away: 0 }
    if (row.team_side === 'away') entry.away += 1
    else entry.home += 1
    counts.set(row.match_id, entry)
  }

  const items: MatchCardMatch[] = rows.map((row) => {
    const venue = row.venue_id ? venues.get(row.venue_id) : undefined
    const count = counts.get(row.id) ?? { home: 0, away: 0 }
    const involvement = sides.get(row.id)

    return {
      id: row.id,
      kickoffAt: row.kickoff_at,
      durationMinutes: row.duration_minutes,
      format: row.format,
      status: row.status,
      isRanked: row.is_ranked,
      venueName: venue?.name ?? null,
      city: venue?.city ?? null,
      timezone: venue?.timezone ?? null,
      homeScore: row.home_score,
      awayScore: row.away_score,
      homeCount: count.home,
      awayCount: count.away,
      matchQuality: row.match_quality,
      yourSide: involvement?.side ?? null,
      isConfirmed: involvement?.confirmed ?? null,
    }
  })

  return sortByRelevance(items)
}

/**
 * Next kick-off first, then everything already played, most recent first.
 *
 * Plain chronological order buries tonight's game under two years of history; reverse order buries
 * it under next month's. The thing a player opens this tab for is the next match.
 */
function sortByRelevance(items: readonly MatchCardMatch[]): MatchCardMatch[] {
  const now = Date.now()
  const upcoming: MatchCardMatch[] = []
  const past: MatchCardMatch[] = []

  for (const item of items) {
    const at = Date.parse(item.kickoffAt)
    if (Number.isNaN(at) || at >= now) upcoming.push(item)
    else past.push(item)
  }

  upcoming.sort((a, b) => Date.parse(a.kickoffAt) - Date.parse(b.kickoffAt))
  past.sort((a, b) => Date.parse(b.kickoffAt) - Date.parse(a.kickoffAt))

  return [...upcoming, ...past]
}

function unique(values: readonly (string | null)[]): string[] {
  const set = new Set<string>()
  for (const value of values) {
    if (value) set.add(value)
  }
  return [...set]
}
