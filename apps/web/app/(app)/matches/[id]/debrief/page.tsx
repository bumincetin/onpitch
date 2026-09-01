/**
 * app/(app)/matches/[id]/debrief/page.tsx
 *
 * The post-match debrief wizard. Server reads the fixture (including a confirmed score, which
 * beats anything typed here); the client island pre-fills from the local live session or starts
 * the 60-second reconstruction.
 *
 * The debrief is the coach's record. It never writes `matches` — the official result still goes
 * through `score_reports` on the match page, and the wizard says so.
 */

import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"

import { getSessionUser } from "@/lib/rbac"
import { createClient } from "@/lib/supabase/server"
import { isUuid } from "@halisaha/shared/channels"
import { DebriefWizard } from "@/components/matchday/debrief-wizard"
import { formatKickoff } from "@/components/match/match-card"

export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "Maç özeti",
  description: "60 saniyede maç özeti: sonuç, anlar, süreler, değerlendirme ve paylaşılabilir kartlar.",
}

const NIL_UUID = "00000000-0000-0000-0000-000000000000"

export default async function MatchDebriefPage({ params }: { params: { id: string } }) {
  if (!isUuid(params.id)) notFound()

  const session = await getSessionUser()
  if (!session) return null

  const supabase = await createClient()
  const viewerId = session.user.id

  const { data: match } = await supabase
    .from("matches")
    .select("id, kickoff_at, status, home_score, away_score, venue_id, home_team_id, away_team_id")
    .eq("id", params.id)
    .maybeSingle()

  if (!match) notFound()

  const teamIds = [match.home_team_id, match.away_team_id].filter((id): id is string => typeof id === "string")

  const [teamsResult, selfResult, venueResult] = await Promise.all([
    supabase.from("teams").select("id, name").in("id", teamIds.length ? teamIds : [NIL_UUID]),
    supabase.from("match_participants").select("team_side").eq("match_id", match.id).eq("player_id", viewerId).maybeSingle(),
    supabase.from("venues").select("name, timezone").eq("id", match.venue_id ?? NIL_UUID).maybeSingle(),
  ])

  const teams = new Map((teamsResult.data ?? []).map((row) => [row.id, row]))
  const selfSide = selfResult.data?.team_side
  const viewerSide = selfSide === "home" || selfSide === "away" ? selfSide : null
  const kickoff = formatKickoff(match.kickoff_at, venueResult.data?.timezone ?? "Europe/Istanbul")
  const confirmedScore =
    match.home_score !== null && match.away_score !== null ? { home: match.home_score, away: match.away_score } : null

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Maç özeti</h1>
          <p className="text-sm text-muted-foreground">
            <time dateTime={match.kickoff_at} title={kickoff.full}>
              {kickoff.date}, {kickoff.time}
            </time>
          </p>
        </div>
        <Link href={`/matches/${match.id}`} className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground">
          Maç ayrıntıları
        </Link>
      </div>

      <DebriefWizard
        matchId={match.id}
        matchStatus={match.status}
        kickoffAt={match.kickoff_at}
        venueName={venueResult.data?.name ?? null}
        homeTeam={{ name: match.home_team_id ? (teams.get(match.home_team_id)?.name ?? "Ev sahibi") : "Ev sahibi" }}
        awayTeam={{ name: match.away_team_id ? (teams.get(match.away_team_id)?.name ?? "Deplasman") : "Deplasman" }}
        viewerSide={viewerSide}
        confirmedScore={confirmedScore}
      />
    </div>
  )
}
