/**
 * app/(tabs)/book.tsx
 *
 * Find a pitch. The front door of the booking funnel.
 *
 * ---------------------------------------------------------------------------
 * THE READ
 * ---------------------------------------------------------------------------
 * Venues are read with the user's own Supabase client, so `venues_select_active_or_own` and
 * `pitches_select_visible` decide the result set. The `is_active` / `charges_enabled` predicates
 * layered on top are a product decision — never show a customer a venue that cannot take their
 * money — not the authorisation.
 *
 * One query, up to `RESULT_LIMIT` venues, sorted and filtered on the device from there. Paging
 * would mean sorting by price or distance across a page boundary the server did not sort by,
 * which produces a list that reorders itself as you scroll. Narrowing by city is the answer to a
 * long list, and the notice at the bottom says so when the cap is hit.
 *
 * ---------------------------------------------------------------------------
 * THE DATE FILTER IS AN INTENT, NOT AN AVAILABILITY SEARCH
 * ---------------------------------------------------------------------------
 * Free/busy cannot be computed here. `bookings_select_stakeholders` shows a customer their own
 * bookings and nobody else's, which is the correct privacy posture and also means a grid built
 * from a client-side read of `bookings` would advertise slots that are already sold. The web app
 * folds availability in on the server; the equivalent on mobile would be one
 * `/api/pitches/[id]/slots` round trip per pitch on the page.
 *
 * So the date picked here selects the day, carries into the venue and pitch screens through the
 * route, and is checked against the real grid there — where the request count is bounded by the
 * pitches of one venue instead of by the whole result set. The label says "Book for", not
 * "Available on", because the two are not the same promise.
 *
 * ---------------------------------------------------------------------------
 * DISTANCE
 * ---------------------------------------------------------------------------
 * Nothing in this app asks the OS for a position: no location module is in the dependency set,
 * and adding one to sort a list would be a large privacy cost for a small convenience. "Nearest
 * first" instead measures from the middle of the venues in the city on the user's own profile —
 * data they already gave us — and the chip says which city it is measuring from.
 *
 * It is still gated on `profiles.location_sharing_enabled`, because that switch is the user's
 * stated answer about location-derived features. For an under-16 account the column is pinned
 * false by a CHECK constraint and a trigger, so the chip is simply ABSENT. That is the one place
 * this app hides a control rather than disabling it: a locked toggle in Settings explains a
 * standing policy, but a permanently dead sort chip on a search screen just looks broken.
 */

import { useFocusEffect, useRouter } from 'expo-router'
import * as React from 'react'
import { FlatList, RefreshControl, ScrollView, View } from 'react-native'

import { VenueCard, formatShortLabel, MATCH_FORMATS, type VenueCardVenue } from '@/components/booking'
import { Button, EmptyState, Field, NightBand, Notice, Screen, Separator, Spinner, Text } from '@/components/ui'
import {
  addDaysToDateKey,
  centroidOf,
  distanceKm,
  parseDateKey,
  todayKey,
  zonedWallClockToUtc,
  type Coordinates,
} from '@/lib/booking/slots'
import { formatDayLabel } from '@/lib/format'
import { consentBlockReason } from '@/lib/gdpr'
import { supabase, useSession } from '@/lib/supabase'
import { useTheme } from '@/lib/theme'
import type { Enums } from '@onpitch/shared/database'
import { DEFAULT_CURRENCY, toMinor } from '@onpitch/shared/domain'

/** How many venues one search loads. Past this the answer is "narrow the city", not "page 2". */
const RESULT_LIMIT = 60

/** How far ahead the day strip runs. */
const DAY_CHOICES = 14

/** Typing pauses this long before the query runs, so a five-letter city is one request. */
const SEARCH_DEBOUNCE_MS = 350

type SortKey = 'name' | 'price' | 'distance'

/* -------------------------------------------------------------------------- */
/*  Rows                                                                       */
/* -------------------------------------------------------------------------- */

interface VenuePitchRow {
  id: string
  format: Enums<'match_format'>
  hourly_rate_minor: number
  currency: string
  is_active: boolean
}

interface VenueRow {
  id: string
  name: string
  slug: string
  city: string | null
  district: string | null
  photos: string[] | null
  amenities: string[] | null
  latitude: number | null
  longitude: number | null
  pitches: VenuePitchRow[]
}

const VENUE_SELECT = `
  id, name, slug, city, district, photos, amenities, latitude, longitude,
  pitches!inner ( id, format, hourly_rate_minor, currency, is_active )
`

/** A venue plus the derived fields the card and the sorts need. */
interface SearchResult extends VenueCardVenue {
  coordinates: Coordinates | null
}

/* -------------------------------------------------------------------------- */

export default function BookScreen(): React.ReactElement {
  const theme = useTheme()
  const router = useRouter()
  const { profile, loading: sessionLoading } = useSession()

  /* ---- filters ------------------------------------------------------- */
  const [where, setWhere] = React.useState('')
  const [debouncedWhere, setDebouncedWhere] = React.useState('')
  const [format, setFormat] = React.useState<Enums<'match_format'> | null>(null)
  const [maxPriceInput, setMaxPriceInput] = React.useState('')
  const [debouncedMaxPrice, setDebouncedMaxPrice] = React.useState('')
  const [dateKey, setDateKey] = React.useState(() => todayKey(deviceTimeZone()))
  const [sort, setSort] = React.useState<SortKey>('name')

  React.useEffect(() => {
    const timer = setTimeout(() => setDebouncedWhere(where.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [where])

  React.useEffect(() => {
    const timer = setTimeout(() => setDebouncedMaxPrice(maxPriceInput.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [maxPriceInput])

  const maxPriceMinor = React.useMemo(() => parsePriceCeiling(debouncedMaxPrice), [debouncedMaxPrice])
  const priceInputInvalid = debouncedMaxPrice.length > 0 && maxPriceMinor === null

  /* ---- results ------------------------------------------------------- */
  const [results, setResults] = React.useState<SearchResult[]>([])
  const [loading, setLoading] = React.useState(true)
  const [refreshing, setRefreshing] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [truncated, setTruncated] = React.useState(false)

  // Guards against a slow first request landing after a fast second one and replacing newer
  // results with older ones.
  const requestRef = React.useRef(0)

  const runSearch = React.useCallback(async (): Promise<void> => {
    const requestId = ++requestRef.current
    setError(null)

    let builder = supabase
      .from('venues')
      .select(VENUE_SELECT)
      .eq('is_active', true)
      .eq('charges_enabled', true)
      .eq('pitches.is_active', true)

    const pattern = sanitisePattern(debouncedWhere)
    if (pattern) {
      builder = builder.or(
        `name.ilike.%${pattern}%,city.ilike.%${pattern}%,district.ilike.%${pattern}%`,
      )
    }
    if (format) builder = builder.eq('pitches.format', format)
    if (maxPriceMinor !== null) {
      // `.lte()` only types plain columns; an embedded path has to go through `.filter()`.
      builder = builder.filter('pitches.hourly_rate_minor', 'lte', maxPriceMinor)
    }

    const { data, error: queryError } = await builder
      .order('name', { ascending: true })
      .limit(RESULT_LIMIT + 1)
      .returns<VenueRow[]>()

    if (requestRef.current !== requestId) return

    if (queryError) {
      setResults([])
      setError('That search could not be run. Check your connection and try again.')
      return
    }

    const rows = data ?? []
    setTruncated(rows.length > RESULT_LIMIT)
    setResults(rows.slice(0, RESULT_LIMIT).map(toSearchResult))
  }, [debouncedWhere, format, maxPriceMinor])

  const loadedOnceRef = React.useRef(false)

  React.useEffect(() => {
    let active = true
    setLoading(true)
    void runSearch().finally(() => {
      if (!active) return
      setLoading(false)
      loadedOnceRef.current = true
    })
    return () => {
      active = false
    }
  }, [runSearch])

  // Coming back from a booking should not leave a stale list on screen. The ref keeps this
  // callback stable, so a focus refetch happens once per visit rather than once per filter
  // change — the effect above already covers those.
  const runSearchRef = React.useRef(runSearch)
  React.useEffect(() => {
    runSearchRef.current = runSearch
  }, [runSearch])

  useFocusEffect(
    React.useCallback(() => {
      if (!loadedOnceRef.current) return
      void runSearchRef.current()
    }, []),
  )

  const handleRefresh = React.useCallback((): void => {
    setRefreshing(true)
    void runSearch().finally(() => setRefreshing(false))
  }, [runSearch])

  /* ---- the distance anchor ------------------------------------------- */
  const locationSharing = profile?.location_sharing_enabled ?? false
  const homeCity = profile?.city?.trim() ?? ''
  const [anchor, setAnchor] = React.useState<Coordinates | null>(null)

  React.useEffect(() => {
    if (!locationSharing || homeCity.length === 0) {
      setAnchor(null)
      return
    }

    let active = true
    void (async () => {
      const { data } = await supabase
        .from('venues')
        .select('latitude, longitude')
        .eq('is_active', true)
        .ilike('city', homeCity)
        .not('latitude', 'is', null)
        .not('longitude', 'is', null)
        .limit(100)

      if (!active) return

      const points: Coordinates[] = []
      for (const row of data ?? []) {
        if (row.latitude === null || row.longitude === null) continue
        points.push({ latitude: row.latitude, longitude: row.longitude })
      }
      setAnchor(centroidOf(points))
    })()

    return () => {
      active = false
    }
  }, [locationSharing, homeCity])

  const canSortByDistance = locationSharing && anchor !== null
  React.useEffect(() => {
    // The chip can disappear while it is the active sort — the profile changes, or the city has
    // no mapped venues. Fall back rather than leaving a sort nothing can compute.
    if (sort === 'distance' && !canSortByDistance) setSort('name')
  }, [sort, canSortByDistance])

  /* ---- sorting ------------------------------------------------------- */
  const sorted = React.useMemo(() => {
    // Distance is attached whenever it can be computed, not only when it is the sort key — the
    // badge is useful on a price-sorted list too. `map` already returns a fresh array, so
    // sorting it in place cannot disturb `results`.
    const withDistance = results.map((venue) => ({
      ...venue,
      distanceKm:
        canSortByDistance && anchor && venue.coordinates
          ? distanceKm(anchor, venue.coordinates)
          : null,
    }))

    if (sort === 'price') {
      withDistance.sort((a, b) => rateOrLast(a.fromRateMinor) - rateOrLast(b.fromRateMinor))
    } else if (sort === 'distance') {
      withDistance.sort((a, b) => distanceOrLast(a.distanceKm) - distanceOrLast(b.distanceKm))
    } else {
      withDistance.sort((a, b) => a.name.localeCompare(b.name))
    }
    return withDistance
  }, [results, sort, anchor, canSortByDistance])

  const days = React.useMemo(() => {
    const zone = deviceTimeZone()
    const start = todayKey(zone)
    return Array.from({ length: DAY_CHOICES }, (_unused, offset) => {
      const key = addDaysToDateKey(start, offset)
      // Label the day from LOCAL NOON, not from midnight UTC. Midnight UTC lands on the previous
      // or the next calendar day for anyone far enough east or west, and the strip would open on
      // a chip labelled "Tomorrow" that is actually today.
      const { year, month, day } = parseDateKey(key)
      const noon = zonedWallClockToUtc(year, month, day, 12, 0, zone)
      return { key, label: formatDayLabel(noon, zone) }
    })
  }, [])

  // Null while the session profile is still being read. `consentBlockReason(null)` returns the
  // guardian sentence, and accusing an adult of having no parental approval for the length of one
  // round trip is worse than saying nothing at all.
  const consentNotice = sessionLoading ? null : consentBlockReason(profile)

  const openVenue = React.useCallback(
    (slug: string): void => {
      router.push(`/venue/${encodeURIComponent(slug)}?date=${dateKey}`)
    },
    [router, dateKey],
  )

  const listHeader = (
    <View style={{ gap: theme.spacing.lg, paddingBottom: theme.spacing.md }}>
      <NightBand
        compact
        bleed={theme.spacing.lg}
        eyebrow="Saha"
        title="Bir saat tut"
        lede="İşletmeleri ara, sonra istediğin sahada bir saat seç."
        aside={<Button title="Rezervasyonlarım" variant="outline" size="sm" onPress={() => router.push('/bookings')} />}
        style={{ marginTop: -theme.spacing.lg }}
      />

      {consentNotice ? (
        <Notice tone="warning" title="Rezervasyon henüz açılmadı" description={consentNotice} />
      ) : null}

      {/* The error sits above the filters rather than replacing the screen: a failed search
          usually needs the filters changed, and a full-screen error takes them away. */}
      {error ? (
        <Notice tone="destructive" title="Arama çalıştırılamadı" description={error} live>
          <Button title="Tekrar dene" variant="outline" size="sm" onPress={() => void runSearch()} />
        </Notice>
      ) : null}

      <Field
        label="Şehir"
        value={where}
        onChangeText={setWhere}
        placeholder="İstanbul, Kadıköy, or a venue name"
        autoCapitalize="words"
        autoCorrect={false}
        returnKeyType="search"
        maxLength={60}
        hint="Şehir, ilçe ya da işletme adıyla eşleşir."
      />

      <View style={{ gap: theme.spacing.sm }}>
        <Text variant="label">Kimin için</Text>
        <ChipRow>
          {days.map((day) => (
            <Chip
              key={day.key}
              label={day.label}
              selected={day.key === dateKey}
              onPress={() => setDateKey(day.key)}
            />
          ))}
        </ChipRow>
        <Text variant="caption" tone="muted">
          Seçtiğin gün saha takvimine taşınır; gerçek saatler orada kontrol edilir.
        </Text>
      </View>

      <View style={{ gap: theme.spacing.sm }}>
        <Text variant="label">Format</Text>
        <ChipRow>
          <Chip label="Fark etmez" selected={format === null} onPress={() => setFormat(null)} />
          {MATCH_FORMATS.map((option) => (
            <Chip
              key={option}
              label={formatShortLabel(option)}
              selected={format === option}
              onPress={() => setFormat(option)}
            />
          ))}
        </ChipRow>
      </View>

      <Field
        label="En yüksek saatlik ücret"
        value={maxPriceInput}
        onChangeText={setMaxPriceInput}
        placeholder="Sınır yok"
        inputMode="decimal"
        keyboardType="decimal-pad"
        maxLength={9}
        error={priceInputInvalid ? 'Enter an amount like 750, or clear the field.' : null}
        hint={`Per hour, in ${DEFAULT_CURRENCY.toUpperCase()}.`}
      />

      <View style={{ gap: theme.spacing.sm }}>
        <Text variant="label">Sırala</Text>
        <ChipRow>
          <Chip label="Ad" selected={sort === 'name'} onPress={() => setSort('name')} />
          <Chip label="Fiyat" selected={sort === 'price'} onPress={() => setSort('price')} />
          {canSortByDistance ? (
            <Chip
              label="En yakın"
              selected={sort === 'distance'}
              onPress={() => setSort('distance')}
            />
          ) : null}
        </ChipRow>
        {sort === 'distance' && homeCity ? (
          <Text variant="caption" tone="muted">
            {`Measured from the middle of the venues in ${homeCity}. Your device location is never read.`}
          </Text>
        ) : null}
      </View>

      <Separator />

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}>
        <Text variant="label" tone="muted" accessibilityLiveRegion="polite">
          {loading
            ? 'Searching'
            : sorted.length === 1
              ? '1 venue'
              : `${sorted.length}${truncated ? '+' : ''} venues`}
        </Text>
        {loading && !refreshing ? <Spinner size="small" label="Aranıyor" /> : null}
      </View>
    </View>
  )

  return (
    <Screen padded={false}>
      <FlatList
        data={sorted}
        keyExtractor={(item) => item.id}
        ListHeaderComponent={listHeader}
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.lg,
          paddingTop: theme.spacing.lg,
          paddingBottom: theme.spacing.xxl,
          gap: theme.spacing.md,
        }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        renderItem={({ item }) => <VenueCard venue={item} onPress={() => openVenue(item.slug)} />}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={theme.colors.primary}
          />
        }
        ListEmptyComponent={
          loading ? (
            <Spinner centred label="İşletmeler aranıyor" />
          ) : error ? (
            // The header already carries the failure and the retry. Saying "nothing matches"
            // underneath it would blame the filters for a network problem.
            null
          ) : (
            <EmptyState
              title="Bu filtrelere uyan bir şey yok"
              description="Başka bir şehir, farklı bir format ya da daha yüksek bir saatlik ücret dene."
              action={
                hasFilters(where, format, maxPriceInput)
                  ? {
                      label: 'Filtreleri temizle',
                      onPress: () => {
                        setWhere('')
                        setFormat(null)
                        setMaxPriceInput('')
                      },
                    }
                  : undefined
              }
            />
          )
        }
        ListFooterComponent={
          truncated ? (
            <Text
              variant="caption"
              tone="muted"
              align="center"
              style={{ paddingTop: theme.spacing.lg }}
            >
              {`Showing the first ${RESULT_LIMIT} venues. Add a city to narrow the search.`}
            </Text>
          ) : null
        }
      />
    </Screen>
  )
}

/* -------------------------------------------------------------------------- */
/*  Chips                                                                      */
/* -------------------------------------------------------------------------- */

function ChipRow({ children }: React.PropsWithChildren): React.ReactElement {
  const theme = useTheme()
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: theme.spacing.sm, paddingRight: theme.spacing.lg }}
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  )
}

function Chip({
  label,
  selected,
  onPress,
}: {
  label: string
  selected: boolean
  onPress: () => void
}): React.ReactElement {
  return (
    <Button
      title={label}
      size="sm"
      variant={selected ? 'primary' : 'outline'}
      onPress={onPress}
      accessibilityState={{ selected }}
    />
  )
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** PostgREST filter syntax travels in the query string; strip it out of free text. */
function sanitisePattern(raw: string): string {
  return raw
    .replace(/[,.()"'\\%*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
}

/**
 * A typed price ceiling, in minor units, or null when the field is empty or not a number.
 *
 * `toMinor` throws on anything non-finite, which is the right behaviour at a trust boundary and
 * the wrong behaviour inside a render, so the parse happens here and the caller gets a null it
 * can turn into a field error.
 */
function parsePriceCeiling(raw: string): number | null {
  if (raw.length === 0) return null
  const normalised = raw.replace(',', '.')
  const value = Number(normalised)
  if (!Number.isFinite(value) || value < 0) return null
  try {
    return toMinor(value, DEFAULT_CURRENCY)
  } catch {
    return null
  }
}

function hasFilters(
  where: string,
  format: Enums<'match_format'> | null,
  maxPrice: string,
): boolean {
  return where.trim().length > 0 || format !== null || maxPrice.trim().length > 0
}

/** Venues with no rate sort last rather than first, which is what a 0 would do. */
function rateOrLast(rate: number | null): number {
  return rate === null ? Number.POSITIVE_INFINITY : rate
}

function distanceOrLast(km: number | null | undefined): number {
  return km === null || km === undefined ? Number.POSITIVE_INFINITY : km
}

/** The device's IANA zone, for the day strip. Falls back to UTC on a trimmed ICU build. */
function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

function toSearchResult(row: VenueRow): SearchResult {
  const active = row.pitches.filter((pitch) => pitch.is_active)

  const formats: Enums<'match_format'>[] = []
  for (const pitch of active) {
    if (!formats.includes(pitch.format)) formats.push(pitch.format)
  }

  let fromRateMinor: number | null = null
  let currency = DEFAULT_CURRENCY
  for (const pitch of active) {
    if (!Number.isFinite(pitch.hourly_rate_minor) || pitch.hourly_rate_minor <= 0) continue
    if (fromRateMinor === null || pitch.hourly_rate_minor < fromRateMinor) {
      fromRateMinor = pitch.hourly_rate_minor
      currency = (pitch.currency || DEFAULT_CURRENCY).toLowerCase()
    }
  }

  const coordinates =
    row.latitude !== null && row.longitude !== null
      ? { latitude: row.latitude, longitude: row.longitude }
      : null

  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    city: row.city,
    district: row.district,
    photos: row.photos,
    amenities: row.amenities,
    formats,
    fromRateMinor,
    currency,
    distanceKm: null,
    coordinates,
  }
}
