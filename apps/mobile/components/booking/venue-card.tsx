/**
 * components/booking/venue-card.tsx
 *
 * One venue in the search results.
 *
 * The card answers the three questions that decide whether a customer taps it — where is it,
 * what does it sell, what does it cost — and nothing else. Amenities are trimmed to three
 * because the fourth line pushes the next result off the screen and nobody scrolls a list of
 * feature bullets.
 *
 * `photos[0]` is loaded when there is one. `Image` failing is handled by simply not showing the
 * banner rather than by drawing a broken-image placeholder, since a venue with no photo and a
 * venue whose photo 404s are the same thing to the reader.
 */

import * as React from 'react'
import { Image, View } from 'react-native'

import { Badge, Card, Text } from '@/components/ui'
import { formatDistanceKm } from '@/lib/booking/slots'
import { formatMinor } from '@/lib/format'
import { useTheme } from '@/lib/theme'
import type { Enums } from '@onpitch/shared/database'

import { formatShortLabel, placeLabel } from './labels'

export interface VenueCardVenue {
  id: string
  name: string
  slug: string
  city: string | null
  district: string | null
  photos: string[] | null
  amenities: string[] | null
  /** Distinct formats across the venue's active pitches, already de-duplicated. */
  formats: readonly Enums<'match_format'>[]
  /** Cheapest active pitch, in minor units. Null when the venue has no priced pitch. */
  fromRateMinor: number | null
  currency: string
  /** Kilometres from the search anchor. Only set when distance sorting is switched on. */
  distanceKm?: number | null
}

export interface VenueCardProps {
  venue: VenueCardVenue
  onPress: () => void
}

const MAX_AMENITIES = 3
const MAX_FORMATS = 3

export function VenueCard({ venue, onPress }: VenueCardProps): React.ReactElement {
  const theme = useTheme()
  const [bannerFailed, setBannerFailed] = React.useState(false)

  const place = placeLabel(venue.district, venue.city)
  const banner = venue.photos?.[0]
  const showBanner = Boolean(banner) && !bannerFailed

  const amenities = (venue.amenities ?? []).filter((item) => item.trim().length > 0)
  const shownAmenities = amenities.slice(0, MAX_AMENITIES)
  const extraAmenities = amenities.length - shownAmenities.length

  const shownFormats = venue.formats.slice(0, MAX_FORMATS)
  const extraFormats = venue.formats.length - shownFormats.length

  const price =
    venue.fromRateMinor === null
      ? null
      : `from ${formatMinor(venue.fromRateMinor, venue.currency)} an hour`

  const accessibilityLabel = [
    venue.name,
    place,
    venue.distanceKm === null || venue.distanceKm === undefined
      ? null
      : formatDistanceKm(venue.distanceKm),
    price,
  ]
    .filter((part): part is string => Boolean(part))
    .join('. ')

  return (
    <Card flush onPress={onPress} accessibilityLabel={accessibilityLabel}>
      {showBanner && banner ? (
        <Image
          source={{ uri: banner }}
          style={{ width: '100%', height: 132, backgroundColor: theme.colors.muted }}
          resizeMode="cover"
          onError={() => setBannerFailed(true)}
          // The card's own label already names the venue; a second announcement here would make
          // a screen reader read every result twice.
          accessible={false}
        />
      ) : null}

      <View style={{ padding: theme.spacing.lg, gap: theme.spacing.sm }}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'flex-start',
            gap: theme.spacing.md,
          }}
        >
          <Text variant="heading" style={{ flex: 1 }} numberOfLines={2}>
            {venue.name}
          </Text>
          {venue.distanceKm !== null && venue.distanceKm !== undefined ? (
            <Badge tone="outline" size="sm">
              {formatDistanceKm(venue.distanceKm)}
            </Badge>
          ) : null}
        </View>

        {place ? (
          <Text variant="label" tone="muted">
            {place}
          </Text>
        ) : null}

        {shownFormats.length > 0 ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm }}>
            {shownFormats.map((format) => (
              <Badge key={format} tone="neutral" size="sm">
                {formatShortLabel(format)}
              </Badge>
            ))}
            {extraFormats > 0 ? (
              <Badge tone="outline" size="sm">{`+${extraFormats}`}</Badge>
            ) : null}
          </View>
        ) : null}

        {shownAmenities.length > 0 ? (
          <Text variant="caption" tone="muted" numberOfLines={1}>
            {extraAmenities > 0
              ? `${shownAmenities.join(' · ')} · +${extraAmenities} more`
              : shownAmenities.join(' · ')}
          </Text>
        ) : null}

        {price ? (
          <Text variant="label" tone="primary" weight="600">
            {price}
          </Text>
        ) : (
          <Text variant="caption" tone="muted">
            Henüz yayınlanmış ücret yok
          </Text>
        )}
      </View>
    </Card>
  )
}
