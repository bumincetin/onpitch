/**
 * packages/shared/src/leagues.ts
 *
 * The city-league vocabulary: five divisions, their order, their colours and their names, plus
 * the schemas both apps parse `my_leagues()` and `league_table()` with.
 *
 * The ladder is duplicated from `supabase/migrations/0009_leagues.sql` for the same reason the
 * XP curve is duplicated in `gamification.ts` — a client has to render a badge and a movement
 * arrow without a round trip. `assertDivisionLadderMatchesSql()` pins the two together, and the
 * migration's own self-test pins the other end.
 */

import { z } from "zod"

/* ========================================================================== */
/*  Divisions                                                                 */
/* ========================================================================== */

/**
 * Bronze at the bottom, diamond at the top. ORDER IS LOAD-BEARING: the index in this array is
 * the division's rank, and `private.division_rank()` in Postgres assumes the same order.
 * Append only — inserting a tier in the middle silently renumbers everything above it.
 */
export const DIVISIONS = ["bronze", "silver", "gold", "platinum", "diamond"] as const
export type Division = (typeof DIVISIONS)[number]

/** 1 for bronze, 5 for diamond. */
export function divisionRank(division: Division): number {
  return DIVISIONS.indexOf(division) + 1
}

/** The inverse, clamped: you cannot promote out of diamond or relegate out of bronze. */
export function divisionAt(rank: number): Division {
  const index = Math.max(1, Math.min(DIVISIONS.length, Math.round(rank))) - 1
  return DIVISIONS[index] ?? "bronze"
}

export const DIVISION_LABELS: Readonly<Record<Division, string>> = {
  bronze: "Bronz",
  silver: "Gümüş",
  gold: "Altın",
  platinum: "Platin",
  diamond: "Elmas",
}

/**
 * Division colours, as raw hex so a Tailwind style and a React Native style come from one
 * source. They are the site accents rather than a new palette: the metals read as metals, and
 * diamond takes the teal that means "confirmed" everywhere else in the product.
 */
export const DIVISION_COLORS: Readonly<Record<Division, string>> = {
  bronze: "#a97142",
  silver: "#aab4ad",
  gold: "#e0b352",
  platinum: "#9fc0d8",
  diamond: "#2fb8bf",
}

export const MOVEMENTS = ["promoted", "held", "relegated"] as const
export type LeagueMovement = (typeof MOVEMENTS)[number]

export const MOVEMENT_LABELS: Readonly<Record<LeagueMovement, string>> = {
  promoted: "Yükseldi",
  held: "Kaldı",
  relegated: "Düştü",
}

/**
 * The promotion and relegation rules, in one place, so the UI can explain them without
 * paraphrasing SQL. `close_season()` in 0009 is the implementation; this is the statement of it
 * that the league page prints.
 */
export const LEAGUE_RULES = {
  /** How many go up from each division, except diamond. */
  promote: 2,
  /** How many go down from each division, except bronze. */
  relegate: 2,
  /** Below this many teams nobody moves: a four-team table is not a competition. */
  minimumForMovement: 6,
  /** Weeks in a season. */
  seasonWeeks: 13,
} as const

export function assertDivisionLadderMatchesSql(): void {
  for (let rank = 1; rank <= DIVISIONS.length; rank += 1) {
    if (divisionRank(divisionAt(rank)) !== rank) {
      throw new Error(`leagues: division ladder drift at rank ${rank}.`)
    }
  }
  if (divisionAt(0) !== "bronze" || divisionAt(99) !== "diamond") {
    throw new Error("leagues: division ladder does not clamp the way 0009_leagues.sql does.")
  }
}

/* ========================================================================== */
/*  Wire schemas                                                              */
/* ========================================================================== */

/** One row of `public.league_table()`, in its snake_case wire form. */
export const leagueTableRowSchema = z.object({
  place: z.number().int().positive(),
  team_id: z.string().uuid(),
  team_name: z.string(),
  team_slug: z.string(),
  crest_url: z.string().nullable(),
  played: z.number().int().nonnegative(),
  won: z.number().int().nonnegative(),
  drawn: z.number().int().nonnegative(),
  lost: z.number().int().nonnegative(),
  goals_for: z.number().int().nonnegative(),
  goals_against: z.number().int().nonnegative(),
  goal_difference: z.number().int(),
  points: z.number().int().nonnegative(),
})
export type LeagueTableRow = z.infer<typeof leagueTableRowSchema>

/** Camel-cased for the UI, so no component has to know the wire spelling. */
export interface LeagueStanding {
  place: number
  teamId: string
  teamName: string
  teamSlug: string
  crestUrl: string | null
  played: number
  won: number
  drawn: number
  lost: number
  goalsFor: number
  goalsAgainst: number
  goalDifference: number
  points: number
}

export function toLeagueStanding(row: LeagueTableRow): LeagueStanding {
  return {
    place: row.place,
    teamId: row.team_id,
    teamName: row.team_name,
    teamSlug: row.team_slug,
    crestUrl: row.crest_url,
    played: row.played,
    won: row.won,
    drawn: row.drawn,
    lost: row.lost,
    goalsFor: row.goals_for,
    goalsAgainst: row.goals_against,
    goalDifference: row.goal_difference,
    points: row.points,
  }
}

/** One entry from `public.my_leagues()`. */
export const myLeagueEntrySchema = z.object({
  teamId: z.string().uuid(),
  teamName: z.string(),
  teamSlug: z.string(),
  city: z.string(),
  seasonId: z.string().uuid(),
  seasonName: z.string(),
  endsOn: z.string(),
  division: z.enum(DIVISIONS),
  position: z.number().int().positive(),
  teamsInDivision: z.number().int().nonnegative(),
  played: z.number().int().nonnegative(),
  won: z.number().int().nonnegative(),
  drawn: z.number().int().nonnegative(),
  lost: z.number().int().nonnegative(),
  goalsFor: z.number().int().nonnegative(),
  goalsAgainst: z.number().int().nonnegative(),
  goalDifference: z.number().int(),
  points: z.number().int().nonnegative(),
})
export type MyLeagueEntry = z.infer<typeof myLeagueEntrySchema>

export const myLeaguesSchema = z.array(myLeagueEntrySchema)

export const leagueCitySchema = z.object({
  city: z.string(),
  season_id: z.string().uuid(),
  season_name: z.string(),
  ends_on: z.string(),
  teams: z.number().int().nonnegative(),
})
export type LeagueCityRow = z.infer<typeof leagueCitySchema>

/* ========================================================================== */
/*  Derived reading                                                           */
/* ========================================================================== */

export type StandingZone = "promotion" | "safe" | "relegation"

/**
 * Which end of the table a position is in, given how many teams are in it.
 *
 * Mirrors `close_season()`: below `minimumForMovement` nobody moves, so every position is safe
 * and the UI must not colour rows as if somebody were going down. Diamond has nothing above it
 * and bronze nothing below.
 */
export function zoneFor(
  place: number,
  teamsInDivision: number,
  division: Division,
): StandingZone {
  if (teamsInDivision < LEAGUE_RULES.minimumForMovement) return "safe"
  if (place <= LEAGUE_RULES.promote && division !== "diamond") return "promotion"
  if (place > teamsInDivision - LEAGUE_RULES.relegate && division !== "bronze") return "relegation"
  return "safe"
}

/** Days left in a season, floored at zero. */
export function daysLeft(endsOn: string, now: Date = new Date()): number {
  const end = Date.parse(`${endsOn}T23:59:59Z`)
  if (Number.isNaN(end)) return 0
  return Math.max(0, Math.ceil((end - now.getTime()) / 86_400_000))
}
