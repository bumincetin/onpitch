/**
 * components/booking/pitch-card.tsx
 *
 * One pitch on a venue page, with how free it is on the day the customer picked.
 *
 * Availability is passed in as a small state machine rather than as a number, because the four
 * cases read very differently and collapsing them loses the reader. "Checking" is not "none
 * free", and "we could not check" is certainly not "none free" — a card that shows a dash where
 * a count should be, with no explanation, is how a customer decides the venue is fully booked
 * and closes the app.
 */

import * as React from 'react'
import { View } from 'react-native'

import { Badge, Card, Spinner, Text } from '@/components/ui'
import { formatMinor, formatTime } from '@/lib/format'
import { useTheme } from '@/lib/theme'
import type { Enums } from '@halisaha/shared/database'

import { formatLabel, surfaceLabel } from './labels'

export interface PitchCardPitch {
  id: string
  name: string
  format: Enums<'match_format'>
  surface: Enums<'pitch_surface'>
  isIndoor: boolean
  capacity: number | null
  hourlyRateMinor: number
  currency: string
  slotMinutes: number
  isActive: boolean
}

/** What the venue screen knows about this pitch's day, at the moment it renders. */
export type PitchAvailability =
  /** Not asked for — no date is selected, or the pitch is past the fetch cap. */
  | { state: 'idle' }
  | { state: 'loading' }
  | {
      state: 'ready'
      freeSlots: number
      /** ISO instant of the earliest free slot, or null when the day is full. */
      nextFreeAt: string | null
    }
  | { state: 'error'; message: string }

export interface PitchCardProps {
  pitch: PitchCardPitch
  /** IANA zone from `venues.timezone`. The "next free" time is the venue's wall clock. */
  timezone: string
  availability?: PitchAvailability
  onPress: () => void
}

export function PitchCard({
  pitch,
  timezone,
  availability = { state: 'idle' },
  onPress,
}: PitchCardProps): React.ReactElement {
  const theme = useTheme()

  const attributes = [
    formatLabel(pitch.format),
    surfaceLabel(pitch.surface),
    pitch.isIndoor ? 'Indoor' : 'Outdoor',
    pitch.capacity ? `${pitch.capacity} players` : null,
  ].filter((part): part is string => Boolean(part))

  const rate = formatMinor(pitch.hourlyRateMinor, pitch.currency)

  return (
    <Card
      onPress={onPress}
      accessibilityLabel={`${pitch.name}. ${attributes.join('. ')}. ${rate} an hour. ${availabilitySpeech(availability, timezone)}`}
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
            {pitch.name}
          </Text>
          <Text variant="caption" tone="muted">
            {attributes.join(' · ')}
          </Text>
        </View>

        {pitch.isActive ? null : (
          <Badge tone="neutral" size="sm">
            Kapalı
          </Badge>
        )}
      </View>

      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: theme.spacing.md,
        }}
      >
        <View style={{ gap: 2 }}>
          <Text variant="body" weight="600">
            {`${rate} / hour`}
          </Text>
          <Text variant="caption" tone="muted">
            {`Sold in ${pitch.slotMinutes}-minute slots`}
          </Text>
        </View>

        <AvailabilityPill availability={availability} timezone={timezone} />
      </View>
    </Card>
  )
}

function AvailabilityPill({
  availability,
  timezone,
}: {
  availability: PitchAvailability
  timezone: string
}): React.ReactElement | null {
  const theme = useTheme()

  switch (availability.state) {
    case 'idle':
      return null

    case 'loading':
      return (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}>
          <Spinner size="small" label="Müsaitlik kontrol ediliyor" />
          <Text variant="caption" tone="muted">
            Kontrol ediliyor
          </Text>
        </View>
      )

    case 'error':
      return (
        <Badge tone="outline" size="sm">
          Saatler bilinmiyor
        </Badge>
      )

    case 'ready': {
      if (availability.freeSlots === 0) {
        return (
          <Badge tone="neutral" size="sm">
            Dolu
          </Badge>
        )
      }
      return (
        <View style={{ alignItems: 'flex-end', gap: 2 }}>
          <Badge tone="success" size="sm">
            {availability.freeSlots === 1 ? '1 slot free' : `${availability.freeSlots} slots free`}
          </Badge>
          {availability.nextFreeAt ? (
            <Text variant="caption" tone="muted">
              {`from ${formatTime(availability.nextFreeAt, timezone)}`}
            </Text>
          ) : null}
        </View>
      )
    }
  }
}

/** The same information as one sentence, for the card's accessibility label. */
function availabilitySpeech(availability: PitchAvailability, timezone: string): string {
  switch (availability.state) {
    case 'idle':
      return 'Open it to see available times.'
    case 'loading':
      return 'Checking availability.'
    case 'error':
      return 'Availability could not be checked.'
    case 'ready':
      if (availability.freeSlots === 0) return 'No slots free on the selected day.'
      return availability.nextFreeAt
        ? `${availability.freeSlots} slots free, from ${formatTime(availability.nextFreeAt, timezone)}.`
        : `${availability.freeSlots} slots free.`
  }
}
