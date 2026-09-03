/**
 * app/(dashboard)/dashboard/page.tsx
 *
 * The player's home. Set like the landing page: a night band, a numbered spine, hairlines
 * instead of card chrome, and one accent colour.
 *
 * `(dashboard)` is a route GROUP — the parentheses keep it out of the URL — so this file is
 * what creates the `/dashboard` URL that `middleware.ts` (`homeForRole`), `lib/rbac.ts`,
 * `/auth/callback` and both auth forms redirect to. Without it every one of those redirects
 * lands on `app/not-found.tsx`.
 *
 * WHAT IS ON THIS PAGE AND WHY
 * The five sections are the five reasons somebody opens the app when they are not already
 * mid-booking: what am I on (level and form), when do I play next, what can I finish this week,
 * what have I collected, and where do I stand. Everything else — searching, booking, rosters —
 * has its own screen and is reached from here rather than duplicated onto it.
 *
 * Every read is best-effort. `loadMyProgress()` returns null instead of throwing, and the page
 * renders around the gap: a progression outage costs the rings, not the fixture list.
 *
 * The `?error=forbidden` notice is the one `middleware.ts` stamps on a wrong-role bounce. Like
 * `app/(auth)/login/page.tsx`, the query parameter is mapped through a FIXED table and never
 * echoed: `from` is attacker-controllable, so it is read for nothing and printed nowhere.
 */

import type { Metadata } from "next"
import Link from "next/link"

import { NightBand, Measure, SectionHead } from "@/components/dashboard/night-band"
import { AchievementGrid, AchievementSummary } from "@/components/progress/achievement-grid"
import { ChallengeList } from "@/components/progress/challenge-list"
import { LeaderboardOptIn } from "@/components/progress/leaderboard-opt-in"
import { LeaderboardTable } from "@/components/progress/leaderboard-table"
import { MyLeagueCard } from "@/components/leagues/my-league-card"
import { LevelCaption, LevelRing } from "@/components/progress/level-ring"
import { NextFixtureCard } from "@/components/progress/next-fixture"
import { FormRow, StreakStrip } from "@/components/progress/streak-strip"
import { XpLedger } from "@/components/progress/xp-ledger"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { getSessionUser } from "@/lib/rbac"
import { loadLeaderboard, loadMyProgress, loadNextFixture, loadRecentForm } from "@/lib/progress"
import { loadMyLeagues } from "@/lib/leagues"
import { formatXp, rankForLevel } from "@onpitch/shared/gamification"

export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "Panelim",
  description: "Seviyen, serin, bu haftaki görevlerin ve sıradaki maçın.",
}

/** Fixed, non-echoing messages. Anything not in here is ignored. */
const NOTICES: Record<string, { title: string; body: string }> = {
  forbidden: {
    title: "Bu sayfa senin değil",
    body: "Giriş yapmış durumdasın ama orası başka bir hesap türü için. İşte kendi panelin.",
  },
}

const QUICK_LINKS = [
  { href: "/venues", label: "Saha ara", hint: "Boş saat bul ve kilitle" },
  { href: "/matches", label: "Açık maçlar", hint: "Kadrosu eksik oyunlara katıl" },
  { href: "/teams", label: "Takımlar", hint: "Kadronu kur ya da birine katıl" },
  { href: "/bookings", label: "Rezervasyonlarım", hint: "Ödemeler ve iptaller" },
  { href: "/leagues", label: "Ligler", hint: "Şehrindeki puan durumu" },
] as const

export default async function DashboardPage({
  searchParams,
}: {
  searchParams?: { error?: string; from?: string }
}) {
  // The layout above has already run `requireRole()`, so a session exists; this read is deduped
  // against the layout's own call rather than being a second round trip.
  const session = await getSessionUser()
  const profile = session?.profile ?? null
  const userId = session?.user.id ?? null
  const name = profile?.display_name ?? profile?.full_name ?? null

  const notice = searchParams?.error ? NOTICES[searchParams.error] : undefined

  // Five independent reads. Sequential would be five round trips on the app's home screen.
  const [progress, form, fixture, leaders, leagues] = await Promise.all([
    loadMyProgress(),
    userId ? loadRecentForm(userId) : Promise.resolve({ results: [], lastFive: [] }),
    userId ? loadNextFixture(userId) : Promise.resolve(null),
    loadLeaderboard({ scope: "xp", city: profile?.city ?? null, limit: 5 }),
    loadMyLeagues(),
  ])

  const level = progress?.level ?? 1
  const rank = rankForLevel(level)
  const counters = progress?.counters
  const isPublic = profile?.profile_visibility === "public"
  // A minor is hard-blocked from a public profile by
  // `profiles_minor_privacy_locked_check`, so offering the opt-in would be offering
  // something Postgres will refuse.
  const canOptIn = !isPublic && profile?.is_minor === false

  return (
    <div className="space-y-14 pb-10">
      {notice && (
        <Alert variant="destructive">
          <AlertTitle>{notice.title}</AlertTitle>
          <AlertDescription>{notice.body}</AlertDescription>
        </Alert>
      )}

      {/* ----------------------------------------------------------- the band */}
      <NightBand
        shot="centre"
        eyebrow={`Panel · ${profile?.city ?? "Türkiye"}`}
        title={name ? `Tekrar hoş geldin, ${name}` : "Tekrar hoş geldin"}
        lede={
          progress
            ? `${rank.tr} · ${formatXp(progress.xp)} XP. Sonraki seviyeye ${formatXp(
                Math.max(0, progress.nextLevelAt - progress.xp),
              )} XP kaldı.`
            : "Seviyen yüklenemedi, ama sahaya çıkmana engel değil."
        }
        aside={progress ? <LevelRing xp={progress.xp} level={progress.level} /> : null}
      >
        <div className="grid gap-8 lg:grid-cols-12">
          <div className="space-y-6 lg:col-span-7">
            {progress ? <LevelCaption xp={progress.xp} level={progress.level} /> : null}

            <div className="grid gap-6 sm:grid-cols-2">
              {progress ? (
                <StreakStrip
                  weeks={progress.currentStreakWeeks}
                  longest={progress.longestStreakWeeks}
                  lastPlayedOn={progress.lastPlayedOn}
                />
              ) : null}
              <FormRow results={form.results} />
            </div>

            {counters ? (
              <dl className="grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">
                <Measure label="Maç" value={counters.matchesPlayed} />
                <Measure label="Galibiyet" value={counters.matchesWon} tone="teal" />
                <Measure label="Gol" value={counters.goals} tone="gold" />
                <Measure label="Asist" value={counters.assists} />
              </dl>
            ) : null}
          </div>

          <div className="lg:col-span-4 lg:col-start-9">
            <NextFixtureCard fixture={fixture} />
          </div>
        </div>
      </NightBand>

      {/* ------------------------------------------------------- 01 challenges */}
      <section>
        <SectionHead
          n="01"
          title="Bu haftanın görevleri"
          aside={
            progress ? (
              <span className="label-eyebrow nums">
                {progress.challenges.filter((c) => c.completedAt !== null).length} /{" "}
                {progress.challenges.length}
              </span>
            ) : null
          }
        />
        <div className="mt-6">
          {progress ? (
            <ChallengeList challenges={progress.challenges} />
          ) : (
            <p className="text-sm text-muted-foreground">Görevler yüklenemedi.</p>
          )}
        </div>
      </section>

      {/* ----------------------------------------------------------- 02 leagues */}
      {leagues.length > 0 ? (
        <section>
          <SectionHead
            n="02"
            title="Lig durumun"
            aside={
              <Link
                href="/leagues"
                className="label-eyebrow text-gold transition-opacity hover:opacity-70"
              >
                Puan durumu →
              </Link>
            }
          />
          <div className="mt-6 grid gap-px border border-foreground/15 bg-foreground/15 sm:grid-cols-2 lg:grid-cols-3">
            {leagues.map((entry) => (
              <MyLeagueCard key={`${entry.seasonId}-${entry.teamId}`} entry={entry} />
            ))}
          </div>
        </section>
      ) : null}

      {/* ------------------------------------------------------ 03 achievements */}
      <section>
        <SectionHead
          n="03"
          title="Rozetler"
          aside={progress ? <AchievementSummary achievements={progress.achievements} /> : null}
        />
        <div className="mt-6 space-y-5">
          {progress ? (
            <>
              <AchievementGrid achievements={progress.achievements} limit={6} />
              <Link
                href="/achievements"
                className="label-eyebrow inline-flex items-center gap-2 text-gold transition-opacity hover:opacity-70"
              >
                Tüm rozetler
                <span aria-hidden="true">→</span>
              </Link>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">Rozetler yüklenemedi.</p>
          )}
        </div>
      </section>

      {/* -------------------------------------------------------- 03 leaderboard */}
      <section>
        <SectionHead
          n="04"
          title={profile?.city ? `${profile.city} sıralaması` : "Sıralama"}
          aside={<span className="label-eyebrow">Tecrübe</span>}
        />
        <div className="mt-6 space-y-6">
          <LeaderboardTable entries={leaders} scope="xp" currentUserId={userId} />
          {canOptIn ? <LeaderboardOptIn /> : null}
          <Link
            href="/leaderboard"
            className="label-eyebrow inline-flex items-center gap-2 text-gold transition-opacity hover:opacity-70"
          >
            Tüm sıralama
            <span aria-hidden="true">→</span>
          </Link>
        </div>
      </section>

      {/* ------------------------------------------------------------ 04 ledger */}
      <section>
        <SectionHead n="05" title="Puan defteri" />
        <div className="mt-4 max-w-2xl">
          {progress ? (
            <XpLedger events={progress.recentEvents} />
          ) : (
            <p className="text-sm text-muted-foreground">Puan hareketleri yüklenemedi.</p>
          )}
        </div>
      </section>

      {/* ------------------------------------------------------------ 05 links */}
      <section>
        <SectionHead n="06" title="Kısayollar" />
        <div className="mt-6 grid gap-px border border-foreground/15 bg-foreground/15 sm:grid-cols-2 lg:grid-cols-4">
          {QUICK_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="group flex flex-col bg-background p-5 transition-colors hover:bg-secondary/60"
            >
              <span className="text-base font-normal">{link.label}</span>
              <span className="mt-1.5 text-sm text-muted-foreground">{link.hint}</span>
              <span className="label-eyebrow mt-4 text-gold opacity-0 transition-opacity group-hover:opacity-100">
                Aç →
              </span>
            </Link>
          ))}
        </div>

        {profile ? (
          <div className="mt-6">
            <Button variant="outline" size="sm" asChild>
              <Link href={`/players/${profile.id}`}>Profilimi gör</Link>
            </Button>
          </div>
        ) : null}
      </section>
    </div>
  )
}
