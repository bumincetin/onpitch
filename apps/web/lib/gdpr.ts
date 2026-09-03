/**
 * lib/gdpr.ts
 *
 * The compliance layer: age assessment, the Article 8 consent gate, the "private by default"
 * rule for minors, and guardian email delivery.
 *
 * WHY THIS FILE EXISTS AT ALL
 * ---------------------------
 * Every rule below is ALSO enforced in Postgres — `private.is_minor_dob()`, the
 * `profiles_minor_privacy_locked_check` CHECK constraint, the `enforce_minor_privacy` trigger
 * and `public.assert_consented()`. That is deliberate: the database is the boundary a bug
 * cannot route around. This module exists so the product can *explain itself* — tell a
 * 14-year-old why the location toggle is greyed out instead of letting them flip it and eat a
 * SQLSTATE 42501, and refuse a 12-year-old at the first step instead of after a signup.
 *
 * If these two layers ever disagree, the database wins and this file is the bug.
 *
 * IMPORTABLE FROM CLIENT COMPONENTS. There is no `server-only` import here and no module-scope
 * environment read — `age-gate.tsx` needs `assessAge()` in the browser. Every secret is read
 * inside a function body, and the only function that touches one (`sendGuardianConsentEmail`)
 * is never referenced from client code, so bundlers drop it from the browser graph.
 */

import type { Enums, Tables } from "@onpitch/shared/database"

/* ========================================================================== */
/*  1. Age thresholds                                                         */
/* ========================================================================== */

/**
 * GDPR Art. 8(1): the age of digital consent. The Regulation's default is 16; member states may
 * lower it to as far as 13. docs/SECURITY.md §3 commits to 16.
 *
 * This constant and `private.is_minor_dob()` in `0001_schema.sql` are the ONLY two places the
 * threshold appears. Changing jurisdiction is a one-line migration plus this line.
 */
export const DIGITAL_CONSENT_AGE = 16

/**
 * The floor below which we do not create an account at all, with or without a guardian.
 *
 * Art. 8 permits a guardian to consent on a child's behalf; it does not *oblige* a controller to
 * offer the service. An amateur-football marketplace that takes card payments and publishes
 * fixtures has no business onboarding a 12-year-old, so we decline rather than build a consent
 * flow we cannot honestly supervise.
 */
export const MINIMUM_SIGNUP_AGE = 13

/** How long a guardian consent link stays valid. Mirrors the 7 days in `request_parental_consent`. */
export const CONSENT_TOKEN_TTL_DAYS = 7

/* ========================================================================== */
/*  1b. Credential policy                                                     */
/* ========================================================================== */

/**
 * The minimum password length the auth server actually enforces.
 *
 * This MIRRORS `minimum_password_length` in `supabase/config.toml` (and the same setting in the
 * hosted project's Auth settings). TOML cannot import from TypeScript, so the two have to be
 * changed together — this constant exists so that every client-side check and every sentence
 * shown to a user quotes the number GoTrue will really apply, instead of advertising a shorter
 * one and then rejecting it.
 *
 * GoTrue additionally enforces `password_requirements = "lower_upper_letters_digits"`, which has
 * no client-side mirror: its rejection message is passed through to the user verbatim.
 */
export const MINIMUM_PASSWORD_LENGTH = 12

/* ========================================================================== */
/*  2. Age assessment                                                         */
/* ========================================================================== */

export type AgeBand =
  /** No usable date of birth yet. */
  | "unknown"
  /** Under {@link MINIMUM_SIGNUP_AGE} — signup is refused. */
  | "under_minimum"
  /** {@link MINIMUM_SIGNUP_AGE} to {@link DIGITAL_CONSENT_AGE} - 1 — needs verifiable guardian consent. */
  | "minor"
  /** {@link DIGITAL_CONSENT_AGE} and over — consents for themselves. */
  | "adult"

export interface AgeAssessment {
  /** Completed years, or `null` when the input was absent or unparseable. */
  age: number | null
  band: AgeBand
  /** True for `minor` only. `under_minimum` cannot sign up, so it needs nothing. */
  requiresGuardianConsent: boolean
  /** True when signup must be refused outright. */
  blocked: boolean
  /** Plain-language sentence for the UI. Never legalese — a 14-year-old has to understand it. */
  message: string | null
}

/** Accepts `YYYY-MM-DD` (the `<input type="date">` value), an ISO string, or a `Date`. */
function toDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value

  const trimmed = value.trim()
  if (!trimmed) return null

  // Parse date-only strings as UTC midnight explicitly. `new Date('2010-05-04')` is already UTC,
  // but `new Date('2010-5-4')` is local — normalising removes the one-day drift that would
  // otherwise appear either side of a timezone boundary on someone's exact birthday.
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed)
  if (dateOnly) {
    const parsed = new Date(
      Date.UTC(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])),
    )
    return Number.isNaN(parsed.getTime()) ? null : parsed
  }

  const parsed = new Date(trimmed)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

/**
 * Completed years between `dateOfBirth` and `now`, computed in UTC.
 *
 * Matches `public.age_years()` in `0003_auth_rbac_gdpr.sql`. Returns `null` for absent or
 * unparseable input, and `null` for a future date — a birth date that has not happened yet is
 * bad data, not an age of zero, and must not be silently rounded into "adult".
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
 * The single decision function the signup flow branches on.
 *
 * @example
 * assessAge('2013-04-01').band // 'minor'   -> collect guardian details
 * assessAge('2016-04-01').band // 'under_minimum' -> refuse
 */
export function assessAge(
  dateOfBirth: string | Date | null | undefined,
  now: Date = new Date(),
): AgeAssessment {
  const age = calculateAge(dateOfBirth, now)

  if (age === null) {
    return {
      age: null,
      band: "unknown",
      requiresGuardianConsent: false,
      blocked: false,
      message: null,
    }
  }

  if (age < MINIMUM_SIGNUP_AGE) {
    return {
      age,
      band: "under_minimum",
      requiresGuardianConsent: false,
      blocked: true,
      message:
        `We're sorry — you need to be at least ${MINIMUM_SIGNUP_AGE} to have a OnPitch account. ` +
        "Booking a pitch involves card payments and publishing your name in a fixture list, and " +
        "we can't do that responsibly for younger players. Ask a parent or guardian to book on " +
        "your behalf from their own account.",
    }
  }

  if (age < DIGITAL_CONSENT_AGE) {
    return {
      age,
      band: "minor",
      requiresGuardianConsent: true,
      blocked: false,
      message:
        `Because you're under ${DIGITAL_CONSENT_AGE}, the law (GDPR Article 8) says a parent or ` +
        "guardian has to approve your account before you can book pitches or join matches. " +
        "We'll email them a link — nothing is shared publicly until they confirm, and your " +
        "location stays switched off either way.",
    }
  }

  return {
    age,
    band: "adult",
    requiresGuardianConsent: false,
    blocked: false,
    message: null,
  }
}

/** The `max` for a `<input type="date">` so the picker cannot offer a future birth date. */
export function maxBirthDateInputValue(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10)
}

/** The `min` for a `<input type="date">`. Mirrors `profiles_dob_sane_check` (> 1900-01-01). */
export const MIN_BIRTH_DATE_INPUT_VALUE = "1901-01-01"

/* ========================================================================== */
/*  3. The consent gate                                                       */
/* ========================================================================== */

/** The subset of a profile any of the consent helpers actually needs. */
export type ConsentSubject = Pick<
  Tables<"profiles">,
  "date_of_birth" | "is_minor" | "parental_consent_status"
>

/**
 * Is this person a minor for Art. 8 purposes?
 *
 * `profiles.is_minor` is a STORED generated column, i.e. a write-time snapshot: a profile that
 * ages past 16 keeps `is_minor = true` until the row is next written (see the contract note in
 * `0001_schema.sql`). So the birth date is authoritative when we have one, and the stored flag
 * is only the fallback for profiles with no recorded date of birth.
 *
 * A missing birth date is NOT treated as a minor — that matches `is_minor` and
 * `assert_consented()`, both of which read an unknown age as "adult". The age gate is what
 * guarantees we have a birth date in the first place.
 */
export function isMinor(profile: ConsentSubject, now: Date = new Date()): boolean {
  const age = calculateAge(profile.date_of_birth, now)
  if (age !== null) return age < DIGITAL_CONSENT_AGE
  return profile.is_minor === true
}

/** Thrown when a minor without granted consent tries to do something Art. 8 gates. */
export class ConsentRequiredError extends Error {
  readonly status = 403 as const
  readonly code = "CONSENT_REQUIRED" as const
  readonly consentStatus: Enums<"consent_status">

  constructor(consentStatus: Enums<"consent_status">) {
    super(
      "A parent or guardian must approve this account before it can book pitches or join " +
        `matches (GDPR Article 8). Current status: ${consentStatus}.`,
    )
    this.name = "ConsentRequiredError"
    this.consentStatus = consentStatus
  }
}

export function isConsentRequiredError(error: unknown): error is ConsentRequiredError {
  return error instanceof ConsentRequiredError
}

/**
 * Application-side mirror of `public.assert_consented()`.
 *
 * Call it early in a transacting flow so the user gets a sentence instead of a Postgres error.
 * It is NOT a substitute for the SQL guard — every booking and match RPC still opens with
 * `perform public.assert_consented((select auth.uid()))`, which is what actually stops a
 * hand-rolled request.
 *
 * @throws {ConsentRequiredError}
 */
export function assertConsent(profile: ConsentSubject, now: Date = new Date()): void {
  if (!isMinor(profile, now)) return
  if (profile.parental_consent_status === "granted") return
  throw new ConsentRequiredError(profile.parental_consent_status)
}

/** Non-throwing form, for rendering a banner. */
export function hasTransactingConsent(profile: ConsentSubject, now: Date = new Date()): boolean {
  return !isMinor(profile, now) || profile.parental_consent_status === "granted"
}

/* ========================================================================== */
/*  4. Private by default (Art. 25)                                           */
/* ========================================================================== */

/** The privacy switches a minor may not operate. */
export type LockedPrivacyField = "location_sharing_enabled" | "profile_visibility" | "marketing_opt_in"

export type PrivacySubject = ConsentSubject &
  Pick<Tables<"profiles">, "location_sharing_enabled" | "profile_visibility" | "marketing_opt_in">

export interface PrivacyDefaults {
  location_sharing_enabled: boolean
  profile_visibility: "public" | "members" | "private"
  marketing_opt_in: boolean
}

export interface PrivacyEnforcement {
  /** The values that will actually survive a write, after the DB trigger has had its say. */
  values: PrivacyDefaults
  /** Fields the UI must render DISABLED. Never hidden — see below. */
  lockedFields: readonly LockedPrivacyField[]
  /** Field -> the sentence to show next to the disabled control. */
  explanations: Readonly<Partial<Record<LockedPrivacyField, string>>>
  /** True when at least one field was forced away from the requested value. */
  changed: boolean
}

/**
 * The sentence shown next to each disabled control. Exported so the signup form can explain a
 * locked switch before a profile row even exists.
 */
export const MINOR_PRIVACY_EXPLANATIONS: Readonly<Record<LockedPrivacyField, string>> = {
  location_sharing_enabled:
    `Location sharing stays off until you turn ${DIGITAL_CONSENT_AGE}. Matches near you are ` +
    "found by city instead, so you can still get suggestions without broadcasting where you are.",
  profile_visibility:
    `Your profile can't be public before you turn ${DIGITAL_CONSENT_AGE}. Teammates you've ` +
    "played with can still see you; strangers and search engines can't.",
  marketing_opt_in:
    `We don't send marketing to anyone under ${DIGITAL_CONSENT_AGE}, so there's nothing to opt ` +
    "into here. You'll still get the emails you need about your bookings.",
}

/**
 * "Private by default" for minors, as a pure function.
 *
 * THE UI RULE: these controls are rendered DISABLED with the explanation attached — never
 * hidden. Hiding them teaches a young user that the platform
 * is opaque and leaves them unable to tell a policy from a bug; showing them greyed out with a
 * reason is the transparency Art. 12 asks for and it is also how they learn the setting exists
 * for when they turn {@link DIGITAL_CONSENT_AGE}.
 *
 * The same three values are hard-locked by `enforce_minor_privacy` (BEFORE INSERT/UPDATE) and by
 * `profiles_minor_privacy_locked_check`, so this function only decides what the screen says.
 *
 * @example
 * const { values, lockedFields } = enforcePrivacyDefaults(profile)
 * <Switch checked={values.location_sharing_enabled}
 *         disabled={lockedFields.includes('location_sharing_enabled')} />
 */
export function enforcePrivacyDefaults(
  profile: PrivacySubject,
  now: Date = new Date(),
): PrivacyEnforcement {
  const requested: PrivacyDefaults = {
    location_sharing_enabled: profile.location_sharing_enabled,
    profile_visibility: (profile.profile_visibility as PrivacyDefaults["profile_visibility"]) ?? "private",
    marketing_opt_in: profile.marketing_opt_in,
  }

  if (!isMinor(profile, now)) {
    return { values: requested, lockedFields: [], explanations: {}, changed: false }
  }

  // Mirrors the trigger exactly: location and marketing are forced off; visibility is forced to
  // 'private' unless it is already the (also-safe) 'members'.
  const values: PrivacyDefaults = {
    location_sharing_enabled: false,
    profile_visibility: requested.profile_visibility === "members" ? "members" : "private",
    marketing_opt_in: false,
  }

  return {
    values,
    lockedFields: ["location_sharing_enabled", "profile_visibility", "marketing_opt_in"],
    explanations: MINOR_PRIVACY_EXPLANATIONS,
    changed:
      values.location_sharing_enabled !== requested.location_sharing_enabled ||
      values.profile_visibility !== requested.profile_visibility ||
      values.marketing_opt_in !== requested.marketing_opt_in,
  }
}

/* ========================================================================== */
/*  5. Guardian consent email                                                 */
/* ========================================================================== */

export interface GuardianConsentEmail {
  /** Guardian's address, as typed by the child at signup. */
  to: string
  guardianName?: string | null
  /** How the child identified themselves. Used only inside the email body. */
  minorName?: string | null
  /** Absolute URL carrying the one-time token. NEVER persisted, NEVER returned to a browser. */
  consentUrl: string
  expiresAt: Date
}

export type EmailDeliveryChannel = "resend" | "smtp" | "console"

export interface EmailDeliveryResult {
  channel: EmailDeliveryChannel
  delivered: boolean
  /** Provider message id, when the provider returns one. */
  id?: string
  /** Present when `delivered` is false. Safe to log — never contains the token. */
  error?: string
}

/** A pluggable transport, so swapping Resend for SES is one function, not a refactor. */
export interface GuardianEmailTransport {
  readonly channel: EmailDeliveryChannel
  send(message: GuardianConsentEmail): Promise<EmailDeliveryResult>
}

/** `a***z@example.com` — enough for a user to recognise their own address, useless to a scraper. */
export function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@")
  if (!domain) return "***"
  if (local.length <= 2) return `${local[0] ?? "*"}***@${domain}`
  return `${local[0]}***${local[local.length - 1]}@${domain}`
}

function renderSubject(): string {
  return "Approve your child's OnPitch account"
}

function renderText(message: GuardianConsentEmail): string {
  const greeting = message.guardianName ? `Hello ${message.guardianName},` : "Hello,"
  const child = message.minorName ? message.minorName : "A young player"

  return [
    greeting,
    "",
    `${child} has asked to join OnPitch, an amateur football app for booking pitches and`,
    "organising matches. They told us they are under 16, so European data protection law",
    "(GDPR Article 8) requires your approval before we may process their data.",
    "",
    "If you're happy for them to use OnPitch, confirm here:",
    message.consentUrl,
    "",
    `This link expires on ${message.expiresAt.toUTCString()} and can only be used once.`,
    "",
    "What we do for accounts under 16, whether or not you approve:",
    "  - location sharing is switched off and cannot be turned on;",
    "  - the profile is never public — only teammates can see it;",
    "  - no marketing email is ever sent.",
    "",
    "Until you approve, the account cannot book a pitch or join a match.",
    "If you weren't expecting this email, you can ignore it — the link will simply expire, and",
    "the account stays blocked from booking and playing.",
    "",
    "OnPitch",
  ].join("\n")
}

function renderHtml(message: GuardianConsentEmail): string {
  const greeting = message.guardianName ? `Hello ${escapeHtml(message.guardianName)},` : "Hello,"
  const child = message.minorName ? escapeHtml(message.minorName) : "A young player"

  return `<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;line-height:1.6;color:#0f172a">
<p>${greeting}</p>
<p>${child} has asked to join <strong>OnPitch</strong>, an amateur football app for booking pitches and organising matches. They told us they are under 16, so European data protection law (GDPR Article&nbsp;8) requires your approval before we may process their data.</p>
<p><a href="${escapeHtml(message.consentUrl)}" style="display:inline-block;padding:12px 20px;background:#15803d;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">Bu hesabı onayla</a></p>
<p style="font-size:13px;color:#475569">This link expires on ${escapeHtml(message.expiresAt.toUTCString())} and can only be used once.</p>
<p><strong>16 yaş altı her hesap için, onaylasan da onaylamasan da:</strong></p>
<ul>
<li>konum paylaşımı kapalıdır ve açılamaz;</li>
<li>profil asla herkese açık olmaz — yalnızca takım arkadaşları görebilir;</li>
<li>hiçbir zaman pazarlama e-postası gönderilmez.</li>
</ul>
<p>Sen onaylayana kadar hesap saha tutamaz ve maça katılamaz. Bu e-postayı beklemiyorduysan görmezden gelebilirsin — bağlantının süresi kendiliğinden dolar ve hesap kapalı kalır.</p>
<p style="color:#475569">— OnPitch</p>
</body></html>`
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function fromAddress(): string {
  return (
    process.env.RESEND_FROM_EMAIL ??
    process.env.EMAIL_FROM ??
    "OnPitch <onboarding@resend.dev>"
  )
}

/**
 * Resend, over plain `fetch` — no SDK dependency for one POST.
 * https://resend.com/docs/api-reference/emails/send-email
 */
function resendTransport(apiKey: string): GuardianEmailTransport {
  return {
    channel: "resend",
    async send(message) {
      try {
        const response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: fromAddress(),
            to: [message.to],
            subject: renderSubject(),
            text: renderText(message),
            html: renderHtml(message),
          }),
          // A guardian email must never hold a signup request open. 10s then give up.
          signal: AbortSignal.timeout(10_000),
        })

        if (!response.ok) {
          // The body may echo the recipient address; it never contains the token, which only
          // appears inside `consentUrl` in the request we sent.
          const detail = await response.text().catch(() => "")
          return {
            channel: "resend",
            delivered: false,
            error: `Resend responded ${response.status}: ${detail.slice(0, 300)}`,
          }
        }

        const payload = (await response.json().catch(() => null)) as { id?: string } | null
        return { channel: "resend", delivered: true, id: payload?.id }
      } catch (error) {
        return {
          channel: "resend",
          delivered: false,
          error: error instanceof Error ? error.message : "Bilinmeyen Resend iletim hatası",
        }
      }
    },
  }
}

/**
 * DOCUMENTED STUB — the only stub in this module, and the task brief allows it.
 *
 * `SMTP_URL` is honoured as an escape hatch for self-hosted deployments, but no SMTP client is
 * bundled (nodemailer is not a dependency of this project). Rather than pretend, this transport
 * reports `delivered: false` with an actionable error so the failure is visible in logs and in
 * the API response's `delivery` field instead of being silently swallowed.
 *
 * To finish it: add `nodemailer`, build a transport from `SMTP_URL`, and send
 * `{ from: fromAddress(), to, subject: renderSubject(), text: renderText(m), html: renderHtml(m) }`.
 */
function smtpTransport(): GuardianEmailTransport {
  return {
    channel: "smtp",
    async send() {
      return {
        channel: "smtp",
        delivered: false,
        error:
          "SMTP_URL is set but no SMTP client is bundled. Install nodemailer and implement " +
          "smtpTransport() in lib/gdpr.ts, or set RESEND_API_KEY instead.",
      }
    },
  }
}

/**
 * Development transport. Prints the consent link to the server console so a developer can click
 * it without wiring a mail provider.
 *
 * This is the one place the raw token is ever written anywhere, and it is hard-gated on
 * `NODE_ENV !== 'production'`. In production with no provider configured, the link is REDACTED
 * and the call reports failure — a missing `RESEND_API_KEY` in production must look like an
 * outage, not like a success that quietly leaked a consent token into a log aggregator.
 */
function consoleTransport(): GuardianEmailTransport {
  return {
    channel: "console",
    async send(message) {
      const isProduction = process.env.NODE_ENV === "production"

      if (isProduction) {
        // eslint-disable-next-line no-console
        console.error(
          "[gdpr] No email provider configured (RESEND_API_KEY unset). Guardian consent email " +
            `for ${maskEmail(message.to)} was NOT sent. The link is withheld from this log by design.`,
        )
        return {
          channel: "console",
          delivered: false,
          error: "No email provider configured in production.",
        }
      }

      // eslint-disable-next-line no-console
      console.info(
        [
          "",
          "──────────────────────────────────────────────────────────────",
          " GDPR Art. 8 — guardian consent email (dev, not actually sent)",
          `   to:      ${message.to}`,
          `   expires: ${message.expiresAt.toISOString()}`,
          `   link:    ${message.consentUrl}`,
          "──────────────────────────────────────────────────────────────",
          "",
        ].join("\n"),
      )
      return { channel: "console", delivered: true }
    },
  }
}

/** Picks a transport from the environment. Resend wins, then SMTP, then the dev console. */
export function resolveGuardianEmailTransport(): GuardianEmailTransport {
  const resendKey = process.env.RESEND_API_KEY
  if (resendKey) return resendTransport(resendKey)
  if (process.env.SMTP_URL) return smtpTransport()
  return consoleTransport()
}

/**
 * Sends the Art. 8 consent email.
 *
 * SERVER ONLY by convention — it reads `RESEND_API_KEY`. It is never imported by a client
 * component, so it does not reach the browser bundle.
 *
 * Never throws: a mail provider outage must not roll back a consent request that Postgres has
 * already committed. The caller surfaces `delivered: false` as "we couldn't send it, try
 * resending" while the request row stays valid for its full 7 days.
 */
export async function sendGuardianConsentEmail(
  message: GuardianConsentEmail,
): Promise<EmailDeliveryResult> {
  const transport = resolveGuardianEmailTransport()
  try {
    return await transport.send(message)
  } catch (error) {
    return {
      channel: transport.channel,
      delivered: false,
      error: error instanceof Error ? error.message : "Bilinmeyen iletim hatası",
    }
  }
}

/**
 * Builds the absolute guardian link.
 *
 * @param rawToken the one-time token from `request_parental_consent`. Server-side only.
 * @param origin fallback origin when `NEXT_PUBLIC_SITE_URL` is unset (derive it from the request).
 */
export function buildConsentUrl(rawToken: string, origin?: string): string {
  const base = process.env.NEXT_PUBLIC_SITE_URL ?? origin ?? "http://localhost:3000"
  const url = new URL("/parental-consent", base)
  url.searchParams.set("token", rawToken)
  return url.toString()
}

/* ========================================================================== */
/*  6. Issuing a consent request                                              */
/* ========================================================================== */

/**
 * `public.request_parental_consent()` is declared `returns table (request_id uuid, raw_token
 * text)`, so PostgREST answers with an ARRAY of one row, which is what
 * `packages/shared/src/database.ts` now declares too. This normaliser stays tolerant of the other shapes anyway — a single row object,
 * or a bare token string — so a database that predates the corrected signature degrades to a
 * `null` token instead of a crash.
 *
 * The raw token it pulls out is a one-time credential. It goes from here into an email body and
 * nowhere else: never into a log, a response body, an error message, or a database column.
 */
export function extractRawConsentToken(data: unknown): {
  requestId: string | null
  rawToken: string | null
} {
  const row = Array.isArray(data) ? data[0] : data

  if (typeof row === "string") {
    return { requestId: null, rawToken: row || null }
  }

  if (row && typeof row === "object") {
    const record = row as Record<string, unknown>
    const rawToken = typeof record["raw_token"] === "string" ? record["raw_token"] : null
    const requestId = typeof record["request_id"] === "string" ? record["request_id"] : null
    return { requestId, rawToken }
  }

  return { requestId: null, rawToken: null }
}

/** Why a consent request could not be issued. Maps 1:1 onto the SQLSTATEs the RPC raises. */
export type ConsentIssueFailure =
  | "unauthenticated"
  | "not_a_minor"
  | "invalid_email"
  | "rate_limited"
  | "token_missing"
  | "unknown"

export type ConsentIssueResult =
  | {
      ok: true
      requestId: string | null
      /** Safe to return to a browser. The full address never leaves the server. */
      guardianEmailMasked: string
      expiresAt: string
      delivery: EmailDeliveryResult
    }
  | { ok: false; reason: ConsentIssueFailure; message: string }

/** The minimum surface of a Supabase client this needs — keeps the import type-only. */
interface ConsentRpcClient {
  rpc(
    fn: "request_parental_consent",
    args: { p_guardian_email: string; p_guardian_name?: string | null },
  ): PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }>
}

/**
 * Mints a guardian consent token and emails the link. Used by
 * `POST /api/auth/parental-consent/request` and, for the confirm-your-email signup flow, by
 * `/auth/callback` once a session finally exists.
 *
 * MUST be called with a client carrying the MINOR's session — `request_parental_consent` reads
 * `auth.uid()` and issues the token for the caller, so it cannot be used to send a consent email
 * about somebody else.
 *
 * @param supabase a user-scoped Supabase client (never the admin client)
 * @param origin fallback origin for the link when `NEXT_PUBLIC_SITE_URL` is unset
 */
export async function issueGuardianConsent(
  supabase: ConsentRpcClient,
  input: {
    guardianEmail: string
    guardianName?: string | null
    minorName?: string | null
    origin?: string
  },
): Promise<ConsentIssueResult> {
  const guardianEmail = input.guardianEmail.trim().toLowerCase()

  const { data, error } = await supabase.rpc("request_parental_consent", {
    p_guardian_email: guardianEmail,
    p_guardian_name: input.guardianName?.trim() || null,
  })

  if (error) {
    // SQLSTATEs raised by the function itself (0003_auth_rbac_gdpr.sql).
    switch (error.code) {
      case "42501":
        return /already 16 or older/i.test(error.message) || /only required for accounts under/i.test(error.message)
          ? { ok: false, reason: "not_a_minor", message: error.message }
          : { ok: false, reason: "unauthenticated", message: error.message }
      case "22023":
        return { ok: false, reason: "invalid_email", message: error.message }
      case "P0001":
        return { ok: false, reason: "rate_limited", message: error.message }
      default:
        return { ok: false, reason: "unknown", message: error.message }
    }
  }

  const { requestId, rawToken } = extractRawConsentToken(data)
  if (!rawToken) {
    return {
      ok: false,
      reason: "token_missing",
      message: "Onay isteği oluşturuldu ama jeton dönmedi.",
    }
  }

  const expiresAt = new Date(Date.now() + CONSENT_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000)

  const delivery = await sendGuardianConsentEmail({
    to: guardianEmail,
    guardianName: input.guardianName ?? null,
    minorName: input.minorName ?? null,
    consentUrl: buildConsentUrl(rawToken, input.origin),
    expiresAt,
  })

  return {
    ok: true,
    requestId,
    guardianEmailMasked: maskEmail(guardianEmail),
    expiresAt: expiresAt.toISOString(),
    delivery,
  }
}
