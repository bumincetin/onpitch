import { describe, expect, it } from "vitest"

import {
  conversationListSchema,
  groupMessages,
  istanbulDayKey,
  removedMessageLabel,
  sendMessageSchema,
  startConversationSchema,
  toMessageView,
  type MessageView,
} from "../messaging"
import {
  accentColorOf,
  bannerShotOf,
  initialsOf,
  profileStyleOf,
  profileStyleSchema,
} from "../profile"

const A = "11111111-1111-4111-8111-111111111111"
const B = "22222222-2222-4222-8222-222222222222"
const C = "33333333-3333-4333-8333-333333333333"

function view(over: Partial<MessageView> & { id: string; createdAt: string; senderId: string }): MessageView {
  return { conversationId: C, body: "x", deleted: false, redacted: false, ...over }
}

describe("message rows", () => {
  it("blanks the body of an unsent or redacted message and says which", () => {
    const base = { id: A, conversation_id: C, sender_id: B, body: "gizli", created_at: "2026-09-03T10:00:00Z" }
    expect(toMessageView({ ...base, deleted_at: "2026-09-03T10:01:00Z" }).body).toBe("")
    expect(toMessageView({ ...base, redacted_at: "2026-09-03T10:01:00Z" }).body).toBe("")
    expect(toMessageView(base).body).toBe("gizli")
    expect(removedMessageLabel({ deleted: true, redacted: false })).toMatch(/geri alındı/)
    expect(removedMessageLabel({ deleted: false, redacted: true })).toMatch(/silindi/)
    expect(removedMessageLabel({ deleted: false, redacted: false })).toBeNull()
  })

  it("groups a thread by Istanbul day and by five-minute runs of one sender", () => {
    const days = groupMessages([
      view({ id: "1", senderId: A, createdAt: "2026-09-03T20:58:00Z" }), // 23:58 Istanbul
      view({ id: "2", senderId: A, createdAt: "2026-09-03T20:59:00Z" }),
      view({ id: "3", senderId: B, createdAt: "2026-09-03T21:00:30Z" }), // 00:00 next day
      view({ id: "4", senderId: B, createdAt: "2026-09-03T21:06:00Z" }), // > 5 min later
    ])
    expect(days).toHaveLength(2)
    expect(days[0]!.runs).toHaveLength(1)
    expect(days[0]!.runs[0]!.messages.map((m) => m.id)).toEqual(["1", "2"])
    expect(days[1]!.runs).toHaveLength(2)
    expect(istanbulDayKey("2026-09-03T21:00:30Z")).toBe("2026-09-04")
  })
})

describe("request bodies", () => {
  it("trims and bounds a message body", () => {
    expect(sendMessageSchema.safeParse({ body: "  selam  " }).data?.body).toBe("selam")
    expect(sendMessageSchema.safeParse({ body: "   " }).success).toBe(false)
    expect(sendMessageSchema.safeParse({ body: "x".repeat(2001) }).success).toBe(false)
    expect(sendMessageSchema.safeParse({ body: "x", extra: 1 }).success).toBe(false)
  })

  it("requires a uuid recipient and allows an empty first message", () => {
    expect(startConversationSchema.safeParse({ recipientId: A }).success).toBe(true)
    expect(startConversationSchema.safeParse({ recipientId: "ali" }).success).toBe(false)
  })
})

describe("inbox rows", () => {
  it("parses what my_conversations() returns and tolerates an unknown accent", () => {
    const parsed = conversationListSchema.safeParse([
      {
        id: C,
        bookingId: null,
        lastMessageAt: "2026-09-03T10:00:00+00:00",
        mutedAt: null,
        lastReadAt: null,
        unreadCount: 2,
        counterpart: { id: B, displayName: "Ayşe", avatarUrl: null, accentColor: "neon", role: "player", erased: false },
        lastMessage: { id: A, senderId: B, body: "Cumartesi?", removed: false, createdAt: "2026-09-03T10:00:00+00:00" },
      },
    ])
    expect(parsed.success).toBe(true)
    expect(parsed.data?.[0]?.counterpart?.accentColor).toBe("gold")
  })
})

describe("profile style", () => {
  it("falls back to the defaults for anything the palette does not know", () => {
    expect(accentColorOf("teal")).toBe("teal")
    expect(accentColorOf("magenta")).toBe("gold")
    expect(accentColorOf(null)).toBe("gold")
    expect(bannerShotOf("tunnel")).toBe("tunnel")
    expect(bannerShotOf("roof")).toBe("stands")
  })

  it("reads a row into a style the form can hold", () => {
    const style = profileStyleOf({ accent_color: "ice", banner_shot: "aerial", tagline: "Sol kanat", jersey_number: 7, dominant_foot: "left" })
    expect(profileStyleSchema.safeParse(style).success).toBe(true)
    expect(style).toEqual({ accentColor: "ice", bannerShot: "aerial", tagline: "Sol kanat", jerseyNumber: 7, dominantFoot: "left" })
    expect(profileStyleSchema.safeParse({ ...style, jerseyNumber: 100 }).success).toBe(false)
  })

  it("makes initials the Turkish way", () => {
    expect(initialsOf("Ayşe Demir")).toBe("AD")
    expect(initialsOf("ışık")).toBe("IŞ")
    expect(initialsOf("")).toBe("?")
  })
})
