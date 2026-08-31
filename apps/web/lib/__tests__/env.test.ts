import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * `lib/env.ts` decides whether a bad deploy dies at boot or serves traffic it cannot honour, and
 * every rule in it encodes a specific production failure somebody would otherwise have to
 * diagnose live. Each test below names that failure.
 *
 * The module reads `process.env` at import — `publicEnv` at module scope, `serverEnv()` once and
 * then cached — so every scenario resets the module registry and re-imports. `loadEnv()` does
 * both and returns the fresh module.
 */

const BASE = {
  NEXT_PUBLIC_SUPABASE_URL: "https://abcdefgh.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.anon-key-long-enough",
  SUPABASE_SERVICE_ROLE_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.service-role-key",
} as const

/** Every key this module looks at, so one test cannot leak configuration into the next. */
const MANAGED = [
  "NODE_ENV",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY",
  "NEXT_PUBLIC_SITE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_CONNECT_WEBHOOK_SECRET",
  "PLATFORM_FEE_BPS",
  "PLATFORM_FEE_MIN_MINOR",
  "PLATFORM_FEE_MAX_MINOR",
  "BOOKING_RESERVATION_TTL_MINUTES",
  "BOOKING_CANCELLATION_WINDOW_HOURS",
  "BOOKING_LATE_CANCELLATION_REFUND_BPS",
  "INTERNAL_API_TOKEN",
  "ANOMALY_SERVICE_URL",
  "ANOMALY_SERVICE_SECRET",
  "RESEND_API_KEY",
  "RESEND_FROM_EMAIL",
  "EMAIL_FROM",
  "SMTP_URL",
  "VERCEL_URL",
  "MOBILE_ALLOWED_ORIGINS",
] as const

let saved: Record<string, string | undefined>

/**
 * Next's ambient types declare `process.env.NODE_ENV` readonly, which is right for application
 * code and wrong for a test whose whole subject is what happens under a different NODE_ENV.
 * This is the one place that distinction has to be set aside.
 */
const mutableEnv = process.env as Record<string, string | undefined>

beforeEach(() => {
  saved = Object.fromEntries(MANAGED.map((k) => [k, mutableEnv[k]]))
  for (const key of MANAGED) delete mutableEnv[key]
  Object.assign(mutableEnv, BASE)
  vi.resetModules()
})

afterEach(() => {
  for (const key of MANAGED) {
    if (saved[key] === undefined) delete mutableEnv[key]
    else mutableEnv[key] = saved[key]
  }
  vi.resetModules()
})

async function loadEnv() {
  vi.resetModules()
  return await import("../env")
}

/** Import and call `serverEnv()`, returning the thrown message or null if it parsed. */
async function failureFor(overrides: Record<string, string | undefined>): Promise<string | null> {
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete mutableEnv[key]
    else mutableEnv[key] = value
  }
  try {
    const { serverEnv } = await loadEnv()
    serverEnv()
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/* ========================================================================== */

describe("the minimum viable configuration", () => {
  it("parses with only Supabase configured", async () => {
    const { serverEnv, publicEnv } = await loadEnv()
    expect(() => serverEnv()).not.toThrow()
    expect(publicEnv.NEXT_PUBLIC_SUPABASE_URL).toBe(BASE.NEXT_PUBLIC_SUPABASE_URL)
  })

  it("caches, so a hot path calling serverEnv() does not re-parse every request", async () => {
    const { serverEnv } = await loadEnv()
    expect(serverEnv()).toBe(serverEnv())
  })

  it("coerces the numeric variables rather than leaving them as strings", async () => {
    mutableEnv.PLATFORM_FEE_BPS = "1000"
    mutableEnv.BOOKING_RESERVATION_TTL_MINUTES = "30"
    const { serverEnv } = await loadEnv()
    const env = serverEnv()
    expect(env.PLATFORM_FEE_BPS).toBe(1000)
    expect(env.BOOKING_RESERVATION_TTL_MINUTES).toBe(30)
  })
})

describe("required in every environment", () => {
  it("refuses a missing service-role key", async () => {
    const message = await failureFor({ SUPABASE_SERVICE_ROLE_KEY: undefined })
    expect(message).toContain("SUPABASE_SERVICE_ROLE_KEY")
  })

  it("refuses a Supabase URL that is not a URL", async () => {
    mutableEnv.NEXT_PUBLIC_SUPABASE_URL = "abcdefgh.supabase.co"
    await expect(loadEnv()).rejects.toThrow(/NEXT_PUBLIC_SUPABASE_URL/)
  })

  it("refuses a site URL with a trailing slash, which doubles the slash in every redirect", async () => {
    mutableEnv.NEXT_PUBLIC_SITE_URL = "https://halisaha.example/"
    await expect(loadEnv()).rejects.toThrow(/NEXT_PUBLIC_SITE_URL/)
  })

  it("reports every problem at once, so a deploy is not fixed one restart at a time", async () => {
    const message = await failureFor({
      SUPABASE_SERVICE_ROLE_KEY: undefined,
      ANOMALY_SERVICE_URL: "https://anomaly.internal",
      // ANOMALY_SERVICE_SECRET deliberately absent — that is the second problem.
    })
    expect(message).toContain("SUPABASE_SERVICE_ROLE_KEY")
    expect(message).toContain("ANOMALY_SERVICE_SECRET")
    expect(message).toMatch(/2 problems/)
  })

  it("never echoes a value into the error, which would put it in the deploy log", async () => {
    const message = await failureFor({
      SUPABASE_SERVICE_ROLE_KEY: "short", // fails min length
      INTERNAL_API_TOKEN: "also-far-too-short-to-be-a-token",
    })
    expect(message).not.toContain("short")
    expect(message).toContain("SUPABASE_SERVICE_ROLE_KEY")
  })
})

describe("Stripe is all-or-nothing", () => {
  it("refuses a secret key with no webhook secret — the case that takes money and loses the booking", async () => {
    const message = await failureFor({ STRIPE_SECRET_KEY: "sk_test_abc123" })
    expect(message).toContain("STRIPE_WEBHOOK_SECRET")
  })

  it("accepts a secret key WITH a webhook secret", async () => {
    expect(
      await failureFor({
        STRIPE_SECRET_KEY: "sk_test_abc123",
        STRIPE_WEBHOOK_SECRET: "whsec_platform",
      }),
    ).toBeNull()
  })

  it("refuses the platform secret reused for the connect endpoint", async () => {
    // Stripe signs the connect endpoint with a different secret. Reusing this one makes every
    // account.updated event fail, so an owner who finishes KYC never becomes payable.
    const message = await failureFor({
      STRIPE_SECRET_KEY: "sk_test_abc123",
      STRIPE_WEBHOOK_SECRET: "whsec_same",
      STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_same",
    })
    expect(message).toContain("STRIPE_CONNECT_WEBHOOK_SECRET")
  })

  it("refuses a fee floor above the ceiling", async () => {
    const message = await failureFor({
      PLATFORM_FEE_MIN_MINOR: "5000",
      PLATFORM_FEE_MAX_MINOR: "1000",
    })
    expect(message).toContain("PLATFORM_FEE_MIN_MINOR")
  })

  it("refuses a fee outside 0-10000 basis points", async () => {
    expect(await failureFor({ PLATFORM_FEE_BPS: "10001" })).toContain("PLATFORM_FEE_BPS")
    expect(await failureFor({ PLATFORM_FEE_BPS: "-1" })).toContain("PLATFORM_FEE_BPS")
    expect(await failureFor({ PLATFORM_FEE_BPS: "10.5" })).toContain("PLATFORM_FEE_BPS")
    expect(await failureFor({ PLATFORM_FEE_BPS: "10000" })).toBeNull()
  })
})

describe("the anomaly sidecar needs both halves", () => {
  it("refuses a URL with no shared secret, which would 401 every request silently", async () => {
    expect(await failureFor({ ANOMALY_SERVICE_URL: "https://anomaly.internal" })).toContain(
      "ANOMALY_SERVICE_SECRET",
    )
  })

  it("refuses a secret with no URL", async () => {
    expect(
      await failureFor({ ANOMALY_SERVICE_SECRET: "0".repeat(64) }),
    ).toContain("ANOMALY_SERVICE_SECRET")
  })

  it("accepts both, and accepts neither", async () => {
    expect(
      await failureFor({
        ANOMALY_SERVICE_URL: "https://anomaly.internal",
        ANOMALY_SERVICE_SECRET: "0".repeat(64),
      }),
    ).toBeNull()
    expect(await failureFor({})).toBeNull()
  })
})

describe("production-only rules", () => {
  const production = { NODE_ENV: "production" } as const

  it("requires a site origin, because a redirect URL cannot be guessed safely", async () => {
    const message = await failureFor({ ...production, INTERNAL_API_TOKEN: "0".repeat(64), RESEND_API_KEY: "re_x" })
    expect(message).toContain("NEXT_PUBLIC_SITE_URL")
  })

  it("requires https, because the auth cookies are Secure and would never be sent", async () => {
    const message = await failureFor({
      ...production,
      NEXT_PUBLIC_SITE_URL: "http://halisaha.example",
      INTERNAL_API_TOKEN: "0".repeat(64),
      RESEND_API_KEY: "re_x",
    })
    expect(message).toContain("NEXT_PUBLIC_SITE_URL")
  })

  it("rejects a TEST Stripe key in a production build", async () => {
    // The mistake that looks like it works: the flow completes, the dashboard shows payments,
    // and no money ever moves.
    const message = await failureFor({
      ...production,
      NEXT_PUBLIC_SITE_URL: "https://halisaha.example",
      STRIPE_SECRET_KEY: "sk_test_abc",
      STRIPE_WEBHOOK_SECRET: "whsec_p",
      INTERNAL_API_TOKEN: "0".repeat(64),
      RESEND_API_KEY: "re_x",
    })
    expect(message).toContain("STRIPE_SECRET_KEY")
    expect(message).toContain("TEST key")
  })

  it("rejects a live secret key paired with a test publishable key", async () => {
    const message = await failureFor({
      ...production,
      NEXT_PUBLIC_SITE_URL: "https://halisaha.example",
      NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_test_abc",
      STRIPE_SECRET_KEY: "sk_live_abc",
      STRIPE_WEBHOOK_SECRET: "whsec_p",
      INTERNAL_API_TOKEN: "0".repeat(64),
      RESEND_API_KEY: "re_x",
    })
    expect(message).toMatch(/STRIPE_SECRET_KEY|NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY/)
  })

  it("requires the internal token, without which the reservation sweeper cannot run", async () => {
    const message = await failureFor({
      ...production,
      NEXT_PUBLIC_SITE_URL: "https://halisaha.example",
      RESEND_API_KEY: "re_x",
    })
    expect(message).toContain("INTERNAL_API_TOKEN")
  })

  it("requires an email transport, or an under-16 signup can never be approved", async () => {
    const message = await failureFor({
      ...production,
      NEXT_PUBLIC_SITE_URL: "https://halisaha.example",
      INTERNAL_API_TOKEN: "0".repeat(64),
    })
    expect(message).toContain("RESEND_API_KEY")
  })

  it("accepts a complete production configuration", async () => {
    expect(
      await failureFor({
        ...production,
        NEXT_PUBLIC_SITE_URL: "https://halisaha.example",
        NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_live_abc",
        STRIPE_SECRET_KEY: "sk_live_abc",
        STRIPE_WEBHOOK_SECRET: "whsec_platform",
        STRIPE_CONNECT_WEBHOOK_SECRET: "whsec_connect",
        INTERNAL_API_TOKEN: "0".repeat(64),
        RESEND_API_KEY: "re_live_abc",
      }),
    ).toBeNull()
  })

  it("lets those same values through outside production, so local dev is not blocked", async () => {
    expect(await failureFor({ NODE_ENV: "development", STRIPE_SECRET_KEY: undefined })).toBeNull()
  })
})
