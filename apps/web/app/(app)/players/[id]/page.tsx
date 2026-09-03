/**
 * app/(app)/players/[id]/page.tsx
 *
 * A player's rating, its uncertainty, and the matches behind it.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT A VISITOR SEES IS DECIDED IN POSTGRES, NOT HERE
 * ---------------------------------------------------------------------------------------------
 *
 * Three policies from `0002_rls.sql` shape this page, and they deliberately disagree with each
 * other about how much to reveal:
 *
 *   profiles       self, admins, teammates, or a non-minor with visibility 'public'/'members'.
 *                  A minor's profile is NEVER visible to a stranger — `is_minor is not true` is a
 *                  conjunct of the policy, not a preference.
 *   player_ratings world-readable to any signed-in user. mu and sigma are non-identifying, and
 *                 gating them per row would turn every leaderboard page into a full scan plus a
 *                 visibility lookup. The NAME attached to a rating is what the profiles policies
 *                 protect.
 *   player_stats   your own rows, plus rows from matches you can see.
 *
 * So a private profile yields "rating visible, person not" — which is exactly right, and is why
 * this page renders an explained partial state instead of a 404. Pretending the row does not exist
 * would be a lie the ratings table contradicts one query later.
 */

import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"

import { getSessionUser } from "@/lib/rbac"
import { createClient } from "@/lib/supabase/server"
import { isUuid } from "@onpitch/shared/channels"
import { MATCH_STATUS_META, formatKickoff } from "@/components/match/match-card"
import { RatingDeltaInline, UncertaintyBar, conservativeRating } from "@/components/match/rating-delta"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "Oyuncu",
  description: "Reyting, belirsizlik ve maç geçmişi.",
}

const NIL_UUID = "00000000-0000-0000-0000-000000000000"
const HISTORY_LIMIT = 20

const RATING_1DP = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
})

export default async function PlayerPage({ params }: { params: { id: string } }) {
  if (!isUuid(params.id)) notFound()

  const session = await getSessionUser()
  if (!session) return null

  const supabase = await createClient()
  const playerId = params.id.toLowerCase()
  const isSelf = playerId === session.user.id.toLowerCase()

  const [profileResult, ratingResult, statsResult] = await Promise.all([
    supabase
      .from("profiles")
      // No `deleted_at` predicate: it is outside the column-scoped SELECT grant in
      // 0002_rls.sql (4.1), and a column privilege covers a WHERE-clause reference too, so
      // naming it would make the whole statement a 42501 and render every player as "Private
      // profile". profiles_select_self_or_visible already carries `deleted_at is null` on every
      // branch that could admit another user's row, and a policy qual is evaluated by the
      // executor rather than under the caller's column privileges.
      .select("id, display_name, full_name, city, preferred_position, bio, created_at, avatar_url")
      .eq("id", playerId)
      .maybeSingle(),
    supabase
      .from("player_ratings")
      .select(
        "player_id, mu, sigma, conservative_rating, matches_played, wins, draws, losses, last_match_at",
      )
      .eq("player_id", playerId)
      .maybeSingle(),
    supabase
      .from("player_stats")
      .select(
        // Kept as a single literal so postgrest-js can infer the row type from it.
        "id, match_id, goals, assists, saves, yellow_cards, red_cards, minutes_played, mu_before, sigma_before, mu_after, sigma_after, rating_delta, created_at, team_side",
      )
      .eq("player_id", playerId)
      .order("created_at", { ascending: false })
      .limit(HISTORY_LIMIT),
  ])

  if (profileResult.error) {
    // A failed read renders as an unnamed profile, which is also what a legitimately private one
    // looks like. Log so the two are distinguishable.
    // eslint-disable-next-line no-console
    console.error(
      "[players/:id] profile read failed:",
      profileResult.error.code,
      profileResult.error.message,
    )
  }

  const profile = profileResult.data
  const rating = ratingResult.data
  const stats = statsResult.data ?? []

  // Nothing at all: no readable profile AND no rating row. The id is either fake or belongs to an
  // erased account, and both are a 404 to this page.
  if (!profile && !rating) notFound()

  const matchIds = stats.map((row) => row.match_id)
  const { data: matchRows } = await supabase
    .from("matches")
    .select("id, kickoff_at, status, home_score, away_score, home_team_id, away_team_id, is_ranked")
    .in("id", matchIds.length ? matchIds : [NIL_UUID])

  const matches = new Map((matchRows ?? []).map((row) => [row.id, row]))

  const displayName = profile?.display_name ?? profile?.full_name ?? "Private profile"
  const played = rating?.matches_played ?? 0
  const winRate = played > 0 ? Math.round(((rating?.wins ?? 0) / played) * 100) : null

  return (
    <div className="space-y-6">
      {/* ---------------- header ---------------- */}
      <header className="flex flex-wrap items-start gap-4">
        <span
          aria-hidden="true"
          className="grid size-14 shrink-0 place-items-center rounded-full bg-muted text-lg font-semibold uppercase text-muted-foreground"
        >
          {displayName.trim().slice(0, 2)}
        </span>

        <div className="min-w-0 flex-1 space-y-1">
          <h1 className="truncate text-2xl font-semibold tracking-tight">{displayName}</h1>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
            {profile?.preferred_position ? <span>{profile.preferred_position}</span> : null}
            {profile?.preferred_position && profile?.city ? <span aria-hidden="true">·</span> : null}
            {profile?.city ? <span>{profile.city}</span> : null}
            {isSelf ? <Badge variant="secondary">Bu sensin</Badge> : null}
          </p>
        </div>
      </header>

      {profile?.bio ? <p className="max-w-prose text-sm leading-relaxed">{profile.bio}</p> : null}

      {!profile ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Bu profil gizli</CardTitle>
            <CardDescription>
              Aşağıdaki reyting giriş yapmış üyelere açıktır — mu ve sigma, kişinin kim olduğu hakkında bir şey söylemez. Arkasındaki ad, şehir ve geçmiş seninle paylaşılmaz.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      {/* ---------------- rating ---------------- */}
      {rating ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Reyting</CardTitle>
            <CardDescription>
              Sıralamada kullanılan sayı <strong>mu &minus; 3&sigma;</strong>: modelin bu oyuncunun
              about 99.7% confident this player is above.
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-5">
            <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
              <div>
                <p className="text-4xl font-semibold tabular-nums">
                  {RATING_1DP.format(
                    rating.conservative_rating ?? conservativeRating(rating.mu, rating.sigma),
                  )}
                </p>
                <p className="text-xs text-muted-foreground">Güvenli reyting</p>
              </div>

              <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
                <div>
                  <dt className="text-xs text-muted-foreground">Beceri (mu)</dt>
                  <dd className="tabular-nums">{RATING_1DP.format(rating.mu)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Uncertainty (σ)</dt>
                  <dd className="tabular-nums">{rating.sigma.toFixed(2)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Oynadığı</dt>
                  <dd className="tabular-nums">{played}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">G / B / M</dt>
                  <dd className="tabular-nums">
                    {rating.wins}&thinsp;/&thinsp;{rating.draws}&thinsp;/&thinsp;{rating.losses}
                    {winRate !== null ? (
                      <span className="ml-1.5 text-xs text-muted-foreground">{winRate}%</span>
                    ) : null}
                  </dd>
                </div>
              </dl>
            </div>

            <UncertaintyBar sigma={rating.sigma} label="Modelin bu oyuncuyu ne kadar tanıdığı" />

            <Separator />

            <p className="text-xs leading-relaxed text-muted-foreground">
              σ shrinks with every match played and creeps back up during a lay-off — inactive
              ratings are decayed nightly, which widens σ without ever touching mu. So a long break
              lowers the displayed rating even though the estimate of the player&rsquo;s skill has
              not changed at all: the model has simply become less sure, and it discounts what it is
              unsure about.
              {rating.last_match_at ? (
                <>
                  {" "}
                  Last match{" "}
                  <time dateTime={rating.last_match_at}>
                    {formatKickoff(rating.last_match_at).date}
                  </time>
                  .
                </>
              ) : null}
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Henüz reyting yok</CardTitle>
            <CardDescription>
              Reyting, onaylanmış sonucu olan ilk reytingli maçtan sonra oluşur. Herkes mu 25,0 ve σ 8,33 ile başlar; bu da 0,0 güvenli reyting demektir.
            </CardDescription>
          </CardHeader>
        </Card>
      )}

      {/* ---------------- history ---------------- */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Maç geçmişi</CardTitle>
          <CardDescription>
            {isSelf
              ? `Your last ${HISTORY_LIMIT} rated appearances.`
              : "Only matches you were also part of are shown — a stranger's full history is not public."}
          </CardDescription>
        </CardHeader>

        <CardContent>
          {stats.length === 0 ? (
            <p className="rounded-md border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
              {isSelf
                ? "Henüz maç yok. Reytingli bir maç oyna; sonuç onaylandığında burada görünür."
                : "No shared matches to show."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Maç</TableHead>
                    <TableHead className="text-right">Skor</TableHead>
                    <TableHead className="text-right">G</TableHead>
                    <TableHead className="text-right">A</TableHead>
                    <TableHead className="text-right">Dk</TableHead>
                    <TableHead className="text-right">Reyting</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {stats.map((row) => {
                    const match = matches.get(row.match_id)
                    const kickoff = match ? formatKickoff(match.kickoff_at) : null
                    const scoreLine =
                      match && match.home_score !== null && match.away_score !== null
                        ? `${match.home_score}–${match.away_score}`
                        : "—"

                    return (
                      <TableRow key={row.id}>
                        <TableCell className="max-w-[12rem]">
                          <Link
                            href={`/matches/${row.match_id}`}
                            className="block truncate underline-offset-4 hover:underline"
                          >
                            {kickoff ? `${kickoff.date}, ${kickoff.time}` : "Match"}
                          </Link>
                          <span className="text-xs text-muted-foreground">
                            {match ? MATCH_STATUS_META[match.status].label : "Sana görünmüyor"}
                            {row.team_side ? ` · ${row.team_side}` : ""}
                          </span>
                        </TableCell>

                        <TableCell className="text-right tabular-nums">{scoreLine}</TableCell>
                        <TableCell className="text-right tabular-nums">{row.goals}</TableCell>
                        <TableCell className="text-right tabular-nums">{row.assists}</TableCell>
                        <TableCell className="text-right tabular-nums">{row.minutes_played}</TableCell>
                        <TableCell className="text-right">
                          <RatingDeltaInline ratingDelta={row.rating_delta} />
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
