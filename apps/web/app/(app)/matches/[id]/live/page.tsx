/**
 * app/(app)/matches/[id]/live/page.tsx
 *
 * The live screen — the one that gets propped against a fence and stared at for ninety minutes.
 *
 * The server does the reading and the authorisation; exactly ONE client island (`LiveScoreboard`)
 * holds the Realtime channel. That is not a stylistic preference: Realtime permits one channel per
 * topic per client, so `match:<id>` has to have a single owner on the page, and the roster gets its
 * presence passed down as a prop rather than opening a second subscription that would be refused.
 *
 * Everything rendered here is also a server-side snapshot, so the page is correct before any socket
 * connects and stays correct if one never does.
 */

import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"

import { getSessionUser } from "@/lib/rbac"
import { createClient } from "@/lib/supabase/server"
import { isUuid, type MatchPresencePayload } from "@onpitch/shared/channels"
import { LiveCompanion } from "@/components/matchday/live-companion"
import type { RosterPlayer } from "@/components/match/roster"
import { formatKickoff } from "@/components/match/match-card"

export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "Canlı",
  description: "Canlı skor, süre ve sahada kimin olduğu.",
}

const NIL_UUID = "00000000-0000-0000-0000-000000000000"

export default async function LiveMatchPage({ params }: { params: { id: string } }) {
  if (!isUuid(params.id)) notFound()

  const session = await getSessionUser()
  if (!session) return null

  const supabase = await createClient()
  const viewerId = session.user.id

  const { data: match } = await supabase
    .from("matches")
    .select(
      // One long literal, deliberately not split with `+`: postgrest-js infers the row type from
      // the select string as a LITERAL type, and `"a" + "b"` widens to `string`, which silently
      // collapses the result to an untyped record.
      "id, kickoff_at, duration_minutes, format, status, home_score, away_score, is_ranked, venue_id, home_team_id, away_team_id, created_by, updated_at",
    )
    .eq("id", params.id)
    .maybeSingle()

  if (!match) notFound()

  const teamIds = [match.home_team_id, match.away_team_id].filter(
    (id): id is string => typeof id === "string",
  )

  const [teamsResult, participantsResult, venueResult] = await Promise.all([
    supabase.from("teams").select("id, name").in("id", teamIds.length ? teamIds : [NIL_UUID]),
    supabase
      .from("match_participants")
      .select("player_id, team_side, is_confirmed")
      .eq("match_id", match.id),
    supabase
      .from("venues")
      .select("id, name, owner_id, timezone")
      .eq("id", match.venue_id ?? NIL_UUID)
      .maybeSingle(),
  ])

  const participants = participantsResult.data ?? []
  const playerIds = participants.map((participant) => participant.player_id)

  const { data: profileRows } = await supabase
    .from("profiles")
    .select("id, display_name, full_name")
    .in("id", playerIds.length ? playerIds : [NIL_UUID])

  const profiles = new Map((profileRows ?? []).map((row) => [row.id, row]))
  const teams = new Map((teamsResult.data ?? []).map((row) => [row.id, row]))

  const rosterPlayers: RosterPlayer[] = participants.map((participant) => {
    const profile = profiles.get(participant.player_id)
    return {
      playerId: participant.player_id,
      displayName: profile?.display_name ?? profile?.full_name ?? null,
      teamSide:
        participant.team_side === "home" || participant.team_side === "away" ? participant.team_side : null,
      isConfirmed: participant.is_confirmed,
      isSelf: participant.player_id === viewerId,
    }
  })

  const self = participants.find((participant) => participant.player_id === viewerId)
  const isParticipant = Boolean(self)
  // Hoisted so TypeScript can narrow it: `self?.team_side === "home"` narrows the PROPERTY, not
  // `self`, so reading `self.team_side` back inside the branch would still be possibly-undefined.
  const selfSideRaw = self?.team_side
  const selfSide = selfSideRaw === "home" || selfSideRaw === "away" ? selfSideRaw : null
  const ownsVenue = venueResult.data?.owner_id === viewerId
  const isAdmin = session.profile.role === "admin"

  /*
   * Mirrors the `rt_match_public_write` policy in 0006 §5 — participants, the venue owner of the
   * match, admins. It only decides whether to RENDER the buttons; the broadcast itself is
   * authorised server-side against `realtime.messages`, so an over-generous guess here shows
   * someone a button that silently does nothing rather than letting them do anything.
   */
  const canScore = isParticipant || ownsVenue || isAdmin

  /*
   * Spectators watch without appearing. Presence is keyed on the profile id (0006 §7) so a player
   * who reconnects replaces their own entry rather than being counted twice. `teamSide` here is a
   * hint for the roster UI only — never an input to scoring, quorum or rating.
   */
  const presenceSelf: MatchPresencePayload | null = isParticipant
    ? {
        profileId: viewerId,
        displayName: session.profile.display_name ?? session.profile.full_name ?? null,
        teamSide: selfSide,
        checkedInAt: new Date().toISOString(),
      }
    : null

  const timeZone = venueResult.data?.timezone ?? "Europe/Istanbul"
  const kickoff = formatKickoff(match.kickoff_at, timeZone)
  const homeTeamName = match.home_team_id ? (teams.get(match.home_team_id)?.name ?? null) : null
  const awayTeamName = match.away_team_id ? (teams.get(match.away_team_id)?.name ?? null) : null

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Canlı</h1>
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

        <div className="flex gap-4">
          <Link
            href={`/matches/${match.id}/plan`}
            className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
          >
            Plan
          </Link>
          <Link
            href={`/matches/${match.id}`}
            className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
          >
            Maç ayrıntıları
          </Link>
        </div>
      </div>

      {/*
        `LiveCompanion` renders the unchanged `LiveScoreboard` (still the page's one channel
        owner) and, under it, the matchday panel fed by the plan saved on this device.
      */}
      <LiveCompanion
        match={match}
        homeTeamName={homeTeamName}
        awayTeamName={awayTeamName}
        participants={rosterPlayers}
        viewer={presenceSelf}
        canScore={canScore}
        reportHref={`/matches/${match.id}`}
        viewerSide={selfSide}
      />

      <p className="text-xs leading-relaxed text-muted-foreground">
        Bu ekrandaki anlık skoru sahadakiler tutar ve hiçbir yere kaydedilmez. Sonuç sisteme ancak biri maç sayfasından skor bildirdiğinde girer ve ancak karşı taraf da onayladığında kesinleşir.
      </p>
    </div>
  )
}
