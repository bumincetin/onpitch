/**
 * packages/shared/src/profile.ts
 *
 * The vocabulary of profile customisation, mirrored from the CHECK constraints 0011 puts on
 * `public.profiles`. Both apps read these lists; neither may invent a value the database will
 * refuse.
 *
 * Colour VALUES are not here on purpose — they are design tokens, and the web app and the
 * phone paint them differently. What is shared is the name and what it means.
 */

import { z } from "zod"

/* -------------------------------------------------------------------------- */
/*  Accent                                                                    */
/* -------------------------------------------------------------------------- */

export const ACCENT_COLORS = [
  "gold",
  "teal",
  "vermilion",
  "azure",
  "violet",
  "lime",
  "coral",
  "ice",
] as const
export type AccentColor = (typeof ACCENT_COLORS)[number]
export const DEFAULT_ACCENT_COLOR: AccentColor = "gold"

/** How the picker names them. Football words where one exists. */
export const ACCENT_COLOR_LABEL: Record<AccentColor, string> = {
  gold: "Altın",
  teal: "Turkuaz",
  vermilion: "Kırmızı",
  azure: "Lacivert",
  violet: "Mor",
  lime: "Fıstık",
  coral: "Mercan",
  ice: "Buz",
}

export const accentColorSchema = z.enum(ACCENT_COLORS)

export function isAccentColor(value: unknown): value is AccentColor {
  return typeof value === "string" && (ACCENT_COLORS as readonly string[]).includes(value)
}

/** Any string from the database → a colour the palette knows, never `undefined`. */
export function accentColorOf(value: string | null | undefined): AccentColor {
  return isAccentColor(value) ? value : DEFAULT_ACCENT_COLOR
}

/* -------------------------------------------------------------------------- */
/*  Banner shot                                                               */
/* -------------------------------------------------------------------------- */

/** Mirrors `BANNER_SHOTS` in `apps/web/components/three/scene.ts`. */
export const PROFILE_BANNER_SHOTS = ["stands", "centre", "goalmouth", "touchline", "aerial", "tunnel"] as const
export type ProfileBannerShot = (typeof PROFILE_BANNER_SHOTS)[number]
export const DEFAULT_BANNER_SHOT: ProfileBannerShot = "stands"

export const BANNER_SHOT_LABEL: Record<ProfileBannerShot, { title: string; hint: string }> = {
  stands: { title: "Tribün", hint: "Köşe bayrağının üstünden, bütün saha karede." },
  centre: { title: "Orta yuvarlak", hint: "Krampon hizasından, santra noktasında." },
  goalmouth: { title: "Kale ağzı", hint: "Kalenin arkasından, sahanın boyuna bakarken." },
  touchline: { title: "Taç çizgisi", hint: "Kafesin dışından, tel örgüden içeri." },
  aerial: { title: "Kuş bakışı", hint: "Yukarıdan, çizgiler okunur." },
  tunnel: { title: "Tünel", hint: "Alçaktan ve ortadan, sahaya çıkarken." },
}

export const bannerShotSchema = z.enum(PROFILE_BANNER_SHOTS)

export function bannerShotOf(value: string | null | undefined): ProfileBannerShot {
  return typeof value === "string" && (PROFILE_BANNER_SHOTS as readonly string[]).includes(value)
    ? (value as ProfileBannerShot)
    : DEFAULT_BANNER_SHOT
}

/* -------------------------------------------------------------------------- */
/*  The rest                                                                  */
/* -------------------------------------------------------------------------- */

export const DOMINANT_FEET = ["left", "right", "both"] as const
export type DominantFoot = (typeof DOMINANT_FEET)[number]
export const DOMINANT_FOOT_LABEL: Record<DominantFoot, string> = {
  left: "Sol",
  right: "Sağ",
  both: "İkisi de",
}
export const dominantFootSchema = z.enum(DOMINANT_FEET)

export const MESSAGING_POLICIES = ["everyone", "teammates", "nobody"] as const
export type MessagingPolicy = (typeof MESSAGING_POLICIES)[number]
export const DEFAULT_MESSAGING_POLICY: MessagingPolicy = "teammates"

export const MESSAGING_POLICY_LABEL: Record<MessagingPolicy, { title: string; hint: string }> = {
  everyone: {
    title: "Herkes",
    hint: "Giriş yapmış her üye sana yazabilir. Engellediklerin hariç.",
  },
  teammates: {
    title: "Takım arkadaşları",
    hint: "Aynı takımda oynadıkların ve rezervasyon ilişkin olan işletmeler. Varsayılan.",
  },
  nobody: {
    title: "Hiç kimse",
    hint: "Kimse yeni sohbet başlatamaz; açık sohbetlere de yeni mesaj gelmez.",
  },
}
export const messagingPolicySchema = z.enum(MESSAGING_POLICIES)

export const TAGLINE_MAX = 80
export const JERSEY_NUMBER_MIN = 0
export const JERSEY_NUMBER_MAX = 99

/** The customisable slice of a profile, as the account form and the preview card see it. */
export const profileStyleSchema = z.object({
  accentColor: accentColorSchema,
  bannerShot: bannerShotSchema,
  tagline: z.string().max(TAGLINE_MAX).nullable(),
  jerseyNumber: z.number().int().min(JERSEY_NUMBER_MIN).max(JERSEY_NUMBER_MAX).nullable(),
  dominantFoot: dominantFootSchema.nullable(),
})
export type ProfileStyle = z.infer<typeof profileStyleSchema>

/** Read the style off any row-shaped object without trusting it. */
export function profileStyleOf(row: {
  accent_color?: string | null
  banner_shot?: string | null
  tagline?: string | null
  jersey_number?: number | null
  dominant_foot?: string | null
}): ProfileStyle {
  const foot = row.dominant_foot
  return {
    accentColor: accentColorOf(row.accent_color),
    bannerShot: bannerShotOf(row.banner_shot),
    tagline: row.tagline ?? null,
    jerseyNumber: typeof row.jersey_number === "number" ? row.jersey_number : null,
    dominantFoot:
      typeof foot === "string" && (DOMINANT_FEET as readonly string[]).includes(foot) ? (foot as DominantFoot) : null,
  }
}

/** "Ayşe Demir" → "AD"; "Ayşe" → "AY"; "" → "?". */
export function initialsOf(name: string | null | undefined): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return "?"
  if (parts.length === 1) return parts[0]!.slice(0, 2).toLocaleUpperCase("tr-TR")
  return `${parts[0]![0] ?? ""}${parts[parts.length - 1]![0] ?? ""}`.toLocaleUpperCase("tr-TR")
}
