/**
 * app/(app)/matches/[id]/page.tsx
 *
 * One match, in full. A Server Component: everything that can be rendered on the server is, and
 * only three things become client islands — the consensus panel (it hashes in the browser), the
 * score reporter (it writes) and the roster (it can layer presence on top).
 *
 * The page is deliberately a hub rather than a live view. `/matches/[id]/live` holds the socket;
 * this page reads the row, so it stays fast, cacheable-shaped and fully readable with JavaScript
 * disabled up to the point where a form is genuinely needed.
 */

import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"

import { getSessionUser } from "@/lib/rbac"
import { createClient } from "@/lib/supabase/server"
import { isUuid } from "@halisaha/shared/channels"
import {
  MATCH_FORMAT_LABEL,
  MATCH_FORMAT_PLAYERS_PER_SIDE,
  MATCH_STATUS_META,
  formatKickoff,
  formatRelative,
} from "@/components/match/match-card"
import { ConsensusPanel } from "@/components/match/consensus-panel"
import { MatchPrivateListener } from "@/components/match/match-private-listener"
import { RatingDelta } from "@/components/match/rating-delta"
import { Roster, type RosterPlayer } from "@/components/match/roster"
import { ScoreReporter } from "@/components/match/score-reporter"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "Maç",
  description: "Kadro, sonuç ve sonucun nasıl onaylandığının kaydı.",
}

const NIL_UUID = "00000000-0000-0000-0000-000000000000"

/** `report_window_hours` in `0005_integrity_consensus.sql`. Mirrored to render honest UI. */
const REPORT_WINDOW_HOURS = 48

export default async function MatchDetailPage({ params }: { params: { id: string } }) {
  // Reject a malformed id before it reaches PostgREST: `uuid = 'nonsense'` raises 22P02, which
  // surfaces as a 500 rather than the 404 this obviously is.
  if (!isUuid(params.id)) notFound()

  const session = await getSessionUser()
  if (!session) return null

  const supabase = await createClient()
  const viewerId = session.user.id

  const { data: match } = await supabase
    .from("matches")
    .select(
      // One long literal on purpose: postgrest-js derives the row type from the select string as a
      // literal type, and `"a" + "b"` widens to `string`, which loses the typing entirely.
      "id, kickoff_at, duration_minutes, format, status, home_score, away_score, is_ranked, requires_consensus, consensus_deadline, score_confirmed_at, venue_id, pitch_id, home_team_id, away_team_id, created_by, updated_at",
    )
    .eq("id", params.id)
    .maybeSingle()

  // No row means either "does not exist" or "you may not see it", and the page must not
  // distinguish the two — telling a stranger a match id is real is itself a disclosure.
  if (!match) notFound()

  const teamIds = [match.home_team_id, match.away_team_id].filter(
    (id): id is string => typeof id === "string",
  )

  const [venueResult, pitchResult, teamsResult, participantsResult, ownReportResult, ownStatsResult] =
    await Promise.all([
      supabase
        .from("venues")
        .select("id, name, city, district, timezone")
        .eq("id", match.venue_id ?? NIL_UUID)
        .maybeSingle(),
      supabase
        .from("pitches")
        .select("id, name, surface, is_indoor")
        .eq("id", match.pitch_id ?? NIL_UUID)
        .maybeSingle(),
      supabase.from("teams").select("id, name, slug").in("id", teamIds.length ? teamIds : [NIL_UUID]),
      supabase
        .from("match_participants")
        .select("player_id, team_side, is_confirmed")
        .eq("match_id", match.id),
      supabase
        .from("score_reports")
        .select("home_score, away_score, reported_at")
        .eq("match_id", match.id)
        .eq("reported_by", viewerId)
        .maybeSingle(),
      supabase
        .from("player_stats")
        .select("mu_before, sigma_before, mu_after, sigma_after")
        .eq("match_id", match.id)
        .eq("player_id", viewerId)
        .maybeSingle(),
    ])

  const participants = participantsResult.data ?? []
  const playerIds = participants.map((participant) => participant.player_id)

  // Profiles and ratings for the whole line-up in two reads. `player_ratings` is world-readable to
  // signed-in users by design (0002 §5.10) — the NAME attached to a rating is what the profiles
  // policies protect, which is why a display name can come back null here for someone whose
  // profile the viewer may not see.
  const [profilesResult, ratingsResult, reportCountResult] = await Promise.all([
    supabase
      .from("profiles")
      .select("id, display_name, full_name")
      .in("id", playerIds.length ? playerIds : [NIL_UUID]),
    supabase
      .from("player_ratings")
      .select("player_id, conservative_rating")
      .in("player_id", playerIds.length ? playerIds : [NIL_UUID]),
    supabase
      .from("score_reports")
      .select("id", { count: "exact", head: true })
      .eq("match_id", match.id),
  ])

  const profiles = new Map((profilesResult.data ?? []).map((row) => [row.id, row]))
  const ratings = new Map((ratingsResult.data ?? []).map((row) => [row.player_id, row]))
  const teams = new Map((teamsResult.data ?? []).map((row) => [row.id, row]))

  const rosterPlayers: RosterPlayer[] = participants.map((participant) => {
    const profile = profiles.get(participant.player_id)
    return {
      playerId: participant.player_id,
      displayName: profile?.display_name ?? profile?.full_name ?? null,
      teamSide: participant.team_side === "home" || participant.team_side === "away" ? participant.team_side : null,
      isConfirmed: participant.is_confirmed,
      conservativeRating: ratings.get(participant.player_id)?.conservative_rating ?? null,
      isSelf: participant.player_id === viewerId,
    }
  })

  const venue = venueResult.data
  const pitch = pitchResult.data
  const timeZone = venue?.timezone ?? "Europe/Istanbul"
  const kickoff = formatKickoff(match.kickoff_at, timeZone)
  const status = MATCH_STATUS_META[match.status]

  const homeTeamName = match.home_team_id ? (teams.get(match.home_team_id)?.name ?? null) : null
  const awayTeamName = match.away_team_id ? (teams.get(match.away_team_id)?.name ?? null) : null

  const isParticipant = participants.some((participant) => participant.player_id === viewerId)
  const isOrganiser = match.created_by === viewerId

  /*
   * Whether to OFFER the report form. Every one of these conditions is re-checked by
   * `trg_score_reports_validate` inside the writing transaction, which is the only place they are
   * enforced; this is here so the UI does not dangle a form that can only be refused.
   */
  const kickoffMs = Date.parse(match.kickoff_at)
  const windowClosesMs = kickoffMs + REPORT_WINDOW_HOURS * 3_600_000
  const nowMs = Date.now()
  const canReport =
    isParticipant &&
    !match.score_confirmed_at &&
    match.status !== "cancelled" &&
    match.status !== "finalized" &&
    nowMs >= kickoffMs &&
    nowMs <= windowClosesMs

  const hasScore = match.home_score !== null && match.away_score !== null

  return (
    <div className="space-y-6">
      {/*
        The only subscriber to `match:<id>:private`. It renders nothing and holds no state — it
        joins the private lane 0006 §6 already broadcasts to and calls router.refresh(), which is
        what makes the server-rendered gates below (the consensus panel, the dispute banner) show
        up without a navigation. Participants only: rt_match_private_read admits nobody else, so
        mounting it for a spectator would only produce a join that is never authorised.
      */}
      {isParticipant ? <MatchPrivateListener matchId={match.id} /> : null}

      {/* ---------------- header ---------------- */}
      <header className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={status.variant} className={status.className}>
            {status.label}
          </Badge>
          <Badge variant="outline">{MATCH_FORMAT_LABEL[match.format]}</Badge>
          <Badge variant="outline">{match.is_ranked ? "Ranked" : "Friendly"}</Badge>
          {isOrganiser ? <Badge variant="secondary">Bu maçı sen kurdun</Badge> : null}
        </div>

        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          {homeTeamName ?? "Home"} <span className="text-muted-foreground">vs</span>{" "}
          {awayTeamName ?? "Away"}
        </h1>

        <p className="text-sm text-muted-foreground">
          <time dateTime={match.kickoff_at} title={kickoff.full}>
            {kickoff.date}, {kickoff.time}
          </time>{" "}
          <span aria-hidden="true">·</span> {match.duration_minutes} min{" "}
          <span aria-hidden="true">·</span>{" "}
          <span className="whitespace-nowrap">{formatRelative(match.kickoff_at)}</span>
          {venue ? (
            <>
              {" "}
              <span aria-hidden="true">·</span>{" "}
              {[pitch?.name, venue.name, venue.district, venue.city].filter(Boolean).join(", ")}
            </>
          ) : null}
        </p>

        {match.status === "live" ? (
          <Link
            href={`/matches/${match.id}/live`}
            className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          >
            Canlı skoru aç
          </Link>
        ) : null}
      </header>

      {/* ---------------- result ---------------- */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{hasScore ? "Result" : "No result yet"}</CardTitle>
          <CardDescription>{status.description}</CardDescription>
        </CardHeader>
        <CardContent>
          {hasScore ? (
            <p className="text-4xl font-bold tabular-nums">
              <span className="sr-only">
                {homeTeamName ?? "Home"} {match.home_score}, {awayTeamName ?? "Away"}{" "}
                {match.away_score}
              </span>
              <span aria-hidden="true">
                {match.home_score}
                <span className="px-2 text-muted-foreground">–</span>
                {match.away_score}
              </span>
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              {(reportCountResult.count ?? 0) === 0
                ? "Nobody has reported a score."
                : `${reportCountResult.count} ${reportCountResult.count === 1 ? "report" : "reports"} filed so far.`}
            </p>
          )}

          {ownReportResult.data ? (
            <p className="mt-3 text-sm text-muted-foreground tabular-nums">
              You reported {ownReportResult.data.home_score}&ndash;{ownReportResult.data.away_score}.
            </p>
          ) : null}

          {/*
            Other people's reported scorelines are deliberately NOT shown before the result is
            settled, even though RLS would let this viewer read them. Corroboration only means
            something if the second reporter did not copy the first, and a screen that shows the
            answer turns an independent check into an echo. The COUNT is safe and useful; the
            values are not.
          */}
        </CardContent>
      </Card>

      {/* ---------------- consensus ---------------- */}
      {match.requires_consensus ? (
        <ConsensusPanel
          matchId={match.id}
          viewerId={viewerId}
          deadline={match.consensus_deadline}
          homeTeamName={homeTeamName}
          awayTeamName={awayTeamName}
          canVote={isParticipant}
          timeZone={timeZone}
        />
      ) : null}

      {match.status === "disputed" ? (
        <Alert>
          <AlertTitle>Bir yönetici bu maçı karara bağlıyor</AlertTitle>
          <AlertDescription>
            Oyuncular skorda anlaşamadı; sonuç — ve varsa reyting değişimi — elle karara bağlanana kadar beklemede.
          </AlertDescription>
        </Alert>
      ) : null}

      {/* ---------------- reporting ---------------- */}
      {canReport ? (
        <ScoreReporter
          matchId={match.id}
          reporterId={viewerId}
          homeTeamName={homeTeamName}
          awayTeamName={awayTeamName}
          alreadyReported={Boolean(ownReportResult.data)}
        />
      ) : isParticipant && !match.score_confirmed_at && nowMs > windowClosesMs ? (
        <Alert>
          <AlertTitle>Bildirim süresi kapandı</AlertTitle>
          <AlertDescription>
            Scores can be self-reported for {REPORT_WINDOW_HOURS} hours after kickoff. After that the
            venue or an administrator records the result.
          </AlertDescription>
        </Alert>
      ) : null}

      {/* ---------------- line-up ---------------- */}
      {/*
        `live` is false: this page holds no channel on the wide `match:<id>` topic, and opening
        one here would collide with the live screen if a player had both tabs open on the same
        match. (MatchPrivateListener above is on `match:<id>:private` — a different topic, so it
        does not collide.)
      */}
      <Roster
        matchId={match.id}
        players={rosterPlayers}
        homeTeamName={homeTeamName}
        awayTeamName={awayTeamName}
        capacityPerSide={MATCH_FORMAT_PLAYERS_PER_SIDE[match.format]}
        live={false}
      />

      {/* ---------------- your rating ---------------- */}
      {isParticipant ? (
        <RatingDelta
          muBefore={ownStatsResult.data?.mu_before ?? null}
          sigmaBefore={ownStatsResult.data?.sigma_before ?? null}
          muAfter={ownStatsResult.data?.mu_after ?? null}
          sigmaAfter={ownStatsResult.data?.sigma_after ?? null}
          isRanked={match.is_ranked}
        />
      ) : null}
    </div>
  )
}
