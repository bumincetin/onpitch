/**
 * lib/stripe.ts
 *
 * The single Stripe client for the whole server, plus the platform-fee arithmetic and the small
 * amount of Connect vocabulary the four `/api/stripe/connect/*` handlers share.
 *
 * ---------------------------------------------------------------------------
 * WHY CONNECT **EXPRESS**, AND WHAT THE PLATFORM IS LIABLE FOR
 * ---------------------------------------------------------------------------
 * OnPitch is a marketplace: players pay, venue owners get paid, and we keep a percentage. That
 * makes every venue owner a *seller of record* whose identity we are legally obliged to verify
 * (KYC), screen (AML/sanctions), and — in most markets — tax-report on. Connect offers three
 * shapes for that obligation:
 *
 *   Standard — the venue owner brings their own full Stripe account. Least platform control:
 *              we cannot set payout schedules, cannot see requirements cleanly, and the owner
 *              can detach at will. Bad fit for an onboarding funnel we want to instrument.
 *   Express  — Stripe hosts the KYC flow end to end. We create an account shell, hand the owner
 *              a single-use Account Link, and Stripe collects name, date of birth, national id,
 *              bank details, and identity documents on Stripe-controlled pages. Stripe runs the
 *              verification and tells us the result through `account.requirements`.  <-- WE USE THIS
 *   Custom   — we build and host the KYC UI ourselves. Maximum control, and with it every
 *              obligation Express externalises.
 *
 * Express is the right trade for an MVP, for four concrete reasons:
 *
 *   • Identity documents never touch our infrastructure. Passport scans, ID numbers, and bank
 *     credentials are collected on `connect.stripe.com`. We never store, log, or transit them,
 *     so they are outside our breach blast radius and outside our GDPR Art. 9 / Art. 32 scope
 *     for that data class entirely.
 *   • PCI scope stays minimal. Card data is likewise never on our origin — the booking flow uses
 *     Stripe Elements / hosted checkout, so we stay in SAQ-A territory rather than SAQ-D.
 *   • AML / sanctions screening is Stripe's, performed against their own programme. We consume a
 *     boolean-ish verdict (`charges_enabled`, `payouts_enabled`, `requirements.*`) and gate the
 *     product on it. We do not make the judgement call, so we do not carry the model risk.
 *   • Payout mechanics — schedules, reversals, negative balances, 1099/e-Fatura style reporting —
 *     are Stripe's rails. We record what happened in `venue_payouts` for the dashboard; we do not
 *     move money ourselves and therefore are not a money transmitter on these flows.
 *
 * What we DO stay liable for:
 *
 *   • **Destination charges make the PLATFORM the merchant of record.** Every booking is created
 *     on OUR account with `transfer_data.destination = acct_...` and `application_fee_amount`.
 *     The charge, the customer relationship, and therefore the *chargeback* are ours. When a
 *     player disputes, the dispute lands on the platform balance, and the platform pays the
 *     dispute fee. Recovering it from the venue requires an explicit transfer reversal — it is
 *     not automatic. Budget for chargeback losses as a platform cost line, not a venue cost line.
 *   • **Refunds come out of the platform balance too.** `refund_application_fee` and
 *     `reverse_transfer` are policy decisions we make per refund; if we refund the customer in
 *     full without reversing the transfer, the venue keeps the money and we eat the difference.
 *   • **The service itself.** Consumer law does not care that Stripe processed the payment: we
 *     sold the booking. Pitch not available, venue closed, double-booked — that is our problem
 *     and the reason `bookings_no_double_booking` is enforced in Postgres rather than in a
 *     hopeful application check.
 *   • **An Account Link is a credential.** Account Links are single-use, short-lived, and
 *     grant whoever holds one the ability to complete KYC for that account. They are never
 *     logged, never emailed, never put in a query string we persist.
 *   • **Onboarding state gates checkout.** A venue may not take money until
 *     `charges_enabled && payouts_enabled`. That gate lives in the database (`venues.is_active`,
 *     `venues.charges_enabled`) and is re-checked at checkout, not just in the dashboard UI.
 */

import Stripe from "stripe"

import type { StripeOnboardingState } from "@onpitch/shared/domain"

/* ========================================================================== */
/*  1. Environment                                                            */
/* ========================================================================== */

/**
 * Fail loudly and early when the server is misconfigured, with a message that names the missing
 * variable but never echoes a key. Call this before any Stripe work you want to blame precisely;
 * the client constructor calls it too, so it is a safety net rather than a required prelude.
 */
export function assertStripeEnv(): void {
  const key = process.env.STRIPE_SECRET_KEY

  if (!key || key.trim().length === 0) {
    throw new Error(
      "STRIPE_SECRET_KEY is not set. Add it to .env.local (server-only, never NEXT_PUBLIC_).",
    )
  }
  if (!/^(sk|rk)_(test|live)_[A-Za-z0-9]+$/.test(key)) {
    throw new Error(
      "STRIPE_SECRET_KEY does not look like a Stripe secret or restricted key " +
        "(expected sk_test_… / sk_live_… / rk_…). Refusing to start the client.",
    )
  }
  if (key.startsWith("pk_")) {
    throw new Error("STRIPE_SECRET_KEY holds a PUBLISHABLE key. Use the secret key.")
  }
}

/** True when the configured key is a live-mode key. Used to harden a few dev-only affordances. */
export function isLiveMode(): boolean {
  return (process.env.STRIPE_SECRET_KEY ?? "").includes("_live_")
}

/* ========================================================================== */
/*  2. The lazily-instantiated singleton                                      */
/* ========================================================================== */

/**
 * Next.js evaluates route modules at build time (collecting page data) where `STRIPE_SECRET_KEY`
 * is frequently absent. Constructing the client at module scope would turn a missing env var into
 * a *build* failure in every file that transitively imports this one. So the real client is built
 * on first property access and cached for the lifetime of the server process (and across HMR
 * reloads in dev, via a global slot, so we do not leak a socket pool per edit).
 */
declare global {
  // eslint-disable-next-line no-var
  var __onpitchStripe__: Stripe | undefined
}

function createStripeClient(): Stripe {
  if (typeof window !== "undefined") {
    throw new Error(
      "lib/stripe.ts is server-only — importing it into a Client Component would ship the " +
        "secret key to the browser.",
    )
  }

  assertStripeEnv()

  return new Stripe(process.env.STRIPE_SECRET_KEY as string, {
    // NOTE ON `apiVersion`: deliberately omitted so stripe-node uses the version its own
    // TypeScript definitions were generated against. Pinning a version that disagrees with the
    // installed types is how you get silently-wrong field access. When you are ready to pin
    // explicitly (recommended before going live, so a Stripe-side version bump cannot change
    // response shapes under you), upgrade the SDK and add the matching literal here:
    //     apiVersion: "2025-01-27.acacia",
    // The literal must equal `Stripe.LatestApiVersion` for the installed package, or TS will
    // reject it, which is the guard rail you want.
    typescript: true,
    appInfo: { name: "OnPitch" },
    // Stripe's own guidance: retries are safe because every mutating call below either is
    // naturally idempotent or carries an explicit idempotency key.
    maxNetworkRetries: 2,
  })
}

function getStripeClient(): Stripe {
  if (!globalThis.__onpitchStripe__) {
    globalThis.__onpitchStripe__ = createStripeClient()
  }
  return globalThis.__onpitchStripe__
}

/**
 * The shared client. Typed as a plain `Stripe` so call sites read normally (`stripe.accounts
 * .create(...)`), but backed by a proxy that defers construction until the first property read.
 */
export const stripe: Stripe = new Proxy({} as Stripe, {
  get(_target, property, _receiver) {
    const client = getStripeClient() as unknown as Record<string | symbol, unknown>
    const value = Reflect.get(client, property, client)
    // Bind methods to the real client so `this` survives destructuring at the call site.
    return typeof value === "function" ? (value as (...args: never[]) => unknown).bind(client) : value
  },
  set(_target, property, value) {
    return Reflect.set(getStripeClient() as unknown as object, property, value)
  },
  has(_target, property) {
    return Reflect.has(getStripeClient() as unknown as object, property)
  },
  ownKeys() {
    return Reflect.ownKeys(getStripeClient() as unknown as object)
  },
  getOwnPropertyDescriptor(_target, property) {
    const descriptor = Reflect.getOwnPropertyDescriptor(
      getStripeClient() as unknown as object,
      property,
    )
    // A proxy may only report a non-configurable property if the target has one; the target here
    // is an empty object, so force `configurable` to keep the invariant satisfied.
    return descriptor ? { ...descriptor, configurable: true } : undefined
  },
  getPrototypeOf() {
    return Reflect.getPrototypeOf(getStripeClient() as unknown as object)
  },
})

/* ========================================================================== */
/*  3. Platform fee arithmetic                                                */
/* ========================================================================== */

function readIntEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === "") return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < min || parsed > max) {
    // A typo'd fee must not silently become a 0% or a 100% take rate.
    throw new Error(`${name} must be an integer in [${min}, ${max}], received "${raw}".`)
  }
  return parsed
}

/**
 * The platform's take rate in **basis points** (1 bp = 0.01%). `1000` = 10%.
 *
 * Basis points rather than a float percentage so the rate itself is exact: `0.1` is not
 * representable in binary floating point, `1000` is.
 */
export const PLATFORM_FEE_BPS: number = readIntEnv("PLATFORM_FEE_BPS", 1000, 0, 10_000)

/**
 * Absolute floor on the fee, in minor units. Below some threshold the fee is worth less than the
 * processing it triggers, so a marketplace normally sets a small minimum. Default 0 = no floor.
 */
export const PLATFORM_FEE_MIN_MINOR: number = readIntEnv(
  "PLATFORM_FEE_MIN_MINOR",
  0,
  0,
  Number.MAX_SAFE_INTEGER,
)

/**
 * Absolute ceiling on the fee, in minor units — keeps a very large booking from producing an
 * eye-watering commission. Default: effectively unbounded (the per-charge cap below still holds).
 */
export const PLATFORM_FEE_MAX_MINOR: number = readIntEnv(
  "PLATFORM_FEE_MAX_MINOR",
  Number.MAX_SAFE_INTEGER,
  0,
  Number.MAX_SAFE_INTEGER,
)

/**
 * The `application_fee_amount` for a charge of `amountMinor`, in the same minor units.
 *
 * Integer math throughout: `amountMinor * bps` is an exact integer product well inside
 * `Number.MAX_SAFE_INTEGER` for any plausible booking (a 1,000,000.00 TRY booking at 100% is
 * 10^12), and the single `Math.round` is the only place a fraction can appear. Doing this as
 * `amount * 0.1` would drift — `4999 * 0.1` is `499.90000000000003`.
 *
 * Then two clamps, in this order:
 *   1. floor/ceiling from `PLATFORM_FEE_MIN_MINOR` / `PLATFORM_FEE_MAX_MINOR`;
 *   2. a hard cap at `amountMinor` itself, because Stripe rejects an application fee larger than
 *      the charge and `bookings_fee_within_total_check` rejects it in Postgres too.
 *
 * A zero charge always yields a zero fee (the floor cannot manufacture money out of nothing).
 */
export function calculatePlatformFee(
  amountMinor: number,
  bps: number = PLATFORM_FEE_BPS,
): number {
  if (!Number.isFinite(amountMinor) || !Number.isInteger(amountMinor)) {
    throw new TypeError(
      `calculatePlatformFee expects an integer amount in minor units, received ${String(amountMinor)}`,
    )
  }
  if (amountMinor < 0) {
    throw new RangeError("calculatePlatformFee expects a non-negative amount")
  }
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    throw new RangeError(`Platform fee basis points must be an integer in [0, 10000], got ${bps}`)
  }
  if (amountMinor === 0) return 0

  const proportional = Math.round((amountMinor * bps) / 10_000)
  const floored = Math.max(proportional, PLATFORM_FEE_MIN_MINOR)
  const ceilinged = Math.min(floored, PLATFORM_FEE_MAX_MINOR)
  return Math.min(ceilinged, amountMinor)
}

/* ========================================================================== */
/*  4. Origins and Connect redirect targets                                   */
/* ========================================================================== */

/** Where Stripe sends the owner back when an Account Link expires or is abandoned. */
export const CONNECT_REFRESH_PATH = "/api/stripe/connect/refresh"

/** Where Stripe sends the owner after they finish (or bail out of) the hosted KYC flow. */
export const CONNECT_RETURN_PATH = "/venue/onboarding/complete"

/** Human-facing page the refresh handler falls back to when it cannot mint a link. */
export const CONNECT_ONBOARDING_PATH = "/venue/onboarding"

/**
 * The canonical public origin of this deployment.
 *
 * Derived from configuration, never from the request's `Host` header. Building Stripe
 * `return_url` / `refresh_url` from an attacker-controllable header is a textbook host-header
 * injection: it would let someone hand a venue owner a link that completes KYC and then bounces
 * them to a look-alike origin holding a live session.
 */
/**
 * Both moved to `lib/site-url.ts` so the metadata routes (`robots.ts`, `sitemap.ts`,
 * `manifest.ts`) can name the site's origin without importing the Stripe SDK. Re-exported here
 * because every existing caller in the Connect handlers imports them from this module, and there
 * is no reason to churn those call sites over a file move.
 */
export { resolveSiteOrigin, buildSiteUrl } from "@/lib/site-url"

/**
 * Stripe rejects `business_profile.url` values it cannot reach, and every local dev origin is
 * unreachable. Send the URL only when it is plausibly public.
 */
export function isPubliclyReachableOrigin(origin: string): boolean {
  try {
    const { protocol, hostname } = new URL(origin)
    if (protocol !== "https:") return false
    if (hostname === "localhost" || hostname.endsWith(".local")) return false
    if (/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(hostname)) return false
    return hostname.includes(".")
  } catch {
    return false
  }
}

/* ========================================================================== */
/*  5. Connect Express helpers                                                */
/* ========================================================================== */

/**
 * Merchant category code. `7941` — "Commercial Sports, Athletic Fields, Professional Sports
 * Clubs and Sport Promoters" — is the closest fit for hiring out a football pitch by the hour.
 * Stripe uses it for risk scoring and card-network reporting; a wrong MCC can slow verification.
 */
export const ONPITCH_MCC = "7941"

/**
 * Idempotency key for connected-account creation, derived purely from the Supabase user id.
 *
 * Two concurrent POSTs to `/onboard` from the same owner replay one `POST /v1/accounts`, so a
 * double-clicked button cannot produce two connected accounts (and therefore two half-finished
 * KYC files) for one person. Stripe retains idempotency keys for 24 hours, which
 * comfortably covers a stuck button; the persisted `stripe_account_id` covers everything after.
 *
 * NOTE: deliberately NOT used for Account Links. Those are single-use and short-lived — replaying
 * a key there would hand the owner an already-consumed or already-expired link.
 */
export function connectAccountIdempotencyKey(userId: string, scope = "default"): string {
  // `scope` is normally the venue id. It exists because Stripe rejects a replayed key whose
  // PARAMETERS differ, and account-create parameters embed the venue (name, country, metadata).
  // Scoping keeps the double-click guarantee exact while avoiding a spurious idempotency error
  // if the same owner ever onboards a second venue inside the 24h key window.
  return `onpitch:connect:account:${userId}:${scope}`
}

/**
 * Fold a `Stripe.Account` into the shape the dashboard renders.
 *
 * `requirements.currently_due` is the actionable list ("do this now or you stop being paid"),
 * `past_due` is the already-missed subset, `eventually_due` is the horizon, and
 * `pending_verification` is what Stripe is actively reviewing — a venue sitting in
 * `pending_verification` with an empty `currently_due` is waiting on Stripe, not on us, and the
 * UI must say so instead of nagging.
 */
export function toOnboardingState(account: Stripe.Account): StripeOnboardingState {
  const requirements = account.requirements
  const chargesEnabled = account.charges_enabled === true
  const payoutsEnabled = account.payouts_enabled === true

  return {
    accountId: account.id,
    chargesEnabled,
    payoutsEnabled,
    detailsSubmitted: account.details_submitted === true,
    disabledReason: requirements?.disabled_reason ?? null,
    currentlyDue: requirements?.currently_due ?? [],
    eventuallyDue: requirements?.eventually_due ?? [],
    pastDue: requirements?.past_due ?? [],
    pendingVerification: requirements?.pending_verification ?? [],
    isComplete: chargesEnabled && payoutsEnabled,
  }
}

/** The state to report when an owner has not started onboarding at all. */
export function emptyOnboardingState(): StripeOnboardingState {
  return {
    accountId: null,
    chargesEnabled: false,
    payoutsEnabled: false,
    detailsSubmitted: false,
    disabledReason: null,
    currentlyDue: [],
    eventuallyDue: [],
    pastDue: [],
    pendingVerification: [],
    isComplete: false,
  }
}

/* ========================================================================== */
/*  6. Error triage                                                           */
/* ========================================================================== */

/** Narrow an unknown to a stripe-node error without `instanceof` across bundler realms. */
export function isStripeError(error: unknown): error is Stripe.errors.StripeError {
  if (typeof error !== "object" || error === null) return false
  const type = (error as { type?: unknown }).type
  return typeof type === "string" && type.startsWith("Stripe")
}

/**
 * True when Stripe says the object is not there — an account deleted from the dashboard,
 * or a stale id from a wiped test-mode project. That is recoverable (mint a new account); every
 * other Stripe failure is not, and must surface as `STRIPE_ERROR`.
 */
export function isResourceMissing(error: unknown): boolean {
  return isStripeError(error) && (error.code === "resource_missing" || error.statusCode === 404)
}

/**
 * A redacted, log-safe view of a Stripe failure.
 *
 * `requestId` is the field that actually matters in a support ticket. `message` is included
 * because this object goes to the SERVER log only — never inline it into an HTTP response; the
 * route handlers return the stable `STRIPE_ERROR` code instead.
 */
export function describeStripeError(error: unknown): Record<string, unknown> {
  if (!isStripeError(error)) {
    return { kind: "non-stripe", message: error instanceof Error ? error.message : String(error) }
  }
  return {
    kind: "stripe",
    type: error.type,
    code: error.code,
    statusCode: error.statusCode,
    requestId: error.requestId,
    param: (error as { param?: unknown }).param,
    message: error.message,
  }
}
