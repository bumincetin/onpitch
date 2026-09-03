/**
 * app/bookings.tsx
 *
 * Every booking this account can see, split into what is still coming and what is done.
 *
 * ---------------------------------------------------------------------------
 * WHAT "MY BOOKINGS" MEANS
 * ---------------------------------------------------------------------------
 * `bookings_select_stakeholders` already scopes the table to the caller: their own bookings,
 * their team's, and — for a venue owner — the ones on their pitches. The `or()` below narrows
 * that to the first two, because this screen is the customer's list and a venue owner's hundred
 * incoming bookings would bury their own five. It is a filter, not the authorisation; removing
 * it would widen what is asked for, never what is allowed.
 *
 * ---------------------------------------------------------------------------
 * UPCOMING vs PAST IS SPLIT IN POSTGRES, NOT IN JAVASCRIPT
 * ---------------------------------------------------------------------------
 * `bookings.time_range` is a `tstzrange`, so the split is a range comparison:
 * `time_range << [now,now]` is "ended before now", and its negation is "still to come" — which correctly keeps a
 * game being played RIGHT NOW in the upcoming list instead of dropping it out of both. Both sides
 * are asked for separately so the row cap applies PER TAB. Fetching one page ordered by
 * `created_at` and splitting it here would silently lose an upcoming booking that was made a long
 * time ago, which is exactly the row the customer opened the screen to find.
 *
 * ---------------------------------------------------------------------------
 * FIVE QUERIES, NOT 4N
 * ---------------------------------------------------------------------------
 * PostgREST cannot embed `venues` through `pitches` from `bookings` in one hop here, so the page
 * resolves the bookings first and then reads the pitches, venues and matches for the whole page
 * in one query each. A per-row lookup would be a request per booking on a mobile connection.
 */

import { Stack, useFocusEffect, useRouter } from 'expo-router'
import * as React from 'react'
import { FlatList, RefreshControl, View } from 'react-native'

import { BookingStatusBadge } from '@/components/booking'
import { Badge, Button, Card, EmptyState, Screen, Separator, Spinner, Text } from '@/components/ui'
import { parseRange } from '@/lib/booking/slots'
import { formatDayLabel, formatMinor, formatTimeRange } from '@/lib/format'
import { supabase, useSession } from '@/lib/supabase'
import { useTheme } from '@/lib/theme'
import type { Enums } from '@onpitch/shared/database'

/** How many bookings each tab loads. Past this the answer is a date filter, not a page 2. */
const ROW_LIMIT = 100

/** A degenerate `[now,now]` range: the pivot both halves of the split are compared against. */
function nowRangeLiteral(now: Date): string {
  const iso = now.toISOString()
  return `["${iso}","${iso}"]`
}

/** Statuses whose booking is still going to happen. */
const LIVE: readonly Enums<'booking_status'>[] = ['pending', 'awaiting_payment', 'confirmed']

type Tab = 'upcoming' | 'past'

interface BookingRow {
  id: string
  pitch_id: string
  team_id: string | null
  status: Enums<'booking_status'>
  payment_status: Enums<'payment_status'>
  time_range: string
  total_minor: number
  currency: string
  created_at: string
}

interface PitchRow {
  id: string
  name: string
  venue_id: string
}

interface VenueRow {
  id: string
  name: string
  slug: string
  timezone: string
}

/** One row, with everything the card needs already joined in. */
interface BookingItem {
  id: string
  status: Enums<'booking_status'>
  paymentStatus: Enums<'payment_status'>
  startsAt: number | null
  endsAt: number | null
  totalMinor: number
  currency: string
  pitchName: string
  venueName: string
  timezone: string
  isTeamBooking: boolean
  hasMatch: boolean
}

export default function BookingsScreen(): React.ReactElement {
  const theme = useTheme()
  const router = useRouter()
  const { user } = useSession()

  const [items, setItems] = React.useState<BookingItem[]>([])
  const [loading, setLoading] = React.useState(true)
  const [refreshing, setRefreshing] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [tab, setTab] = React.useState<Tab>('upcoming')

  const userId = user?.id ?? null

  const load = React.useCallback(async (): Promise<void> => {
    if (!userId) {
      setItems([])
      setError('Sign in to see your bookings.')
      return
    }
    setError(null)

    const { data: memberships } = await supabase
      .from('team_members')
      .select('team_id')
      .eq('player_id', userId)
      .is('left_at', null)

    const teamIds = (memberships ?? []).map((row) => row.team_id)

    // The select string has to stay an inline literal: postgrest-js derives the row type from it
    // as a literal type, and hoisting it to a `const` widens it to `string` and loses the typing.
    const scoped = () => {
      let builder = supabase
        .from('bookings')
        .select(
          'id, pitch_id, team_id, status, payment_status, time_range, total_minor, currency, created_at',
        )

      builder =
        teamIds.length > 0
          ? builder.or(`booked_by.eq.${userId},team_id.in.(${teamIds.join(',')})`)
          : builder.eq('booked_by', userId)

      return builder
    }

    // One pivot for both halves, so a row cannot fall through the gap between two `now`s or land
    // in both lists.
    const pivot = nowRangeLiteral(new Date())

    const [upcomingResult, pastResult] = await Promise.all([
      scoped()
        .not('time_range', 'sl', pivot)
        .order('time_range', { ascending: true })
        .limit(ROW_LIMIT)
        .returns<BookingRow[]>(),
      scoped()
        .filter('time_range', 'sl', pivot)
        .order('time_range', { ascending: false })
        .limit(ROW_LIMIT)
        .returns<BookingRow[]>(),
    ])

    const bookingError = upcomingResult.error ?? pastResult.error
    if (bookingError) {
      setItems([])
      setError('Your bookings could not be loaded. Try again in a moment.')
      return
    }

    const rows = [...(upcomingResult.data ?? []), ...(pastResult.data ?? [])]
    if (rows.length === 0) {
      setItems([])
      return
    }

    const pitchIds = unique(rows.map((row) => row.pitch_id))
    const bookingIds = rows.map((row) => row.id)

    const { data: pitchRows } = await supabase
      .from('pitches')
      .select('id, name, venue_id')
      .in('id', pitchIds)
      .returns<PitchRow[]>()

    const venueIds = unique((pitchRows ?? []).map((row) => row.venue_id))

    const [venueResult, matchResult] = await Promise.all([
      venueIds.length > 0
        ? supabase
            .from('venues')
            .select('id, name, slug, timezone')
            .in('id', venueIds)
            .returns<VenueRow[]>()
        : Promise.resolve({ data: [] as VenueRow[] }),
      supabase.from('matches').select('id, booking_id').in('booking_id', bookingIds),
    ])

    const pitches = new Map((pitchRows ?? []).map((row) => [row.id, row]))
    const venues = new Map((venueResult.data ?? []).map((row) => [row.id, row]))
    const matched = new Set<string>()
    for (const match of matchResult.data ?? []) {
      if (match.booking_id) matched.add(match.booking_id)
    }

    setItems(
      rows.map((row) => {
        const pitch = pitches.get(row.pitch_id) ?? null
        const venue = pitch ? (venues.get(pitch.venue_id) ?? null) : null
        const range = parseRange(row.time_range)

        return {
          id: row.id,
          status: row.status,
          paymentStatus: row.payment_status,
          startsAt: range?.start ?? null,
          endsAt: range?.end ?? null,
          totalMinor: row.total_minor,
          currency: row.currency,
          pitchName: pitch?.name ?? 'Pitch',
          venueName: venue?.name ?? 'Venue',
          timezone: venue?.timezone ?? 'UTC',
          isTeamBooking: row.team_id !== null,
          hasMatch: matched.has(row.id),
        }
      }),
    )
  }, [userId])

  React.useEffect(() => {
    let active = true
    setLoading(true)
    void load().finally(() => {
      if (active) setLoading(false)
    })
    return () => {
      active = false
    }
  }, [load])

  // A booking paid for, or cancelled, on the detail screen changes this list.
  const loadRef = React.useRef(load)
  React.useEffect(() => {
    loadRef.current = load
  }, [load])
  const seenFirstFocus = React.useRef(false)

  useFocusEffect(
    React.useCallback(() => {
      if (!seenFirstFocus.current) {
        seenFirstFocus.current = true
        return
      }
      void loadRef.current()
    }, []),
  )

  /* ---- the two lists --------------------------------------------------- */

  const { upcoming, past } = React.useMemo(() => {
    const nowMs = Date.now()
    const up: BookingItem[] = []
    const done: BookingItem[] = []

    for (const item of items) {
      // A booking with an unreadable range cannot be placed in time, so it goes in Upcoming
      // where the customer will actually look at it, rather than being quietly filed away.
      const stillToCome = item.endsAt === null || item.endsAt > nowMs
      if (stillToCome && LIVE.includes(item.status)) up.push(item)
      else done.push(item)
    }

    up.sort((a, b) => (a.startsAt ?? Number.MAX_SAFE_INTEGER) - (b.startsAt ?? Number.MAX_SAFE_INTEGER))
    done.sort((a, b) => (b.startsAt ?? 0) - (a.startsAt ?? 0))
    return { upcoming: up, past: done }
  }, [items])

  const visible = tab === 'upcoming' ? upcoming : past

  return (
    <>
      <Stack.Screen
        options={{
          headerShown: true,
          title: 'Rezervasyonlarım',
          headerBackTitle: 'Back',
          headerStyle: { backgroundColor: theme.colors.background },
          headerTintColor: theme.colors.foreground,
          headerTitleStyle: { color: theme.colors.foreground },
          headerShadowVisible: false,
        }}
      />

      <Screen padded={false} error={error} onRetry={() => void load()}>
        <FlatList
          data={visible}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{
            paddingHorizontal: theme.spacing.lg,
            paddingTop: theme.spacing.lg,
            paddingBottom: theme.spacing.xxl,
            gap: theme.spacing.md,
          }}
          ListHeaderComponent={
            <View style={{ gap: theme.spacing.md, paddingBottom: theme.spacing.sm }}>
              <View style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
                <Button
                  title={`Upcoming${upcoming.length > 0 ? ` (${upcoming.length})` : ''}`}
                  size="sm"
                  variant={tab === 'upcoming' ? 'primary' : 'outline'}
                  onPress={() => setTab('upcoming')}
                  accessibilityState={{ selected: tab === 'upcoming' }}
                />
                <Button
                  title="Geçmiş"
                  size="sm"
                  variant={tab === 'past' ? 'primary' : 'outline'}
                  onPress={() => setTab('past')}
                  accessibilityState={{ selected: tab === 'past' }}
                />
              </View>
              <Separator />
            </View>
          }
          renderItem={({ item }) => (
            <BookingRowCard item={item} onPress={() => router.push(`/booking/${item.id}`)} />
          )}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                setRefreshing(true)
                void load().finally(() => setRefreshing(false))
              }}
              tintColor={theme.colors.primary}
            />
          }
          ListEmptyComponent={
            loading ? (
              <Spinner centred label="Rezervasyonların yükleniyor" />
            ) : tab === 'upcoming' ? (
              <EmptyState
                title="Henüz rezervasyon yok"
                description="Bir saha bul, saat seç; burada görünür."
                action={{ label: 'Saha bul', onPress: () => router.replace('/(tabs)/book') }}
              />
            ) : (
              <EmptyState
                title="Geçmiş rezervasyon yok"
                description="Oynadığın maçlar ve iptal ettiklerin buraya düşer."
              />
            )
          }
        />
      </Screen>
    </>
  )
}

function BookingRowCard({
  item,
  onPress,
}: {
  item: BookingItem
  onPress: () => void
}): React.ReactElement {
  const theme = useTheme()

  const when =
    item.startsAt === null || item.endsAt === null
      ? 'Time unavailable'
      : `${formatDayLabel(item.startsAt, item.timezone)} · ${formatTimeRange(item.startsAt, item.endsAt, item.timezone)}`

  return (
    <Card
      onPress={onPress}
      accessibilityLabel={`${item.venueName}, ${item.pitchName}. ${when}. ${formatMinor(item.totalMinor, item.currency)}.`}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: theme.spacing.md,
        }}
      >
        <View style={{ flex: 1, gap: theme.spacing.xs }}>
          <Text variant="heading" numberOfLines={1}>
            {item.venueName}
          </Text>
          <Text variant="caption" tone="muted" numberOfLines={1}>
            {item.pitchName}
          </Text>
        </View>
        <BookingStatusBadge status={item.status} paymentStatus={item.paymentStatus} size="sm" />
      </View>

      <Text variant="body">{when}</Text>

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}>
        <Text variant="label" weight="600">
          {formatMinor(item.totalMinor, item.currency)}
        </Text>
        {item.isTeamBooking ? (
          <Badge tone="outline" size="sm">
            Takım
          </Badge>
        ) : null}
        {item.hasMatch ? (
          <Badge tone="outline" size="sm">
            Maç
          </Badge>
        ) : null}
      </View>
    </Card>
  )
}

function unique(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    if (seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}
