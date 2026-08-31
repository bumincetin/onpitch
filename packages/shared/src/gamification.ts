/**
 * packages/shared/src/gamification.ts
 *
 * The progression system's client half: the level curve, the rank titles, the
 * labels for an XP ledger entry, and the schemas both apps parse `my_progress()`
 * and `leaderboard_page()` with.
 *
 * ---------------------------------------------------------------------------
 * THE CURVE IS DUPLICATED ON PURPOSE, AND PINNED
 * ---------------------------------------------------------------------------
 * `private.xp_for_level` / `private.level_for_xp` in
 * `supabase/migrations/0008_gamification.sql` are the authority: `level` is a
 * GENERATED STORED column, so the database's answer is the one that exists.
 * This copy is here so a client can render a progress ring, animate a level-up,
 * and show "120 XP to go" without a round trip.
 *
 * Two things keep the copies honest. The migration ends with a self-test over
 * the same boundary values listed in `LEVEL_CURVE_FIXTURES` below, and
 * `assertLevelCurveMatchesSql()` checks this implementation against them. If
 * either side is edited alone, one of the two fails loudly instead of the two
 * quietly disagreeing about somebody's level.
 */

import { z } from "zod"

/* ========================================================================== */
/*  The level curve                                                           */
/* ========================================================================== */

/**
 * Cumulative XP required to REACH `level`: `50 * L * (L - 1)`.
 *
 *   L1 0 · L2 100 · L3 300 · L4 600 · L5 1000 · L10 4500 · L20 19000
 *
 * The step from L to L+1 is therefore a flat `100 * L`.
 */
export function xpForLevel(level: number): number {
  if (!Number.isFinite(level) || level < 1) return 0
  const l = Math.floor(level)
  return 50 * l * (l - 1)
}

/**
 * The inverse of {@link xpForLevel}.
 *
 * The closed form is `floor((1 + sqrt(1 + xp / 12.5)) / 2)`, but float64 is not
 * reliable exactly ON a boundary — which is the value read most often, because
 * it is the moment somebody levels up — so the candidate is corrected against
 * the exact integer curve. Same two comparisons as the SQL, same answers.
 */
export function levelForXp(xp: number): number {
  const total = Number.isFinite(xp) && xp > 0 ? Math.floor(xp) : 0
  const candidate = Math.max(1, Math.floor((1 + Math.sqrt(1 + total / 12.5)) / 2))

  if (50 * (candidate + 1) * candidate <= total) return candidate + 1
  if (50 * candidate * (candidate - 1) > total) return Math.max(1, candidate - 1)
  return candidate
}

export interface LevelProgress {
  level: number
  /** Cumulative XP at which this level began. */
  floor: number
  /** Cumulative XP at which the next level begins. */
  ceiling: number
  /** XP earned inside the current level. */
  into: number
  /** XP the whole level is worth. */
  span: number
  /** 0..1, for a ring or a bar. */
  ratio: number
  /** XP still to earn before the next level. */
  remaining: number
}

export function levelProgress(xp: number): LevelProgress {
  const total = Number.isFinite(xp) && xp > 0 ? Math.floor(xp) : 0
  const level = levelForXp(total)
  const floor = xpForLevel(level)
  const ceiling = xpForLevel(level + 1)
  const span = Math.max(1, ceiling - floor)
  const into = Math.max(0, total - floor)

  return {
    level,
    floor,
    ceiling,
    into,
    span,
    ratio: Math.min(1, into / span),
    remaining: Math.max(0, ceiling - total),
  }
}

/** The exact pairs the SQL self-test also asserts. Editing one side breaks both. */
export const LEVEL_CURVE_FIXTURES: readonly (readonly [xp: number, level: number])[] = [
  [0, 1],
  [99, 1],
  [100, 2],
  [299, 2],
  [300, 3],
  [999, 4],
  [1000, 5],
  [18999, 19],
  [19000, 20],
]

/**
 * Throws if this module's curve has drifted from the migration's.
 *
 * Called from the web app's progress loader in development, so a drift shows up
 * the first time anybody opens a dashboard rather than the first time somebody
 * notices their level is wrong on one screen and right on another.
 */
export function assertLevelCurveMatchesSql(): void {
  for (const [xp, expected] of LEVEL_CURVE_FIXTURES) {
    const actual = levelForXp(xp)
    if (actual !== expected) {
      throw new Error(
        `gamification: level curve drift — levelForXp(${xp}) is ${actual}, ` +
          `but 0008_gamification.sql pins it to ${expected}.`,
      )
    }
  }
  for (let level = 1; level <= 200; level += 1) {
    if (levelForXp(xpForLevel(level)) !== level) {
      throw new Error(`gamification: level curve drift — round trip failed at level ${level}.`)
    }
  }
}

/* ========================================================================== */
/*  Ranks                                                                     */
/* ========================================================================== */

export interface Rank {
  /** Lowest level that carries this title. */
  from: number
  tr: string
  en: string
}

/**
 * Level bands, so a number also has a name.
 *
 * A level is a fine progress bar and a poor identity. "Seviye 23" tells another
 * player nothing; "Veteran" tells them how long you have been turning up.
 */
export const RANKS: readonly Rank[] = [
  { from: 1, tr: "Çaylak", en: "Rookie" },
  { from: 5, tr: "Amatör", en: "Amateur" },
  { from: 10, tr: "Sahacı", en: "Regular" },
  { from: 20, tr: "Veteran", en: "Veteran" },
  { from: 35, tr: "Usta", en: "Master" },
  { from: 55, tr: "Efsane", en: "Legend" },
]

export function rankForLevel(level: number): Rank {
  let current: Rank = RANKS[0] as Rank
  for (const rank of RANKS) {
    if (level >= rank.from) current = rank
  }
  return current
}

/* ========================================================================== */
/*  Achievements                                                              */
/* ========================================================================== */

export const ACHIEVEMENT_TIERS = ["bronze", "silver", "gold", "platinum"] as const
export type AchievementTier = (typeof ACHIEVEMENT_TIERS)[number]

/**
 * Tier colours, as raw hex so both a Tailwind class and a React Native style can
 * be derived from one source. They are the site accents, not a new palette:
 * bronze is the muted ink, silver the bone, gold the brand accent, platinum the
 * teal reserved elsewhere for "confirmed".
 */
export const TIER_COLORS: Readonly<Record<AchievementTier, string>> = {
  bronze: "#8a6a3d",
  silver: "#aab4ad",
  gold: "#e0b352",
  platinum: "#2fb8bf",
}

export const TIER_LABELS: Readonly<Record<AchievementTier, string>> = {
  bronze: "Bronz",
  silver: "Gümüş",
  gold: "Altın",
  platinum: "Platin",
}

/* ========================================================================== */
/*  XP events                                                                 */
/* ========================================================================== */

export const XP_EVENT_KINDS = [
  "match_played",
  "match_won",
  "match_drawn",
  "goal",
  "assist",
  "clean_sheet",
  "score_reported",
  "consensus_voted",
  "booking_paid",
  "streak_bonus",
  "achievement",
  "challenge",
  "onboarding",
  "admin_adjustment",
] as const
export type XpEventKind = (typeof XP_EVENT_KINDS)[number]

/** Ledger copy. One line per kind, in the language the rest of the product speaks. */
export const XP_EVENT_LABELS: Readonly<Record<XpEventKind, string>> = {
  match_played: "Maça çıktın",
  match_won: "Maçı kazandın",
  match_drawn: "Beraberlik",
  goal: "Gol",
  assist: "Asist",
  clean_sheet: "Gol yemeden bitirdin",
  score_reported: "Sonucu bildirdin",
  consensus_voted: "Uzlaşma oyu verdin",
  booking_paid: "Sahayı sen tuttun",
  streak_bonus: "Seri bonusu",
  achievement: "Rozet kazandın",
  challenge: "Görev tamamlandı",
  onboarding: "Profilini tamamladın",
  admin_adjustment: "Düzeltme",
}

export const PROGRESS_METRICS = [
  "matches_played",
  "matches_won",
  "goals",
  "assists",
  "clean_sheets",
  "bookings_paid",
  "distinct_venues",
  "reports_filed",
  "consensus_votes",
  "late_matches",
  "hat_tricks",
  "best_unbeaten_run",
  "current_streak_weeks",
  "teams_captained",
] as const
export type ProgressMetric = (typeof PROGRESS_METRICS)[number]

/* ========================================================================== */
/*  Wire schemas                                                              */
/* ========================================================================== */

/**
 * `public.my_progress()` returns jsonb, which PostgREST hands over as an opaque
 * object. Parsing it here rather than casting means a schema change in SQL
 * surfaces as one legible error in one place, on both clients, instead of as
 * `undefined` somewhere deep in a render.
 */
export const progressCountersSchema = z.object({
  matchesPlayed: z.number().int().nonnegative(),
  matchesWon: z.number().int().nonnegative(),
  matchesDrawn: z.number().int().nonnegative(),
  matchesLost: z.number().int().nonnegative(),
  goals: z.number().int().nonnegative(),
  assists: z.number().int().nonnegative(),
  cleanSheets: z.number().int().nonnegative(),
  hatTricks: z.number().int().nonnegative(),
  lateMatches: z.number().int().nonnegative(),
  distinctVenues: z.number().int().nonnegative(),
  bookingsPaid: z.number().int().nonnegative(),
  reportsFiled: z.number().int().nonnegative(),
  consensusVotes: z.number().int().nonnegative(),
  teamsCaptained: z.number().int().nonnegative(),
  currentUnbeatenRun: z.number().int().nonnegative(),
  bestUnbeatenRun: z.number().int().nonnegative(),
})
export type ProgressCounters = z.infer<typeof progressCountersSchema>

export const achievementStateSchema = z.object({
  code: z.string(),
  name: z.string(),
  description: z.string(),
  tier: z.enum(ACHIEVEMENT_TIERS),
  target: z.number().int().positive(),
  xpReward: z.number().int().nonnegative(),
  progress: z.number().int().nonnegative(),
  unlockedAt: z.string().nullable(),
})
export type AchievementState = z.infer<typeof achievementStateSchema>

export const challengeStateSchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  title: z.string(),
  description: z.string(),
  target: z.number().int().positive(),
  xpReward: z.number().int().nonnegative(),
  endsOn: z.string(),
  progress: z.number().int().nonnegative(),
  completedAt: z.string().nullable(),
  claimedAt: z.string().nullable(),
})
export type ChallengeState = z.infer<typeof challengeStateSchema>

export const xpEventSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(XP_EVENT_KINDS),
  points: z.number().int(),
  matchId: z.string().uuid().nullable(),
  metadata: z.unknown().optional(),
  createdAt: z.string(),
})
export type XpEvent = z.infer<typeof xpEventSchema>

export const playerProgressSchema = z.object({
  xp: z.number().int().nonnegative(),
  level: z.number().int().positive(),
  levelFloor: z.number().int().nonnegative(),
  nextLevelAt: z.number().int().nonnegative(),
  currentStreakWeeks: z.number().int().nonnegative(),
  longestStreakWeeks: z.number().int().nonnegative(),
  lastPlayedOn: z.string().nullable(),
  counters: progressCountersSchema,
  achievements: z.array(achievementStateSchema),
  challenges: z.array(challengeStateSchema),
  recentEvents: z.array(xpEventSchema),
})
export type PlayerProgress = z.infer<typeof playerProgressSchema>

export const LEADERBOARD_SCOPES = ["xp", "rating", "streak"] as const
export type LeaderboardScope = (typeof LEADERBOARD_SCOPES)[number]

export const LEADERBOARD_SCOPE_LABELS: Readonly<Record<LeaderboardScope, string>> = {
  xp: "Tecrübe",
  rating: "Reyting",
  streak: "Seri",
}

/** One row of `public.leaderboard_page()`, in its snake_case wire form. */
export const leaderboardRowSchema = z.object({
  rank: z.number().int().positive(),
  player_id: z.string().uuid(),
  display_name: z.string(),
  avatar_url: z.string().nullable(),
  city: z.string().nullable(),
  level: z.number().int().positive(),
  xp: z.number().int().nonnegative(),
  conservative_rating: z.number(),
  matches_played: z.number().int().nonnegative(),
  current_streak_weeks: z.number().int().nonnegative(),
})
export type LeaderboardRow = z.infer<typeof leaderboardRowSchema>

/** Camel-cased for the UI, so no component has to know the wire spelling. */
export interface LeaderboardEntry {
  rank: number
  playerId: string
  displayName: string
  avatarUrl: string | null
  city: string | null
  level: number
  xp: number
  conservativeRating: number
  matchesPlayed: number
  currentStreakWeeks: number
}

export function toLeaderboardEntry(row: LeaderboardRow): LeaderboardEntry {
  return {
    rank: row.rank,
    playerId: row.player_id,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    city: row.city,
    level: row.level,
    xp: row.xp,
    conservativeRating: row.conservative_rating,
    matchesPlayed: row.matches_played,
    currentStreakWeeks: row.current_streak_weeks,
  }
}

/* ========================================================================== */
/*  Venue scorecard                                                           */
/* ========================================================================== */

export const VENUE_TIERS = ["bronze", "silver", "gold", "platinum"] as const
export type VenueTier = (typeof VENUE_TIERS)[number]

export const venueScorecardSchema = z.object({
  venueId: z.string().uuid(),
  windowDays: z.number().int().positive(),
  score: z.number().int().nonnegative(),
  tier: z.enum(VENUE_TIERS),
  paidBookings: z.number().int().nonnegative(),
  completedBookings: z.number().int().nonnegative(),
  cancelledBookings: z.number().int().nonnegative(),
  disputedBookings: z.number().int().nonnegative(),
  netMinor: z.number().int(),
  distinctCustomers: z.number().int().nonnegative(),
  nextTierAt: z.number().int().nullable(),
})
export type VenueScorecard = z.infer<typeof venueScorecardSchema>

/* ========================================================================== */
/*  Formatting                                                                */
/* ========================================================================== */

/** `1 240` rather than `1,240` — Turkish groups with a space and this is a Turkish product. */
export function formatXp(xp: number): string {
  const value = Number.isFinite(xp) ? Math.round(xp) : 0
  return value.toLocaleString("tr-TR").replace(/ /g, " ")
}

/**
 * Form as five letters, most recent last: `G` galibiyet, `B` beraberlik, `M` mağlubiyet.
 *
 * Takes results already ordered oldest-first and returns at most the last five,
 * because that is the width the badge row is designed for on a phone.
 */
export function formToLetters(results: readonly ("win" | "draw" | "loss")[]): string[] {
  return results.slice(-5).map((r) => (r === "win" ? "G" : r === "draw" ? "B" : "M"))
}
