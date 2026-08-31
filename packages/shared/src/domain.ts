/**
 * packages/shared/src/domain.ts
 *
 * The hand-authored application vocabulary — everything that is NOT a 1:1 database row.
 * `database.ts` is the schema mirror; this file is the layer above it: branded money,
 * the availability/quote/checkout shapes, rating and matchmaking types, the anomaly and
 * consensus contracts, the `ApiResponse<T>` envelope every route handler returns, and the zod
 * schemas every route parses its body with.
 *
 * House rule (docs/SECURITY.md §2): nothing crossing a trust boundary is typed by assertion,
 * it is parsed. That includes browser request bodies AND the anomaly sidecar's responses.
 */

import { Constants } from "./database"
import type { Enums, Expect, Json } from "./database"
import { z } from "zod"

/* ========================================================================== */
/*  0. Small type-level utilities                                             */
/* ========================================================================== */


/** True when `A` and `B` are mutually assignable. */
export type MutuallyAssignable<A, B> = A extends B ? (B extends A ? true : false) : false

/* ========================================================================== */
/*  1. Money — integer minor units, branded                                   */
/* ========================================================================== */

/**
 * An integer count of a currency's MINOR unit (kurus for TRY, cents for EUR/USD).
 *
 * The brand exists so a major-unit float can never be silently passed where the database,
 * Stripe, and every `*_minor` column expect an integer. Widen with `asMinor()` at the trust
 * boundary; never with a cast.
 */
export type MinorUnits = number & { readonly __brand: "MinorUnits" }

/** The platform default currency. Lowercase, matching the `^[a-z]{3}$` CHECK on the schema. */
export const DEFAULT_CURRENCY = "try"

/** ISO 4217 codes with no minor unit at all (Stripe's zero-decimal list). */
const ZERO_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set([
  "bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga",
  "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf",
])

/** ISO 4217 codes whose minor unit is 1/1000 of the major unit. */
const THREE_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set([
  "bhd", "jod", "kwd", "omr", "tnd",
])

/** How many decimal places separate the major unit from the minor unit. */
export function minorUnitExponent(currency: string = DEFAULT_CURRENCY): number {
  const code = currency.toLowerCase()
  if (ZERO_DECIMAL_CURRENCIES.has(code)) return 0
  if (THREE_DECIMAL_CURRENCIES.has(code)) return 3
  return 2
}

/**
 * Brand a value that is ALREADY an integer count of minor units — a `*_minor` column, a Stripe
 * `amount`, a server-side computation. Throws on anything that is not a finite integer, so a
 * float slipping in from arithmetic fails loudly at the boundary instead of becoming a
 * fractional charge.
 */
export function asMinor(value: number): MinorUnits {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new TypeError(`Expected an integer count of minor units, received ${String(value)}`)
  }
  return value as MinorUnits
}

/** Convert a major-unit amount (149.5 TRY) into minor units (14950). Rounds half away from zero. */
export function toMinor(major: number, currency: string = DEFAULT_CURRENCY): MinorUnits {
  if (!Number.isFinite(major)) {
    throw new TypeError(`Expected a finite major-unit amount, received ${String(major)}`)
  }
  const factor = 10 ** minorUnitExponent(currency)
  const scaled = major * factor
  // Math.round() breaks ties toward +Infinity, which is asymmetric for negative amounts
  // (refunds, adjustments). Round the magnitude and re-apply the sign.
  const rounded = Math.sign(scaled) * Math.round(Math.abs(scaled))
  return asMinor(rounded === 0 ? 0 : rounded)
}

/** Convert minor units back to a major-unit number. Display only — never do money math on this. */
export function fromMinor(minor: MinorUnits | number, currency: string = DEFAULT_CURRENCY): number {
  return minor / 10 ** minorUnitExponent(currency)
}

/**
 * Human-readable money, e.g. `formatMinor(asMinor(45000), 'try') === '₺450,00'` under `tr-TR`.
 * Accepts a plain `number` too so read paths can format a `*_minor` column without branding it.
 * Falls back to a plain `<amount> <CODE>` string if the runtime rejects the currency code.
 */
export function formatMinor(
  amount: MinorUnits | number,
  currency: string = DEFAULT_CURRENCY,
  locale = "tr-TR",
): string {
  const exponent = minorUnitExponent(currency)
  const major = amount / 10 ** exponent
  const code = currency.toUpperCase()
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: code,
      minimumFractionDigits: exponent,
      maximumFractionDigits: exponent,
    }).format(major)
  } catch {
    return `${major.toFixed(exponent)} ${code}`
  }
}

/* ========================================================================== */
/*  2. String unions backing CHECK constraints                                */
/* ========================================================================== */

export const TEAM_SIDES = ["home", "away"] as const
export type TeamSide = (typeof TEAM_SIDES)[number]

export const PROFILE_VISIBILITIES = ["public", "members", "private"] as const
export type ProfileVisibility = (typeof PROFILE_VISIBILITIES)[number]

export const ANOMALY_SOURCES = ["rule_engine", "isolation_forest", "manual"] as const
export type AnomalySource = (typeof ANOMALY_SOURCES)[number]

export const CONSENSUS_DECISIONS = ["approve", "reject"] as const
export type ConsensusDecision = (typeof CONSENSUS_DECISIONS)[number]

export const SCORE_VERDICTS = ["finalized", "requires_consensus", "awaiting_opponent"] as const
/**
 * The HTTP response vocabulary of `GET`/`POST /api/matches/[id]/report-score`, produced by that
 * route's `verdictFor()` from `matches.status` and `matches.requires_consensus`.
 *
 * It is NOT what `evaluate_score_consensus` returns -- that RPC answers with a `decision` drawn
 * from `SCORE_CONSENSUS_DECISIONS` below, and none of these three strings is ever emitted by it.
 */
export type ScoreVerdict = (typeof SCORE_VERDICTS)[number]

export const SCORE_CONSENSUS_DECISIONS = [
  "accepted",
  "contested",
  "accepted_by_default",
  "awaiting_counterparty",
  "noop",
  "awaiting_reports",
] as const
/** The `decision` key of the object `public.evaluate_score_consensus()` returns. */
export type ScoreConsensusDecision = (typeof SCORE_CONSENSUS_DECISIONS)[number]

/* ========================================================================== */
/*  3. Availability & booking                                                 */
/* ========================================================================== */

/** Why a slot on the grid cannot be booked. */
export type SlotUnavailableReason =
  | "booked"
  | "blocked"
  | "closed"
  | "past"
  | "venue_not_payable"

export interface TimeSlot {
  /** ISO-8601 instant, inclusive lower bound of the half-open range. */
  startsAt: string
  /** ISO-8601 instant, exclusive upper bound. */
  endsAt: string
  available: boolean
  /** Price for this single slot, already scaled from `pitches.hourly_rate_minor`. */
  priceMinor: MinorUnits
  /** Present only when `available` is false. */
  reason?: SlotUnavailableReason
}

export interface AvailabilityDay {
  /** Local calendar date in the venue timezone, `YYYY-MM-DD`. */
  date: string
  slots: TimeSlot[]
}

/**
 * A pitch's bookable grid over a date window. Slots are rendered in the VENUE timezone but the
 * `startsAt` / `endsAt` instants stay absolute, so a DST boundary shifts the labels, never the
 * underlying reservation.
 */
export interface AvailabilityGrid {
  pitchId: string
  venueId: string
  /** IANA zone from `venues.timezone`. */
  timezone: string
  /** Grid granularity from `pitches.slot_minutes`. */
  slotMinutes: number
  currency: string
  hourlyRateMinor: MinorUnits
  days: AvailabilityDay[]
}

/**
 * A server-computed price for one booking window. The client never sends an amount; this is
 * recomputed from `pitches.hourly_rate_minor` on every checkout attempt.
 *
 * `totalMinor` is what the customer is charged; `platformFeeMinor` is the Stripe
 * `application_fee_amount`. The schema only guarantees `platformFeeMinor <= totalMinor` —
 * fee-on-top and fee-deducted are both valid destination-charge shapes.
 */
export interface BookingQuote {
  pitchId: string
  startsAt: string
  endsAt: string
  durationMinutes: number
  hourlyRateMinor: MinorUnits
  subtotalMinor: MinorUnits
  platformFeeMinor: MinorUnits
  totalMinor: MinorUnits
  currency: string
}

/** What `POST /api/bookings/checkout` returns on success. */
export interface CheckoutResult {
  bookingId: string
  /** PaymentIntent client secret for Stripe.js. */
  clientSecret: string
  /** `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, echoed so the client never has to guess. */
  publishableKey: string
  quote: BookingQuote
}

/** Refund outcome of `POST /api/bookings/[id]/cancel`. */
export interface CancellationResult {
  bookingId: string
  status: Enums<"booking_status">
  paymentStatus: Enums<"payment_status">
  refundedAmountMinor: MinorUnits
  currency: string
  /** True when the refund covered the full `total_minor`. */
  fullRefund: boolean
}

/* ========================================================================== */
/*  4. Ratings & matchmaking                                                  */
/* ========================================================================== */

/** A player's TrueSkill posterior at a point in time. */
export interface RatingSnapshot {
  mu: number
  sigma: number
  /** `mu - 3 * sigma` — the number shown on leaderboards. */
  conservativeRating: number
}

/** How balanced a proposed fixture is, per the rating model. */
export interface MatchQuality {
  /** Draw-probability quality score in [0,1]; 1 is a perfectly even fixture. */
  quality: number
  /** Predicted probability of a draw, in [0,1]. */
  drawProbability: number
  /** Predicted probability the home side wins, in [0,1]. */
  homeWinProbability: number
  /** Predicted probability the away side wins, in [0,1]. */
  awayWinProbability: number
}

/** One player as seen by the balancer / rating engine. */
export interface RatedPlayer {
  playerId: string
  rating: RatingSnapshot
  /** TrueSkill 2 partial-play weight in (0,1]. 1 means the player was on for the full match. */
  weight: number
  preferredPosition: string | null
}

/** A proposed split of a roster into two sides. */
export interface BalancedLineup {
  home: RatedPlayer[]
  away: RatedPlayer[]
  quality: MatchQuality
}

/**
 * An open match ranked for one specific player by `GET /api/matchmaking/suggest`.
 *
 * `distanceKm` is `null` for minors: their location sharing is off by design, so the distance
 * term is skipped entirely rather than approximated. The privacy default propagates into the
 * ranking instead of being defeated by it.
 */
export interface MatchmakingCandidate {
  matchId: string
  kickoffAt: string
  format: Enums<"match_format">
  status: Enums<"match_status">
  venueId: string | null
  venueName: string | null
  city: string | null
  distanceKm: number | null
  spotsRemaining: number
  isRanked: boolean
  quality: MatchQuality
  /** Component scores, all normalised to [0,1] before weighting. */
  ratingProximity: number
  kickoffPreference: number
  noShowPenalty: number
  /** Final weighted rank, descending. */
  score: number
}

/* ========================================================================== */
/*  5. Anomaly detection — the Python sidecar contract                        */
/* ========================================================================== */

/**
 * The feature vector sent to `services/anomaly/`.
 *
 * THIS MUST STAY FIELD-FOR-FIELD IDENTICAL to the pydantic model in the sidecar and to the
 * `match_anomaly_feature_row` composite that the `anomaly_features(match_id)` RPC mirrors.
 * Changing one without the other two silently degrades detection instead of failing loudly.
 * (`anomaly_features` returns these eleven fields PLUS a nested `collusion` object, which this
 * interface deliberately does not model.)
 */
export interface AnomalyFeatureVector {
  matchId: string
  /** Variance of reported scorelines across all `score_reports` for the match. */
  scoreVariance: number
  /** Seconds between kickoff+duration and the first report. */
  reportingDelaySeconds: number
  /** How many distinct participants filed a report. */
  reporterCount: number
  /** Agreement in [0,1] between the home-side and away-side reports. */
  opposingReportAgreement: number
  /** Roster overlap in [0,1] with the previous meeting of these two line-ups. */
  participantOverlapRatio: number
  /** Deviation of this report from the reporter's historical reporting pattern. */
  historicalReportDeviation: number
  /** `abs(homeScore - awayScore)` of the agreed or first-reported scoreline. */
  goalDiff: number
  /** Kickoff hour 0..23 in the venue timezone. */
  kickoffHour: number
  /** Bookings at the venue in the trailing 7 days. */
  venueBookingsLast7d: number
  /** Age in days of the first reporter's account. */
  reporterAccountAgeDays: number
}

/**
 * The verdict persisted into `match_anomaly_flags` via `record_anomaly_verdict`.
 *
 * `source` is `'isolation_forest'` when the sidecar answered and `'rule_engine'` when it did
 * not: the ML service is advisory and must never block a match from finalising. Under the
 * fallback, `leafDepth`, `averagePathLength` and `modelVersion` are null.
 */
export interface AnomalyVerdict {
  matchId: string
  source: AnomalySource
  /** `2^(-E[h(x)] / c(n))`. Higher means more anomalous; a SHORT path is the anomalous case. */
  anomalyScore: number
  isAnomalous: boolean
  leafDepth: number | null
  averagePathLength: number | null
  modelVersion: string | null
  /** Score above which `matches.requires_consensus` is raised. Currently 0.62. */
  threshold: number
  /** Human-readable reason codes stored in `match_anomaly_flags.reasons`. */
  reasons: string[]
}

/* ========================================================================== */
/*  6. Cryptographic peer consensus                                           */
/* ========================================================================== */

/**
 * The canonical document a participant signs when voting on a contested result.
 *
 * The digest is only meaningful if the browser and the server hash identical bytes. `consensus_payload(match_id)` is the ONLY producer — the client hashes
 * the exact serialised bytes it received and never re-serialises this object itself.
 *
 * The canonical bytes are the Postgres `jsonb::text` rendering, NOT JCS: keys ordered by
 * (length, bytewise) => nonce, match_id, away_score, home_score, reported_at, participant_ids;
 * one space after every colon and comma; UTC second-precision timestamp; participant uuids
 * sorted ascending as text; UTF-8. Two reference implementations exist -- copy one rather than
 * writing a third: `canonicalizeJsonb` in `apps/web/components/match/consensus-panel.tsx`
 * (browser) and `canonicalJsonbText` imported by
 * `apps/web/app/api/matches/[id]/consensus/route.ts` (server).
 */
export interface ConsensusPayload {
  version: number
  matchId: string
  homeTeamId: string | null
  awayTeamId: string | null
  homeScore: number
  awayScore: number
  kickoffAt: string
  /** Confirmed participant ids, sorted ascending. */
  participantIds: string[]
  /** Server-issued single-use nonce, lowercase hex. Replay protection for the signature. */
  nonce: string
  issuedAt: string
}

/** Live state of a consensus round, from `GET /api/matches/[id]/consensus`. */
export interface ConsensusRound {
  matchId: string
  payload: ConsensusPayload
  /** The exact canonical string the digest is computed over. */
  canonical: string
  /** Lowercase hex SHA-256 of `canonical`, as computed by the server. */
  digest: string
  deadline: string | null
  /** ceil(2/3) of confirmed participants. */
  quorumRequired: number
  approvals: number
  rejections: number
  /** Approvals must come from BOTH sides — a Sybil cluster on one side cannot reach quorum. */
  hasHomeApproval: boolean
  hasAwayApproval: boolean
  /** Whether the calling user has already voted in this round. */
  callerHasVoted: boolean
}

/** One vote submitted to `POST /api/matches/[id]/consensus`. */
export interface ConsensusApprovalInput {
  matchId: string
  decision: ConsensusDecision
  /** Lowercase hex SHA-256 the client computed. The server recomputes and rejects mismatches. */
  clientDigest: string
  /** Base64 HMAC over `payload_digest || nonce`. Optional until device keys ship. */
  signature?: string
  /** Defaults to `hmac-sha256`; a column, not a constant, so Ed25519 is a data migration. */
  signatureAlg?: string
}

/* ========================================================================== */
/*  7. Stripe Connect & venue dashboard                                       */
/* ========================================================================== */

/** Normalised `account.requirements`, from `GET /api/stripe/connect/status`. */
export interface StripeOnboardingState {
  accountId: string | null
  chargesEnabled: boolean
  payoutsEnabled: boolean
  detailsSubmitted: boolean
  disabledReason: string | null
  currentlyDue: string[]
  eventuallyDue: string[]
  pastDue: string[]
  pendingVerification: string[]
  /** True only when charges AND payouts are enabled — the gate on `venues.is_active`. */
  isComplete: boolean
}

/** A single-use Connect Account Link. Expires quickly; mint a fresh one on every render. */
export interface StripeOnboardingLink {
  url: string
  accountId: string
  expiresAt: string
}

/** The next payout Stripe has scheduled for a connected account. */
export interface NextPayout {
  payoutId: string
  amountMinor: MinorUnits
  currency: string
  status: Enums<"payout_status">
  /** `YYYY-MM-DD`, or null while Stripe has not scheduled one. */
  arrivalDate: string | null
}

/**
 * Headline numbers for the venue owner dashboard. Every figure is computed SQL-side over the
 * requested window; occupancy honours opening hours and blackout blocks rather than assuming a
 * 24h day.
 */
export interface VenueDashboardMetrics {
  /** Booked minutes / bookable minutes, in [0,1]. */
  occupancyRate: number
  /** Gross charged to customers over the window. */
  revenueMinor: MinorUnits
  /** Count of confirmed bookings with a kickoff still in the future. */
  upcomingBookings: number
  nextPayout: NextPayout | null
  currency: string
  /** Optional detail, populated by `GET /api/venues/[id]/metrics`. */
  platformFeeMinor?: MinorUnits
  netMinor?: MinorUnits
  bookingCount?: number
  averageBookingValueMinor?: MinorUnits
  cancellationRate?: number
  rangeFrom?: string
  rangeTo?: string
}

/* ========================================================================== */
/*  8. The API envelope                                                       */
/* ========================================================================== */

/** Error codes the route handlers agree on. `ApiError.code` stays `string` for forward compat. */
export const API_ERROR_CODES = {
  UNAUTHENTICATED: "UNAUTHENTICATED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  VALIDATION_FAILED: "VALIDATION_FAILED",
  RATE_LIMITED: "RATE_LIMITED",
  INTERNAL: "INTERNAL",
  /** SQLSTATE 23P01 on `bookings_no_double_booking` — someone else won the race. */
  SLOT_TAKEN: "SLOT_TAKEN",
  /** SQLSTATE 23P01 on `pitch_blocks_no_overlap`. */
  BLOCK_OVERLAP: "BLOCK_OVERLAP",
  /** Minor without granted parental consent attempted a transacting action. */
  CONSENT_REQUIRED: "CONSENT_REQUIRED",
  /** The venue's connected account cannot accept charges yet. */
  VENUE_NOT_PAYABLE: "VENUE_NOT_PAYABLE",
  /** Pitch inactive, or the window falls outside opening hours. */
  PRICE_UNAVAILABLE: "PRICE_UNAVAILABLE",
  /** Client digest did not match the server's recomputation of the canonical payload. */
  DIGEST_MISMATCH: "DIGEST_MISMATCH",
  /** Reporter is not a confirmed participant, or the report window has closed. */
  REPORT_REJECTED: "REPORT_REJECTED",
  /** Consent token unknown, already used, or past `expires_at`. */
  CONSENT_TOKEN_INVALID: "CONSENT_TOKEN_INVALID",
  STRIPE_ERROR: "STRIPE_ERROR",
} as const

export type ApiErrorCode = (typeof API_ERROR_CODES)[keyof typeof API_ERROR_CODES]

export interface ApiError {
  code: string
  message: string
  details?: Json
}

/**
 * The discriminated union EVERY route handler returns. Callers narrow on `ok` — there is no
 * shape where both `data` and `error` are readable, so a forgotten error check is a type error
 * rather than a runtime `undefined`.
 */
export type ApiResponse<T> = { ok: true; data: T } | { ok: false; error: ApiError }

export function isApiOk<T>(response: ApiResponse<T>): response is { ok: true; data: T } {
  return response.ok
}

export function isApiErr<T>(response: ApiResponse<T>): response is { ok: false; error: ApiError } {
  return !response.ok
}

/* ========================================================================== */
/*  9. Request-body schemas                                                   */
/* ========================================================================== */

/*
 * Enum schemas are built from `Constants` in database.ts rather than re-typed here, so a
 * migration that adds an enum value cannot leave the validators behind.
 */
export const appRoleSchema = z.enum(Constants.public.Enums.app_role)
export const matchFormatSchema = z.enum(Constants.public.Enums.match_format)
export const matchStatusSchema = z.enum(Constants.public.Enums.match_status)
export const bookingStatusSchema = z.enum(Constants.public.Enums.booking_status)
export const teamSideSchema = z.enum(TEAM_SIDES)
export const consensusDecisionSchema = z.enum(CONSENSUS_DECISIONS)
export const anomalySourceSchema = z.enum(ANOMALY_SOURCES)
export const profileVisibilitySchema = z.enum(PROFILE_VISIBILITIES)

const uuidSchema = z.string().uuid()
const isoInstantSchema = z.string().datetime({ offset: true })
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
/** Query-string windows may be given as a bare date or a full instant. */
const isoDateOrInstantSchema = z.union([isoInstantSchema, isoDateSchema])
/** Lowercase hex SHA-256. Exactly 64 characters; anything else is not a digest. */
const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/, "expected a lowercase hex SHA-256 digest")
/**
 * Query strings carry no booleans. `Boolean("false")` is `true`, so `z.coerce.boolean()` would
 * turn `?openOnly=false` into `true` — parse the accepted spellings explicitly instead.
 */
const queryBooleanSchema = z
  .enum(["true", "false", "1", "0"])
  .optional()
  .transform((value) => value === "true" || value === "1")

/* --- POST /api/bookings/checkout ----------------------------------------- */

/**
 * The client picks a pitch and a window; it never sends a price. The handler recomputes the
 * quote from `pitches.hourly_rate_minor` before touching Stripe.
 */
export const bookingCheckoutSchema = z
  .object({
    pitchId: uuidSchema,
    startsAt: isoInstantSchema,
    endsAt: isoInstantSchema,
    teamId: uuidSchema.optional(),
    notes: z.string().max(500).optional(),
  })
  .refine((body) => Date.parse(body.endsAt) > Date.parse(body.startsAt), {
    message: "endsAt must be after startsAt",
    path: ["endsAt"],
  })
  .refine(
    (body) => {
      const minutes = (Date.parse(body.endsAt) - Date.parse(body.startsAt)) / 60_000
      return minutes >= 15 && minutes <= 480
    },
    { message: "a booking must be between 15 minutes and 8 hours", path: ["endsAt"] },
  )

export type BookingCheckoutInput = z.infer<typeof bookingCheckoutSchema>

/* --- POST /api/bookings/[id]/cancel --------------------------------------- */

/**
 * `refund_application_fee` and `reverse_transfer` are decided by policy on the server; the
 * caller may only supply a reason.
 */
export const cancelBookingSchema = z.object({
  reason: z.string().min(3).max(500).optional(),
})

export type CancelBookingInput = z.infer<typeof cancelBookingSchema>

/* --- POST /api/matches ---------------------------------------------------- */

export const createMatchSchema = z
  .object({
    bookingId: uuidSchema.optional(),
    pitchId: uuidSchema.optional(),
    venueId: uuidSchema.optional(),
    format: matchFormatSchema.default("seven_a_side"),
    kickoffAt: isoInstantSchema,
    durationMinutes: z.number().int().min(10).max(240).default(60),
    homeTeamId: uuidSchema.optional(),
    awayTeamId: uuidSchema.optional(),
    isRanked: z.boolean().default(true),
    /** Which side auto-enrols the creator. */
    creatorSide: teamSideSchema.default("home"),
  })
  .refine(
    (body) =>
      body.homeTeamId === undefined ||
      body.awayTeamId === undefined ||
      body.homeTeamId !== body.awayTeamId,
    { message: "a team cannot play itself", path: ["awayTeamId"] },
  )

export type CreateMatchInput = z.infer<typeof createMatchSchema>

/* --- POST /api/matches/[id]/report-score ---------------------------------- */

/**
 * `clientReportedAt` is the timestamp the CLIENT asserts. It is stored alongside the server's
 * own `reported_at` and the gap between them is an anomaly feature — it is evidence, never a
 * source of truth.
 */
export const reportScoreSchema = z.object({
  homeScore: z.number().int().min(0).max(99),
  awayScore: z.number().int().min(0).max(99),
  clientReportedAt: isoInstantSchema,
  teamSide: teamSideSchema.optional(),
})

export type ReportScoreInput = z.infer<typeof reportScoreSchema>

/** What the report-score route answers with. */
export interface ReportScoreResult {
  verdict: ScoreVerdict
  variance: number
  reportsCount: number
  requiresConsensus: boolean
}

/* --- POST /api/matches/[id]/consensus ------------------------------------- */

export const consensusApprovalSchema = z.object({
  decision: consensusDecisionSchema,
  clientDigest: sha256HexSchema,
  signature: z.string().min(1).max(1024).optional(),
  signatureAlg: z.string().min(1).max(64).optional(),
})

export type ConsensusApprovalBody = z.infer<typeof consensusApprovalSchema>

/* --- POST /api/matches/[id]/join ------------------------------------------ */

export const joinMatchSchema = z.object({
  /** Omit to let the balancer pick the side that improves match quality. */
  teamSide: teamSideSchema.optional(),
})

export type JoinMatchInput = z.infer<typeof joinMatchSchema>

/* --- POST /api/auth/parental-consent/{request,verify} --------------------- */

export const parentalConsentRequestSchema = z.object({
  guardianEmail: z.string().email().max(254),
  guardianName: z.string().min(2).max(120),
})

export type ParentalConsentRequestInput = z.infer<typeof parentalConsentRequestSchema>

/** The raw token only ever travels guardian-email -> this route. It is never logged. */
export const parentalConsentVerifySchema = z.object({
  token: z.string().min(32).max(512),
})

export type ParentalConsentVerifyInput = z.infer<typeof parentalConsentVerifySchema>

/* --- POST /api/stripe/connect/onboard ------------------------------------- */

/**
 * Kicks off (or resumes) Stripe Connect Express onboarding. Return/refresh paths are
 * same-origin PATHS, never absolute URLs — accepting a caller-supplied absolute URL here would
 * be an open redirect straight out of a payments flow.
 */
export const onboardingSchema = z.object({
  venueId: uuidSchema.optional(),
  country: z.string().regex(/^[A-Z]{2}$/, "expected an ISO 3166-1 alpha-2 code").default("TR"),
  businessType: z.enum(["individual", "company"]).default("individual"),
  email: z.string().email().max(254).optional(),
  returnPath: z.string().regex(/^\/[^/\\]/, "must be a same-origin path").max(512).optional(),
  refreshPath: z.string().regex(/^\/[^/\\]/, "must be a same-origin path").max(512).optional(),
})

export type OnboardingInput = z.infer<typeof onboardingSchema>

/* --- POST /api/pitches, PATCH /api/pitches/[id] --------------------------- */

export const createPitchSchema = z.object({
  venueId: uuidSchema,
  name: z.string().min(1).max(80),
  format: matchFormatSchema.default("seven_a_side"),
  surface: z.enum(Constants.public.Enums.pitch_surface).default("artificial_turf"),
  isIndoor: z.boolean().default(false),
  capacity: z.number().int().min(1).max(60).nullable().optional(),
  hourlyRateMinor: z.number().int().positive(),
  currency: z.string().regex(/^[a-z]{3}$/).default(DEFAULT_CURRENCY),
  openingTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/).default("08:00"),
  closingTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/).default("23:00"),
  slotMinutes: z.number().int().min(15).max(240).default(60),
  isActive: z.boolean().default(true),
})

export type CreatePitchInput = z.infer<typeof createPitchSchema>

export const updatePitchSchema = createPitchSchema.partial().omit({ venueId: true })

export type UpdatePitchInput = z.infer<typeof updatePitchSchema>

/* --- POST /api/pitches/[id]/availability ---------------------------------- */

export const availabilityBlockSchema = z
  .object({
    startsAt: isoInstantSchema,
    endsAt: isoInstantSchema,
    reason: z.string().max(280).optional(),
  })
  .refine((body) => Date.parse(body.endsAt) > Date.parse(body.startsAt), {
    message: "endsAt must be after startsAt",
    path: ["endsAt"],
  })

export type AvailabilityBlockInput = z.infer<typeof availabilityBlockSchema>

/* --- POST /api/gdpr/erase ------------------------------------------------- */

/** Art. 17 is irreversible from the user's point of view; require them to type it out. */
export const gdprErasureSchema = z.object({
  confirmation: z.literal("DELETE MY ACCOUNT"),
})

export type GdprErasureInput = z.infer<typeof gdprErasureSchema>

/* --- POST /api/internal/anomaly/check ------------------------------------- */

/**
 * The sidecar boundary, in both directions. The request schema is what we SEND; the response
 * schema is what we PARSE back — an ML service answering with garbage must degrade to the
 * rule-engine verdict, not poison `match_anomaly_flags`.
 */
export const anomalyFeatureVectorSchema = z.object({
  matchId: z.string().uuid(),
  scoreVariance: z.number(),
  reportingDelaySeconds: z.number(),
  reporterCount: z.number(),
  opposingReportAgreement: z.number(),
  participantOverlapRatio: z.number(),
  historicalReportDeviation: z.number(),
  goalDiff: z.number(),
  kickoffHour: z.number(),
  venueBookingsLast7d: z.number(),
  reporterAccountAgeDays: z.number(),
})

export const anomalyVerdictResponseSchema = z.object({
  matchId: z.string().uuid(),
  anomalyScore: z.number().min(0).max(1),
  isAnomalous: z.boolean(),
  leafDepth: z.number().int().min(0).nullable().default(null),
  averagePathLength: z.number().nullable().default(null),
  modelVersion: z.string().max(64).nullable().default(null),
  threshold: z.number().min(0).max(1),
  reasons: z.array(z.string().max(280)).default([]),
})

export type AnomalyVerdictResponse = z.infer<typeof anomalyVerdictResponseSchema>

/** Body of the internal route that triggers a check for one match. */
export const anomalyCheckRequestSchema = z.object({
  matchId: uuidSchema,
})

export type AnomalyCheckRequestInput = z.infer<typeof anomalyCheckRequestSchema>

/* --- GET /api/matches (query string) -------------------------------------- */

export const matchListQuerySchema = z.object({
  city: z.string().max(80).optional(),
  format: matchFormatSchema.optional(),
  status: matchStatusSchema.optional(),
  from: isoDateOrInstantSchema.optional(),
  to: isoDateOrInstantSchema.optional(),
  openOnly: queryBooleanSchema,
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
})

export type MatchListQuery = z.infer<typeof matchListQuerySchema>

/* --- GET /api/venues/[id]/metrics (query string) -------------------------- */

export const venueMetricsQuerySchema = z.object({
  from: isoDateOrInstantSchema.optional(),
  to: isoDateOrInstantSchema.optional(),
})

export type VenueMetricsQuery = z.infer<typeof venueMetricsQuerySchema>

/* ========================================================================== */
/*  10. Contract assertions                                                   */
/* ========================================================================== */

/**
 * `AnomalyFeatureVector` and `anomalyFeatureVectorSchema` describe the same wire format as the
 * sidecar's pydantic model. If one drifts, this alias stops satisfying `Expect<true>` and the
 * build fails instead of the detector quietly mis-scoring.
 */
export type AssertAnomalyVectorShape = Expect<
  MutuallyAssignable<AnomalyFeatureVector, z.infer<typeof anomalyFeatureVectorSchema>>
>

/** The parsed sidecar response must be a complete `AnomalyVerdict` minus the `source` we stamp. */
export type AssertAnomalyVerdictShape = Expect<
  MutuallyAssignable<Omit<AnomalyVerdict, "source">, AnomalyVerdictResponse>
>

/**
 * `ConsensusApprovalInput` is `consensusApprovalSchema` plus the `matchId` path parameter, so a
 * parsed body is always a valid input once the id is attached. Checked one-directionally
 * because zod infers optional keys as `T | undefined`, which is deliberately not assignable to
 * a bare `key?: T` under `exactOptionalPropertyTypes`.
 */
export type AssertConsensusApprovalShape = Expect<
  Omit<ConsensusApprovalInput, "matchId"> extends ConsensusApprovalBody ? true : false
>
