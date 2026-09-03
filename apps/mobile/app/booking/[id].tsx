/**
 * app/booking/[id].tsx
 *
 * One booking: the receipt, where and when, and the two actions that still apply.
 *
 * Also the target of `onpitch://booking/<uuid>` — the confirmation email and the push
 * notification both land here, so it has to stand on its own with no navigation history behind
 * it.
 *
 * ---------------------------------------------------------------------------
 * `?payment=complete` IS NOT A CONFIRMATION
 * ---------------------------------------------------------------------------
 * It means the Payment Sheet reported success on this device. The booking becomes `confirmed`
 * when `payment_intent.succeeded` reaches `app/api/stripe/webhook`, which is a different machine
 * and a second or two later. Until the row catches up this screen says "confirming" and re-reads
 * it a few times. Drawing a confirmed booking off the query parameter would be a lie that the
 * next refresh exposes.
 *
 * ---------------------------------------------------------------------------
 * THE RESERVATION COUNTDOWN
 * ---------------------------------------------------------------------------
 * An unpaid booking holds its slot for a limited time and is then swept back onto the calendar.
 * The server owns that TTL, so the clock here is advisory — see `RESERVATION_TTL_MINUTES`. When
 * it runs out the screen does not guess: it says the hold has probably lapsed, and gives the two
 * things that resolve it, re-reading the row and going back to the pitch.
 *
 * ---------------------------------------------------------------------------
 * REFUND AMOUNTS ARE NOT PREDICTED HERE
 * ---------------------------------------------------------------------------
 * `resolveCancellationPolicy()` reads two server environment variables the app cannot see. A
 * refund figure computed on the device would be wrong on any deployment that has tuned them, and
 * wrong about money is the worst kind of wrong. So the screen explains that the amount depends on
 * how close to kickoff the cancellation is, and then shows the real number the route returned.
 */

import { Stack, useLocalSearchParams, useRouter } from 'expo-router'
import * as React from 'react'
import { RefreshControl, View } from 'react-native'

import { BookingStatusBadge, QuoteBreakdown, describeBookingStatus, useCheckoutSheet } from '@/components/booking'
import { Button, Card, EmptyState, Notice, Screen, Separator, Sheet, Text } from '@/components/ui'
import { apiFetch, isApiError } from '@/lib/api'
import {
  countdownLabel,
  parseCancellationResult,
  parseCheckoutResult,
  parseRange,
  reservationExpiresAt,
  RESERVATION_TTL_MINUTES,
} from '@/lib/booking/slots'
import { formatDayLabel, formatDuration, formatMinor, formatTimeRange } from '@/lib/format'
import { supabase, useSession } from '@/lib/supabase'
import { MessageButton } from '@/components/messaging'
import { useTheme } from '@/lib/theme'
import type { Enums } from '@onpitch/shared/database'
import { API_ERROR_CODES, type CancellationResult } from '@onpitch/shared/domain'

/** Statuses `POST /api/bookings/[id]/cancel` still acts on. Mirrors that route's own list. */
const CANCELLABLE: readonly Enums<'booking_status'>[] = ['pending', 'awaiting_payment', 'confirmed']

/** Statuses that still hold the slot without having been paid for. */
const UNPAID_HOLD: readonly Enums<'booking_status'>[] = ['pending', 'awaiting_payment']

/** Statuses where the reservation is already resolved, one way or the other. */
const CANCELLED_OR_DONE: readonly Enums<'booking_status'>[] = [
  'cancelled',
  'refunded',
  'completed',
  'disputed',
]

/** How long the screen waits for the webhook after the sheet reports success. */
const CONFIRM_POLL_ATTEMPTS = 6
const CONFIRM_POLL_INTERVAL_MS = 3_000

interface BookingRow {
  id: string
  pitch_id: string
  booked_by: string
  team_id: string | null
  status: Enums<'booking_status'>
  payment_status: Enums<'payment_status'>
  time_range: string
  subtotal_minor: number
  platform_fee_minor: number
  total_minor: number
  refunded_amount_minor: number
  currency: string
  notes: string | null
  cancellation_reason: string | null
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
  owner_id: string
  timezone: string
  address_line1: string | null
  city: string | null
  district: string | null
  phone: string | null
}

interface Loaded {
  booking: BookingRow
  pitch: PitchRow | null
  venue: VenueRow | null
  matchId: string | null
}

export default function BookingDetailScreen(): React.ReactElement {
  const theme = useTheme()
  const router = useRouter()
  const params = useLocalSearchParams()
  const { user, profile } = useSession()
  const checkoutSheet = useCheckoutSheet()

  const bookingId = firstParam(params.id)
  const arrivedFromPayment = firstParam(params.payment) === 'complete'

  const [data, setData] = React.useState<Loaded | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [refreshing, setRefreshing] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const [paying, setPaying] = React.useState(false)
  const [cancelOpen, setCancelOpen] = React.useState(false)
  const [cancelling, setCancelling] = React.useState(false)
  const [cancellation, setCancellation] = React.useState<CancellationResult | null>(null)
  const [notice, setNotice] = React.useState<{
    tone: 'info' | 'success' | 'warning' | 'destructive'
    title: string
    description: string
  } | null>(null)

  /* ------------------------------------------------------------------ load */

  const load = React.useCallback(async (): Promise<void> => {
    if (!bookingId) {
      setError('That booking link is missing its identifier.')
      return
    }
    setError(null)

    // Read with the user's own client: `bookings_select_stakeholders` decides who sees this row
    // — the booker, their team-mates on a team booking, and the owner of the pitch.
    const { data: booking, error: bookingError } = await supabase
      .from('bookings')
      .select(
        'id, pitch_id, booked_by, team_id, status, payment_status, time_range, subtotal_minor, platform_fee_minor, total_minor, refunded_amount_minor, currency, notes, cancellation_reason, created_at',
      )
      .eq('id', bookingId)
      .returns<BookingRow[]>()
      .maybeSingle()

    if (bookingError) {
      setError('That booking could not be loaded. Try again in a moment.')
      return
    }
    if (!booking) {
      setData(null)
      return
    }

    const { data: pitch } = await supabase
      .from('pitches')
      .select('id, name, venue_id')
      .eq('id', booking.pitch_id)
      .returns<PitchRow[]>()
      .maybeSingle()

    const [venueResult, matchResult] = await Promise.all([
      pitch
        ? supabase
            .from('venues')
            .select('id, name, slug, owner_id, timezone, address_line1, city, district, phone')
            .eq('id', pitch.venue_id)
            .returns<VenueRow[]>()
            .maybeSingle()
        : Promise.resolve({ data: null }),
      supabase.from('matches').select('id').eq('booking_id', booking.id).maybeSingle(),
    ])

    setData({
      booking,
      pitch: pitch ?? null,
      venue: venueResult.data ?? null,
      matchId: matchResult.data?.id ?? null,
    })
  }, [bookingId])

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

  /* --------------------------------------------- waiting for the webhook */

  const booking = data?.booking ?? null
  const awaitingWebhook =
    arrivedFromPayment &&
    booking !== null &&
    booking.status !== 'confirmed' &&
    booking.payment_status !== 'succeeded' &&
    !CANCELLED_OR_DONE.includes(booking.status)

  React.useEffect(() => {
    if (!awaitingWebhook) return

    let attempts = 0
    let active = true
    const timer = setInterval(() => {
      attempts += 1
      if (!active || attempts > CONFIRM_POLL_ATTEMPTS) {
        clearInterval(timer)
        return
      }
      void load()
    }, CONFIRM_POLL_INTERVAL_MS)

    return () => {
      active = false
      clearInterval(timer)
    }
  }, [awaitingWebhook, load])

  /* --------------------------------------------------- the hold countdown */

  const holdsSlotUnpaid = booking !== null && UNPAID_HOLD.includes(booking.status)
  // A number, not a Date. The effect below depends on this, and a fresh `Date` object built on
  // every render never compares equal, which would tear the interval down and re-create it on
  // every tick — so the `clearInterval` at the deadline would never survive to take effect.
  const expiresAtMs =
    booking && holdsSlotUnpaid ? (reservationExpiresAt(booking.created_at)?.getTime() ?? null) : null

  const [nowMs, setNowMs] = React.useState(() => Date.now())

  React.useEffect(() => {
    if (expiresAtMs === null) return
    // The ticker stops the moment the deadline passes; there is nothing to count down to after
    // that, and a timer running for the life of the screen is a battery cost for no information.
    const timer = setInterval(() => {
      const next = Date.now()
      setNowMs(next)
      if (next >= expiresAtMs) clearInterval(timer)
    }, 1_000)
    return () => clearInterval(timer)
  }, [expiresAtMs])

  const expiresAt = expiresAtMs === null ? null : new Date(expiresAtMs)
  const remaining = countdownLabel(expiresAt, new Date(nowMs))
  const holdExpired = expiresAt !== null && remaining === null

  /* ------------------------------------------------------------- actions */

  const range = booking ? parseRange(booking.time_range) : null

  const handlePayNow = React.useCallback(async (): Promise<void> => {
    if (!booking || !range || paying) return

    setPaying(true)
    setNotice(null)

    try {
      // The same route as a fresh checkout. When the reservation is still live it resumes the
      // existing PaymentIntent (`resumeOwnCheckout`) and hands back the same booking id; when
      // the hold has already been swept it makes a NEW booking, which is why the id below is
      // read off the response rather than assumed.
      const checkout = parseCheckoutResult(
        await apiFetch<unknown>('/api/bookings/checkout', {
          method: 'POST',
          json: {
            pitchId: booking.pitch_id,
            startsAt: new Date(range.start).toISOString(),
            endsAt: new Date(range.end).toISOString(),
          },
          timeoutMs: 30_000,
        }),
      )

      const outcome = await checkoutSheet.present(checkout, {
        email: profile?.email,
        name: profile?.full_name,
      })

      if (outcome.kind === 'paid') {
        if (checkout.bookingId === booking.id) {
          await load()
          setNotice({
            tone: 'success',
            title: 'Ödeme alındı',
            description: 'İşletmeye bildiriliyor. Onaylandığı anda bu sayfa güncellenir.',
          })
        } else {
          router.replace(`/booking/${encodeURIComponent(checkout.bookingId)}?payment=complete`)
        }
        return
      }

      // A reservation this attempt created — because the old hold had lapsed — is released. The
      // ORIGINAL booking is not: the customer is looking at it, may well retry, and there is an
      // explicit Cancel button for the other case.
      if (checkout.bookingId !== booking.id) {
        await releaseReservation(checkout.bookingId)
      }

      setNotice(
        outcome.kind === 'cancelled'
          ? {
              tone: 'info',
              title: 'Ödeme iptal edildi',
              description: 'Hiçbir tutar çekilmedi. Süre dolana kadar saat hâlâ tutuluyor.',
            }
          : {
              tone: 'destructive',
              title: 'Ödeme gerçekleşmedi',
              description: outcome.message,
            },
      )
      await load()
    } catch (caught) {
      if (isApiError(caught, API_ERROR_CODES.SLOT_TAKEN)) {
        setNotice({
          tone: 'warning',
          title: 'Saat gitti',
          description:
            'Bu rezervasyonun süresi doldu ve saati başkası aldı. Hiçbir tutar çekilmedi.',
        })
        await load()
        return
      }
      setNotice({
        tone: 'destructive',
        title: 'İşlem tamamlanamadı',
        description:
          caught instanceof Error && caught.message
            ? caught.message
            : 'Ödeme başlatılamadı.',
      })
    } finally {
      setPaying(false)
    }
  }, [booking, range, paying, checkoutSheet, profile, load, router])

  const handleCancel = React.useCallback(async (): Promise<void> => {
    if (!booking || cancelling) return

    setCancelling(true)
    setNotice(null)

    try {
      const result = parseCancellationResult(
        await apiFetch<unknown>(`/api/bookings/${encodeURIComponent(booking.id)}/cancel`, {
          method: 'POST',
          json: { reason: 'Cancelled by the customer from the mobile app.' },
          timeoutMs: 30_000,
        }),
      )
      setCancellation(result)
      setCancelOpen(false)
      await load()
    } catch (caught) {
      setNotice({
        tone: 'destructive',
        title: 'Rezervasyon iptal edilmedi',
        description:
          caught instanceof Error && caught.message
            ? caught.message
            : 'Hiçbir şey değişmedi. Birazdan tekrar dene.',
      })
    } finally {
      setCancelling(false)
    }
  }, [booking, cancelling, load])

  /* -------------------------------------------------------------- render */

  const header = (
    <Stack.Screen
      options={{
        headerShown: true,
        title: 'Rezervasyon',
        headerBackTitle: 'Back',
        headerStyle: { backgroundColor: theme.colors.background },
        headerTintColor: theme.colors.foreground,
        headerTitleStyle: { color: theme.colors.foreground },
        headerShadowVisible: false,
      }}
    />
  )

  if (loading || error || !data || !booking) {
    return (
      <>
        {header}
        <Screen
          loading={loading}
          loadingLabel="Loading your booking"
          error={error}
          onRetry={() => void load()}
        >
          {!loading && !error && !data ? (
            <EmptyState
              title="Bu rezervasyon kullanılamıyor"
              description="Kaldırılmış olabilir ya da başkasına ait olabilir."
              action={{ label: 'Rezervasyonlarım', onPress: () => router.replace('/bookings') }}
            />
          ) : null}
        </Screen>
      </>
    )
  }

  const { pitch, venue, matchId } = data
  const timezone = venue?.timezone ?? 'UTC'
  const status = describeBookingStatus(booking.status, booking.payment_status)
  const canCancel = CANCELLABLE.includes(booking.status)
  const canPay = holdsSlotUnpaid && booking.booked_by === (user?.id ?? '')

  const place = [venue?.address_line1, venue?.district, venue?.city]
    .filter((part): part is string => Boolean(part))
    .join(', ')

  return (
    <>
      {header}
      <Screen
        scroll
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
        <View style={{ gap: theme.spacing.sm }}>
          <BookingStatusBadge status={booking.status} paymentStatus={booking.payment_status} />
          <Text variant="display" accessibilityRole="header">
            {venue?.name ?? 'Your booking'}
          </Text>
          {pitch ? (
            <Text variant="body" tone="muted">
              {pitch.name}
            </Text>
          ) : null}
        </View>

        {awaitingWebhook ? (
          <Notice
            tone="info"
            live
            title="Ödemen onaylanıyor"
            description={`Your card was accepted. ${venue?.name ?? 'The venue'} is being notified, and this page updates itself as soon as the confirmation lands.`}
          />
        ) : null}

        {holdsSlotUnpaid && !holdExpired && remaining ? (
          <Notice
            tone="warning"
            title={`This slot is held for ${remaining}`}
            description={`Reservations that go unpaid are put back on the calendar after about ${RESERVATION_TTL_MINUTES} minutes.`}
          />
        ) : null}

        {holdsSlotUnpaid && holdExpired ? (
          <Notice
            tone="destructive"
            live
            title="Bu tutma süresi büyük olasılıkla doldu"
            description="Ödenmemiş rezervasyonlar kendiliğinden serbest bırakılır. Hâlâ senin mi diye kontrol et ya da başka bir saat seç."
          >
            <View style={{ flexDirection: 'row', gap: theme.spacing.sm, flexWrap: 'wrap' }}>
              <Button title="Yeniden kontrol et" variant="outline" size="sm" onPress={() => void load()} />
              {venue && pitch ? (
                <Button
                  title="Başka bir saat seç"
                  variant="outline"
                  size="sm"
                  onPress={() =>
                    router.push(
                      `/venue/${encodeURIComponent(venue.slug)}/${encodeURIComponent(pitch.id)}`,
                    )
                  }
                />
              ) : null}
            </View>
          </Notice>
        ) : null}

        {cancellation ? (
          <Notice
            tone="success"
            live
            title="Rezervasyon iptal edildi"
            description={
              cancellation.refundedAmountMinor > 0
                ? `${formatMinor(cancellation.refundedAmountMinor, cancellation.currency)} is on its way back to your card. Refunds usually settle in a few working days.`
                : 'Nothing was refunded under the venue’s cancellation policy. The slot is back on the calendar.'
            }
          />
        ) : null}

        {notice ? (
          <Notice tone={notice.tone} title={notice.title} description={notice.description} live />
        ) : null}

        <Card title="Ne zaman">
          {range ? (
            <View style={{ gap: theme.spacing.xs }}>
              <Text variant="heading">{formatDayLabel(range.start, timezone)}</Text>
              <Text variant="body">
                {formatTimeRange(range.start, range.end, timezone)}
              </Text>
              <Text variant="caption" tone="muted">
                {`${formatDuration((range.end - range.start) / 60_000)} · venue local time (${timezone})`}
              </Text>
            </View>
          ) : (
            <Text variant="body" tone="muted">
              Bu kayıttan rezerve edilen saat aralığı okunamadı. Yola çıkmadan önce işletmeyle iletişime geç.
            </Text>
          )}
        </Card>

        {venue ? (
          <Card
            title="Nerede"
            onPress={() => router.push(`/venue/${encodeURIComponent(venue.slug)}`)}
            accessibilityLabel={`Where: ${venue.name}. Open the venue.`}
          >
            <Text variant="body">{venue.name}</Text>
            {place ? (
              <Text variant="caption" tone="muted">
                {place}
              </Text>
            ) : null}
            {venue.phone ? (
              <Text variant="caption" tone="muted">
                {venue.phone}
              </Text>
            ) : null}
            {/* A booking is a relationship in can_message(): booker and owner may always write. */}
            {user?.id && booking.booked_by === user.id && venue.owner_id !== user.id ? (
              <MessageButton userId={venue.owner_id} title="İşletmeye yaz" variant="outline" size="sm" />
            ) : null}
            {user?.id && venue.owner_id === user.id && booking.booked_by !== user.id ? (
              <MessageButton userId={booking.booked_by} title="Rezervasyon sahibine yaz" variant="outline" size="sm" />
            ) : null}
          </Card>
        ) : null}

        <Card title="Makbuz" subtitle={`Booked ${formatDayLabel(booking.created_at)}`}>
          <QuoteBreakdown
            subtotalMinor={booking.subtotal_minor}
            platformFeeMinor={booking.platform_fee_minor}
            totalMinor={booking.total_minor}
            currency={booking.currency}
            durationMinutes={range ? (range.end - range.start) / 60_000 : null}
            refundedMinor={booking.refunded_amount_minor}
          />
          <Separator />
          <Text variant="caption" tone="muted">
            {`Status: ${status.label}.`}
            {booking.cancellation_reason ? ` ${booking.cancellation_reason}` : ''}
          </Text>
        </Card>

        {booking.notes ? (
          <Card title="Notun">
            <Text variant="body" tone="muted">
              {booking.notes}
            </Text>
          </Card>
        ) : null}

        {matchId ? (
          <Button
            title="Maçı aç"
            variant="secondary"
            fullWidth
            onPress={() => router.push(`/match/${encodeURIComponent(matchId)}`)}
          />
        ) : null}

        {canPay ? (
          <Button
            title="Şimdi öde"
            size="lg"
            fullWidth
            loading={paying}
            onPress={() => void handlePayNow()}
          />
        ) : null}

        {canCancel ? (
          <Button
            title="Bu rezervasyonu iptal et"
            variant="outline"
            fullWidth
            onPress={() => setCancelOpen(true)}
          />
        ) : null}
      </Screen>

      <Sheet
        visible={cancelOpen}
        onClose={() => setCancelOpen(false)}
        dismissible={!cancelling}
        title="Bu rezervasyonu iptal edelim mi?"
        description="Saat doğrudan takvime geri döner."
        footer={
          <View style={{ gap: theme.spacing.sm }}>
            <Button
              title="Rezervasyonu iptal et"
              variant="destructive"
              fullWidth
              loading={cancelling}
              onPress={() => void handleCancel()}
            />
            <Button
              title="Kalsın"
              variant="ghost"
              fullWidth
              disabled={cancelling}
              onPress={() => setCancelOpen(false)}
            />
          </View>
        }
      >
        <Text variant="body" tone="muted">
          Ne kadarının geri döneceği, başlama saatine ne kadar kala iptal ettiğine bağlıdır. İşletmenin kuralı sunucuda uygulanır ve iade istendiği anda kesin tutar burada gösterilir.
        </Text>
        {range ? (
          <Text variant="body" tone="muted">
            {`This booking is for ${formatDayLabel(range.start, timezone)}, ${formatTimeRange(range.start, range.end, timezone)}.`}
          </Text>
        ) : null}
      </Sheet>
    </>
  )
}

/** Release a reservation this screen created and then did not pay for. */
async function releaseReservation(bookingId: string): Promise<void> {
  try {
    await apiFetch<unknown>(`/api/bookings/${encodeURIComponent(bookingId)}/cancel`, {
      method: 'POST',
      json: { reason: 'The customer closed the payment sheet before paying.' },
    })
  } catch {
    // The reservation sweeper picks it up. Nothing useful for the customer to do about it here.
  }
}

function firstParam(value: string | string[] | undefined): string | null {
  if (typeof value === 'string') return value.length > 0 ? value : null
  if (Array.isArray(value)) {
    const head = value[0]
    return typeof head === 'string' && head.length > 0 ? head : null
  }
  return null
}
