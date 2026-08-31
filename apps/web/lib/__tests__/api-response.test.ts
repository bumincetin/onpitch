import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { API_ERROR_CODES } from "@halisaha/shared/domain"

import { ApiRouteError, fail, handleRoute, ok } from "../api-response"

/**
 * `handleRoute()` is the app's single redaction point. Every one of these tests throws something
 * that carries a secret — an account id, a connection string, a column name, a Stripe request id
 * — and asserts the secret does NOT appear in the response body. A regression here is a data
 * leak that no type checker and no lint rule would catch, because the leaking value is a string
 * that was always legal to put in a message.
 */

// A Response body is a one-shot stream, and `clone()` on an already-read one throws. Read the
// bytes once per response and derive both views from that string.
const text = async (response: Response) => await response.text()
const body = async (response: Response) =>
  JSON.parse(await response.text()) as Record<string, unknown>

let logged: unknown[][]

beforeEach(() => {
  logged = []
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    logged.push(args)
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("ok", () => {
  it("wraps the payload in the discriminated union the client narrows on", async () => {
    const response = ok({ id: "abc", count: 2 })
    expect(response.status).toBe(200)
    expect(await body(response)).toEqual({ ok: true, data: { id: "abc", count: 2 } })
  })

  it("marks every response no-store, because an authenticated body must never be cached", async () => {
    const response = ok({ secret: "only-for-this-session" })
    expect(response.headers.get("Cache-Control")).toContain("no-store")
    expect(response.headers.get("Vary")).toBe("Cookie")
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff")
    expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8")
  })

  it("honours a caller's status and extra headers without losing the base ones", async () => {
    const response = ok({ id: "x" }, { status: 201, headers: { Location: "/api/teams/x" } })
    expect(response.status).toBe(201)
    expect(response.headers.get("Location")).toBe("/api/teams/x")
    expect(response.headers.get("Cache-Control")).toContain("no-store")
  })

  it("lets a caller override a base header deliberately — the rate limiter needs to", () => {
    const response = ok({ id: "x" }, { headers: { Vary: "Cookie, Authorization" } })
    expect(response.headers.get("Vary")).toBe("Cookie, Authorization")
  })
})

describe("fail", () => {
  it("produces { ok: false, error: { code, message } }", async () => {
    const response = fail("SLOT_TAKEN", "Bu saat az önce doldu.", 409)
    expect(response.status).toBe(409)
    expect(await body(response)).toEqual({
      ok: false,
      error: { code: "SLOT_TAKEN", message: "Bu saat az önce doldu." },
    })
  })

  it("clamps a nonsense status to 500 rather than throwing inside the error path", () => {
    // `new Response(body, { status: 200 })` for an error would make a client's `response.ok`
    // disagree with the envelope's `ok: false`.
    for (const status of [200, 302, 0, 600, 4.5, Number.NaN]) {
      expect(fail("INTERNAL", "x", status).status).toBe(500)
    }
    expect(fail("INTERNAL", "x", 429).status).toBe(429)
    expect(fail("INTERNAL", "x", 599).status).toBe(599)
  })

  it("omits `details` entirely when it cannot be serialised, instead of blowing up", async () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic

    const response = fail("VALIDATION_FAILED", "Geçersiz istek.", 422, cyclic)
    const payload = await body(response)
    expect(payload.ok).toBe(false)
    expect((payload.error as Record<string, unknown>).details).toBeUndefined()

    // A BigInt makes JSON.stringify throw outright.
    const withBigInt = fail("INTERNAL", "x", 500, { n: BigInt(1) })
    expect((await body(withBigInt)).error).toEqual({ code: "INTERNAL", message: "x" })
  })

  it("keeps details that do serialise", async () => {
    const response = fail("VALIDATION_FAILED", "Geçersiz istek.", 422, {
      issues: [{ path: "startsAt", message: "required" }],
    })
    expect((await body(response)).error).toEqual({
      code: "VALIDATION_FAILED",
      message: "Geçersiz istek.",
      details: { issues: [{ path: "startsAt", message: "required" }] },
    })
  })
})

describe("handleRoute — passthrough", () => {
  it("returns the handler's own response untouched", async () => {
    const response = await handleRoute(async () => ok({ hello: "world" }))
    expect(await body(response)).toEqual({ ok: true, data: { hello: "world" } })
  })

  it("rethrows Next's control flow rather than turning a redirect into a 500", async () => {
    for (const digest of [
      "NEXT_NOT_FOUND",
      "NEXT_REDIRECT;replace;/giris;307",
      "DYNAMIC_SERVER_USAGE",
      "BAILOUT_TO_CLIENT_SIDE_RENDERING",
    ]) {
      const control = Object.assign(new Error("control flow"), { digest })
      await expect(
        handleRoute(async () => {
          throw control
        }),
      ).rejects.toBe(control)
    }

    const dynamic = Object.assign(new Error("no store"), { name: "DynamicServerError" })
    await expect(
      handleRoute(async () => {
        throw dynamic
      }),
    ).rejects.toBe(dynamic)
  })
})

describe("handleRoute — ApiRouteError is the ONLY message that reaches the client verbatim", () => {
  it("renders its code, message and status", async () => {
    const response = await handleRoute(async () => {
      throw new ApiRouteError("BOOKING_TOO_LATE", "Maç başlamış, iptal edilemez.", 409)
    })
    expect(response.status).toBe(409)
    expect(await body(response)).toEqual({
      ok: false,
      error: { code: "BOOKING_TOO_LATE", message: "Maç başlamış, iptal edilemez." },
    })
  })

  it("carries its details through", async () => {
    const response = await handleRoute(async () => {
      throw new ApiRouteError("RATE_LIMITED", "Çok fazla deneme.", 429, { retryAfter: 42 })
    })
    expect((await body(response)).error).toMatchObject({ details: { retryAfter: 42 } })
  })
})

describe("handleRoute — redaction", () => {
  it("answers 403 for a ForbiddenError without echoing which roles were required", async () => {
    // The real message is "Forbidden: this action requires admin or venue_owner, but the current
    // user is player." — that enumerates the role model to an attacker probing endpoints.
    const forbidden = Object.assign(
      new Error("Forbidden: this action requires admin or venue_owner, but the current user is player."),
      { name: "ForbiddenError", code: "FORBIDDEN", status: 403 },
    )

    const response = await handleRoute(async () => {
      throw forbidden
    })
    expect(response.status).toBe(403)
    const wire = await text(response)
    expect(JSON.parse(wire).error).toMatchObject({ code: API_ERROR_CODES.FORBIDDEN })
    expect(wire).not.toContain("venue_owner")
  })

  it("answers 422 for a ZodError with paths but not the offending values", async () => {
    const zod = Object.assign(new Error("invalid"), {
      name: "ZodError",
      issues: [
        { path: ["startsAt"], message: "Required" },
        { path: ["players", 3, "phone"], message: "Invalid" },
      ],
    })

    const response = await handleRoute(async () => {
      throw zod
    })
    expect(response.status).toBe(422)
    const payload = await body(response)
    expect(payload.error).toMatchObject({
      code: API_ERROR_CODES.VALIDATION_FAILED,
      details: {
        issues: [
          { path: "startsAt", message: "Required" },
          { path: "players.3.phone", message: "Invalid" },
        ],
      },
    })
  })

  it("turns the double-booking exclusion into a 409 a human can act on", async () => {
    const conflict = {
      code: "23P01",
      message: 'conflicting key value violates exclusion constraint "bookings_no_double_booking"',
      details: "Key (pitch_id, slot)=(9f1c…, [2026-09-01 19:00, 2026-09-01 20:00)) conflicts.",
    }

    const response = await handleRoute(async () => {
      throw conflict
    })
    expect(response.status).toBe(409)
    const wire = await text(response)
    expect(JSON.parse(wire).error).toMatchObject({ code: API_ERROR_CODES.SLOT_TAKEN })
    // The constraint name and the raw key tuple are internal schema detail.
    expect(wire).not.toContain("bookings_no_double_booking")
    expect(wire).not.toContain("pitch_id")
  })

  it("distinguishes the blackout-window overlap from a taken slot", async () => {
    const response = await handleRoute(async () => {
      throw {
        code: "23P01",
        message: 'conflicting key value violates exclusion constraint "pitch_blocks_no_overlap"',
        details: "",
      }
    })
    expect((await body(response)).error).toMatchObject({ code: API_ERROR_CODES.BLOCK_OVERLAP })
    expect(response.status).toBe(409)
  })

  it("answers a generic 500 for any other Postgres error, logging the SQLSTATE", async () => {
    const response = await handleRoute(async () => {
      throw {
        code: "42501",
        message: 'permission denied for table "payouts"',
        details: "RLS policy payouts_select_own",
      }
    })
    expect(response.status).toBe(500)
    const wire = await text(response)
    expect(JSON.parse(wire).error).toMatchObject({ code: API_ERROR_CODES.INTERNAL })
    expect(wire).not.toContain("payouts")
    expect(wire).not.toContain("42501")
    // It has to be *logged*, or an on-call engineer has nothing to go on.
    expect(JSON.stringify(logged)).toContain("42501")
  })

  it("does not mistake a Node errno for a SQLSTATE", async () => {
    // `ECONNRESET` is not five alphanumerics, so it must fall through to the catch-all rather
    // than being rendered as a database error.
    const response = await handleRoute(async () => {
      throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })
    })
    expect(response.status).toBe(500)
    expect((await body(response)).error).toMatchObject({ code: API_ERROR_CODES.INTERNAL })
  })

  it("answers 502 for a Stripe error without echoing account ids or request ids", async () => {
    const stripe = Object.assign(new Error("No such destination: 'acct_1PfakeAccount'"), {
      type: "StripeInvalidRequestError",
      code: "account_invalid",
      requestId: "req_secret123",
    })

    const response = await handleRoute(async () => {
      throw stripe
    })
    expect(response.status).toBe(502)
    const wire = await text(response)
    expect(JSON.parse(wire).error).toMatchObject({ code: API_ERROR_CODES.STRIPE_ERROR })
    expect(wire).not.toContain("acct_1PfakeAccount")
    expect(wire).not.toContain("req_secret123")
    expect(JSON.stringify(logged)).toContain("req_secret123")
  })

  it("answers a generic 500 for a bare exception and never leaks its message or stack", async () => {
    const response = await handleRoute(async () => {
      throw new Error("postgres://halisaha:hunter2@db.internal:5432/prod timed out")
    })
    expect(response.status).toBe(500)
    const wire = await text(response)
    expect(wire).not.toContain("hunter2")
    expect(wire).not.toContain("db.internal")
    expect(JSON.parse(wire)).toMatchObject({ ok: false, error: { code: API_ERROR_CODES.INTERNAL } })
  })

  it("survives a thrown non-Error — a rejected string, null, or undefined", async () => {
    for (const thrown of ["boom", null, undefined, 42, Symbol("x")]) {
      const response = await handleRoute(async () => {
        throw thrown
      })
      expect(response.status).toBe(500)
      expect((await body(response)).error).toMatchObject({ code: API_ERROR_CODES.INTERNAL })
    }
  })

  it("keeps the no-store headers on every error path, not just the happy one", async () => {
    const response = await handleRoute(async () => {
      throw new Error("boom")
    })
    expect(response.headers.get("Cache-Control")).toContain("no-store")
    expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8")
  })
})
