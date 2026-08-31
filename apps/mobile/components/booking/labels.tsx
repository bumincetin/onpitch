/**
 * components/booking/labels.tsx
 *
 * Enum values, in the words a customer uses.
 *
 * One module so the search filter, the venue card and the pitch header cannot disagree about
 * what `seven_a_side` is called. `FORMAT_TEAM_SIZE` comes from @halisaha/shared/balance rather
 * than being retyped, which means a new format is a compile error here instead of a blank chip.
 */

import { FORMAT_TEAM_SIZE } from '@halisaha/shared/balance'
import { Constants, type Enums } from '@halisaha/shared/database'

/** Every format, in the order a picker should show them. */
export const MATCH_FORMATS: readonly Enums<'match_format'>[] = Constants.public.Enums.match_format

/** `five_a_side` → `5-a-side`. */
export function formatLabel(format: Enums<'match_format'>): string {
  return `${FORMAT_TEAM_SIZE[format]}-a-side`
}

/** `five_a_side` → `5v5`, for a chip with no room. */
export function formatShortLabel(format: Enums<'match_format'>): string {
  const size = FORMAT_TEAM_SIZE[format]
  return `${size}v${size}`
}

const SURFACE_LABEL: Readonly<Record<Enums<'pitch_surface'>, string>> = {
  natural_grass: 'Natural grass',
  artificial_turf: 'Artificial turf',
  hybrid: 'Hybrid',
  indoor_court: 'Indoor court',
}

export function surfaceLabel(surface: Enums<'pitch_surface'>): string {
  return SURFACE_LABEL[surface]
}

/**
 * A venue's location on one line: `Kadıköy, İstanbul`, or whichever half exists.
 *
 * Both columns are nullable, and a card that renders `null, İstanbul` looks broken in a way that
 * makes the whole listing look untrustworthy.
 */
export function placeLabel(district: string | null, city: string | null): string | null {
  const parts = [district, city].filter((part): part is string => Boolean(part?.trim()))
  return parts.length > 0 ? parts.join(', ') : null
}
