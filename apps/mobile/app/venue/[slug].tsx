/**
 * app/venue/[slug].tsx
 *
 * One venue: where it is, what it has, and which of its pitches are free on the chosen day.
 *
 * ---------------------------------------------------------------------------
 * WHY AVAILABILITY IS FETCHED HERE AND NOT ON THE SEARCH SCREEN
 * ---------------------------------------------------------------------------
 * Free/busy costs one `/api/pitches/[id]/slots` round trip per pitch, because a customer cannot
 * read other people's bookings (that is `bookings_select_stakeholders` doing its job) and the
 * route computes the grid server-side from anonymised intervals. On a search screen that is one
 * request per pitch in the whole result set. Here it is bounded by the pitches of one venue, and
 * capped at {@link AVAILABILITY_PROBE_LIMIT} on top of that — the rest say "open it to see
 * times", which is honest, rather than showing a count that was never fetched.
 *
 * A pitch whose probe fails renders "Times unknown". It never renders "Full": the difference
 * between "nothing is free" and "we could not ask" is the difference between the customer trying
 * another day and the customer leaving.
 *
 * ---------------------------------------------------------------------------
 * THE DAY STRIP IS IN THE VENUE'S ZONE
 * ---------------------------------------------------------------------------
 * `?date=` arrives from the search screen as a day on the DEVICE's calendar. Everything from
 * here down is venue-local, because opening hours, the slot grid and the price are, so the strip
 * is generated from today at the venue and the incoming key is only used when it names a day the
 * strip actually offers.
 */

import { Stack, useLocalSearchParams, useRouter } from 'expo-router'
import * as React from 'react'
import { Image, RefreshControl, ScrollView, View } from 'react-native'

import { PitchCard, placeLabel, type PitchAvailability, type PitchCardPitch } from '@/components/booking'
import { Badge, Button, EmptyState, Notice, Screen, Separator, Text } from '@/components/ui'
import { apiFetch, isApiError } from '@/lib/api'
import {
  addDaysToDateKey,
  countAvailable,
  dayByKey,
  firstAvailable,
  isDateKey,
  parseDateKey,
  parsePitchSlots,
  todayKey,
  zonedWallClockToUtc,
} from '@/lib/booking/slots'
import { formatDayLabel } from '@/lib/format'
import { consentBlockReason } from '@/lib/gdpr'
import { supabase, useSession } from '@/lib/supabase'
import { MessageButton } from '@/components/messaging'
import { canMessage } from '@/lib/messaging'
import { useTheme } from '@/lib/theme'
import type { Enums } from '@onpitch/shared/database'

/** How many pitches get a live free-slot count. Beyond this the card says to open it. */
const AVAILABILITY_PROBE_LIMIT = 8

/** How far ahead the day strip runs. */
const DAY_CHOICES = 14

interface VenueRow {
  id: string
  name: string
  slug: string
  owner_id: string
  description: string | null
  address_line1: string | null
  city: string | null
  district: string | null
  phone: string | null
  photos: string[] | null
  amenities: string[] | null
  timezone: string
  is_active: boolean
  charges_enabled: boolean
}

interface PitchRow {
  id: string
  name: string
  format: Enums<'match_format'>
  surface: Enums<'pitch_surface'>
  is_indoor: boolean
  capacity: number | null
  hourly_rate_minor: number
  currency: string
  slot_minutes: number
  is_active: boolean
}

export default function VenueScreen(): React.ReactElement {
  const theme = useTheme()
  const router = useRouter()
  const params = useLocalSearchParams()
  const { user, profile, loading: sessionLoading } = useSession()

  const slug = firstParam(params.slug)
  const requestedDate = firstParam(params.date)

  const [venue, setVenue] = React.useState<VenueRow | null>(null)
  const [pitches, setPitches] = React.useState<PitchRow[]>([])
  const [loading, setLoading] = React.useState(true)
  const [refreshing, setRefreshing] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [canWriteToOwner, setCanWriteToOwner] = React.useState(false)

  /* ---- the venue and its pitches -------------------------------------- */
  const load = React.useCallback(async (): Promise<void> => {
    if (!slug) {
      setError('That venue link is missing its address.')
      return
    }
    setError(null)

    const { data: venueRow, error: venueError } = await supabase
      .from('venues')
      .select(
        'id, name, slug, owner_id, description, address_line1, city, district, phone, photos, amenities, timezone, is_active, charges_enabled',
      )
      .eq('slug', slug)
      .returns<VenueRow[]>()
      .maybeSingle()

    if (venueError) {
      setError('That venue could not be loaded. Try again in a moment.')
      return
    }
    if (!venueRow) {
      // Either it does not exist or `venues_select_active_or_own` hides it. One answer for both.
      setVenue(null)
      setPitches([])
      return
    }
    setCanWriteToOwner(venueRow.owner_id !== user?.id && (await canMessage(venueRow.owner_id)))

    const { data: pitchRows, error: pitchError } = await supabase
      .from('pitches')
      .select(
        'id, name, format, surface, is_indoor, capacity, hourly_rate_minor, currency, slot_minutes, is_active',
      )
      .eq('venue_id', venueRow.id)
      .eq('is_active', true)
      .order('name', { ascending: true })
      .returns<PitchRow[]>()

    if (pitchError) {
      setVenue(venueRow)
      setPitches([])
      setError('The pitches at this venue could not be loaded.')
      return
    }

    setVenue(venueRow)
    setPitches(pitchRows ?? [])
  }, [slug])

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

  /* ---- the day strip --------------------------------------------------- */
  const timezone = venue?.timezone ?? 'UTC'

  const days = React.useMemo(() => {
    const start = todayKey(timezone)
    return Array.from({ length: DAY_CHOICES }, (_unused, offset) => {
      const key = addDaysToDateKey(start, offset)
      const { year, month, day } = parseDateKey(key)
      // Local noon, so the label cannot land on the neighbouring day in a far-east zone.
      return { key, label: formatDayLabel(zonedWallClockToUtc(year, month, day, 12, 0, timezone), timezone) }
    })
  }, [timezone])

  const [dateKey, setDateKey] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!venue) return
    setDateKey((current) => {
      if (current && days.some((day) => day.key === current)) return current
      if (requestedDate && isDateKey(requestedDate) && days.some((day) => day.key === requestedDate)) {
        return requestedDate
      }
      return days[0]?.key ?? todayKey(timezone)
    })
  }, [venue, days, requestedDate, timezone])

  /* ---- availability probes --------------------------------------------- */
  const probed = React.useMemo(() => pitches.slice(0, AVAILABILITY_PROBE_LIMIT), [pitches])
  const [availability, setAvailability] = React.useState<Record<string, PitchAvailability>>({})

  React.useEffect(() => {
    if (!dateKey || probed.length === 0) {
      setAvailability({})
      return
    }

    let active = true

    const pending: Record<string, PitchAvailability> = {}
    for (const pitch of probed) pending[pitch.id] = { state: 'loading' }
    setAvailability(pending)

    void (async () => {
      const entries = await Promise.all(
        probed.map(async (pitch): Promise<[string, PitchAvailability]> => {
          try {
            const payload = await apiFetch<unknown>(
              `/api/pitches/${encodeURIComponent(pitch.id)}/slots?date=${dateKey}&days=1`,
            )
            const slots = parsePitchSlots(payload)
            const day = dayByKey(slots.grid, dateKey)
            const next = firstAvailable(day)
            return [
              pitch.id,
              { state: 'ready', freeSlots: countAvailable(day), nextFreeAt: next?.startsAt ?? null },
            ]
          } catch (caught) {
            return [
              pitch.id,
              {
                state: 'error',
                message: isApiError(caught) ? caught.message : 'Müsaitlik kontrol edilemedi.',
              },
            ]
          }
        }),
      )

      if (!active) return
      const resolved: Record<string, PitchAvailability> = {}
      for (const [pitchId, state] of entries) resolved[pitchId] = state
      setAvailability(resolved)
    })()

    return () => {
      active = false
    }
  }, [probed, dateKey])

  /* ---- render ---------------------------------------------------------- */
  const handleRefresh = React.useCallback((): void => {
    setRefreshing(true)
    void load().finally(() => setRefreshing(false))
  }, [load])

  // Null while the session profile is still being read. `consentBlockReason(null)` returns the
  // guardian sentence, and accusing an adult of having no parental approval for the length of one
  // round trip is worse than saying nothing at all.
  const consentNotice = sessionLoading ? null : consentBlockReason(profile)
  const place = venue ? placeLabel(venue.district, venue.city) : null
  const banner = venue?.photos?.[0]

  const header = (
    <Stack.Screen
      options={{
        headerShown: true,
        title: venue?.name ?? 'Venue',
        headerBackTitle: 'Back',
        headerStyle: { backgroundColor: theme.colors.background },
        headerTintColor: theme.colors.foreground,
        headerTitleStyle: { color: theme.colors.foreground },
        headerShadowVisible: false,
      }}
    />
  )

  if (loading || error || !venue) {
    return (
      <>
        {header}
        <Screen
          scroll
          loading={loading}
          loadingLabel="Loading the venue"
          error={error}
          onRetry={() => void load()}
        >
          {!loading && !error && !venue ? (
            <EmptyState
              title="Bu işletme kullanılamıyor"
              description="Kaldırılmış olabilir ya da bağlantı yanlış olabilir."
              action={{ label: 'Aramaya dön', onPress: () => router.replace('/(tabs)/book') }}
            />
          ) : null}
        </Screen>
      </>
    )
  }

  const bookable = venue.is_active && venue.charges_enabled

  return (
    <>
      {header}
      <Screen padded={false}>
        <ScrollView
          contentContainerStyle={{
            paddingBottom: theme.spacing.xxl,
            gap: theme.spacing.lg,
          }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={handleRefresh}
              tintColor={theme.colors.primary}
            />
          }
        >
          {banner ? (
            <Image
              source={{ uri: banner }}
              style={{ width: '100%', height: 180, backgroundColor: theme.colors.muted }}
              resizeMode="cover"
              accessible={false}
            />
          ) : null}

          <View style={{ paddingHorizontal: theme.spacing.lg, gap: theme.spacing.lg }}>
            <View style={{ gap: theme.spacing.xs }}>
              <Text variant="display" accessibilityRole="header">
                {venue.name}
              </Text>
              {place ? (
                <Text variant="body" tone="muted">
                  {place}
                </Text>
              ) : null}
              {venue.address_line1 ? (
                <Text variant="caption" tone="muted">
                  {venue.address_line1}
                </Text>
              ) : null}
            </View>

            {!bookable ? (
              <Notice
                tone="warning"
                title="Şu an rezervasyon almıyor"
                description="Bu işletme hakediş kurulumunu tamamlamamış; saatlerinin ödemesi henüz alınamıyor."
              />
            ) : null}

            {consentNotice ? (
              <Notice
                tone="warning"
                title="Rezervasyon henüz açılmadı"
                description={consentNotice}
              />
            ) : null}

            {venue.description ? (
              <Text variant="body" tone="muted">
                {venue.description}
              </Text>
            ) : null}

            {venue.amenities && venue.amenities.length > 0 ? (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm }}>
                {venue.amenities.map((amenity) => (
                  <Badge key={amenity} tone="outline" size="sm">
                    {amenity}
                  </Badge>
                ))}
              </View>
            ) : null}

            <Separator />

            <View style={{ gap: theme.spacing.sm }}>
              <Text variant="label">Gün</Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ gap: theme.spacing.sm, paddingRight: theme.spacing.lg }}
              >
                {days.map((day) => (
                  <Button
                    key={day.key}
                    title={day.label}
                    size="sm"
                    variant={day.key === dateKey ? 'primary' : 'outline'}
                    onPress={() => setDateKey(day.key)}
                    accessibilityState={{ selected: day.key === dateKey }}
                  />
                ))}
              </ScrollView>
              <Text variant="caption" tone="muted">
                {`Times are the venue's local clock (${timezone}).`}
              </Text>
            </View>

            <View style={{ gap: theme.spacing.md }}>
              <Text variant="title" accessibilityRole="header">
                Sahalar
              </Text>

              {pitches.length === 0 ? (
                <EmptyState
                  title="Kayıtlı saha yok"
                  description="Bu işletme henüz rezerve edilebilir bir saha yayınlamamış."
                />
              ) : (
                pitches.map((pitch) => (
                  <PitchCard
                    key={pitch.id}
                    pitch={toCardPitch(pitch)}
                    timezone={timezone}
                    availability={availability[pitch.id] ?? { state: 'idle' }}
                    onPress={() =>
                      router.push(
                        `/venue/${encodeURIComponent(venue.slug)}/${encodeURIComponent(pitch.id)}?date=${dateKey ?? ''}`,
                      )
                    }
                  />
                ))
              )}

              {pitches.length > AVAILABILITY_PROBE_LIMIT ? (
                <Text variant="caption" tone="muted">
                  {`Free-slot counts are shown for the first ${AVAILABILITY_PROBE_LIMIT} pitches. Open any other pitch to see its times.`}
                </Text>
              ) : null}
            </View>

            {venue.phone ? (
              <Text variant="caption" tone="muted">
                {`İşletme telefonu: ${venue.phone}`}
              </Text>
            ) : null}

            {/* A booking here is a relationship in can_message(); otherwise the owner's policy decides. */}
            {canWriteToOwner ? (
              <MessageButton userId={venue.owner_id} title="İşletmeye yaz" variant="outline" fullWidth />
            ) : null}
          </View>
        </ScrollView>
      </Screen>
    </>
  )
}

function toCardPitch(row: PitchRow): PitchCardPitch {
  return {
    id: row.id,
    name: row.name,
    format: row.format,
    surface: row.surface,
    isIndoor: row.is_indoor,
    capacity: row.capacity,
    hourlyRateMinor: row.hourly_rate_minor,
    currency: row.currency,
    slotMinutes: row.slot_minutes,
    isActive: row.is_active,
  }
}

/**
 * The first value of a route parameter.
 *
 * expo-router hands back `string | string[] | undefined` — a repeated query key becomes an array
 * — and `noUncheckedIndexedAccess` makes indexing that array `string | undefined` too.
 */
function firstParam(value: string | string[] | undefined): string | null {
  if (typeof value === 'string') return value.length > 0 ? value : null
  if (Array.isArray(value)) {
    const head = value[0]
    return typeof head === 'string' && head.length > 0 ? head : null
  }
  return null
}
