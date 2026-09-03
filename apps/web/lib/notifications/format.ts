/**
 * lib/notifications/format.ts
 *
 * One place that turns a `notifications` row into something a screen can render.
 *
 * The table stores a dotted `type`, a `title`, a nullable `body` and a free-form `data` blob.
 * Producers are scattered — `private.notify_participants` and `private.notify_admins` in
 * 0005_integrity_consensus.sql, `verify_parental_consent` / `revoke_parental_consent` in
 * 0003_auth_rbac_gdpr.sql, and the Stripe webhook and booking-cancel routes on the Node side —
 * and they do not agree on a key convention: SQL writes `matchId` and `requestId`, the webhook
 * writes `booking_id` and `venue_id`. Rather than migrate live rows, this module reads both
 * spellings and is the only file that has to know that.
 *
 * Three rules it follows:
 *
 *   1. The stored `title`/`body` win. A producer wrote copy for a specific event ("A payout to
 *      Yesilkoy OnPitch could not be completed") and a generic per-type string cannot beat it.
 *      The descriptor table is the FALLBACK, for rows written before a producer had copy and
 *      for types this build has never heard of.
 *   2. `data` is untrusted input. It is jsonb, so it can be an array, a number, or an object
 *      with a `matchId` that is not a uuid. Everything is parsed with zod; a failed parse
 *      degrades to "no deep link", never to a broken href.
 *   3. A link is only produced for a route that exists in this app. A player has no
 *      booking-detail page, so a `booking.confirmed` notification for a player links to its
 *      match when the payload names one and is otherwise plain text. An href to a 404 is worse
 *      than no href.
 *
 * Timestamps are formatted through a FIXED locale and timezone. The alternative — the viewer's
 * local zone — renders differently on the server and in the browser, which is a hydration
 * mismatch on every row of the list.
 */

import { z } from "zod"

import type { Tables } from "@onpitch/shared/database"
import type { AppRole } from "@/lib/rbac"

/* ========================================================================== */
/*  Types                                                                     */
/* ========================================================================== */

/** Only the columns the formatter reads, so a caller may project a narrower select. */
export type NotificationRow = Pick<
  Tables<"notifications">,
  "id" | "type" | "title" | "body" | "data" | "read_at" | "created_at"
>

export const NOTIFICATION_GROUPS = [
  "booking",
  "match",
  "payout",
  "venue",
  "account",
  "progress",
  "other",
] as const
export type NotificationGroup = (typeof NOTIFICATION_GROUPS)[number]

/** Drives the accent colour and the badge variant. Nothing security-relevant hangs off it. */
export const NOTIFICATION_TONES = ["neutral", "positive", "attention", "critical"] as const
export type NotificationTone = (typeof NOTIFICATION_TONES)[number]

/** The render-ready shape. Every route in this feature returns these, never raw rows. */
export interface NotificationView {
  id: string
  type: string
  title: string
  body: string | null
  /** Null when this app has no page for the thing the notification is about. */
  href: string | null
  createdAt: string
  /** ISO timestamp, or null while unread. */
  readAt: string | null
  group: NotificationGroup
  tone: NotificationTone
}

/** `GET /api/notifications`. */
export interface NotificationPage {
  items: NotificationView[]
  unreadCount: number
  /** Feed back as `?before=` for the next page. Null when the feed is exhausted. */
  nextCursor: string | null
}

/** `POST /api/notifications/[id]/read`. */
export interface NotificationReadResult {
  id: string
  readAt: string
  unreadCount: number
}

/** `POST /api/notifications/read-all`. */
export interface NotificationReadAllResult {
  markedRead: number
  unreadCount: number
}

/**
 * Whose screen this is. It steers the href only: a venue owner's `payout.failed` belongs on
 * `/venue/payouts`, and the same row shown to anyone else has nowhere to go.
 */
export type NotificationAudience = AppRole | null

/* ========================================================================== */
/*  Type descriptors                                                          */
/* ========================================================================== */

interface TypeDescriptor {
  title: string
  body: string
  group: NotificationGroup
  tone: NotificationTone
}

/**
 * Every `type` string this codebase writes today, taken from the migrations and the two Node
 * producers. Anything absent falls through to the prefix rules in `descriptorFor`, which is
 * what stops a new producer from rendering as a blank row.
 */
const DESCRIPTORS: Readonly<Record<string, TypeDescriptor>> = {
  "booking.confirmed": {
    title: "Rezervasyon onaylandı",
    body: "Ödeme tamamlandı, saat senin.",
    group: "booking",
    tone: "positive",
  },
  "booking.cancelled": {
    title: "Rezervasyon iptal edildi",
    body: "Saat serbest bırakıldı.",
    group: "booking",
    tone: "attention",
  },
  "booking.refunded": {
    title: "İade yapıldı",
    body: "İade, ödemenin yapıldığı karta doğru yolda.",
    group: "booking",
    tone: "positive",
  },
  "booking.payment_failed": {
    title: "Ödeme başarısız",
    body: "Kart reddedildi, bu yüzden saat tutulmadı.",
    group: "booking",
    tone: "critical",
  },
  "booking.payment_needs_review": {
    title: "Ödemeye bakılması gerekiyor",
    body: "Zaten serbest bırakılmış bir rezervasyona ödeme geldi. Destek ekibine bildirildi.",
    group: "booking",
    tone: "attention",
  },
  "booking.disputed": {
    title: "Ödemeye itiraz edildi",
    body: "Bu rezervasyona karşı ters ibraz açıldı.",
    group: "booking",
    tone: "critical",
  },
  "match.consensus_required": {
    title: "Bir sonuç oyunu bekliyor",
    body: "Bildirilen skor sıra dışı göründü; sonucu oyuncular birlikte karara bağlıyor.",
    group: "match",
    tone: "attention",
  },
  "match.finalized": {
    title: "Sonuç onaylandı",
    body: "Skor kesinleşti ve reytingler güncellendi.",
    group: "match",
    tone: "positive",
  },
  "match.disputed": {
    title: "Sonuca itiraz edildi",
    body: "Uzlaşma turu anlaşma olmadan kapandı. Bundan sonrasına bir moderatör karar verir.",
    group: "match",
    tone: "critical",
  },
  "consent.granted": {
    title: "Veli onayı confirmed",
    body: "Velin hesabı onayladı. Rezervasyon ve maçlar yeniden açık.",
    group: "account",
    tone: "positive",
  },
  "consent.revoked": {
    title: "Veli onayı withdrawn",
    body: "Bir veli hesabı yeniden onaylayana kadar rezervasyon ve maç özellikleri durduruldu.",
    group: "account",
    tone: "critical",
  },
  "venue.activated": {
    title: "İşletmen yayında",
    body: "Rezervasyon alabilir ve hakediş tahsil edebilir.",
    group: "venue",
    tone: "positive",
  },
  "venue.deactivated": {
    title: "Hakediş hesabında işlem gerekiyor",
    body: "İşletme yeniden yayınlanabilmesi için Stripe daha fazla bilgi istiyor.",
    group: "venue",
    tone: "critical",
  },
  "payout.failed": {
    title: "Bir hakediş başarısız oldu",
    body: "Aktarım tamamlanamadı. Stripe panelindeki banka bilgilerini kontrol et.",
    group: "payout",
    tone: "critical",
  },

  /*
    Progression, written by 0008_gamification.sql.

    These three producers ALWAYS write a title and a body — "Seviye 7", the badge's own name
    and description — and the stored copy wins over anything here, so in practice these
    entries only ever supply the group and the tone. The fallback strings are kept in English
    like their neighbours rather than half-translating the table for rows that do not render.
  */
  "progress.level_up": {
    title: "Seviye atladın",
    body: "Toplam tecrübe puanın yeni bir seviyeye geçti.",
    group: "progress",
    tone: "positive",
  },
  "progress.achievement": {
    title: "Rozet kazanıldı",
    body: "Yeni bir rozetin şartını tamamladın.",
    group: "progress",
    tone: "positive",
  },
  "progress.streak_risk": {
    title: "Serin bitmek üzere",
    body: "Devam etmesi için bu hafta bir maç oyna.",
    group: "progress",
    tone: "attention",
  },
}

/** Prefix to group, for a `type` this build has never seen. */
const GROUP_BY_PREFIX: Readonly<Record<string, NotificationGroup>> = {
  booking: "booking",
  match: "match",
  payout: "payout",
  venue: "venue",
  consent: "account",
  profile: "account",
  gdpr: "account",
  progress: "progress",
}

function prefixOf(type: string): string {
  const dot = type.indexOf(".")
  return dot === -1 ? type : type.slice(0, dot)
}

function descriptorFor(type: string): TypeDescriptor {
  const known = DESCRIPTORS[type]
  if (known) return known

  return {
    title: "Güncelleme",
    body: "Neyin değiştiğini görmek için OnPitch'yı aç.",
    group: GROUP_BY_PREFIX[prefixOf(type)] ?? "other",
    tone: "neutral",
  }
}

/* ========================================================================== */
/*  Deep links                                                                */
/* ========================================================================== */

/**
 * Both key conventions, all optional. `.passthrough()` keeps the keys we never read from
 * failing the parse of the ones we do.
 */
const linkDataSchema = z
  .object({
    booking_id: z.string().uuid(),
    bookingId: z.string().uuid(),
    match_id: z.string().uuid(),
    matchId: z.string().uuid(),
    venue_id: z.string().uuid(),
    venueId: z.string().uuid(),
  })
  .partial()
  .passthrough()

interface LinkTargets {
  matchId: string | null
  bookingId: string | null
  venueId: string | null
}

function readLinkTargets(data: unknown): LinkTargets {
  const parsed = linkDataSchema.safeParse(data)
  if (!parsed.success) return { matchId: null, bookingId: null, venueId: null }

  const value = parsed.data
  return {
    matchId: value.match_id ?? value.matchId ?? null,
    bookingId: value.booking_id ?? value.bookingId ?? null,
    venueId: value.venue_id ?? value.venueId ?? null,
  }
}

/**
 * Where clicking this notification goes, or null when there is nowhere honest to send the
 * reader. Only routes that exist under `app/` are ever produced.
 */
export function resolveNotificationHref(
  type: string,
  data: unknown,
  audience: NotificationAudience = null,
): string | null {
  const targets = readLinkTargets(data)
  const isVenueOwner = audience === "venue_owner"

  switch (prefixOf(type)) {
    case "match":
      return targets.matchId ? `/matches/${targets.matchId}` : "/matches"

    case "consent":
    case "profile":
    case "gdpr":
      return "/account/privacy"

    case "booking":
      // A venue owner has a bookings table. A player has no booking-detail page, so the best
      // available destination is the fixture, and only when the payload names one.
      if (isVenueOwner) return "/venue/bookings"
      return targets.matchId ? `/matches/${targets.matchId}` : null

    case "payout":
      return isVenueOwner ? "/venue/payouts" : null

    case "venue":
      return isVenueOwner ? "/venue" : null

    case "progress":
      // A badge belongs in the cabinet; a level-up and a lapsing streak belong on the
      // dashboard, where the ring and the streak marks are.
      return type === "progress.achievement" ? "/achievements" : "/dashboard"

    default:
      return null
  }
}

/* ========================================================================== */
/*  Formatting                                                                */
/* ========================================================================== */

function nonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/** Row to render-ready view. Pure; safe from a Server Component or the browser. */
export function formatNotification(
  row: NotificationRow,
  audience: NotificationAudience = null,
): NotificationView {
  const descriptor = descriptorFor(row.type)

  return {
    id: row.id,
    type: row.type,
    title: nonEmpty(row.title) ?? descriptor.title,
    body: nonEmpty(row.body) ?? descriptor.body,
    href: resolveNotificationHref(row.type, row.data, audience),
    createdAt: row.created_at,
    readAt: row.read_at,
    group: descriptor.group,
    tone: descriptor.tone,
  }
}

export function formatNotifications(
  rows: readonly NotificationRow[],
  audience: NotificationAudience = null,
): NotificationView[] {
  return rows.map((row) => formatNotification(row, audience))
}

/* ========================================================================== */
/*  Timestamps                                                                */
/* ========================================================================== */

/**
 * Fixed locale and zone on purpose. The server renders in UTC and the browser in whatever the
 * device is set to, so "local time" formatting mismatches on hydration for every row in a
 * server-rendered list. Turkey is one zone and the product is Turkish, so pinning both sides to
 * it is correct rather than merely convenient.
 */
const TIMESTAMP_LOCALE = "tr-TR"
const TIMESTAMP_ZONE = "Europe/Istanbul"

let timestampFormat: Intl.DateTimeFormat | null = null
let clockFormat: Intl.DateTimeFormat | null = null
let dayKeyFormat: Intl.DateTimeFormat | null = null

function timestampFormatter(): Intl.DateTimeFormat {
  if (timestampFormat === null) {
    timestampFormat = new Intl.DateTimeFormat(TIMESTAMP_LOCALE, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: TIMESTAMP_ZONE,
    })
  }
  return timestampFormat
}

function clockFormatter(): Intl.DateTimeFormat {
  if (clockFormat === null) {
    clockFormat = new Intl.DateTimeFormat(TIMESTAMP_LOCALE, {
      timeStyle: "short",
      timeZone: TIMESTAMP_ZONE,
    })
  }
  return clockFormat
}

/** `en-CA` gives `YYYY-MM-DD`, which compares as a plain string. */
function dayKeyFormatter(): Intl.DateTimeFormat {
  if (dayKeyFormat === null) {
    dayKeyFormat = new Intl.DateTimeFormat("en-CA", {
      dateStyle: "short",
      timeZone: TIMESTAMP_ZONE,
    })
  }
  return dayKeyFormat
}

/** `"3 Eyl 2026 19:40"`. Empty string for an unparseable timestamp. */
export function formatNotificationTime(iso: string): string {
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return ""
  return timestampFormatter().format(parsed)
}

/**
 * The short "when" used in the list: "Bugün 19:40", "Dün 08:05", or the full stamp.
 * Both sides of the comparison are resolved in {@link TIMESTAMP_ZONE}, so the answer does not
 * depend on where the code runs.
 */
export function formatNotificationDay(iso: string, now: Date = new Date()): string {
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return ""

  const key = dayKeyFormatter()
  const stamp = key.format(parsed)
  const today = key.format(now)
  const yesterday = key.format(new Date(now.getTime() - 86_400_000))

  if (stamp === today) return `Bugün ${clockFormatter().format(parsed)}`
  if (stamp === yesterday) return `Dün ${clockFormatter().format(parsed)}`
  return formatNotificationTime(iso)
}
