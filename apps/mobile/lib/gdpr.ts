/**
 * lib/gdpr.ts
 *
 * The age bands and the minors' privacy copy, ported from apps/web/lib/gdpr.ts.
 *
 * The web module cannot be imported here — it pulls in `server-only` and the Next cookie store —
 * and @onpitch/shared does not carry it, so the rules are restated. Keep the two in step: the
 * numbers below are the same ones `private.is_minor_dob()`, `profiles_minor_privacy_locked_check`
 * and `assert_consented()` enforce in Postgres.
 *
 * None of this is a security control. Every decision it makes is re-made in the database, so a
 * user who patches the bundle gets a 42501 instead of a paragraph. This file exists to give
 * everyone else the explanation before they reach the error code.
 */

import type { Enums } from '@onpitch/shared/database'

/** GDPR Art. 8(1) — under this age, a guardian consents on the child's behalf. */
export const DIGITAL_CONSENT_AGE = 16

/** Below this we do not create an account at all. */
export const MINIMUM_SIGNUP_AGE = 13

/** Matches the web signup form and the Supabase project's password policy. */
export const MINIMUM_PASSWORD_LENGTH = 12

/** How long a guardian consent link stays valid. */
export const CONSENT_TOKEN_TTL_DAYS = 7

export type AgeBand = 'unknown' | 'under_minimum' | 'minor' | 'adult'

export interface AgeAssessment {
  age: number | null
  band: AgeBand
  /** True for 13 to 15: the account can exist but cannot transact until a guardian approves. */
  requiresGuardianConsent: boolean
  /** True for under 13: refuse the signup. */
  blocked: boolean
  /** What to show the person. Null when there is nothing to say. */
  message: string | null
}

function toDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  // `YYYY-MM-DD` alone is parsed as UTC midnight, which is what `age_years()` compares against.
  const parsed = new Date(`${value}T00:00:00Z`)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

/**
 * Completed years between `dateOfBirth` and `now`, in UTC.
 *
 * Mirrors `public.age_years()`. Returns null for absent, unparseable, or future input: a birth
 * date that has not happened yet is bad data rather than an age of zero, and must never round
 * into "adult".
 */
export function calculateAge(
  dateOfBirth: string | Date | null | undefined,
  now: Date = new Date(),
): number | null {
  const birth = toDate(dateOfBirth)
  if (!birth) return null

  let age = now.getUTCFullYear() - birth.getUTCFullYear()
  const monthDelta = now.getUTCMonth() - birth.getUTCMonth()
  if (monthDelta < 0 || (monthDelta === 0 && now.getUTCDate() < birth.getUTCDate())) {
    age -= 1
  }

  return age < 0 ? null : age
}

/**
 * The decision the signup flow branches on.
 *
 * @example
 * assessAge('2013-04-01').band // 'minor' -> collect guardian details
 * assessAge('2016-04-01').band // 'under_minimum' -> refuse
 */
export function assessAge(
  dateOfBirth: string | Date | null | undefined,
  now: Date = new Date(),
): AgeAssessment {
  const age = calculateAge(dateOfBirth, now)

  if (age === null) {
    return { age: null, band: 'unknown', requiresGuardianConsent: false, blocked: false, message: null }
  }

  if (age < MINIMUM_SIGNUP_AGE) {
    return {
      age,
      band: 'under_minimum',
      requiresGuardianConsent: false,
      blocked: true,
      message:
        `You need to be at least ${MINIMUM_SIGNUP_AGE} to have a OnPitch account. Booking a ` +
        'pitch means card payments and your name in a public fixture list, and we cannot do that ' +
        'responsibly for younger players. Ask a parent or guardian to book from their own account.',
    }
  }

  if (age < DIGITAL_CONSENT_AGE) {
    return {
      age,
      band: 'minor',
      requiresGuardianConsent: true,
      blocked: false,
      message:
        `Because you are under ${DIGITAL_CONSENT_AGE}, a parent or guardian has to approve your ` +
        'account before you can book a pitch or join a match. We will email them one link. You ' +
        'can look around in the meantime.',
    }
  }

  return { age, band: 'adult', requiresGuardianConsent: false, blocked: false, message: null }
}

/** The three profile columns a minor cannot change. */
export type LockedPrivacyField =
  | 'location_sharing_enabled'
  | 'profile_visibility'
  | 'marketing_opt_in'

/**
 * Why each locked control is locked, in the second person.
 *
 * Shown next to a DISABLED control, never instead of it. Hiding the row leaves the user hunting
 * for a setting that is switched off, and sending the write anyway earns a CHECK violation.
 */
export const MINOR_PRIVACY_EXPLANATIONS: Readonly<Record<LockedPrivacyField, string>> = {
  location_sharing_enabled:
    `Location sharing stays off until you turn ${DIGITAL_CONSENT_AGE}. Nearby matches are found ` +
    'from your city instead, so nobody ever sees where you are.',
  profile_visibility:
    `Your profile cannot be public before you turn ${DIGITAL_CONSENT_AGE}. Teammates you have ` +
    'played with can still see it.',
  marketing_opt_in: `We do not send marketing to anyone under ${DIGITAL_CONSENT_AGE}.`,
}

/**
 * The columns any of the helpers below actually read.
 *
 * Structurally satisfied by `Tables<'profiles'>`, so a profile row can be passed straight in.
 */
export interface ConsentSubject {
  is_minor: boolean | null
  parental_consent_status: Enums<'consent_status'> | null
  date_of_birth?: string | null
}

/**
 * True when the account is under the digital consent age.
 *
 * The date of birth wins over `is_minor`, which is a STORED generated column and therefore a
 * write-time snapshot: it does not change on its own when a 15-year-old has a birthday, and only
 * the nightly `refresh_aged_out_minors()` sweep re-touches the row. Postgres agrees —
 * `assert_consented()` and `enforce_minor_privacy()` both recompute from `date_of_birth` and never
 * read the column — and so does apps/web/lib/gdpr.ts. The stored flag is the fallback for a caller
 * that projected it without the date.
 */
export function isMinor(profile: ConsentSubject | null, now: Date = new Date()): boolean {
  if (!profile) return false
  const age = calculateAge(profile.date_of_birth ?? null, now)
  if (age !== null) return age < DIGITAL_CONSENT_AGE
  return profile.is_minor === true
}

/**
 * True when the account may book, pay and join matches.
 *
 * Adults always may. A minor may only once a guardian has clicked the emailed link and
 * `parental_consent_status` reads `granted`.
 */
export function hasTransactingConsent(
  profile: ConsentSubject | null,
  now: Date = new Date(),
): boolean {
  if (!profile) return false
  if (!isMinor(profile, now)) return true
  return profile.parental_consent_status === 'granted'
}

/** One line explaining why a transacting action is blocked, or null when it is not. */
export function consentBlockReason(
  profile: ConsentSubject | null,
  now: Date = new Date(),
): string | null {
  if (hasTransactingConsent(profile, now)) return null
  if (profile?.parental_consent_status === 'revoked') {
    return 'Your guardian has withdrawn their approval, so booking and joining matches are off.'
  }
  return 'Your guardian has not approved your account yet. Booking and joining matches unlock as soon as they click the link we emailed them.'
}
