/**
 * app/(app)/players/[id]/page.tsx
 *
 * A person's page: the card they designed, the rating the model holds, the matches behind it.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT A VISITOR SEES IS DECIDED IN POSTGRES, NOT HERE
 * ---------------------------------------------------------------------------------------------
 *
 * Three policies from `0002_rls.sql` shape this page, and they deliberately disagree with each
 * other about how much to reveal:
 *
 *   profiles       self, admins, teammates, or a non-minor with visibility 'public'/'members'.
 *                  A minor's profile is NEVER visible to a stranger.
 *   player_ratings world-readable to any signed-in user. mu and sigma are non-identifying.
 *   player_stats   your own rows, plus rows from matches you can see.
 *
 * So a private profile yields "rating visible, person not" — which is exactly right, and is why
 * this page renders an explained partial state instead of a 404.
 *
 * The card at the top is the person's own: their accent, the pitch shot they chose, their
 * number. The live pitch behind it is the page's one WebGL canvas — the `(app)` layout's
 * `RouteBanner` is hidden on this route (see `route-banner.tsx`) so there is never a second.
 */

import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"

import { Measure, SectionHead } from "@/components/dashboard/night-band"
import { MATCH_STATUS_META, formatKickoff } from "@/components/match/match-card"
import { RatingDeltaInline, UncertaintyBar, conservativeRating } from "@/components/match/rating-delta"
import { ProfileActions } from "@/components/profile/profile-actions"
import { ProfileCard } from "@/components/profile/profile-card"
import { PitchBanner } from "@/components/three/pitch-banner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { loadCanMessage } from "@/lib/messaging"
import { getSessionUser } from "@/lib/rbac"
import { createClient } from "@/lib/supabase/server"
import { isUuid } from "@onpitch/shared/channels"
import { profileStyleOf } from "@onpitch/shared/profile"

export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "Oyuncu",
  description: "Kart, reyting ve maç geçmişi.",
}

const NIL_UUID = "00000000-0000-0000-0000-000000000000"
const HISTORY_LIMIT = 20

const RATING_1DP = new Intl.NumberFormat("tr-TR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })

export default async function PlayerPage({ params }: { params: { id: string } }) {
  if (!isUuid(params.id)) notFound()

  const session = await getSessionUser()
  if (!session) return null

  const supabase = await createClient()
  const playerId = params.id.toLowerCase()
  const isSelf = playerId === session.user.id.toLowerCase()

  const [profileResult, ratingResult, statsResult, canMessage, blockResult] = await Promise.all([
    supabase
      .from("profiles")
      .select(
        "id, display_name, full_name, city, preferred_position, bio, created_at, avatar_url, role, accent_color, banner_shot, tagline, jersey_number, dominant_foot",
      )
      .eq("id", playerId)
      .maybeSingle(),
    supabase
      .from("player_ratings")
      .select("player_id, mu, sigma, conservative_rating, matches_played, wins, draws, losses, last_match_at")
      .eq("player_id", playerId)
      .maybeSingle(),
    supabase
      .from("player_stats")
      .select(
        "id, match_id, goals, assists, saves, yellow_cards, red_cards, minutes_played, mu_before, sigma_before, mu_after, sigma_after, rating_delta, created_at, team_side",
      )
      .eq("player_id", playerId)
      .order("created_at", { ascending: false })
      .limit(HISTORY_LIMIT),
    isSelf ? Promise.resolve(false) : loadCanMessage(supabase, playerId),
    isSelf
      ? Promise.resolve({ data: [] })
      : supabase.from("user_blocks").select("blocked_id").eq("blocker_id", session.user.id).eq("blocked_id", playerId),
  ])

  if (profileResult.error) {
    console.error("[players/:id] profile read failed:", profileResult.error.code, profileResult.error.message)
  }

  const profile = profileResult.data
  const rating = ratingResult.data
  const stats = statsResult.data ?? []

  if (!profile && !rating) notFound()

  const matchIds = stats.map((row) => row.match_id)
  const { data: matchRows } = await supabase
    .from("matches")
    .select("id, kickoff_at, status, home_score, away_score, home_team_id, away_team_id, is_ranked")
    .in("id", matchIds.length ? matchIds : [NIL_UUID])
  const matches = new Map((matchRows ?? []).map((row) => [row.id, row]))

  const displayName = profile?.display_name ?? profile?.full_name ?? "Gizli profil"
  const style = profileStyleOf(profile ?? {})
  const played = rating?.matches_played ?? 0
  const winRate = played > 0 ? Math.round(((rating?.wins ?? 0) / played) * 100) : null
  const blocked = (blockResult.data ?? []).length > 0
  const totals = stats.reduce(
    (sum, row) => ({ goals: sum.goals + row.goals, assists: sum.assists + row.assists, minutes: sum.minutes + row.minutes_played }),
    { goals: 0, assists: 0, minutes: 0 },
  )

  return (
    <div className="space-y-12 pb-10">
      {/* ---------------- the card ---------------- */}
      <ProfileCard
        name={displayName}
        avatarUrl={profile?.avatar_url}
        style={style}
        city={profile?.city}
        position={profile?.preferred_position}
        role={profile?.role}
        scene={profile ? <PitchBanner shot={style.bannerShot} /> : null}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            {isSelf ? <Badge variant="secondary">Bu sensin</Badge> : null}
            {rating ? (
              <Badge variant="outline" className="border-user/50 text-user">
                Reyting {RATING_1DP.format(rating.conservative_rating ?? conservativeRating(rating.mu, rating.sigma))}
              </Badge>
            ) : null}
            {profile?.created_at ? (
              <span className="label-eyebrow">Üye · {formatKickoff(profile.created_at).date}</span>
            ) : null}
          </div>
          {isSelf ? (
            <Button asChild variant="outline" className="h-11">
              <Link href="/account">Kartını düzenle</Link>
            </Button>
          ) : profile ? (
            <ProfileActions userId={playerId} name={displayName} canMessage={canMessage} blocked={blocked} />
          ) : null}
        </div>
      </ProfileCard>

      {profile?.bio ? <p className="max-w-prose text-pretty leading-relaxed text-foreground/90">{profile.bio}</p> : null}

      {!profile ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Bu profil gizli</CardTitle>
            <CardDescription>
              Aşağıdaki reyting giriş yapmış üyelere açıktır — mu ve sigma, kişinin kim olduğu hakkında bir şey
              söylemez. Arkasındaki ad, şehir ve geçmiş seninle paylaşılmaz.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      {/* ---------------- 01 numbers ---------------- */}
      <section>
        <SectionHead n="01" title="Sayılar" aside={<span className="label-eyebrow">Onaylı maçlardan</span>} />
        <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4 lg:grid-cols-6">
          <Measure label="Maç" value={played} />
          <Measure label="Galibiyet" value={rating?.wins ?? 0} tone="teal" hint={winRate !== null ? `%${winRate}` : undefined} />
          <Measure label="Beraberlik" value={rating?.draws ?? 0} />
          <Measure label="Mağlubiyet" value={rating?.losses ?? 0} tone="vermilion" />
          <Measure label="Gol" value={totals.goals} tone="gold" hint={`son ${stats.length} maçta`} />
          <Measure label="Asist" value={totals.assists} hint={`${totals.minutes} dk`} />
        </dl>
      </section>

      {/* ---------------- 02 rating ---------------- */}
      <section>
        <SectionHead n="02" title="Reyting" aside={<span className="label-eyebrow">mu − 3σ</span>} />
        {rating ? (
          <div className="mt-6 grid gap-8 lg:grid-cols-12">
            <div className="lg:col-span-4">
              <p className="nums text-6xl font-light leading-none text-user" style={{ textShadow: "0 0 40px hsl(var(--accent-user) / 0.35)" }}>
                {RATING_1DP.format(rating.conservative_rating ?? conservativeRating(rating.mu, rating.sigma))}
              </p>
              <p className="label-eyebrow mt-3">Güvenli reyting</p>
            </div>
            <div className="space-y-5 lg:col-span-8">
              <dl className="grid grid-cols-3 gap-x-6 gap-y-4">
                <Measure label="Beceri (mu)" value={RATING_1DP.format(rating.mu)} />
                <Measure label="Belirsizlik (σ)" value={rating.sigma.toFixed(2)} />
                <Measure label="Son maç" value={rating.last_match_at ? formatKickoff(rating.last_match_at).date : "—"} />
              </dl>
              <UncertaintyBar sigma={rating.sigma} label="Modelin bu oyuncuyu ne kadar tanıdığı" />
              <p className="max-w-prose text-xs leading-relaxed text-muted-foreground">
                Sıralamada kullanılan sayı mu − 3σ: modelin, bu oyuncunun yaklaşık %99,7 olasılıkla üstünde olduğuna
                inandığı eşik. σ her maçta küçülür, uzun aralarda gece işleyen bir görevle yavaşça büyür — beceri
                tahmini değişmez, model yalnızca daha az emin olur.
              </p>
            </div>
          </div>
        ) : (
          <p className="mt-6 max-w-prose text-sm text-muted-foreground">
            Henüz reyting yok. Reyting, onaylanmış sonucu olan ilk reytingli maçtan sonra oluşur. Herkes mu 25,0 ve σ
            8,33 ile başlar; bu da 0,0 güvenli reyting demektir.
          </p>
        )}
      </section>

      {/* ---------------- 03 history ---------------- */}
      <section>
        <SectionHead
          n="03"
          title="Maç geçmişi"
          aside={
            <span className="label-eyebrow">
              {isSelf ? `Son ${HISTORY_LIMIT}` : "Ortak maçlar"}
            </span>
          }
        />
        <div className="mt-6">
          {stats.length === 0 ? (
            <p className="rounded-md border border-dashed border-foreground/20 px-4 py-10 text-center text-sm text-muted-foreground">
              {isSelf ? "Henüz maç yok. Reytingli bir maç oyna; sonuç onaylandığında burada görünür." : "Gösterilecek ortak maç yok."}
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
                          <Link href={`/matches/${row.match_id}`} className="block truncate underline-offset-4 hover:text-user hover:underline">
                            {kickoff ? `${kickoff.date}, ${kickoff.time}` : "Maç"}
                          </Link>
                          <span className="text-xs text-muted-foreground">
                            {match ? MATCH_STATUS_META[match.status].label : "Sana görünmüyor"}
                            {row.team_side ? ` · ${row.team_side === "home" ? "ev" : "deplasman"}` : ""}
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
        </div>
      </section>
    </div>
  )
}
