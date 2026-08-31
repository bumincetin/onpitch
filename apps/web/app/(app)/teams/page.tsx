/**
 * app/(app)/teams/page.tsx
 *
 * The teams you play for, and the ones you could.
 *
 * ---------------------------------------------------------------------------------------------
 * TWO LISTS, AND THE DIFFERENCE BETWEEN THEM IS A POLICY
 * ---------------------------------------------------------------------------------------------
 * `teams_select_public_or_member` in `0002_rls.sql` reads:
 *
 *     is_public  OR  owner_id = auth.uid()  OR  is_team_member(id)  OR  is_admin()
 *
 * So "your teams" and "find a team" are not two permission levels — they are two filters over one
 * readable set. `scope=mine` asks for the teams you are on; discovery asks for the public ones.
 * Neither filter is load-bearing: drop them both and a stranger still cannot see a private team,
 * because the policy says so.
 *
 * The search box submits as a plain GET form. That keeps the results linkable and shareable, keeps
 * the page a Server Component with no client-side fetching, and makes it work before any
 * JavaScript has loaded.
 *
 * ---------------------------------------------------------------------------------------------
 * FOUR QUERIES, NEVER ONE PER TEAM
 * ---------------------------------------------------------------------------------------------
 *   1. the caller's own memberships        (scopes "mine", labels "discover")
 *   2. the teams themselves
 *   3. every active roster row for those teams   (squad sizes, and who to rate)
 *   4. `player_ratings` for every one of those players
 *
 * Step 4 is what lets each card carry a real team rating instead of a placeholder.
 * `player_ratings` is world-readable to signed-in users, so this needs no elevated client.
 */

import type { Metadata } from "next"
import Link from "next/link"

import { TeamCard, type TeamCardTeam } from "@/components/team/team-card"
import {
  aggregateTeamRating,
  type TeamMemberRating,
  type TeamRatingSummary,
} from "@/components/team/team-rating"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { getSessionUser } from "@/lib/rbac"
import { createClient } from "@/lib/supabase/server"
import { cn } from "@/lib/utils"
import type { Enums } from "@halisaha/shared/database"

export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "Takımlar",
  description: "Oynadığın takımlar ve oyuncu arayan açık takımlar.",
}

type TabKey = "mine" | "discover"

const TABS: ReadonlyArray<{ key: TabKey; label: string }> = [
  { key: "mine", label: "Takımların" },
  { key: "discover", label: "Takım bul" },
]

const PAGE_SIZE = 36

export default async function TeamsPage({
  searchParams,
}: {
  searchParams?: { tab?: string; q?: string; city?: string }
}) {
  const session = await getSessionUser()
  // The layout's requireRole() already redirected a signed-out visitor; this is belt and braces
  // for a direct render.
  if (!session) return null

  const tab: TabKey = searchParams?.tab === "discover" ? "discover" : "mine"
  const q = (searchParams?.q ?? "").trim().slice(0, 80)
  const city = (searchParams?.city ?? "").trim().slice(0, 80)

  const supabase = await createClient()

  const { data: membershipRows, error: membershipError } = await supabase
    .from("team_members")
    .select("team_id, role")
    .eq("player_id", session.user.id)
    .is("left_at", null)

  if (membershipError) {
    return (
      <PageFrame tab={tab} q={q} city={city}>
        <Alert variant="destructive">
          <AlertTitle>Takımların yüklenemedi</AlertTitle>
          <AlertDescription>
            Üyeliklerin okunurken bir şeyler ters gitti. Sayfayı yenile; devam ederse bize haber ver.
          </AlertDescription>
        </Alert>
      </PageFrame>
    )
  }

  const myRoles = new Map<string, Enums<"team_member_role">>(
    (membershipRows ?? []).map((row) => [row.team_id, row.role]),
  )

  let query = supabase.from("teams").select("*").limit(PAGE_SIZE)

  if (tab === "mine") {
    const ids = [...myRoles.keys()]
    // One statement rather than two round trips. PostgREST rejects an empty `in.()`, so a player
    // with no memberships falls back to the ownership filter alone.
    query =
      ids.length > 0
        ? query.or(`owner_id.eq.${session.user.id},id.in.(${ids.join(",")})`)
        : query.eq("owner_id", session.user.id)
    query = query.order("created_at", { ascending: false })
  } else {
    query = query.eq("is_public", true)
    if (q) query = query.ilike("name", `%${escapeLike(q)}%`)
    if (city) query = query.ilike("city", `${escapeLike(city)}%`)
    query = query.order("created_at", { ascending: false })
  }

  const { data: teamRows, error: teamsError } = await query

  if (teamsError) {
    return (
      <PageFrame tab={tab} q={q} city={city}>
        <Alert variant="destructive">
          <AlertTitle>Takımlar yüklenemedi</AlertTitle>
          <AlertDescription>
            Takım listesi şu an açılamıyor. Sayfayı yenileyip tekrar dene.
          </AlertDescription>
        </Alert>
      </PageFrame>
    )
  }

  const teams = teamRows ?? []
  const ratings = await loadTeamRatings(supabase, teams.map((team) => team.id))

  if (teams.length === 0) {
    return (
      <PageFrame tab={tab} q={q} city={city}>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {tab === "mine" ? "You are not on a team yet" : "Nothing matched"}
            </CardTitle>
            <CardDescription>
              {tab === "mine"
                ? "Create one and invite the people you already play with, or look through the public teams."
                : "No public team matches that search. Try a shorter name, or a different city."}
            </CardDescription>
          </CardHeader>
        </Card>
      </PageFrame>
    )
  }

  return (
    <PageFrame tab={tab} q={q} city={city}>
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {teams.map((team) => {
          const card: TeamCardTeam = {
            id: team.id,
            name: team.name,
            slug: team.slug,
            city: team.city,
            crestUrl: team.crest_url,
            description: team.description,
            isPublic: team.is_public,
            memberCount: ratings.get(team.id)?.squadSize ?? 0,
            viewerRole: myRoles.get(team.id) ?? null,
            viewerIsOwner: team.owner_id === session.user.id,
          }
          return (
            <li key={team.id}>
              <TeamCard team={card} rating={ratings.get(team.id) ?? null} />
            </li>
          )
        })}
      </ul>
    </PageFrame>
  )
}

/* -------------------------------------------------------------------------- */
/*  Frame                                                                      */
/* -------------------------------------------------------------------------- */

function PageFrame({
  tab,
  q,
  city,
  children,
}: {
  tab: TabKey
  q: string
  city: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Takımlar</h1>
          <p className="text-sm text-muted-foreground">
            Takım; kadronu, forma numaralarını ve sonuçlarını maçlar boyunca bir arada tutar.
          </p>
        </div>
        <Button asChild>
          <Link href="/teams/new">Takım kur</Link>
        </Button>
      </header>

      <nav aria-label="Takım görünümleri">
        <ul className="flex gap-1 border-b">
          {TABS.map((entry) => {
            const isActive = entry.key === tab
            return (
              <li key={entry.key}>
                <Link
                  href={entry.key === "mine" ? "/teams" : "/teams?tab=discover"}
                  aria-current={isActive ? "page" : undefined}
                  className={cn(
                    "inline-flex h-9 items-center border-b-2 px-3 text-sm transition-colors",
                    isActive
                      ? "border-foreground font-medium text-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  {entry.label}
                </Link>
              </li>
            )
          })}
        </ul>
      </nav>

      {tab === "discover" ? (
        <form method="get" action="/teams" className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="tab" value="discover" />
          <div className="min-w-[12rem] flex-1 space-y-1.5">
            <Label htmlFor="team-search-name">Takım adı</Label>
            <Input
              id="team-search-name"
              name="q"
              defaultValue={q}
              maxLength={80}
              placeholder="Kartal"
              autoComplete="off"
            />
          </div>
          <div className="min-w-[10rem] flex-1 space-y-1.5">
            <Label htmlFor="team-search-city">Şehir</Label>
            <Input
              id="team-search-city"
              name="city"
              defaultValue={city}
              maxLength={80}
              placeholder="Istanbul"
              autoComplete="address-level2"
            />
          </div>
          <Button type="submit" variant="outline">
            Ara
          </Button>
        </form>
      ) : null}

      {children}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Ratings                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Kadro size and aggregate rating for a batch of teams, in two round trips.
 *
 * A team whose roster the caller may not read (a private team they are not on never reaches here,
 * but a race could) simply gets no entry, and the card renders "Not rated yet" rather than
 * inventing a number.
 */
async function loadTeamRatings(
  supabase: Awaited<ReturnType<typeof createClient>>,
  teamIds: readonly string[],
): Promise<Map<string, TeamRatingSummary>> {
  const summaries = new Map<string, TeamRatingSummary>()
  if (teamIds.length === 0) return summaries

  const { data: memberRows, error: memberError } = await supabase
    .from("team_members")
    .select("team_id, player_id")
    .in("team_id", [...teamIds])
    .is("left_at", null)

  if (memberError || !memberRows || memberRows.length === 0) return summaries

  const playerIds = [...new Set(memberRows.map((row) => row.player_id))]

  const { data: ratingRows } = await supabase
    .from("player_ratings")
    .select("player_id, mu, sigma")
    .in("player_id", playerIds)

  const ratings = new Map((ratingRows ?? []).map((row) => [row.player_id, row]))

  const byTeam = new Map<string, TeamMemberRating[]>()
  for (const row of memberRows) {
    const rating = ratings.get(row.player_id)
    const bucket = byTeam.get(row.team_id) ?? []
    bucket.push({
      playerId: row.player_id,
      rating: rating ? { mu: rating.mu, sigma: rating.sigma } : null,
    })
    byTeam.set(row.team_id, bucket)
  }

  for (const [teamId, members] of byTeam) {
    const summary = aggregateTeamRating(members)
    if (summary) summaries.set(teamId, summary)
  }

  return summaries
}

/**
 * Neutralise every wildcard on the way to `ilike`.
 *
 * Two layers bite here. PostgREST rewrites `*` into `%` before the pattern reaches SQL, and SQL
 * itself treats `%` and `_` as wildcards with backslash as the escape. Without this a search for
 * "%" returns every row — not a security hole, since RLS still applies, but a result nobody asked
 * for — and a stray `_` quietly matches a character the user did not type.
 */
function escapeLike(value: string): string {
  return value.replace(/\*/g, "").replace(/[\\%_]/g, (character) => `\\${character}`)
}
