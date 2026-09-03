/**
 * app/(app)/matches/[id]/plan/page.tsx
 *
 * The pre-match planner. The server reads the fixture and both rosters (the participants plus
 * each team's active members, so a squad can be seeded even before anyone has joined the match);
 * the client island owns the plan and keeps it in local storage.
 *
 * Authorisation is the `matches` SELECT policy: if the row does not come back, the page 404s the
 * same way the match page does.
 */

import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"

import { getSessionUser } from "@/lib/rbac"
import { createClient } from "@/lib/supabase/server"
import { isUuid } from "@onpitch/shared/channels"
import { pitchFormatFromMatchFormat } from "@onpitch/shared/matchday"
import { PlanWorkspace } from "@/components/matchday/plan-workspace"
import type { RosterSeedPlayer } from "@/lib/matchday/plan"
import { formatKickoff } from "@/components/match/match-card"

export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "Maç planı",
  description: "Kadro, diziliş, eşit süre rotasyonu ve kenar notu.",
}

const NIL_UUID = "00000000-0000-0000-0000-000000000000"

export default async function MatchPlanPage({ params }: { params: { id: string } }) {
  if (!isUuid(params.id)) notFound()

  const session = await getSessionUser()
  if (!session) return null

  const supabase = await createClient()
  const viewerId = session.user.id

  const { data: match } = await supabase
    .from("matches")
    .select("id, kickoff_at, duration_minutes, format, status, venue_id, home_team_id, away_team_id")
    .eq("id", params.id)
    .maybeSingle()

  if (!match) notFound()

  const teamIds = [match.home_team_id, match.away_team_id].filter((id): id is string => typeof id === "string")

  const [teamsResult, participantsResult, membersResult, venueResult] = await Promise.all([
    supabase.from("teams").select("id, name").in("id", teamIds.length ? teamIds : [NIL_UUID]),
    supabase.from("match_participants").select("player_id, team_side").eq("match_id", match.id),
    supabase
      .from("team_members")
      .select("team_id, player_id, jersey_number")
      .in("team_id", teamIds.length ? teamIds : [NIL_UUID])
      .is("left_at", null),
    supabase.from("venues").select("name, timezone").eq("id", match.venue_id ?? NIL_UUID).maybeSingle(),
  ])

  const participants = participantsResult.data ?? []
  const members = membersResult.data ?? []
  const profileIds = [...new Set([...participants.map((row) => row.player_id), ...members.map((row) => row.player_id)])]

  const { data: profileRows } = await supabase
    .from("profiles")
    .select("id, display_name, full_name")
    .in("id", profileIds.length ? profileIds : [NIL_UUID])
  const profiles = new Map((profileRows ?? []).map((row) => [row.id, row]))
  const teams = new Map((teamsResult.data ?? []).map((row) => [row.id, row]))

  // Side per player: the participant row wins; otherwise membership of the home/away team.
  const sideOf = new Map<string, "home" | "away">()
  for (const member of members) {
    if (member.team_id === match.home_team_id) sideOf.set(member.player_id, "home")
    else if (member.team_id === match.away_team_id) sideOf.set(member.player_id, "away")
  }
  for (const participant of participants) {
    if (participant.team_side === "home" || participant.team_side === "away") sideOf.set(participant.player_id, participant.team_side)
  }
  const numberOf = new Map(members.map((member) => [member.player_id, member.jersey_number]))

  const roster: RosterSeedPlayer[] = profileIds.map((profileId) => {
    const profile = profiles.get(profileId)
    return {
      profileId,
      name: profile?.display_name ?? profile?.full_name ?? null,
      number: numberOf.get(profileId) ?? null,
      teamSide: sideOf.get(profileId) ?? null,
    }
  })

  const viewerSide = sideOf.get(viewerId) ?? null
  const timeZone = venueResult.data?.timezone ?? "Europe/Istanbul"
  const kickoff = formatKickoff(match.kickoff_at, timeZone)

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Maç planı</h1>
          <p className="text-sm text-muted-foreground">
            <time dateTime={match.kickoff_at} title={kickoff.full}>
              {kickoff.date}, {kickoff.time}
            </time>
            {venueResult.data ? (
              <>
                {" "}
                <span aria-hidden="true">·</span> {venueResult.data.name}
              </>
            ) : null}
          </p>
        </div>
        <Link href={`/matches/${match.id}`} className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground">
          Maç ayrıntıları
        </Link>
      </div>

      <PlanWorkspace
        matchId={match.id}
        matchStatus={match.status}
        pitchFormat={pitchFormatFromMatchFormat(match.format)}
        durationMinutes={match.duration_minutes}
        kickoffLabel={`${kickoff.date}, ${kickoff.time}`}
        venueName={venueResult.data?.name ?? null}
        homeTeam={{ id: match.home_team_id, name: match.home_team_id ? (teams.get(match.home_team_id)?.name ?? "Ev sahibi") : "Ev sahibi" }}
        awayTeam={{ id: match.away_team_id, name: match.away_team_id ? (teams.get(match.away_team_id)?.name ?? "Deplasman") : "Deplasman" }}
        viewerSide={viewerSide}
        roster={roster}
      />
    </div>
  )
}
