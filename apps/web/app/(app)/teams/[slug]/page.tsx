/**
 * app/(app)/teams/[slug]/page.tsx
 *
 * One team: who is on it, how it has done, and what is next.
 *
 * ---------------------------------------------------------------------------------------------
 * A VISITOR AND A SQUAD MEMBER SEE GENUINELY DIFFERENT PAGES, AND THAT IS THE POLICIES TALKING
 * ---------------------------------------------------------------------------------------------
 *   teams           public, or yours. A private team you are not on is a 404 here.
 *   team_members    readable for any public team, so a stranger can size up the squad.
 *   profiles        `profiles_select_self_or_visible` — active teammates always see each other,
 *                   everyone else only sees adults who opted into public or members visibility.
 *                   So a stranger reading a public roster may find rows with no name attached.
 *                   Those render as "Private profile" rather than being dropped: the squad number
 *                   is real, and hiding the row would misreport the size of the team.
 *   matches         `matches_select_involved` -> `can_view_match` -> `is_match_participant`, which
 *                   requires being on the line-up or on either side's ACTIVE roster. There is no
 *                   public-fixture disjunct. A visitor therefore gets no matches at all, and this
 *                   page says so instead of rendering a 0-0-0 record that would be a lie.
 *
 * Everything is one round trip per entity kind. Six small reads beat sixty correlated ones.
 */

import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"

import { MATCH_STATUS_META, formatKickoff } from "@/components/match/match-card"
import { TeamCrest, isRenderableCrest } from "@/components/team/team-card"
import { RosterTable, type RosterMember } from "@/components/team/roster-table"
import { TeamRating, aggregateTeamRating } from "@/components/team/team-rating"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { getSessionUser } from "@/lib/rbac"
import { createClient } from "@/lib/supabase/server"
import { isTeamSlug } from "@/lib/teams/slug"
import type { Enums } from "@halisaha/shared/database"

export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "Takım",
  description: "Kadro, karne ve yaklaşan maçlar.",
}

const NIL_UUID = "00000000-0000-0000-0000-000000000000"
const FIXTURE_LIMIT = 5

export default async function TeamPage({ params }: { params: { slug: string } }) {
  // The CHECK on `teams.slug` guarantees the shape, so anything else cannot name a real team.
  if (!isTeamSlug(params.slug)) notFound()

  const session = await getSessionUser()
  if (!session) return null

  const supabase = await createClient()
  const viewerId = session.user.id

  const { data: team } = await supabase
    .from("teams")
    .select("*")
    .eq("slug", params.slug)
    .maybeSingle()

  // Invisible and non-existent are the same answer. Confirming that a private team exists would
  // leak the one fact its captain chose to withhold.
  if (!team) notFound()

  const { data: memberRows } = await supabase
    .from("team_members")
    .select("*")
    .eq("team_id", team.id)
    .order("joined_at", { ascending: true })

  const members = memberRows ?? []
  const playerIds = [...new Set(members.map((row) => row.player_id))]

  const [{ data: profileRows }, { data: ratingRows }, { data: matchRows }] = await Promise.all([
    supabase
      .from("profiles")
      .select("id, display_name, full_name, preferred_position")
      .in("id", playerIds.length > 0 ? playerIds : [NIL_UUID]),
    supabase
      .from("player_ratings")
      .select("player_id, mu, sigma, conservative_rating")
      .in("player_id", playerIds.length > 0 ? playerIds : [NIL_UUID]),
    supabase
      .from("matches")
      .select(
        "id, kickoff_at, status, format, home_team_id, away_team_id, home_score, away_score, is_ranked",
      )
      .or(`home_team_id.eq.${team.id},away_team_id.eq.${team.id}`)
      .order("kickoff_at", { ascending: false })
      .limit(100),
  ])

  const profiles = new Map((profileRows ?? []).map((row) => [row.id, row]))
  const ratings = new Map((ratingRows ?? []).map((row) => [row.player_id, row]))

  /* ---- viewer's standing ------------------------------------------------ */

  const viewerRow = members.find((row) => row.player_id === viewerId && row.left_at === null)
  const viewerIsOwner = team.owner_id === viewerId
  const viewerIsCaptain = viewerIsOwner || viewerRow?.role === "captain"
  const viewerCanManage =
    viewerIsOwner || viewerRow?.role === "captain" || viewerRow?.role === "vice_captain"
  const viewerIsMember = viewerIsOwner || viewerRow !== undefined

  /* ---- roster ------------------------------------------------------------ */

  const roster: RosterMember[] = members.map((row) => {
    const profile = profiles.get(row.player_id)
    const rating = ratings.get(row.player_id)
    return {
      playerId: row.player_id,
      // `null` means the viewer may not see this profile, which the table renders honestly. The
      // fallback to full_name matches how the rest of the app names a person.
      displayName: profile ? (profile.display_name ?? profile.full_name) : null,
      role: row.role,
      jerseyNumber: row.jersey_number,
      joinedAt: row.joined_at,
      leftAt: row.left_at,
      isOwner: row.player_id === team.owner_id,
      preferredPosition: profile?.preferred_position ?? null,
      conservativeRating: rating?.conservative_rating ?? null,
    }
  })

  const activeRoster = roster.filter((member) => member.leftAt === null)

  const ratingSummary = aggregateTeamRating(
    activeRoster.map((member) => {
      const rating = ratings.get(member.playerId)
      return {
        playerId: member.playerId,
        rating: rating ? { mu: rating.mu, sigma: rating.sigma } : null,
      }
    }),
  )

  /* ---- record and fixtures ---------------------------------------------- */

  const matches = matchRows ?? []
  const record = summariseRecord(matches, team.id)

  const upcoming = matches
    .filter((match) => match.status === "scheduled" || match.status === "live")
    .sort((a, b) => a.kickoff_at.localeCompare(b.kickoff_at))
    .slice(0, FIXTURE_LIMIT)

  const recent = matches
    .filter((match) => match.status === "finalized")
    .slice(0, FIXTURE_LIMIT)

  const opponentIds = [
    ...new Set(
      [...upcoming, ...recent]
        .map((match) => (match.home_team_id === team.id ? match.away_team_id : match.home_team_id))
        .filter((id): id is string => id !== null),
    ),
  ]

  const { data: opponentRows } = await supabase
    .from("teams")
    .select("id, name, slug")
    .in("id", opponentIds.length > 0 ? opponentIds : [NIL_UUID])

  const opponents = new Map((opponentRows ?? []).map((row) => [row.id, row]))

  /* ---- render ------------------------------------------------------------ */

  return (
    <div className="space-y-6">
      <nav aria-label="Sayfa yolu" className="text-sm text-muted-foreground">
        <Link href="/teams" className="hover:underline">
          Takımlar
        </Link>
        <span aria-hidden="true"> / </span>
        <span className="text-foreground">{team.name}</span>
      </nav>

      <header className="flex flex-wrap items-start gap-4">
        <TeamCrest
          name={team.name}
          url={isRenderableCrest(team.crest_url) ? team.crest_url : null}
          size={64}
        />

        <div className="min-w-0 flex-1 space-y-2">
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">{team.name}</h1>
            <p className="text-sm text-muted-foreground">
              {team.city ?? "No city set"} · {activeRoster.length}{" "}
              {activeRoster.length === 1 ? "player" : "players"}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={team.is_public ? "outline" : "secondary"}>
              {team.is_public ? "Listed in search" : "Invite only"}
            </Badge>
            {viewerIsOwner ? <Badge>Kurucu</Badge> : null}
            {!viewerIsOwner && viewerRow ? (
              <Badge variant="secondary">
                {viewerRow.role === "captain"
                  ? "Captain"
                  : viewerRow.role === "vice_captain"
                    ? "Vice-captain"
                    : "Kadro"}
              </Badge>
            ) : null}
          </div>
        </div>

        {viewerIsCaptain ? (
          <Button asChild variant="outline">
            <Link href={`/teams/${team.slug}/settings`}>Takım ayarları</Link>
          </Button>
        ) : null}
      </header>

      {team.description ? (
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          {team.description}
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <TeamRating summary={ratingSummary} className="lg:col-span-2" />

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Karne</CardTitle>
            <CardDescription>
              {viewerIsMember
                ? "Finalised matches only."
                : "Only squad members can see this team's fixtures."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {viewerIsMember ? (
              <dl className="grid grid-cols-3 gap-3 text-center">
                <Stat label="Galibiyet" value={record.wins} />
                <Stat label="Beraberlik" value={record.draws} />
                <Stat label="Mağlubiyet" value={record.losses} />
              </dl>
            ) : (
              <p className="text-sm text-muted-foreground">
                Maç kayıtları oynayan kişileri adıyla tutar; bu yüzden kadronun içinde kalırlar.
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <section aria-labelledby="squad" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="squad" className="text-lg font-semibold tracking-tight">
            Kadro
          </h2>
          {viewerCanManage ? (
            <Button asChild size="sm" variant="outline">
              <Link href={`/teams/${team.slug}/settings`}>Oyuncu ekle</Link>
            </Button>
          ) : null}
        </div>

        <RosterTable
          teamId={team.id}
          members={roster}
          viewer={{ id: viewerId, isCaptain: viewerIsCaptain, canManageRoster: viewerCanManage }}
        />
      </section>

      {viewerIsMember ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <FixtureList
            title="Sıradaki"
            emptyMessage="Takvimde maç yok."
            matches={upcoming}
            teamId={team.id}
            opponents={opponents}
          />
          <FixtureList
            title="Son sonuçlar"
            emptyMessage="Henüz biten maç yok."
            matches={recent}
            teamId={team.id}
            opponents={opponents}
            showScores
          />
        </div>
      ) : (
        <Alert>
          <AlertTitle>Maçları yalnızca kadro görür</AlertTitle>
          <AlertDescription>
            Bir maç kaydı, o maçta oynayan herkesi adıyla tutar; bu yüzden takımın maçlarını ve sonuçlarını yalnızca kadrodakiler okuyabilir.
          </AlertDescription>
        </Alert>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Pieces                                                                     */
/* -------------------------------------------------------------------------- */

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-2xl font-semibold tabular-nums">{value}</dd>
    </div>
  )
}

interface FixtureMatch {
  id: string
  kickoff_at: string
  status: Enums<"match_status">
  home_team_id: string | null
  away_team_id: string | null
  home_score: number | null
  away_score: number | null
}

function FixtureList({
  title,
  emptyMessage,
  matches,
  teamId,
  opponents,
  showScores = false,
}: {
  title: string
  emptyMessage: string
  matches: readonly FixtureMatch[]
  teamId: string
  opponents: Map<string, { id: string; name: string; slug: string }>
  showScores?: boolean
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {matches.length === 0 ? (
          <p className="text-sm text-muted-foreground">{emptyMessage}</p>
        ) : (
          <ul className="divide-y">
            {matches.map((match) => {
              const isHome = match.home_team_id === teamId
              const opponentId = isHome ? match.away_team_id : match.home_team_id
              const opponent = opponentId ? opponents.get(opponentId) : undefined
              const kickoff = formatKickoff(match.kickoff_at)
              const meta = MATCH_STATUS_META[match.status]
              const ourScore = isHome ? match.home_score : match.away_score
              const theirScore = isHome ? match.away_score : match.home_score

              return (
                <li key={match.id} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      <Link href={`/matches/${match.id}`} className="hover:underline">
                        {isHome ? "vs" : "at"}{" "}
                        {opponent?.name ?? (opponentId ? "Another team" : "Pickup match")}
                      </Link>
                    </p>
                    <p className="text-xs text-muted-foreground" title={kickoff.full}>
                      {kickoff.date} · {kickoff.time}
                    </p>
                  </div>

                  {showScores && ourScore !== null && theirScore !== null ? (
                    <span className="shrink-0 text-sm font-semibold tabular-nums">
                      {ourScore}&ndash;{theirScore}
                    </span>
                  ) : (
                    <Badge variant={meta.variant} className={meta.className}>
                      {meta.label}
                    </Badge>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

/* -------------------------------------------------------------------------- */
/*  Record                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Wins, draws and losses over the FINALISED matches the viewer can read.
 *
 * A match with a null score is skipped rather than counted as a draw: `matches.home_score` stays
 * null until a result is agreed, and treating "not reported" as 0-0 would inflate every record.
 */
function summariseRecord(
  matches: readonly FixtureMatch[],
  teamId: string,
): { wins: number; draws: number; losses: number } {
  let wins = 0
  let draws = 0
  let losses = 0

  for (const match of matches) {
    if (match.status !== "finalized") continue
    if (match.home_score === null || match.away_score === null) continue

    const isHome = match.home_team_id === teamId
    const ours = isHome ? match.home_score : match.away_score
    const theirs = isHome ? match.away_score : match.home_score

    if (ours > theirs) wins += 1
    else if (ours < theirs) losses += 1
    else draws += 1
  }

  return { wins, draws, losses }
}
