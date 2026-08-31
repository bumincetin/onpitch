/**
 * app/venue/[slug]/[pitchId].tsx
 *
 * Pick a slot and pay for it.
 *
 * ---------------------------------------------------------------------------
 * THE ORDER OF EVENTS
 * ---------------------------------------------------------------------------
 *   1. `GET /api/pitches/[id]/slots` draws the grid. It is a FORECAST, never a reservation.
 *   2. The customer selects one or more consecutive slots. Nothing is held yet.
 *   3. `POST /api/bookings/checkout` sends the pitch and the window and NO amount. The server
 *      recomputes the price, INSERTs the booking — which is the moment the `tstzrange` exclusion
 *      constraint actually reserves the slot — and creates the PaymentIntent.
 *   4. The native Payment Sheet is mounted on the returned client secret.
 *   5. On success, the booking screen. On dismissal, the reservation is released immediately.
 *
 * Between 1 and 3 someone else can take the slot. That is not a bug to be engineered away, it is
 * what an exclusion constraint is for: the loser gets `SLOT_TAKEN`, and this screen answers it by
 * refetching the grid rather than by pretending the forecast was authoritative.
 *
 * ---------------------------------------------------------------------------
 * CANCELLING IS NOT FAILING
 * ---------------------------------------------------------------------------
 * Dismissing the Payment Sheet is a decision, not an error, so it gets no red banner. It does get
 * a `POST /api/bookings/[id]/cancel`, because by then step 3 has already taken the slot off the
 * calendar. Without that release the slot sits dead until the reservation sweeper runs, and the
 * customer who changed their mind about 20:00 cannot rebook 20:00.
 *
 * If the release itself fails, the screen says so and offers the booking, rather than claiming a
 * slot was freed that was not.
 *
 * ---------------------------------------------------------------------------
 * PRICE
 * ---------------------------------------------------------------------------
 * The total under the grid adds up prices the SERVER put on the slots. It is labelled an
 * estimate and it is never transmitted. `quoteBooking()` recomputes the charge from
 * `pitches.hourly_rate_minor` on every attempt, and `CheckoutResult.quote` is what the card is
 * actually charged.
 */

import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router'
import * as React from 'react'
import { RefreshControl, ScrollView, View } from 'react-native'

import {
  QuoteBreakdown,
  SlotGrid,
  formatLabel,
  surfaceLabel,
  useCheckoutSheet,
} from '@/components/booking'
import { Button, Card, Notice, Screen, Separator, Text } from '@/components/ui'
import { apiFetch, ApiError, isApiError } from '@/lib/api'
import {
  addDaysToDateKey,
  buildFallbackGrid,
  countAvailable,
  coveringWindow,
  dateKeysFrom,
  dayByKey,
  isDateKey,
  MAX_GRID_DAYS,
  MAX_SLOTS_PER_BOOKING,
  parseCheckoutResult,
  parseDateKey,
  parsePitchSlots,
  parseRange,
  selectionSubtotalMinor,
  selectionWindow,
  SLOT_HOLDING_STATUSES,
  todayKey,
  toggleSlot,
  toRangeLiteral,
  zonedWallClockToUtc,
  type Interval,
  type PitchSlots,
  type SlotSelection,
} from '@/lib/booking/slots'
import { formatDayLabel, formatMinor, formatRelative, formatTimeRange } from '@/lib/format'
import { consentBlockReason } from '@/lib/gdpr'
import { supabase, useSession } from '@/lib/supabase'
import { useTheme } from '@/lib/theme'
import type { Enums } from '@halisaha/shared/database'
import { API_ERROR_CODES, DEFAULT_CURRENCY } from '@halisaha/shared/domain'

/** What the last checkout attempt has to say for itself. */
interface AttemptNotice {
  tone: 'info' | 'success' | 'warning' | 'destructive'
  title: string
  description: string
  action?: { label: string; onPress: () => void }
}

export default function SlotPickerScreen(): React.ReactElement {
  const theme = useTheme()
  const router = useRouter()
  const params = useLocalSearchParams()
  const { profile, loading: sessionLoading } = useSession()
  const checkoutSheet = useCheckoutSheet()

  const slug = firstParam(params.slug)
  const pitchId = firstParam(params.pitchId)
  const requestedDate = firstParam(params.date)

  /** The first day the grid covers. Null asks the server for "today, at the venue". */
  const [gridStart, setGridStart] = React.useState<string | null>(
    requestedDate && isDateKey(requestedDate) ? requestedDate : null,
  )

  const [slots, setSlots] = React.useState<PitchSlots | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [refreshing, setRefreshing] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const [dateKey, setDateKey] = React.useState<string | null>(null)
  const [selection, setSelection] = React.useState<SlotSelection>([])
  const [paying, setPaying] = React.useState(false)
  const [notice, setNotice] = React.useState<AttemptNotice | null>(null)

  /* ------------------------------------------------------------------ load */

  const load = React.useCallback(async (): Promise<void> => {
    if (!pitchId) {
      setError('That pitch link is missing its identifier.')
      return
    }
    setError(null)

    const query = new URLSearchParams({ days: String(MAX_GRID_DAYS) })
    if (gridStart) query.set('date', gridStart)

    try {
      const payload = await apiFetch<unknown>(
        `/api/pitches/${encodeURIComponent(pitchId)}/slots?${query.toString()}`,
      )
      setSlots(parsePitchSlots(payload))
      return
    } catch (caught) {
      if (!shouldFallBack(caught)) {
        setSlots(null)
        setError(
          caught instanceof Error && caught.message
            ? caught.message
            : 'Bu sahanın müsaitliği yüklenemedi.',
        )
        return
      }
    }

    // The slots route is not deployed on this build. Draw the grid from the device instead, and
    // mark it degraded — see `buildFallbackGrid` for exactly what that costs.
    const fallback = await loadFallbackGrid(pitchId, gridStart)
    if (fallback.slots) {
      setSlots(fallback.slots)
      setError(null)
    } else {
      setSlots(null)
      setError(fallback.error)
    }
  }, [pitchId, gridStart])

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

  // A grid the user walked away from is stale by the time they walk back.
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

  /* --------------------------------------------------------- day selection */

  const days = slots?.grid.days ?? []

  React.useEffect(() => {
    if (days.length === 0) {
      setDateKey(null)
      return
    }
    setDateKey((current) => {
      if (current && days.some((day) => day.date === current)) return current
      if (requestedDate && days.some((day) => day.date === requestedDate)) return requestedDate
      return days[0]?.date ?? null
    })
    // `days` is a fresh array on every fetch; keying the effect on the joined dates keeps it
    // from re-running (and resetting the chosen day) on an identical refetch.
  }, [days.map((day) => day.date).join(','), requestedDate]) // eslint-disable-line react-hooks/exhaustive-deps

  // Changing the day abandons a selection that belonged to another day.
  React.useEffect(() => {
    setSelection([])
  }, [dateKey])

  const day = slots && dateKey ? dayByKey(slots.grid, dateKey) : null
  const timezone = slots?.grid.timezone ?? 'UTC'
  const currency = slots?.grid.currency ?? DEFAULT_CURRENCY

  /* ---------------------------------------------------------- the selection */

  const bookingWindow = selectionWindow(selection)
  const estimateMinor = selectionSubtotalMinor(selection)
  // Null while the session profile is still being read. `consentBlockReason(null)` returns the
  // guardian sentence, and accusing an adult of having no parental approval for the length of one
  // round trip is worse than saying nothing at all.
  const consentNotice = sessionLoading ? null : consentBlockReason(profile)
  const venuePayable = slots?.venue.isPayable ?? false
  // `!sessionLoading` matters: `consentNotice` is suppressed while the profile is in flight, so
  // without it a minor could reach the Pay button in that window.
  const canPay =
    Boolean(bookingWindow) && venuePayable && consentNotice === null && !sessionLoading && !paying

  /* --------------------------------------------------------------- payment */

  const releaseReservation = React.useCallback(
    async (bookingId: string): Promise<boolean> => {
      try {
        await apiFetch<unknown>(`/api/bookings/${encodeURIComponent(bookingId)}/cancel`, {
          method: 'POST',
          json: { reason: 'The customer closed the payment sheet before paying.' },
        })
        return true
      } catch {
        return false
      }
    },
    [],
  )

  const handleCheckout = React.useCallback(async (): Promise<void> => {
    if (!pitchId || !bookingWindow || paying) return

    setPaying(true)
    setNotice(null)

    let bookingId: string | null = null

    try {
      /* 1. Reserve and price, on the server. No amount leaves this device. */
      const checkout = parseCheckoutResult(
        await apiFetch<unknown>('/api/bookings/checkout', {
          method: 'POST',
          json: { pitchId, startsAt: bookingWindow.startsAt, endsAt: bookingWindow.endsAt },
          // A cold Stripe account plus a booking INSERT is slower than an ordinary read.
          timeoutMs: 30_000,
        }),
      )
      bookingId = checkout.bookingId

      /* 2. Hand over to the native sheet. */
      const outcome = await checkoutSheet.present(checkout, {
        email: profile?.email,
        name: profile?.full_name,
      })

      /* 3. Paid. The webhook confirms the booking; the detail screen waits for it. */
      if (outcome.kind === 'paid') {
        setSelection([])
        router.replace(`/booking/${encodeURIComponent(checkout.bookingId)}?payment=complete`)
        return
      }

      /* 4. Not paid. Step 1 already took the slot off the calendar, so give it back before
            anything else — an abandoned checkout must not hold 20:00 hostage for half an hour. */
      const released = await releaseReservation(checkout.bookingId)

      if (outcome.kind === 'cancelled') {
        setNotice(
          released
            ? {
                tone: 'info',
                title: 'Ödeme iptal edildi',
                description: 'Hiçbir tutar çekilmedi ve saat takvime geri döndü.',
              }
            : openBookingNotice(
                router,
                checkout.bookingId,
                'Nothing was charged, but the slot is still being held.',
              ),
        )
      } else {
        setNotice(
          released
            ? {
                tone: 'destructive',
                title: 'Ödeme gerçekleşmedi',
                description: `${outcome.message} Your slot was released, so nothing was taken.`,
              }
            : openBookingNotice(
                router,
                checkout.bookingId,
                `${outcome.message} The reservation is still open.`,
              ),
        )
      }

      setSelection([])
      await load()
    } catch (caught) {
      if (isApiError(caught, API_ERROR_CODES.SLOT_TAKEN)) {
        setNotice({
          tone: 'warning',
          title: 'O saati başkası aldı',
          description: 'Bu sayfa açıldıktan sonraki saniyelerde gitti. Güncel saatler bunlar.',
        })
        setSelection([])
        await load()
        return
      }

      if (isApiError(caught, API_ERROR_CODES.CONSENT_REQUIRED)) {
        setNotice({
          tone: 'warning',
          title: 'Rezervasyon henüz açılmadı',
          description: caught.message,
        })
        return
      }

      if (isApiError(caught, API_ERROR_CODES.VENUE_NOT_PAYABLE)) {
        setNotice({
          tone: 'warning',
          title: 'Bu işletme henüz ödeme alamıyor',
          description: caught.message,
        })
        return
      }

      const message =
        caught instanceof Error && caught.message
          ? caught.message
          : 'Rezervasyon başlatılamadı.'

      setNotice(
        bookingId
          ? openBookingNotice(router, bookingId, message)
          : { tone: 'destructive', title: 'İşlem tamamlanamadı', description: message },
      )
    } finally {
      setPaying(false)
    }
  }, [pitchId, bookingWindow, paying, profile, checkoutSheet, releaseReservation, router, load])

  /* ---------------------------------------------------------------- render */

  const header = (
    <Stack.Screen
      options={{
        headerShown: true,
        title: slots?.pitch.name ?? 'Pick a time',
        headerBackTitle: 'Back',
        headerStyle: { backgroundColor: theme.colors.background },
        headerTintColor: theme.colors.foreground,
        headerTitleStyle: { color: theme.colors.foreground },
        headerShadowVisible: false,
      }}
    />
  )

  if (loading || error || !slots) {
    return (
      <>
        {header}
        <Screen loading={loading} loadingLabel="Loading times" error={error} onRetry={() => void load()} />
      </>
    )
  }

  const firstDay = days[0]?.date ?? null
  const earliestAllowed = todayKey(timezone)
  const canGoEarlier = firstDay !== null && firstDay > earliestAllowed

  const payBar = (
    <View style={{ gap: theme.spacing.sm }}>
      {bookingWindow ? (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: theme.spacing.md,
          }}
        >
          <Text variant="label" style={{ flex: 1 }} numberOfLines={1}>
            {formatTimeRange(bookingWindow.startsAt, bookingWindow.endsAt, timezone)}
          </Text>
          <Text variant="label" tone="muted">
            {`about ${formatMinor(estimateMinor, currency)}`}
          </Text>
        </View>
      ) : (
        <Text variant="label" tone="muted">
          {`Tap a time to start. Tap the next one along to book up to ${MAX_SLOTS_PER_BOOKING} in a row.`}
        </Text>
      )}

      <Button
        title="Ödemeye devam et"
        size="lg"
        fullWidth
        loading={paying}
        disabled={!canPay}
        onPress={() => void handleCheckout()}
      />
    </View>
  )

  return (
    <>
      {header}
      <Screen
        scroll
        footer={payBar}
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
      >
        <View style={{ gap: theme.spacing.xs }}>
          <Text variant="title" accessibilityRole="header">
            {slots.pitch.name}
          </Text>
          <Text variant="body" tone="muted">
            {[slots.venue.name, slots.venue.city].filter(Boolean).join(' · ')}
          </Text>
          <Text variant="caption" tone="muted">
            {[
              formatLabel(slots.pitch.format),
              surfaceLabel(slots.pitch.surface),
              slots.pitch.isIndoor ? 'Indoor' : 'Outdoor',
              `${formatMinor(slots.grid.hourlyRateMinor, currency)} / hour`,
            ].join(' · ')}
          </Text>
        </View>

        {slots.degraded ? (
          <Notice
            tone="warning"
            title="Müsaitlik yalnızca kısmen biliniyor"
            description={
              'We could not reach the availability service, so this grid was drawn from what your ' +
              'account is allowed to see. Other customers’ bookings are hidden from it, so a slot ' +
              'shown as free may already be sold. If one is, checkout says so and nothing is charged.'
            }
          />
        ) : null}

        {!venuePayable ? (
          <Notice
            tone="warning"
            title="Henüz ödeme almıyor"
            description="Bu işletme Stripe kurulumunu tamamlamamış; saatleri rezerve edilemiyor."
          />
        ) : null}

        {consentNotice ? (
          <Notice tone="warning" title="Rezervasyon henüz açılmadı" description={consentNotice} />
        ) : null}

        {notice ? (
          <Notice tone={notice.tone} title={notice.title} description={notice.description} live>
            {notice.action ? (
              <Button
                title={notice.action.label}
                variant="outline"
                size="sm"
                onPress={notice.action.onPress}
              />
            ) : null}
          </Notice>
        ) : null}

        <View style={{ gap: theme.spacing.sm }}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: theme.spacing.sm,
            }}
          >
            <Button
              title="Daha erken"
              variant="ghost"
              size="sm"
              disabled={!canGoEarlier}
              onPress={() => {
                if (firstDay) setGridStart(maxDateKey(addDaysToDateKey(firstDay, -MAX_GRID_DAYS), earliestAllowed))
              }}
            />
            <Text variant="label" tone="muted">
              {days.length === MAX_GRID_DAYS ? 'One week' : `${days.length} days`}
            </Text>
            <Button
              title="Daha geç"
              variant="ghost"
              size="sm"
              onPress={() => {
                if (firstDay) setGridStart(addDaysToDateKey(firstDay, MAX_GRID_DAYS))
              }}
            />
          </View>

          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: theme.spacing.sm, paddingRight: theme.spacing.lg }}
          >
            {days.map((option) => (
              <Button
                key={option.date}
                title={dayChipLabel(option.date, timezone)}
                size="sm"
                variant={option.date === dateKey ? 'primary' : 'outline'}
                onPress={() => setDateKey(option.date)}
                accessibilityState={{ selected: option.date === dateKey }}
                accessibilityLabel={`${dayChipLabel(option.date, timezone)}, ${countAvailable(dayByKey(slots.grid, option.date))} slots free`}
              />
            ))}
          </ScrollView>

          <Text variant="caption" tone="muted">
            {`All times are ${slots.venue.name}'s local clock. Checked ${formatRelative(slots.generatedAt)}.`}
          </Text>
        </View>

        <SlotGrid
          day={day}
          timezone={timezone}
          currency={currency}
          selection={selection}
          disabled={paying || !venuePayable}
          onToggle={(slot) => setSelection((current) => toggleSlot(current, slot))}
        />

        {bookingWindow ? (
          <Card title="Seçimin">
            <Text variant="body">
              {`${formatDayLabel(bookingWindow.startsAt, timezone)}, ${formatTimeRange(bookingWindow.startsAt, bookingWindow.endsAt, timezone)}`}
            </Text>
            <Separator />
            <QuoteBreakdown
              subtotalMinor={estimateMinor}
              // The fee is a split behind the price, so before checkout the customer's total is
              // the subtotal. The real split comes back in `CheckoutResult.quote`.
              platformFeeMinor={0}
              totalMinor={estimateMinor}
              currency={currency}
              durationMinutes={bookingWindow.durationMinutes}
              estimate
            />
          </Card>
        ) : null}

        {slug ? (
          <Button
            title="Bu işletmedeki diğer sahalar"
            variant="ghost"
            fullWidth
            onPress={() =>
              router.push(`/venue/${encodeURIComponent(slug)}?date=${dateKey ?? ''}`)
            }
          />
        ) : null}
      </Screen>
    </>
  )
}

/* -------------------------------------------------------------------------- */
/*  The fallback grid                                                          */
/* -------------------------------------------------------------------------- */

/**
 * True when the failure means "that route does not exist here", not "that pitch is not yours".
 *
 * Both are 404s, and telling them apart matters: falling back on the second would draw a grid for
 * a pitch RLS deliberately hid. The route's own not-found answer arrives inside the
 * `ApiResponse` envelope with `code: NOT_FOUND`. A route that is simply absent returns the
 * framework's HTML 404 page, which never parses as an envelope, so `apiFetch` reports it as
 * `INTERNAL` at status 404. That difference is the test.
 */
function shouldFallBack(caught: unknown): boolean {
  return caught instanceof ApiError && caught.status === 404 && caught.code !== API_ERROR_CODES.NOT_FOUND
}

interface FallbackResult {
  slots: PitchSlots | null
  error: string
}

interface FallbackPitchRow {
  id: string
  venue_id: string
  name: string
  format: Enums<'match_format'>
  surface: Enums<'pitch_surface'>
  is_indoor: boolean
  capacity: number | null
  hourly_rate_minor: number
  currency: string
  slot_minutes: number
  opening_time: string
  closing_time: string
  is_active: boolean
}

interface FallbackVenueRow {
  id: string
  name: string
  slug: string
  city: string | null
  timezone: string
  is_active: boolean
  charges_enabled: boolean
}

/**
 * Draw the grid on the device, from the user's own client.
 *
 * Everything this reads is RLS-scoped, which is the point and the limitation:
 * `bookings_select_stakeholders` returns the caller's own bookings, their team's, and the ones
 * on a pitch they own — so the busy set is INCOMPLETE and the resulting grid is optimistic. The
 * caller marks it degraded and the screen says so above the times.
 *
 * `pitch_availability_blocks` is owner-scoped too. A failed or empty read there is treated as
 * "no blackouts known" rather than as an error, because it is the expected answer for a
 * customer, and the same warning already covers it.
 */
async function loadFallbackGrid(pitchId: string, startKey: string | null): Promise<FallbackResult> {
  const { data: pitch, error: pitchError } = await supabase
    .from('pitches')
    .select(
      'id, venue_id, name, format, surface, is_indoor, capacity, hourly_rate_minor, currency, slot_minutes, opening_time, closing_time, is_active',
    )
    .eq('id', pitchId)
    .returns<FallbackPitchRow[]>()
    .maybeSingle()

  if (pitchError) {
    return { slots: null, error: 'This pitch could not be loaded. Try again in a moment.' }
  }
  if (!pitch) {
    return { slots: null, error: 'This pitch is not available.' }
  }

  const { data: venue, error: venueError } = await supabase
    .from('venues')
    .select('id, name, slug, city, timezone, is_active, charges_enabled')
    .eq('id', pitch.venue_id)
    .returns<FallbackVenueRow[]>()
    .maybeSingle()

  if (venueError || !venue) {
    return { slots: null, error: 'The venue behind this pitch could not be loaded.' }
  }

  const gridPitch = {
    id: pitch.id,
    venueId: pitch.venue_id,
    openingTime: pitch.opening_time,
    closingTime: pitch.closing_time,
    slotMinutes: pitch.slot_minutes,
    hourlyRateMinor: pitch.hourly_rate_minor,
    currency: pitch.currency,
    isActive: pitch.is_active,
  }

  const dates = dateKeysFrom(startKey ?? todayKey(venue.timezone), MAX_GRID_DAYS)
  const gridWindow = coveringWindow(gridPitch, dates, venue.timezone)

  let bookings: Interval[] = []
  let blocks: Interval[] = []

  if (gridWindow) {
    const literal = toRangeLiteral(new Date(gridWindow.start), new Date(gridWindow.end))

    const [bookingResult, blockResult] = await Promise.all([
      supabase
        .from('bookings')
        .select('time_range')
        .eq('pitch_id', pitch.id)
        .in('status', [...SLOT_HOLDING_STATUSES])
        .filter('time_range', 'ov', literal),
      supabase
        .from('pitch_availability_blocks')
        .select('block_range')
        .eq('pitch_id', pitch.id)
        .filter('block_range', 'ov', literal),
    ])

    if (bookingResult.error) {
      // Without any busy set at all the grid would claim the whole week is free, which is a
      // worse answer than no grid.
      return { slots: null, error: 'Availability could not be checked. Try again in a moment.' }
    }

    bookings = collectIntervals(bookingResult.data ?? [], (row) => row.time_range)
    blocks = collectIntervals(blockResult.data ?? [], (row) => row.block_range)
  }

  return {
    error: '',
    slots: {
      degraded: true,
      generatedAt: new Date().toISOString(),
      pitch: {
        id: pitch.id,
        name: pitch.name,
        format: pitch.format,
        surface: pitch.surface,
        isIndoor: pitch.is_indoor,
        capacity: pitch.capacity,
        openingTime: pitch.opening_time,
        closingTime: pitch.closing_time,
      },
      venue: {
        id: venue.id,
        name: venue.name,
        slug: venue.slug,
        city: venue.city,
        timezone: venue.timezone,
        isPayable: venue.is_active && venue.charges_enabled,
      },
      grid: buildFallbackGrid({
        pitch: gridPitch,
        timezone: venue.timezone,
        dates,
        bookings,
        blocks,
        venuePayable: venue.is_active && venue.charges_enabled,
      }),
    },
  }
}

/** Parse `tstzrange` literals, dropping any row Postgres rendered in a shape we cannot read. */
function collectIntervals<T>(rows: readonly T[], pick: (row: T) => string | null): Interval[] {
  const intervals: Interval[] = []
  for (const row of rows) {
    const parsed = parseRange(pick(row))
    if (parsed) intervals.push(parsed)
  }
  return intervals
}

/* -------------------------------------------------------------------------- */
/*  Small helpers                                                              */
/* -------------------------------------------------------------------------- */

/** A notice that hands the customer the booking, for every case where a hold may still be live. */
function openBookingNotice(
  router: ReturnType<typeof useRouter>,
  bookingId: string,
  description: string,
): AttemptNotice {
  return {
    tone: 'warning',
    title: 'Rezervasyonu kontrol et',
    description: `${description} Open it to pay or to cancel it.`,
    action: {
      label: 'Rezervasyonu aç',
      onPress: () => router.push(`/booking/${encodeURIComponent(bookingId)}`),
    },
  }
}

/**
 * `Today` / `Tomorrow` / `Sat 6 Sep` for a day key, read on the VENUE's calendar.
 *
 * The instant handed to the formatter is local noon rather than local midnight. Midnight is
 * within an hour of the day boundary in either direction, so any zone far enough from UTC —
 * and any DST shift — can push the label onto the neighbouring day.
 */
function dayChipLabel(dateKey: string, timezone: string): string {
  const { year, month, day } = parseDateKey(dateKey)
  return formatDayLabel(zonedWallClockToUtc(year, month, day, 12, 0, timezone), timezone)
}

/** The later of two `YYYY-MM-DD` keys. They sort lexicographically, which is why this is safe. */
function maxDateKey(a: string, b: string): string {
  return a >= b ? a : b
}

function firstParam(value: string | string[] | undefined): string | null {
  if (typeof value === 'string') return value.length > 0 ? value : null
  if (Array.isArray(value)) {
    const head = value[0]
    return typeof head === 'string' && head.length > 0 ? head : null
  }
  return null
}
