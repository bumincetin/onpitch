/**
 * lib/env.ts
 *
 * One schema for the process environment, and one moment at which a bad deploy is allowed to
 * fail: boot.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * Before this module, every consumer read `process.env.X` where it needed it and coped with a
 * missing value in its own way — a throw at import in `lib/stripe.ts`, a silent `?? default` in
 * `lib/booking/availability.ts`, an `if (!token) return 503` in the internal routes. That is
 * three different failure modes for the same class of mistake, and the worst of them is the
 * silent one: a deploy with `STRIPE_WEBHOOK_SECRET` missing starts, serves, takes a booking, and
 * only fails when Stripe posts the first event — by which time a customer has been charged and
 * the booking is stuck in `pending`.
 *
 * `assertServerEnv()` is called from `instrumentation.ts`, which Next runs once per server
 * process before the first request.
 *
 * MEASURED BEHAVIOUR, because the obvious assumption is wrong. `next build` does NOT run the
 * instrumentation hook — a build with an invalid environment succeeds. `next start` does, and
 * when it throws, the process still binds the port and still logs "Ready" (Next prints that
 * before the hook resolves), and then answers **500 to every request** with the validation
 * error in the log.
 *
 * So the guarantee is "no request is ever served incorrectly", not "the process refuses to
 * start". That distinction decides how the deployment must be health-checked: a TCP check sees
 * an open port and calls it healthy, so the check has to be an HTTP one. docs/PRODUCTION.md
 * section 1a says the same thing where an operator will look for it.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS SPLIT IN TWO
 * ---------------------------------------------------------------------------
 * `NEXT_PUBLIC_*` is inlined into the browser bundle at build time; nothing else is. In the
 * browser every other key is `undefined`, so one flat schema would fail on every client render.
 * Hence `publicEnv` (safe anywhere) and `serverEnv()` (throws if called in the browser, which is
 * itself a useful guard — reaching it from a Client Component is the bug that leaks a secret).
 *
 * The literal `process.env.NEXT_PUBLIC_FOO` spellings below are deliberate and must stay that
 * way. Next's inliner is a *textual* substitution: `process.env[key]` compiles to a runtime
 * lookup against an object that does not exist in the browser, and reads as `undefined`.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT VALIDATED
 * ---------------------------------------------------------------------------
 * `DATABASE_URL` / `DIRECT_URL` — the Next app never opens a Postgres connection; it talks to
 * PostgREST. Requiring them here would fail a perfectly good web deploy over a migration-tool
 * setting. They are validated by the tools that use them.
 */

import { z } from "zod"

/* ========================================================================== */
/*  Small shared refinements                                                  */
/* ========================================================================== */

/** No trailing slash, absolute, http(s) only. Everything that builds a redirect URL assumes it. */
const origin = z
  .string()
  .url()
  .refine((v) => v.startsWith("http://") || v.startsWith("https://"), {
    message: "must be an http(s) URL",
  })
  .refine((v) => !v.endsWith("/"), { message: "must not end with a slash" })

/** A secret long enough to be worth having. 32 hex characters is what the template generates. */
const secret = (min = 32) =>
  z.string().min(min, { message: `must be at least ${min} characters` })

/** `"1000"` -> 1000, with the range enforced rather than clamped silently. */
const intInRange = (min: number, max: number) =>
  z
    .string()
    .regex(/^-?\d+$/, { message: "must be a whole number" })
    .transform(Number)
    .refine((n) => n >= min && n <= max, { message: `must be between ${min} and ${max}` })

/* ========================================================================== */
/*  Public — inlined into the browser bundle                                  */
/* ========================================================================== */

const publicSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(20),
  // Optional: the app renders and books nothing without it, but a preview deploy with payments
  // switched off is a legitimate configuration and should not fail to build.
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: z.string().startsWith("pk_").optional(),
  NEXT_PUBLIC_SITE_URL: origin.optional(),
})

export type PublicEnv = z.infer<typeof publicSchema>

/**
 * Parsed public configuration. Read this instead of `process.env` in shared code so a typo is a
 * type error rather than an `undefined` that reaches a URL.
 */
export const publicEnv: PublicEnv = (() => {
  const parsed = publicSchema.safeParse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY,
    NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
  })
  if (!parsed.success) throw new Error(formatIssues("public environment", parsed.error))
  return parsed.data
})()

/* ========================================================================== */
/*  Server — never sent to the browser                                        */
/* ========================================================================== */

const serverObjectSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

    /* --- Supabase ------------------------------------------------------- */
    // Bypasses RLS. Only lib/supabase/admin.ts may read it.
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),

    /* --- Stripe --------------------------------------------------------- */
    STRIPE_SECRET_KEY: z.string().startsWith("sk_").optional(),
    STRIPE_WEBHOOK_SECRET: z.string().startsWith("whsec_").optional(),
    STRIPE_CONNECT_WEBHOOK_SECRET: z.string().startsWith("whsec_").optional(),
    PLATFORM_FEE_BPS: intInRange(0, 10_000).optional(),
    PLATFORM_FEE_MIN_MINOR: intInRange(0, 100_000_000).optional(),
    PLATFORM_FEE_MAX_MINOR: intInRange(0, 100_000_000).optional(),

    /* --- Booking rules -------------------------------------------------- */
    BOOKING_RESERVATION_TTL_MINUTES: intInRange(10, 1440).optional(),
    BOOKING_CANCELLATION_WINDOW_HOURS: intInRange(0, 720).optional(),
    BOOKING_LATE_CANCELLATION_REFUND_BPS: intInRange(0, 10_000).optional(),

    /* --- Internal m2m --------------------------------------------------- */
    INTERNAL_API_TOKEN: secret().optional(),
    ANOMALY_SERVICE_URL: z.string().url().optional(),
    ANOMALY_SERVICE_SECRET: secret().optional(),

    /* --- Email ---------------------------------------------------------- */
    RESEND_API_KEY: z.string().startsWith("re_").optional(),
    RESEND_FROM_EMAIL: z.string().optional(),
    EMAIL_FROM: z.string().optional(),
    SMTP_URL: z.string().optional(),

    /* --- Origin and CORS ------------------------------------------------ */
    VERCEL_URL: z.string().optional(),
    MOBILE_ALLOWED_ORIGINS: z.string().optional(),
  })

/**
 * The shape above, for `z.infer`. The cross-field rules live in `crossFieldIssues()` rather than
 * in a `.superRefine()` on this schema, and that is not a style choice:
 *
 * Zod SHORT-CIRCUITS. A refinement attached to an object is skipped entirely when the object's
 * own shape fails to parse. Attached here, the rules would run only for a configuration that is
 * already field-by-field valid — so a deploy missing `SUPABASE_SERVICE_ROLE_KEY` *and* carrying
 * a half-configured anomaly sidecar would be told about the first, restarted, and only then
 * discover the second. That is precisely the one-restart-at-a-time loop this module exists to
 * prevent, so the rules read the RAW environment and always run.
 */
const serverSchema = serverObjectSchema

/** A problem found by looking at more than one variable at once. */
interface CrossFieldIssue {
  path: string
  message: string
}

/** `"1000"` -> 1000, or null for anything that is not a whole number. */
function asInteger(value: string | undefined): number | null {
  if (value === undefined || !/^-?\d+$/.test(value)) return null
  return Number(value)
}

/**
 * Cross-field rules, read straight off `process.env`.
 *
 * Each one is a configuration that parses fine key by key and is still wrong as a whole, and
 * each names the production failure it prevents — because in six months the rule will look
 * arbitrary and somebody will be tempted to delete it.
 */
function crossFieldIssues(raw: NodeJS.ProcessEnv): CrossFieldIssue[] {
  const issues: CrossFieldIssue[] = []
  const add = (path: string, message: string) => issues.push({ path, message })

  const nodeEnv = raw.NODE_ENV ?? "development"
  const isProduction = nodeEnv === "production"

  const secretKey = raw.STRIPE_SECRET_KEY
  const webhookSecret = raw.STRIPE_WEBHOOK_SECRET
  const connectSecret = raw.STRIPE_CONNECT_WEBHOOK_SECRET
  const publishable = raw.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
  const siteUrl = raw.NEXT_PUBLIC_SITE_URL

  // Stripe is all-or-nothing. A secret key with no webhook secret takes the customer's money and
  // then silently drops `payment_intent.succeeded`, leaving the booking `pending` and the slot
  // held until the sweeper releases it — money in, no booking.
  if (secretKey && !webhookSecret) {
    add(
      "STRIPE_WEBHOOK_SECRET",
      "required whenever STRIPE_SECRET_KEY is set — without it every payment webhook fails " +
        "signature verification and bookings never leave `pending`",
    )
  }

  // Stripe issues a DIFFERENT secret for the Connect endpoint. Reusing the platform one makes
  // every account.updated event fail, so an owner who finishes KYC never becomes payable.
  if (connectSecret && connectSecret === webhookSecret) {
    add(
      "STRIPE_CONNECT_WEBHOOK_SECRET",
      "must differ from STRIPE_WEBHOOK_SECRET — Stripe signs the connect endpoint with its own " +
        "secret, and reusing the platform one rejects every connect event",
    )
  }

  const feeMin = asInteger(raw.PLATFORM_FEE_MIN_MINOR)
  const feeMax = asInteger(raw.PLATFORM_FEE_MAX_MINOR)
  if (feeMin !== null && feeMax !== null && feeMin > feeMax) {
    add("PLATFORM_FEE_MIN_MINOR", "cannot exceed PLATFORM_FEE_MAX_MINOR")
  }

  // The anomaly sidecar needs both halves or neither; a URL with no shared key means every
  // request comes back 401 and every score silently falls back to the rule engine.
  if (Boolean(raw.ANOMALY_SERVICE_URL) !== Boolean(raw.ANOMALY_SERVICE_SECRET)) {
    add(
      "ANOMALY_SERVICE_SECRET",
      "ANOMALY_SERVICE_URL and ANOMALY_SERVICE_SECRET must be set together, or neither",
    )
  }

  if (!isProduction) return issues

  /* --- production-only requirements ------------------------------------- */

  // Every Stripe return_url, auth redirect and consent link is built from this. Stripe rejects a
  // localhost return_url on a live account, and a host-header fallback is injectable.
  if (!siteUrl && !raw.VERCEL_URL) {
    add(
      "NEXT_PUBLIC_SITE_URL",
      "required in production (or VERCEL_URL) — redirect URLs cannot be guessed safely",
    )
  }
  if (siteUrl?.startsWith("http://")) {
    add(
      "NEXT_PUBLIC_SITE_URL",
      "must be https in production — auth cookies are Secure and will not be sent",
    )
  }

  // Test keys in production is the mistake that looks like it works: the flow completes, the
  // dashboard shows payments, and no money ever moves.
  if (secretKey?.startsWith("sk_test_")) {
    add("STRIPE_SECRET_KEY", "is a TEST key in a production build")
  }
  if (publishable?.startsWith("pk_test_")) {
    add("NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY", "is a TEST key in a production build")
  }
  // Live and test keys from different modes authenticate fine and then disagree about every
  // object id they are handed.
  if (secretKey && publishable && secretKey.startsWith("sk_live_") !== publishable.startsWith("pk_live_")) {
    add("STRIPE_SECRET_KEY", "live/test mode does not match NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY")
  }

  // Unset, `/api/internal/*` answers 503 to everyone — including pg_cron, which is what expires
  // held reservations. Slots would stay locked by abandoned checkouts indefinitely.
  if (!raw.INTERNAL_API_TOKEN) {
    add(
      "INTERNAL_API_TOKEN",
      "required in production — without it the reservation sweeper cannot run and abandoned " +
        "checkouts hold their slots forever",
    )
  }

  // With no transport, `lib/gdpr.ts` withholds the consent link from the log in production, so
  // an under-16 signup becomes unrecoverable: nobody can ever approve the account.
  if (!raw.RESEND_API_KEY) {
    add(
      "RESEND_API_KEY",
      "required in production — parental-consent emails (GDPR Art. 8) have no other working " +
        "transport, and the link is not logged in production",
    )
  }

  // SMTP_URL selects a transport that is a documented stub. Setting it in production means every
  // consent email reports delivered:false.
  if (raw.SMTP_URL && raw.SMTP_URL.length > 0 && !raw.RESEND_API_KEY) {
    add("SMTP_URL", "selects a stub transport that never delivers; set RESEND_API_KEY instead")
  }

  return issues
}

export type ServerEnv = z.infer<typeof serverSchema>

let cached: ServerEnv | null = null

/**
 * Parsed server configuration. Throws in the browser — reaching this from a Client Component is
 * the bug that would put `SUPABASE_SERVICE_ROLE_KEY` in a bundle.
 */
export function serverEnv(): ServerEnv {
  if (typeof window !== "undefined") {
    throw new Error("serverEnv() was called in the browser. Server configuration is not available there.")
  }
  if (cached) return cached

  const parsed = serverSchema.safeParse(process.env)
  const problems = [
    ...(parsed.success
      ? []
      : parsed.error.issues.map((issue) => ({
          path: issue.path.join(".") || "(root)",
          message: issue.message,
        }))),
    ...crossFieldIssues(process.env),
  ]

  if (problems.length > 0) throw new Error(formatProblems("server environment", problems))

  // Unreachable when `problems` is empty: the only way the parse fails is by producing issues.
  cached = (parsed as { success: true; data: ServerEnv }).data
  return cached
}

/**
 * Called once per server process from `instrumentation.ts`. Parses both halves and throws with
 * every problem listed at once — one restart per deploy, not one per missing key.
 *
 * See the module header for what "throws" actually does to a running server: it does not exit
 * the process, it makes every request answer 500.
 */
export function assertServerEnv(): void {
  serverEnv()
}

/* ========================================================================== */
/*  Error formatting                                                          */
/* ========================================================================== */

/**
 * Every issue in one message, keyed by variable name, with NO value echoed. A validation error
 * that prints the offending value writes the service-role key into the deploy log of the very
 * build that failed to start.
 */
function formatIssues(label: string, error: z.ZodError): string {
  return formatProblems(
    label,
    error.issues.map((issue) => ({
      path: issue.path.join(".") || "(root)",
      message: issue.message,
    })),
  )
}

function formatProblems(label: string, problems: CrossFieldIssue[]): string {
  const lines = problems.map((problem) => `  ${problem.path}: ${problem.message}`)
  const unique = [...new Set(lines)].sort()
  return (
    `Invalid ${label} — ${unique.length} problem${unique.length === 1 ? "" : "s"}:\n` +
    `${unique.join("\n")}\n\n` +
    `See .env.example for what each variable is for.`
  )
}
