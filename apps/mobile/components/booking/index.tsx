/**
 * components/booking/index.tsx
 *
 * The booking kit. Import from `@/components/booking`, the same way screens import the UI
 * primitives from `@/components/ui`.
 */

export {
  BookingStatusBadge,
  describeBookingStatus,
  type BookingStatusBadgeProps,
} from './booking-status-badge'
export {
  formatLabel,
  formatShortLabel,
  MATCH_FORMATS,
  placeLabel,
  surfaceLabel,
} from './labels'
export {
  PitchCard,
  type PitchAvailability,
  type PitchCardPitch,
  type PitchCardProps,
} from './pitch-card'
export {
  useCheckoutSheet,
  type CheckoutCustomer,
  type CheckoutOutcome,
  type CheckoutSheet,
} from './payment-sheet'
export { QuoteBreakdown, type QuoteBreakdownProps } from './quote-breakdown'
export { SlotGrid, type SlotGridProps } from './slot-grid'
export { VenueCard, type VenueCardProps, type VenueCardVenue } from './venue-card'
