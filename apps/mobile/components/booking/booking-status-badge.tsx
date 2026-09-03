/**
 * components/booking/booking-status-badge.tsx
 *
 * One pill that says where a booking stands.
 *
 * `bookings` carries TWO state columns and they answer different questions. `status` is the
 * reservation — does this row still hold the slot. `payment_status` is the money — has Stripe
 * captured it, failed it, refunded it. Rendering only the first produces the two worst rows on
 * the list: a "Confirmed" booking whose card was declined, and a "Cancelled" booking with a
 * refund still in flight. So the payment state is allowed to override the label wherever it
 * tells the customer something the reservation state does not.
 */

import * as React from 'react'

import { Badge, type BadgeTone } from '@/components/ui'
import type { Enums } from '@onpitch/shared/database'

export interface BookingStatusBadgeProps {
  status: Enums<'booking_status'>
  /** Optional. When given it can sharpen the label — see the file header. */
  paymentStatus?: Enums<'payment_status'> | null
  size?: 'sm' | 'md'
}

interface StatusDisplay {
  label: string
  tone: BadgeTone
}

/**
 * The label and tone for a booking, as a customer reads it.
 *
 * Exported because the detail screen needs the same words in its heading, and two places
 * inventing their own copy is how "Awaiting payment" and "Unpaid" end up on one screen.
 */
export function describeBookingStatus(
  status: Enums<'booking_status'>,
  paymentStatus?: Enums<'payment_status'> | null,
): StatusDisplay {
  // Money first, but only where it contradicts or refines the reservation state.
  if (status === 'confirmed' && paymentStatus === 'refunded') {
    return { label: 'İade edildi', tone: 'neutral' }
  }
  if (status === 'confirmed' && paymentStatus === 'partially_refunded') {
    return { label: 'Kısmen iade', tone: 'warning' }
  }
  if (status === 'confirmed' && paymentStatus === 'failed') {
    return { label: 'Ödeme başarısız', tone: 'destructive' }
  }

  switch (status) {
    case 'pending':
      return { label: 'Tutuluyor', tone: 'warning' }
    case 'awaiting_payment':
      return { label: 'Ödeme bekleniyor', tone: 'warning' }
    case 'confirmed':
      return paymentStatus === 'processing'
        ? { label: 'Onaylanıyor', tone: 'warning' }
        : { label: 'Onaylandı', tone: 'success' }
    case 'completed':
      return { label: 'Oynandı', tone: 'neutral' }
    case 'cancelled':
      return paymentStatus === 'refunded' || paymentStatus === 'partially_refunded'
        ? { label: 'Cancelled · refunded', tone: 'neutral' }
        : { label: 'İptal edildi', tone: 'neutral' }
    case 'refunded':
      return { label: 'İade edildi', tone: 'neutral' }
    case 'disputed':
      return { label: 'İtirazlı', tone: 'destructive' }
  }
}

export function BookingStatusBadge({
  status,
  paymentStatus = null,
  size = 'md',
}: BookingStatusBadgeProps): React.ReactElement {
  const { label, tone } = describeBookingStatus(status, paymentStatus)
  return (
    <Badge tone={tone} size={size}>
      {label}
    </Badge>
  )
}
