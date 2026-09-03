import { describe, expect, it } from "vitest"

import {
  NOTIFICATION_GROUPS,
  NOTIFICATION_TONES,
  formatNotification,
  formatNotificationDay,
  formatNotificationTime,
  formatNotifications,
  resolveNotificationHref,
  type NotificationRow,
} from "../notifications/format"

/**
 * Two things are being pinned here.
 *
 * The first is that `resolveNotificationHref` only ever produces a route that exists. A
 * notification that lands a player on a 404 is worse than one with no link at all, and the
 * audience argument is what decides: a `payout.failed` row is a page for a venue owner and a
 * dead end for everybody else, even though it is the same row in the same table.
 *
 * The second is that an unknown `type` still renders. Producers are added in migrations and in
 * two Node jobs, and none of them import this module — so a new type WILL arrive here before
 * anyone adds a descriptor for it, and it must degrade to a readable row rather than a blank one.
 */

const row = (over: Partial<NotificationRow> = {}): NotificationRow => ({
  id: "11111111-1111-4111-8111-111111111111",
  type: "booking.confirmed",
  title: "",
  body: null,
  data: null,
  created_at: "2026-09-03T16:40:00.000Z",
  read_at: null,
  ...over,
})

const MATCH = "22222222-2222-4222-8222-222222222222"
const BOOKING = "33333333-3333-4333-8333-333333333333"

const CONVERSATION = "44444444-4444-4444-8444-444444444444"

describe("resolveNotificationHref — messages", () => {
  it("lands a new-message notification in its thread, or the inbox without an id", () => {
    expect(resolveNotificationHref("message.received", { conversationId: CONVERSATION })).toBe(`/messages/${CONVERSATION}`)
    expect(resolveNotificationHref("message.received", { conversation_id: CONVERSATION })).toBe(`/messages/${CONVERSATION}`)
    expect(resolveNotificationHref("message.received", {})).toBe("/messages")
  })

  it("routes a report to the admin queue and nowhere for anyone else", () => {
    expect(resolveNotificationHref("message.reported", {}, "admin")).toBe("/admin")
    expect(resolveNotificationHref("message.reported", {}, "player")).toBeNull()
  })

  it("keeps message text out of the fallback copy", () => {
    const shaped = formatNotification(row({ type: "message.received", title: "Ayşe", body: null }))
    expect(shaped.title).toBe("Ayşe")
    expect(shaped.group).toBe("message")
    expect(shaped.body).not.toContain("Cumartesi")
  })
})

describe("resolveNotificationHref", () => {
  it("sends a match notification to the fixture, or to the list when there is no id", () => {
    expect(resolveNotificationHref("match.finalized", { match_id: MATCH })).toBe(`/matches/${MATCH}`)
    expect(resolveNotificationHref("match.finalized", {})).toBe("/matches")
    expect(resolveNotificationHref("match.disputed", null)).toBe("/matches")
  })

  it("accepts both the snake_case and camelCase payload conventions", () => {
    // SQL producers write snake_case; the two Node jobs write camelCase.
    expect(resolveNotificationHref("match.finalized", { matchId: MATCH })).toBe(`/matches/${MATCH}`)
    expect(resolveNotificationHref("match.finalized", { match_id: MATCH })).toBe(`/matches/${MATCH}`)
  })

  it("ignores an id that is not a uuid rather than routing to a 404", () => {
    expect(resolveNotificationHref("match.finalized", { match_id: "42" })).toBe("/matches")
    expect(resolveNotificationHref("match.finalized", { match_id: "" })).toBe("/matches")
  })

  it("survives a payload that is not an object at all", () => {
    for (const data of [null, undefined, "string", 7, [], true]) {
      expect(() => resolveNotificationHref("match.finalized", data)).not.toThrow()
      expect(resolveNotificationHref("match.finalized", data)).toBe("/matches")
    }
  })

  it("routes a booking by audience — the owner has a table, the player only has the fixture", () => {
    const data = { booking_id: BOOKING, match_id: MATCH }
    expect(resolveNotificationHref("booking.confirmed", data, "venue_owner")).toBe("/venue/bookings")
    expect(resolveNotificationHref("booking.confirmed", data, "player")).toBe(`/matches/${MATCH}`)
    // No match on the payload and not an owner: there is nowhere honest to send them.
    expect(resolveNotificationHref("booking.confirmed", { booking_id: BOOKING }, "player")).toBeNull()
    expect(resolveNotificationHref("booking.confirmed", data, null)).toBe(`/matches/${MATCH}`)
  })

  it("gives payout and venue rows a destination only for a venue owner", () => {
    expect(resolveNotificationHref("payout.failed", {}, "venue_owner")).toBe("/venue/payouts")
    expect(resolveNotificationHref("payout.failed", {}, "player")).toBeNull()
    expect(resolveNotificationHref("payout.failed", {}, "admin")).toBeNull()
    expect(resolveNotificationHref("venue.activated", {}, "venue_owner")).toBe("/venue")
    expect(resolveNotificationHref("venue.deactivated", {}, "player")).toBeNull()
  })

  it("sends every account-shaped notification to the privacy screen", () => {
    for (const type of ["consent.granted", "consent.revoked", "profile.updated", "gdpr.export_ready"]) {
      expect(resolveNotificationHref(type, {})).toBe("/account/privacy")
    }
  })

  it("splits progress: a badge goes to the cabinet, everything else to the dashboard", () => {
    expect(resolveNotificationHref("progress.achievement", {})).toBe("/achievements")
    expect(resolveNotificationHref("progress.level_up", {})).toBe("/dashboard")
    expect(resolveNotificationHref("progress.streak_at_risk", {})).toBe("/dashboard")
  })

  it("returns null for a type nobody has taught it about", () => {
    expect(resolveNotificationHref("league.promoted", { match_id: MATCH })).toBeNull()
    expect(resolveNotificationHref("", {})).toBeNull()
    expect(resolveNotificationHref("no-dot-at-all", {})).toBeNull()
  })
})

describe("formatNotification", () => {
  it("prefers the producer's own title and body over the descriptor's default", () => {
    // 0008's three progress producers always write their own copy — "Seviye 7", a badge name.
    const view = formatNotification(
      row({ type: "progress.level_up", title: "Seviye 7", body: "Yeni rütbe: Amatör" }),
    )
    expect(view.title).toBe("Seviye 7")
    expect(view.body).toBe("Yeni rütbe: Amatör")
  })

  it("falls back to the descriptor when the row's copy is missing or blank", () => {
    // `notifications.title` is `text not null` in 0001, so the empty-ish values it can actually
    // hold are the whitespace ones. `body` is nullable and gets null too.
    for (const blank of ["", "   ", "\n\t"]) {
      const view = formatNotification(row({ title: blank, body: blank }))
      expect(view.title).toBe("Rezervasyon onaylandı")
      expect(view.body).toBe("Ödeme tamamlandı, saat senin.")
    }
    expect(formatNotification(row({ title: "", body: null })).body).toBe(
      "Ödeme tamamlandı, saat senin.",
    )
  })

  it("renders an unknown type as a readable row instead of a blank one", () => {
    const view = formatNotification(row({ type: "league.relegated", title: "", body: null }))
    expect(view.title).toBe("Güncelleme")
    expect(view.body).toBe("Neyin değiştiğini görmek için OnPitch'yı aç.")
    expect(view.group).toBe("other")
    expect(view.tone).toBe("neutral")
    expect(view.href).toBeNull()
  })

  it("groups an unknown subtype by its prefix, so a new booking.* row still files correctly", () => {
    expect(formatNotification(row({ type: "booking.rescheduled" })).group).toBe("booking")
    expect(formatNotification(row({ type: "payout.delayed" })).group).toBe("payout")
    expect(formatNotification(row({ type: "gdpr.erasure_done" })).group).toBe("account")
    expect(formatNotification(row({ type: "progress.challenge_ready" })).group).toBe("progress")
  })

  it("only ever emits a declared group and tone", () => {
    for (const type of [
      "booking.confirmed",
      "booking.cancelled",
      "match.finalized",
      "payout.failed",
      "venue.activated",
      "consent.revoked",
      "progress.achievement",
      "totally.unknown",
    ]) {
      const view = formatNotification(row({ type }))
      expect(NOTIFICATION_GROUPS).toContain(view.group)
      expect(NOTIFICATION_TONES).toContain(view.tone)
    }
  })

  it("carries the identity fields through untouched", () => {
    const source = row({ read_at: "2026-09-03T18:00:00.000Z" })
    const view = formatNotification(source)
    expect(view.id).toBe(source.id)
    expect(view.type).toBe(source.type)
    expect(view.createdAt).toBe(source.created_at)
    expect(view.readAt).toBe(source.read_at)
  })

  it("maps a whole page with one audience", () => {
    const views = formatNotifications(
      [row({ type: "payout.failed" }), row({ type: "venue.activated" })],
      "venue_owner",
    )
    expect(views.map((v) => v.href)).toEqual(["/venue/payouts", "/venue"])
  })
})

describe("timestamps", () => {
  it("renders in Istanbul time regardless of where the code is running", () => {
    // 16:40Z is 19:40 in Istanbul (UTC+3, no DST). This is the assertion that catches a
    // server/browser hydration mismatch — the whole reason the zone is pinned.
    const stamp = formatNotificationTime("2026-09-03T16:40:00.000Z")
    expect(stamp).toContain("19:40")
    expect(stamp).toContain("2026")
  })

  it("says Bugün and Dün in Turkish, resolved in the same fixed zone", () => {
    const now = new Date("2026-09-03T21:00:00.000Z") // 4 Sept 00:00 in Istanbul
    // 3 Sept 22:00Z is already 4 Sept 01:00 in Istanbul — the same Istanbul day as `now`.
    expect(formatNotificationDay("2026-09-03T22:00:00.000Z", now)).toMatch(/^Bugün /)
    // 3 Sept 09:00Z is 12:00 on 3 Sept in Istanbul, the Istanbul day before.
    expect(formatNotificationDay("2026-09-03T09:00:00.000Z", now)).toMatch(/^Dün /)
  })

  it("falls back to the full stamp for anything older than yesterday", () => {
    const now = new Date("2026-09-03T12:00:00.000Z")
    const older = formatNotificationDay("2026-08-20T12:00:00.000Z", now)
    expect(older).not.toMatch(/^Bugün|^Dün/)
    expect(older).toContain("2026")
  })

  it("returns an empty string for an unparseable timestamp rather than 'Invalid Date'", () => {
    for (const bad of ["", "not-a-date", "2026-13-45T99:99:99Z"]) {
      expect(formatNotificationTime(bad)).toBe("")
      expect(formatNotificationDay(bad)).toBe("")
    }
  })
})
