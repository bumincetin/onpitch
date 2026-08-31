/**
 * components/booking/quote-breakdown.tsx
 *
 * What the booking costs, itemised.
 *
 * ---------------------------------------------------------------------------
 * THE FEE IS NOT ALWAYS ADDED
 * ---------------------------------------------------------------------------
 * `quoteBooking()` currently returns `totalMinor === subtotalMinor`: the platform's
 * `application_fee_amount` comes OUT of the venue's cut on a destination charge, so the customer
 * pays the pitch price and the fee is a split behind it. The schema also permits the fee-on-top
 * shape (`platform_fee_minor <= total_minor` is the only invariant), and the comment in
 * `lib/payments.ts` says a future change would live there.
 *
 * So this component decides which sentence to print by COMPARING the numbers it was handed
 * rather than by hard-coding today's policy. If subtotal and total agree, the fee is disclosed
 * as a deduction the venue pays. If they differ, it is itemised as a line the customer pays.
 * Either way the "Total" row is `totalMinor` — the figure Stripe will charge — and it is never
 * arrived at by adding anything up on the device.
 *
 * Every amount arrives in minor units and is rendered through `formatMinor`. No float math.
 */

import * as React from 'react'
import { View } from 'react-native'

import { Separator, Text } from '@/components/ui'
import { formatDuration, formatMinor } from '@/lib/format'
import { useTheme } from '@/lib/theme'

export interface QuoteBreakdownProps {
  /** Pitch hire before any split. `bookings.subtotal_minor` or `BookingQuote.subtotalMinor`. */
  subtotalMinor: number
  /** The Stripe application fee. `bookings.platform_fee_minor`. */
  platformFeeMinor: number
  /** What the card is charged. `bookings.total_minor`. */
  totalMinor: number
  /** ISO 4217, lowercase, as stored. */
  currency: string
  /** Shown as a "for N minutes" caption under the pitch-hire row. */
  durationMinutes?: number | null
  /** Money already returned. Renders a refund row and a "you were charged" net line. */
  refundedMinor?: number | null
  /**
   * Marks the figures as a pre-checkout estimate.
   *
   * The slot picker adds up prices the server put on the grid. That total matches what
   * `quoteBooking()` computes, but the server is still the one that decides — so before
   * checkout the reader is told the number is confirmed on the next screen.
   */
  estimate?: boolean
}

export function QuoteBreakdown({
  subtotalMinor,
  platformFeeMinor,
  totalMinor,
  currency,
  durationMinutes = null,
  refundedMinor = null,
  estimate = false,
}: QuoteBreakdownProps): React.ReactElement {
  const theme = useTheme()

  const feeIsAddedOnTop = totalMinor > subtotalMinor
  const refunded = refundedMinor !== null && refundedMinor > 0 ? refundedMinor : null
  const netMinor = refunded === null ? null : Math.max(0, totalMinor - refunded)

  return (
    <View
      accessible
      accessibilityLabel={`${estimate ? 'Estimated total' : 'Total'} ${formatMinor(totalMinor, currency)}`}
      style={{ gap: theme.spacing.sm }}
    >
      <Row
        label="Saha kirası"
        caption={durationMinutes ? formatDuration(durationMinutes) : undefined}
        value={formatMinor(subtotalMinor, currency)}
      />

      {feeIsAddedOnTop ? (
        <Row label="Hizmet bedeli" value={formatMinor(platformFeeMinor, currency)} />
      ) : null}

      <Separator />

      <Row
        label={estimate ? 'Estimated total' : 'Total'}
        value={formatMinor(totalMinor, currency)}
        emphasis
      />

      {!feeIsAddedOnTop && platformFeeMinor > 0 ? (
        <Text variant="caption" tone="muted">
          {`Includes ${formatMinor(platformFeeMinor, currency)} that Halisaha takes from the venue's share. It is not added to your price.`}
        </Text>
      ) : null}

      {refunded !== null ? (
        <>
          <Separator />
          <Row label="İade edildi" value={`− ${formatMinor(refunded, currency)}`} tone="success" />
          {netMinor !== null ? (
            <Row label="Ödediğin" value={formatMinor(netMinor, currency)} emphasis />
          ) : null}
        </>
      ) : null}

      {estimate ? (
        <Text variant="caption" tone="muted">
          İşletmenin kendi ücreti bir sonraki ekranda uygulanır ve kartından çekilen tutar odur.
        </Text>
      ) : null}
    </View>
  )
}

interface RowProps {
  label: string
  value: string
  caption?: string
  emphasis?: boolean
  tone?: 'default' | 'success'
}

function Row({ label, value, caption, emphasis = false, tone = 'default' }: RowProps): React.ReactElement {
  const theme = useTheme()

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: theme.spacing.lg,
      }}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant={emphasis ? 'heading' : 'body'} tone={emphasis ? 'default' : 'muted'}>
          {label}
        </Text>
        {caption ? (
          <Text variant="caption" tone="muted">
            {caption}
          </Text>
        ) : null}
      </View>

      <Text
        variant={emphasis ? 'heading' : 'body'}
        tone={tone === 'success' ? 'success' : 'default'}
        weight={emphasis ? '700' : '600'}
        // Money lines up on the right, and never wraps mid-amount.
        numberOfLines={1}
      >
        {value}
      </Text>
    </View>
  )
}
