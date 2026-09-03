/**
 * app/settings/notifications.tsx
 *
 * What reaches you, and the feed of what already has.
 *
 * THERE IS ONE STORED PREFERENCE, NOT A PANEL OF THEM
 * --------------------------------------------------
 * The schema holds exactly one notification preference: `profiles.marketing_opt_in`. Everything
 * else in `notifications` is transactional — a booking confirmed, a score to agree, a consensus
 * deadline, a payout that failed — written by `private.notify_participants`, the Stripe webhook and
 * the consent RPCs. Those are the record of something that happened to your money or your fixture,
 * so they are always delivered, and there is no column to switch them off with. Rendering a row of
 * decorative toggles that write nowhere would be worse than saying that plainly, which is what the
 * first card does.
 *
 * The feed below is the same `notifications` table the badge counts, read live. Tapping a row marks
 * it read and, when the payload names something this app can open, goes there. The `data` blob is
 * jsonb written by several producers that never agreed on a key convention — SQL writes `matchId`,
 * the Stripe webhook writes `booking_id` — so both spellings are parsed, and a payload that names
 * nothing openable is simply not a link. An href to a screen that does not exist is worse than no
 * href.
 */

import { useRouter } from 'expo-router'
import * as React from 'react'
import { RefreshControl, View } from 'react-native'

import type { TablesUpdate } from '@onpitch/shared/database'
import { isUuid } from '@onpitch/shared/channels'
import { z } from 'zod'

import { Badge, Button, Card, EmptyState, Notice, Screen, Separator, Text } from '@/components/ui'
import { PrivacyToggle, ScreenHeader, useMyProfile } from '@/components/profile'
import {
  useNotificationFeed,
  useUnreadNotifications,
  type NotificationRow,
} from '@/lib/hooks/use-notifications'
import { DIGITAL_CONSENT_AGE, MINOR_PRIVACY_EXPLANATIONS, isMinor } from '@/lib/gdpr'
import { formatRelative } from '@/lib/format'
import { useTheme } from '@/lib/theme'

const FEED_LIMIT = 15

/**
 * The two ids a notification can carry, under either spelling. Everything is optional and the
 * whole thing is `.passthrough()`: this is untrusted jsonb, and a failed parse must degrade to "no
 * link", never to a thrown render.
 */
const payloadSchema = z
  .object({
    matchId: z.string().optional(),
    match_id: z.string().optional(),
    bookingId: z.string().optional(),
    booking_id: z.string().optional(),
  })
  .passthrough()

/** Where a notification points, or null when it points nowhere this app can open. */
function hrefFor(data: unknown): string | null {
  const parsed = payloadSchema.safeParse(data)
  if (!parsed.success) return null

  const matchId = parsed.data.matchId ?? parsed.data.match_id
  if (matchId && isUuid(matchId)) return `/match/${matchId}`

  const bookingId = parsed.data.bookingId ?? parsed.data.booking_id
  if (bookingId && isUuid(bookingId)) return `/booking/${bookingId}`

  return null
}

export default function NotificationSettingsScreen(): React.ReactElement {
  const theme = useTheme()
  const router = useRouter()

  const { profile, loading: profileLoading, error: profileError, refresh: refreshProfile, patch } =
    useMyProfile()
  const unread = useUnreadNotifications()
  const feed = useNotificationFeed(FEED_LIMIT)

  const [refreshing, setRefreshing] = React.useState(false)
  const [markedRead, setMarkedRead] = React.useState<number | null>(null)

  const minor = isMinor(profile)

  const marketingPatch = React.useCallback(
    (next: boolean): TablesUpdate<'profiles'> => ({ marketing_opt_in: next }),
    [],
  )

  const refreshUnread = unread.refresh
  const refreshFeed = feed.refresh

  const refreshAll = React.useCallback(async (): Promise<void> => {
    setRefreshing(true)
    await Promise.all([refreshProfile(), refreshUnread(), refreshFeed()])
    setRefreshing(false)
  }, [refreshFeed, refreshProfile, refreshUnread])

  const markAllRead = unread.markAllRead
  const handleMarkAll = React.useCallback(async (): Promise<void> => {
    const count = await markAllRead()
    setMarkedRead(count)
    await refreshFeed()
  }, [markAllRead, refreshFeed])

  const openRow = React.useCallback(
    (row: NotificationRow): void => {
      if (row.read_at === null) void feed.markRead(row.id)
      const href = hrefFor(row.data)
      if (href) router.push(href)
    },
    [feed, router],
  )

  const header = (
    <ScreenHeader title="Bildirimler" subtitle="Neler gönderiyoruz ve neler geldi" />
  )

  return (
    <Screen
      edges={['top', 'left', 'right', 'bottom']}
      scroll
      header={header}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => void refreshAll()}
          tintColor={theme.colors.mutedForeground}
          colors={[theme.colors.primary]}
        />
      }
    >
      {/* ------------------------------------------------------------ inbox -- */}
      <Card
        title="Okunmamış"
        subtitle={
          unread.loading
            ? 'Counting…'
            : unread.count === 0
              ? 'Nothing waiting for you'
              : `${unread.count} ${unread.count === 1 ? 'notification' : 'notifications'} waiting`
        }
      >
        {unread.error ? (
          <Notice tone="destructive" title="Sayı güncel değil" description={unread.error} live />
        ) : null}

        {markedRead !== null ? (
          <Notice
            tone="success"
            title={markedRead === 0 ? 'Nothing to clear' : 'Marked as read'}
            description={
              markedRead === 0
                ? 'Everything was already read.'
                : `${markedRead} ${markedRead === 1 ? 'notification' : 'notifications'} cleared.`
            }
            live
          />
        ) : null}

        <Button
          title="Hepsini okundu işaretle"
          variant="outline"
          fullWidth
          loading={unread.updating}
          disabled={unread.count === 0 || unread.updating}
          onPress={() => void handleMarkAll()}
        />
      </Card>

      {/* ------------------------------------------------------ preferences -- */}
      <Card title="Neler gönderiyoruz" subtitle="Buradaki tek ayar pazarlama e-postası">
        {profileError ? (
          <Notice tone="warning" title="Tercihlerin okunamadı" live>
            <Text variant="body" tone="muted">
              {profileError}
            </Text>
            <Button
              title="Tekrar dene"
              size="sm"
              variant="outline"
              onPress={() => void refreshProfile()}
            />
          </Notice>
        ) : null}

        {profile ? (
          <PrivacyToggle
            label="Pazarlama e-postası"
            hint="Yeni sahalar ve özellikler hakkında ara sıra e-posta. Yaptığın bir rezervasyonla ilgili değil."
            value={minor ? false : profile.marketing_opt_in}
            userId={profile.id}
            patchFor={marketingPatch}
            lockedReason={minor ? MINOR_PRIVACY_EXPLANATIONS.marketing_opt_in : null}
            onChanged={(next) => patch({ marketing_opt_in: next })}
          />
        ) : profileLoading ? (
          <Text variant="body" tone="muted">
            Loading your preferences…
          </Text>
        ) : null}

        <Separator />

        <Notice tone="info" title="Maç ve rezervasyon uyarıları her zaman açık">
          <Text variant="body" tone="muted">
            Onaylanmış bir rezervasyon, onayını bekleyen bir skor, bir uzlaşma süresi, bir iade — bunların her biri paranla ya da maçınla ilgili olmuş bir şeyin kaydıdır, o yüzden hepsini iletiriz. Bu uygulamaya gelirler, önemlileri ayrıca e-postayla.
          </Text>
        </Notice>

        {minor ? (
          <Text variant="caption" tone="muted">
            {`Marketing email is off for every account under ${DIGITAL_CONSENT_AGE}, and the database enforces it rather than this screen.`}
          </Text>
        ) : null}
      </Card>

      {/* ------------------------------------------------------------- feed -- */}
      <Card title="Son" subtitle={`The last ${FEED_LIMIT}, newest first`}>
        {feed.error ? (
          <EmptyState
            tone="destructive"
            title="Bildirimlerin yüklenemedi"
            description={feed.error}
            action={{ label: 'Tekrar dene', onPress: () => void refreshFeed() }}
          />
        ) : feed.loading && feed.items.length === 0 ? (
          <Text variant="body" tone="muted">
            Loading…
          </Text>
        ) : feed.items.length === 0 ? (
          <EmptyState
            title="Henüz bir şey yok"
            description="Bir saha tut ya da maça katıl; güncellemeler buraya düşer."
          />
        ) : (
          <View>
            {feed.items.map((row, index) => (
              <React.Fragment key={row.id}>
                {index > 0 ? <Separator style={{ marginVertical: theme.spacing.sm }} /> : null}
                <FeedRow row={row} onPress={() => openRow(row)} />
              </React.Fragment>
            ))}
          </View>
        )}
      </Card>
    </Screen>
  )
}

interface FeedRowProps {
  row: NotificationRow
  onPress: () => void
}

function FeedRow({ row, onPress }: FeedRowProps): React.ReactElement {
  const theme = useTheme()
  const unread = row.read_at === null
  const href = hrefFor(row.data)

  return (
    <Card
      flush
      onPress={onPress}
      accessibilityLabel={`${unread ? 'Unread. ' : ''}${row.title}. ${
        row.body ?? ''
      } ${formatRelative(row.created_at)}.${href ? ' Opens the related screen.' : ''}`}
      style={{ borderWidth: 0, borderRadius: theme.radius.md, backgroundColor: 'transparent' }}
      contentStyle={{
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: theme.spacing.md,
        paddingVertical: theme.spacing.sm,
      }}
    >
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{
          width: 8,
          height: 8,
          marginTop: 6,
          borderRadius: 4,
          backgroundColor: unread ? theme.colors.primary : 'transparent',
        }}
      />

      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="body" weight={unread ? '600' : '400'}>
          {row.title}
        </Text>
        {row.body ? (
          <Text variant="caption" tone="muted" numberOfLines={3}>
            {row.body}
          </Text>
        ) : null}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}>
          <Text variant="caption" tone="muted">
            {formatRelative(row.created_at)}
          </Text>
          {href ? (
            <Badge tone="outline" size="sm">
              Açmak için dokun
            </Badge>
          ) : null}
        </View>
      </View>
    </Card>
  )
}
