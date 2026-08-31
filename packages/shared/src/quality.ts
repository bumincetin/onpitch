/**
 * packages/shared/src/quality.ts
 *
 * "Suggest me a match" — ranking OPEN matches for one specific player.
 *
 * `balance.ts` answers "given these people, who plays with whom?".
 * This file answers the question before that: "of the matches looking for
 * players tonight, which ones should I show you first?".
 *
 * ── The scoring model ────────────────────────────────────────────────────────
 * Five components, each normalised to [0,1] BEFORE weighting, then combined as a
 * weighted mean. Normalising first is what makes the weights readable: a weight
 * is literally the share of the final score that term can contribute, and the
 * weights sum to 1, so the output is itself in [0,1] and comparable across
 * players and across days.
 *
 *   ratingProximity     TrueSkill match quality of "you, added to that fixture".
 *                       Not a raw rating difference — quality already folds in
 *                       how CERTAIN the model is, so an unrated newcomer is not
 *                       ranked as a perfect fit for a squad of veterans.
 *   distance            Haversine great-circle km from the player to the venue,
 *                       decayed exponentially. SKIPPED ENTIRELY FOR MINORS.
 *   kickoffPreference   How well the kickoff hour matches the hours the player
 *                       actually plays, plus a mild penalty for very-soon and
 *                       very-distant fixtures.
 *   formatPreference    Exact format match, partial credit for an adjacent size.
 *   noShowReliability   How reliably the people ALREADY in that match turn up.
 *
 * ── Minors: the privacy default propagates into the algorithm ────────────────
 * `profiles.location_sharing_enabled` is forced false for minors by a CHECK
 * constraint in 0001 and by `enforce_minor_privacy()` in 0003. This ranker does
 * not work around that. For a minor (or any adult with sharing off) the distance
 * term is not estimated, not defaulted to a neutral 0.5, and not back-filled
 * from the city — it is REMOVED, and its weight is redistributed proportionally
 * across the remaining terms so the score stays on the same [0,1] scale and a
 * minor is not systematically ranked below an adult. `distanceKm` comes back
 * `null`, which is the honest wire value and what `MatchmakingCandidate`
 * declares.
 *
 * ── On "the player's no-show history" ────────────────────────────────────────
 * The caller's OWN no-show rate is a constant across every candidate, so it
 * cannot re-order anything — including it would only rescale the whole list.
 * What varies per candidate, and what actually predicts a good evening, is
 * whether the people already signed up turn up. That is what the term measures.
 * The caller's own rate is still accepted and returned as `callerNoShowRate`
 * so the UI can nudge ("you have missed 3 of your last 10 — organisers see
 * that"), it just does not distort the ranking.
 *
 * Nothing here does I/O; the route handler gathers the rows.
 */

import type { Enums } from "./database"
import type { MatchQuality, MatchmakingCandidate, RatingSnapshot } from "./domain"

import { chooseSideForJoin, FORMAT_TEAM_SIZE } from "./balance"
import { defaultRating, matchQuality, outcomeProbabilities, type Rating, type TrueSkillConfig } from "./trueskill"

/* ========================================================================== */
/*  Tunables                                                                  */
/* ========================================================================== */

export interface MatchmakingWeights {
  ratingProximity: number
  distance: number
  kickoffPreference: number
  formatPreference: number
  noShowReliability: number
}

/**
 * The weights. They MUST sum to 1 — `assertWeightsNormalised()` below checks it
 * at module load so a bad edit fails immediately rather than silently producing
 * scores above 1.
 *
 * Rationale for the split:
 *   * Balance carries 45%, so a genuinely even fixture 20km away still beats a
 *     mismatch around the corner.
 *   * Distance is 20%: real, but people will travel for a good game.
 *   * Time is 20%: a brilliant match at 07:00 on a Tuesday is not a match.
 *   * Format is 10%: most players will play 7s or 8s, few care intensely.
 *   * Reliability is 5%: a real signal, but it is built from sparse data early
 *     on and must never dominate. Deliberately the smallest weight.
 */
export const MATCHMAKING_WEIGHTS: Readonly<MatchmakingWeights> = Object.freeze({
  ratingProximity: 0.45,
  distance: 0.2,
  kickoffPreference: 0.2,
  formatPreference: 0.1,
  noShowReliability: 0.05,
})

/** Distance at which the distance term has decayed to 1/e (~0.37). */
export const DISTANCE_DECAY_KM = 12

/** Beyond this the distance term is 0 outright; the venue is a different city. */
export const DISTANCE_HARD_LIMIT_KM = 75

/** Kickoffs sooner than this are penalised: nobody can get there in time. */
export const MIN_LEAD_TIME_MINUTES = 45

/** Kickoffs further out than this are discounted: too speculative to act on. */
export const MAX_LEAD_TIME_DAYS = 14

/** Mean radius of the Earth in kilometres (IUGG). */
const EARTH_RADIUS_KM = 6371.0088

/* ========================================================================== */
/*  Inputs                                                                    */
/* ========================================================================== */

/** Everything the ranker needs to know about the person asking. */
export interface SeekerContext {
  playerId: string
  rating: RatingSnapshot
  /**
   * Drives the privacy branch. Read from `profiles.is_minor`, which is a
   * GENERATED column — never inferred client-side from a date of birth.
   */
  isMinor: boolean
  /** `profiles.location_sharing_enabled`. False for every minor, by constraint. */
  locationSharingEnabled: boolean
  /** Only meaningful when `locationSharingEnabled` is true. */
  latitude?: number | null
  longitude?: number | null
  city?: string | null
  /** `profiles.preferred_position`, free text. Unused for ranking; carried for parity. */
  preferredPosition?: string | null
  /** Formats the player has actually played, most recent first. May be empty. */
  recentFormats?: readonly Enums<"match_format">[]
  /** Local hours (0..23) the player usually kicks off at. Empty = no preference. */
  preferredKickoffHours?: readonly number[]
  /** The caller's own no-show rate in [0,1]. Reported, never ranked on — see header. */
  noShowRate?: number
}

/** One open match, as assembled by `GET /api/matchmaking/suggest`. */
export interface MatchCandidateInput {
  matchId: string
  kickoffAt: string
  format: Enums<"match_format">
  status: Enums<"match_status">
  venueId: string | null
  venueName: string | null
  city: string | null
  venueLatitude?: number | null
  venueLongitude?: number | null
  /** Current home line-up's ratings. */
  homeRatings: readonly Rating[]
  /** Current away line-up's ratings. */
  awayRatings: readonly Rating[]
  /** `2 * teamSize - participants`, never negative. */
  spotsRemaining: number
  isRanked: boolean
  /**
   * No-show rate in [0,1] for each player already in the match. Empty when the
   * platform has no attendance history yet, which is the common early case.
   */
  participantNoShowRates?: readonly number[]
}

export interface RankOptions {
  /** Overrides for experimentation. Missing keys fall back to the defaults. */
  weights?: Partial<MatchmakingWeights>
  /** Evaluation instant. Injected so ranking is a pure function and testable. */
  now?: Date
  /** IANA-ish hour offset used to read the kickoff hour. Defaults to +03:00 (Turkey). */
  utcOffsetMinutes?: number
  /** Runtime override of `public.rating_config`. */
  config?: Partial<TrueSkillConfig>
  /** Drop candidates scoring below this. Default 0 (keep everything). */
  minScore?: number
  /** Truncate after ranking. Default 25. */
  limit?: number
}

/* ========================================================================== */
/*  Entry points                                                              */
/* ========================================================================== */

/**
 * Rank candidates for one player, best first.
 *
 * The sort is total and deterministic: score descending, then earlier kickoff,
 * then `matchId` ascending. Two runs over the same data always produce the same
 * order, which matters because "refresh until a better match appears" is not a
 * feature.
 */
export function rankCandidates(
  seeker: SeekerContext,
  candidates: readonly MatchCandidateInput[],
  options: RankOptions = {},
): MatchmakingCandidate[] {
  const scored = candidates.map((candidate) => scoreCandidate(seeker, candidate, options))
  const minScore = options.minScore ?? 0
  const limit = Math.max(1, Math.trunc(options.limit ?? 25))

  return scored
    .filter((c) => c.score >= minScore)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      const ka = Date.parse(a.kickoffAt)
      const kb = Date.parse(b.kickoffAt)
      if (ka !== kb) return ka - kb
      return a.matchId < b.matchId ? -1 : a.matchId > b.matchId ? 1 : 0
    })
    .slice(0, limit)
}

/**
 * Score ONE candidate. Exported so a match detail page can explain the number
 * it is showing without re-ranking the whole list.
 */
export function scoreCandidate(
  seeker: SeekerContext,
  candidate: MatchCandidateInput,
  options: RankOptions = {},
): MatchmakingCandidate {
  const weights = { ...MATCHMAKING_WEIGHTS, ...(options.weights ?? {}) }
  const now = options.now ?? new Date()
  const offsetMinutes = options.utcOffsetMinutes ?? 180 // Europe/Istanbul, UTC+3 year-round

  /* -- 1. Rating proximity ------------------------------------------------- */
  // Quality of the fixture WITH the seeker added to the side `POST
  // /api/matches/[id]/join` would actually put them on. The side is chosen by
  // `chooseSideForJoin` — the very function the join route calls — so the score
  // and the preview describe the line-up that will exist, not a different one.
  // Best-effort only: the join route honours an explicit `teamSide` override in
  // the request body, which nothing here can predict.
  const teamSize = FORMAT_TEAM_SIZE[candidate.format]
  const { home, away } = projectSeekerOntoLineup(
    candidate.homeRatings,
    candidate.awayRatings,
    seeker.rating,
    teamSize,
    options.config,
  )
  // Pad both sides to the format size with prior-rating placeholders. Without
  // this a 2-vs-1 kickabout scores higher than a full fixture purely because
  // fewer unknowns means less variance, which is exactly backwards for a match
  // that still needs nine more people.
  const paddedHome = padToSize(home, teamSize, options.config)
  const paddedAway = padToSize(away, teamSize, options.config)

  const ratingProximity = clamp01(matchQuality(paddedHome, paddedAway, options.config))
  const probabilities = outcomeProbabilities(paddedHome, paddedAway, options.config)
  const quality: MatchQuality = {
    quality: probabilities.quality,
    drawProbability: probabilities.drawProbability,
    homeWinProbability: probabilities.homeWinProbability,
    awayWinProbability: probabilities.awayWinProbability,
  }

  /* -- 2. Distance --------------------------------------------------------- */
  // THE PRIVACY BRANCH. A minor never has coordinates to compare, and we do not
  // reach for the city as a proxy either — deriving an approximate location for
  // somebody whose location sharing is off defeats the setting.
  const locationUsable =
    !seeker.isMinor &&
    seeker.locationSharingEnabled &&
    isFiniteNumber(seeker.latitude) &&
    isFiniteNumber(seeker.longitude) &&
    isFiniteNumber(candidate.venueLatitude) &&
    isFiniteNumber(candidate.venueLongitude)

  const distanceKm = locationUsable
    ? haversineKm(
        seeker.latitude as number,
        seeker.longitude as number,
        candidate.venueLatitude as number,
        candidate.venueLongitude as number,
      )
    : null

  const distanceScore = distanceKm === null ? null : distanceDecay(distanceKm)

  /* -- 3. Kickoff preference ---------------------------------------------- */
  const kickoffPreference = scoreKickoff(
    candidate.kickoffAt,
    now,
    offsetMinutes,
    seeker.preferredKickoffHours ?? [],
  )

  /* -- 4. Format preference ------------------------------------------------ */
  const formatPreference = scoreFormat(candidate.format, seeker.recentFormats ?? [])

  /* -- 5. Counterparty reliability ---------------------------------------- */
  const noShowReliability = scoreReliability(candidate.participantNoShowRates ?? [])

  /* -- Combine ------------------------------------------------------------- */
  // When the distance term is absent its weight is redistributed across the
  // others in proportion to their existing weights, so the total stays 1 and a
  // location-private player is neither rewarded nor punished for the gap.
  const terms: Array<{ weight: number; value: number }> = [
    { weight: weights.ratingProximity, value: ratingProximity },
    { weight: weights.kickoffPreference, value: kickoffPreference },
    { weight: weights.formatPreference, value: formatPreference },
    { weight: weights.noShowReliability, value: noShowReliability },
  ]
  if (distanceScore !== null) {
    terms.push({ weight: weights.distance, value: distanceScore })
  }

  const totalWeight = terms.reduce((sum, t) => sum + t.weight, 0)
  const score =
    totalWeight > 0
      ? clamp01(terms.reduce((sum, t) => sum + t.weight * t.value, 0) / totalWeight)
      : 0

  return {
    matchId: candidate.matchId,
    kickoffAt: candidate.kickoffAt,
    format: candidate.format,
    status: candidate.status,
    venueId: candidate.venueId,
    venueName: candidate.venueName,
    city: candidate.city,
    distanceKm: distanceKm === null ? null : round(distanceKm, 2),
    spotsRemaining: Math.max(0, Math.trunc(candidate.spotsRemaining)),
    isRanked: candidate.isRanked,
    quality,
    ratingProximity: round(ratingProximity, 5),
    kickoffPreference: round(kickoffPreference, 5),
    // `MatchmakingCandidate.noShowPenalty` is declared as a component score in
    // [0,1] like its siblings. It carries RELIABILITY (1 = everyone turns up),
    // so the arithmetic stays "higher is better" everywhere.
    noShowPenalty: round(noShowReliability, 5),
    score: round(score, 5),
  }
}

/* ========================================================================== */
/*  Component scorers — each exported so they can be unit-tested directly     */
/* ========================================================================== */

/**
 * Great-circle distance in kilometres.
 *
 * Haversine is used rather than the equirectangular approximation because at
 * Turkish latitudes the cheap version is already ~0.5% off over 50km, and
 * rather than Vincenty because sub-metre geodesic accuracy is irrelevant when
 * the venue coordinate itself is a pin dropped on a car park.
 */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = Math.PI / 180
  const dLat = (lat2 - lat1) * toRad
  const dLon = (lon2 - lon1) * toRad
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) * Math.sin(dLon / 2)
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)))
}

/**
 * Exponential decay, hard-zeroed past the limit.
 *
 * Exponential rather than linear because the felt difference between 2km and
 * 6km is large and between 40km and 44km is nil — which is exactly the shape
 * `exp(-d/k)` has.
 */
export function distanceDecay(distanceKm: number): number {
  if (!Number.isFinite(distanceKm) || distanceKm < 0) return 0
  if (distanceKm >= DISTANCE_HARD_LIMIT_KM) return 0
  return clamp01(Math.exp(-distanceKm / DISTANCE_DECAY_KM))
}

/**
 * How well a kickoff suits the player: an hour-of-day fit multiplied by a
 * lead-time window.
 *
 * The hour fit is circular — 23:00 is one hour from 00:00, not twenty-three —
 * because five-a-side genuinely runs past midnight.
 */
export function scoreKickoff(
  kickoffAt: string,
  now: Date,
  utcOffsetMinutes: number,
  preferredHours: readonly number[],
): number {
  const kickoff = Date.parse(kickoffAt)
  if (!Number.isFinite(kickoff)) return 0

  const leadMinutes = (kickoff - now.getTime()) / 60000

  // Already started, or too soon to travel to.
  if (leadMinutes < MIN_LEAD_TIME_MINUTES) return 0

  const leadDays = leadMinutes / (60 * 24)
  // Linear taper from "today" (1.0) to the horizon (0.25). Not zero at the
  // horizon: a great match a fortnight out is still worth surfacing, just below
  // an equally good one tomorrow.
  const leadFit =
    leadDays >= MAX_LEAD_TIME_DAYS ? 0.25 : clamp01(1 - 0.75 * (leadDays / MAX_LEAD_TIME_DAYS))

  if (preferredHours.length === 0) {
    // No history yet. Return the lead-time fit alone rather than inventing a
    // preference — a neutral 0.5 would rank a 06:00 match level with a 20:00 one.
    return round(leadFit, 5)
  }

  const kickoffHour = localHour(kickoff, utcOffsetMinutes)
  let bestDistance = 12 // maximum possible circular distance on a 24h clock
  for (const hour of preferredHours) {
    if (!Number.isFinite(hour)) continue
    const normalised = ((Math.trunc(hour) % 24) + 24) % 24
    const raw = Math.abs(kickoffHour - normalised)
    const circular = Math.min(raw, 24 - raw)
    if (circular < bestDistance) bestDistance = circular
  }

  // 0h apart -> 1.0, 3h apart -> 0.5, 6h+ apart -> 0.
  const hourFit = clamp01(1 - bestDistance / 6)
  return round(hourFit * leadFit, 5)
}

/**
 * Exact format match scores 1; an adjacent size scores on how close the team
 * sizes are. A 7-a-side regular will happily play 8s, less happily play 11s.
 */
export function scoreFormat(
  format: Enums<"match_format">,
  recentFormats: readonly Enums<"match_format">[],
): number {
  if (recentFormats.length === 0) return 0.6 // no history: mildly positive, not decisive
  if (recentFormats.includes(format)) return 1

  const target = FORMAT_TEAM_SIZE[format]
  let best = 0
  for (const played of recentFormats) {
    const gap = Math.abs(FORMAT_TEAM_SIZE[played] - target)
    best = Math.max(best, clamp01(1 - gap / 4))
  }
  return round(best, 5)
}

/**
 * Reliability of the players already in the match, in [0,1].
 *
 * The mean is deliberately pulled toward 1 by two "phantom reliable" players
 * (additive smoothing). Without it a single member with one recorded no-show in
 * one appearance would drag a promising match to the bottom of the list on a
 * sample of one, which is the classic sparse-data failure of any reputation
 * term.
 */
export function scoreReliability(noShowRates: readonly number[]): number {
  const PRIOR_WEIGHT = 2
  let sum = PRIOR_WEIGHT // the phantom players contribute reliability 1 each
  let n = PRIOR_WEIGHT

  for (const rate of noShowRates) {
    if (!Number.isFinite(rate)) continue
    sum += 1 - clamp01(rate)
    n += 1
  }

  return round(clamp01(sum / n), 5)
}

/* ========================================================================== */
/*  Internals                                                                 */
/* ========================================================================== */

/**
 * Put the seeker on the side `chooseSideForJoin` would put them on.
 *
 * `chooseSideForJoin` is what `POST /api/matches/[id]/join` calls, and it picks
 * the side that maximises post-join quality, only falling back to "smaller side,
 * then home" on an exact tie. Re-implementing just the tie-break here would score
 * a line-up the join route usually will not produce, so this delegates instead.
 *
 * The decision is taken on the UNPADDED line-ups, because that is what the join
 * route compares. Padding to the format size happens afterwards, at the call
 * site, and only to keep the quality number itself honest.
 */
function projectSeekerOntoLineup(
  homeRatings: readonly Rating[],
  awayRatings: readonly Rating[],
  seeker: Rating,
  teamSize: number,
  config?: Partial<TrueSkillConfig>,
): { home: Rating[]; away: Rating[] } {
  const { side } = chooseSideForJoin(homeRatings, awayRatings, seeker, { teamSize, config })
  if (side === "away") {
    return { home: [...homeRatings], away: [...awayRatings, seeker] }
  }
  return { home: [...homeRatings, seeker], away: [...awayRatings] }
}

/** Fill a side out to `size` with fresh-player priors. */
function padToSize(side: readonly Rating[], size: number, config?: Partial<TrueSkillConfig>): Rating[] {
  const out = [...side]
  const prior = defaultRating(config)
  while (out.length < size) out.push(prior)
  return out
}

/** Hour 0..23 at a fixed UTC offset. No DST table: Turkey has not observed DST since 2016. */
function localHour(epochMillis: number, utcOffsetMinutes: number): number {
  const shifted = new Date(epochMillis + utcOffsetMinutes * 60000)
  return shifted.getUTCHours()
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/* ========================================================================== */
/*  Load-time invariant                                                       */
/* ========================================================================== */

/**
 * The weights must sum to 1 or the "score is a share of 1" contract silently
 * breaks. Checked once at module load, in every environment, because a ranker
 * that quietly emits 1.3 is worse than one that refuses to start.
 */
function assertWeightsNormalised(weights: MatchmakingWeights): void {
  const total =
    weights.ratingProximity +
    weights.distance +
    weights.kickoffPreference +
    weights.formatPreference +
    weights.noShowReliability
  if (Math.abs(total - 1) > 1e-9) {
    throw new Error(`MATCHMAKING_WEIGHTS must sum to 1, got ${total}`)
  }
}

assertWeightsNormalised(MATCHMAKING_WEIGHTS)
