/**
 * app/(app)/teams/[slug]/settings/page.tsx
 *
 * Running the team: details, who is on the squad, and what rank they hold.
 *
 * ---------------------------------------------------------------------------------------------
 * WHO GETS IN
 * ---------------------------------------------------------------------------------------------
 * The gate is `private.is_team_captain()` restated in TypeScript — the owner, a 'captain' or a
 * 'vice_captain'. That is deliberately the same predicate `teams_update_captain` and
 * `team_members_insert_captain_or_self_join` use, so this page can never offer a control the
 * database would refuse. A vice-captain running the page while the captain is away is normal.
 *
 * Rank changes are narrower: `<RosterTable />` only renders the rank control for a full captain,
 * and `PATCH /api/teams/[id]/members/[playerId]` enforces the same. Handing out authority is a
 * captain's job.
 *
 * Somebody without either right gets an explanation and a way back, not a 404 — they can see this
 * team perfectly well, they just cannot administer it, and a "not found" would be a lie they can
 * disprove by pressing back.
 */

import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"

import { InviteMember } from "@/components/team/invite-member"
import { RosterTable, type RosterMember } from "@/components/team/roster-table"
import { TeamForm } from "@/components/team/team-form"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { getSessionUser } from "@/lib/rbac"
import { createClient } from "@/lib/supabase/server"
import { isTeamSlug } from "@/lib/teams/slug"

export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "Takım ayarları",
  description: "Takımı düzenle, kadroyu yönet, rütbeleri dağıt.",
}

const NIL_UUID = "00000000-0000-0000-0000-000000000000"

export default async function TeamSettingsPage({ params }: { params: { slug: string } }) {
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

  if (!team) notFound()

  const { data: memberRows } = await supabase
    .from("team_members")
    .select("*")
    .eq("team_id", team.id)
    .order("joined_at", { ascending: true })

  const members = memberRows ?? []
  const viewerRow = members.find((row) => row.player_id === viewerId && row.left_at === null)
  const viewerIsOwner = team.owner_id === viewerId
  const viewerIsCaptain = viewerIsOwner || viewerRow?.role === "captain"
  const viewerCanManage =
    viewerIsOwner || viewerRow?.role === "captain" || viewerRow?.role === "vice_captain"

  if (!viewerCanManage) {
    return (
      <div className="mx-auto max-w-2xl space-y-4">
        <Alert>
          <AlertTitle>Takım ayarlarını yalnızca kaptanlar açabilir</AlertTitle>
          <AlertDescription>
            {team.name} is run by its captains and vice-captains. Ask one of them if something on
            the squad needs changing.
          </AlertDescription>
        </Alert>
        <Button asChild variant="outline">
          <Link href={`/teams/${team.slug}`}>Back to {team.name}</Link>
        </Button>
      </div>
    )
  }

  const playerIds = [...new Set(members.map((row) => row.player_id))]

  const [{ data: profileRows }, { data: ratingRows }] = await Promise.all([
    supabase
      .from("profiles")
      .select("id, display_name, full_name, preferred_position")
      .in("id", playerIds.length > 0 ? playerIds : [NIL_UUID]),
    supabase
      .from("player_ratings")
      .select("player_id, conservative_rating")
      .in("player_id", playerIds.length > 0 ? playerIds : [NIL_UUID]),
  ])

  const profiles = new Map((profileRows ?? []).map((row) => [row.id, row]))
  const ratings = new Map((ratingRows ?? []).map((row) => [row.player_id, row]))

  const roster: RosterMember[] = members.map((row) => {
    const profile = profiles.get(row.player_id)
    return {
      playerId: row.player_id,
      displayName: profile ? (profile.display_name ?? profile.full_name) : null,
      role: row.role,
      jerseyNumber: row.jersey_number,
      joinedAt: row.joined_at,
      leftAt: row.left_at,
      isOwner: row.player_id === team.owner_id,
      preferredPosition: profile?.preferred_position ?? null,
      conservativeRating: ratings.get(row.player_id)?.conservative_rating ?? null,
    }
  })

  const activeRoster = roster.filter((member) => member.leftAt === null)
  const takenNumbers = activeRoster
    .map((member) => member.jerseyNumber)
    .filter((number): number is number => number !== null)

  return (
    <div className="space-y-6">
      <nav aria-label="Sayfa yolu" className="text-sm text-muted-foreground">
        <Link href="/teams" className="hover:underline">
          Takımlar
        </Link>
        <span aria-hidden="true"> / </span>
        <Link href={`/teams/${team.slug}`} className="hover:underline">
          {team.name}
        </Link>
        <span aria-hidden="true"> / </span>
        <span className="text-foreground">Ayarlar</span>
      </nav>

      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Takım ayarları</h1>
        <p className="text-sm text-muted-foreground">
          {viewerIsCaptain
            ? "You can change the team details, the squad and everyone's rank."
            : "As a vice-captain you can change the team details and the squad. Only a captain can change ranks."}
        </p>
      </header>

      <InviteMember
        teamId={team.id}
        teamName={team.name}
        existingPlayerIds={activeRoster.map((member) => member.playerId)}
        takenNumbers={takenNumbers}
      />

      <section aria-labelledby="squad-management" className="space-y-3">
        <h2 id="squad-management" className="text-lg font-semibold tracking-tight">
          Kadro
        </h2>
        <RosterTable
          teamId={team.id}
          members={roster}
          viewer={{ id: viewerId, isCaptain: viewerIsCaptain, canManageRoster: viewerCanManage }}
        />
      </section>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Takım bilgileri</CardTitle>
          <CardDescription>
            Maçlarda ve aramada görünen ad. Adres takım kurulurken belirlendi ve paylaşılan bağlantılar çalışmaya devam etsin diye değişmez.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <TeamForm
            team={{
              id: team.id,
              name: team.name,
              slug: team.slug,
              city: team.city,
              description: team.description,
              crestUrl: team.crest_url,
              isPublic: team.is_public,
            }}
          />
        </CardContent>
      </Card>
    </div>
  )
}
