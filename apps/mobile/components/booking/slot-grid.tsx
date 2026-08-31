/**
 * components/booking/slot-grid.tsx
 *
 * The tappable half of the booking funnel: one day's slots, in the VENUE's wall clock.
 *
 * Times are rendered with the venue's IANA zone, not the phone's. A customer in Berlin booking a
 * pitch in İstanbul has to see the time the pitch will be waiting for them, and the whole
 * pricing and opening-hours model on the server is expressed in venue-local terms. The instants
 * behind the labels stay absolute, so nothing about a DST boundary changes what gets reserved.
 *
 * Unavailable slots stay on the grid and stay legible. Removing them would leave a picker that
 * silently reflows every few seconds as other people book, and a customer cannot tell "19:00 is
 * taken" from "this pitch does not sell 19:00" if 19:00 simply is not there.
 */

import * as React from 'react'
import { Pressable, View } from 'react-native'

import { Text } from '@/components/ui'
import {
  isSelected,
  SLOT_REASON_LABEL,
  type SlotSelection,
} from '@/lib/booking/slots'
import { formatMinor, formatTime, formatTimeRange } from '@/lib/format'
import { useTheme, type Theme } from '@/lib/theme'
import type { AvailabilityDay, TimeSlot } from '@halisaha/shared/domain'

export interface SlotGridProps {
  /** The day to render. Null renders the "nothing for this day" state. */
  day: AvailabilityDay | null
  /** `venues.timezone`. Every label on the grid is this zone's wall clock. */
  timezone: string
  /** ISO 4217, lowercase, for the per-slot price. */
  currency: string
  selection: SlotSelection
  onToggle: (slot: TimeSlot) => void
  /** Blocks every slot — used while a checkout is in flight. */
  disabled?: boolean
}

export function SlotGrid({
  day,
  timezone,
  currency,
  selection,
  onToggle,
  disabled = false,
}: SlotGridProps): React.ReactElement {
  const theme = useTheme()

  if (!day || day.slots.length === 0) {
    return (
      <View
        style={{
          paddingVertical: theme.spacing.xl,
          gap: theme.spacing.sm,
        }}
      >
        <Text variant="heading">Bu gün için takvimde bir şey yok</Text>
        <Text variant="body" tone="muted">
          İşletme o gün bu sahayı satmıyor. Başka bir tarih dene.
        </Text>
      </View>
    )
  }

  return (
    <View
      accessibilityRole="list"
      style={{
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: theme.spacing.sm,
      }}
    >
      {day.slots.map((slot) => (
        <SlotChip
          key={slot.startsAt}
          slot={slot}
          timezone={timezone}
          currency={currency}
          selected={isSelected(selection, slot)}
          disabled={disabled}
          onPress={() => onToggle(slot)}
        />
      ))}
    </View>
  )
}

interface SlotChipProps {
  slot: TimeSlot
  timezone: string
  currency: string
  selected: boolean
  disabled: boolean
  onPress: () => void
}

interface ChipPalette {
  background: string
  border: string
  label: string
  caption: string
}

function chipPalette(theme: Theme, selected: boolean, available: boolean): ChipPalette {
  if (selected) {
    return {
      background: theme.colors.primary,
      border: theme.colors.primary,
      label: theme.colors.primaryForeground,
      caption: theme.colors.primaryForeground,
    }
  }
  if (!available) {
    return {
      background: theme.colors.muted,
      border: theme.colors.border,
      label: theme.colors.mutedForeground,
      caption: theme.colors.mutedForeground,
    }
  }
  return {
    background: theme.colors.card,
    border: theme.colors.border,
    label: theme.colors.foreground,
    caption: theme.colors.mutedForeground,
  }
}

function SlotChip({
  slot,
  timezone,
  currency,
  selected,
  disabled,
  onPress,
}: SlotChipProps): React.ReactElement {
  const theme = useTheme()
  const inactive = disabled || !slot.available
  const palette = chipPalette(theme, selected, slot.available)

  const reason = slot.reason ? SLOT_REASON_LABEL[slot.reason] : null
  const caption = slot.available ? formatMinor(slot.priceMinor, currency) : (reason ?? 'Unavailable')

  // Read out as one phrase. A screen reader user swiping a grid of thirty chips needs the whole
  // answer in each one, not a time they then have to correlate with a colour.
  const speech = slot.available
    ? `${formatTimeRange(slot.startsAt, slot.endsAt, timezone)}, ${formatMinor(slot.priceMinor, currency)}${selected ? ', selected' : ''}`
    : `${formatTimeRange(slot.startsAt, slot.endsAt, timezone)}, ${reason ?? 'unavailable'}`

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={speech}
      accessibilityState={{ disabled: inactive, selected }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => ({
        minWidth: 96,
        minHeight: 56,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 2,
        paddingHorizontal: theme.spacing.md,
        paddingVertical: theme.spacing.sm,
        borderRadius: theme.radius.lg,
        borderWidth: 1,
        borderColor: palette.border,
        backgroundColor: palette.background,
        opacity: inactive && !selected ? 0.65 : pressed ? 0.85 : 1,
      })}
    >
      <Text
        variant="body"
        weight="600"
        numberOfLines={1}
        style={{
          color: palette.label,
          // A taken slot reads as struck through as well as dimmed, so the state survives being
          // seen by someone who cannot pick the grey out from the white.
          textDecorationLine: !slot.available && !selected ? 'line-through' : 'none',
        }}
      >
        {formatTime(slot.startsAt, timezone)}
      </Text>
      <Text variant="caption" numberOfLines={1} style={{ color: palette.caption }}>
        {caption}
      </Text>
    </Pressable>
  )
}
