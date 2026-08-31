/**
 * app/(dashboard)/leaderboard/page.tsx
 *
 * The full ranking, in three scopes.
 *
 * Scope and city are query parameters rather than client state, so a ranking is a link: a
 * captain can paste "Ankara, by streak" into a group chat and everyone opens the same table.
 * Both are parsed against fixed lists before they reach the RPC — `scope` against the enum, and
 * `city` is length-capped and used in an equality predicate, never interpolated.
 *
 * `leaderboard_page()` decides who is publishable — public, non-deleted, non-minor profiles
 * with at least one match — so this page adds no filtering of its own and has none to get
 * wrong. What it does add is the explanation: somebody absent from their own city's table
 * needs to be told it is a privacy setting, not a bug.
 */

import type { Metadata } from "next"
import Link from "next/link"

import { NightBand, SectionHead } from "@/components/dashboard/night-band"
import { LeaderboardOptIn } from "@/components/progress/leaderboard-opt-in"
import { LeaderboardTable } from "@/components/progress/leaderboard-table"
import { getSessionUser } from "@/lib/rbac"
import { loadLeaderboard } from "@/lib/progress"
import { cn } from "@/lib/utils"
import {
  LEADERBOARD_SCOPES,
  LEADERBOARD_SCOPE_LABELS,
  type LeaderboardScope,
} from "@halisaha/shared/gamification"

export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "Sıralama",
  description: "Tecrübe, reyting ve seri sıralamaları.",
}

const PAGE_SIZE = 50

const SCOPE_BLURB: Record<LeaderboardScope, string> = {
  xp: "Toplam tecrübe puanı. Oynamak, kazanmak, gol atmak ve sonucu bildirmek puan kazandırır.",
  rating: "TrueSkill güven alt sınırı: ortalama beceriden belirsizliğin üç katı düşülür. Az maç oynayan yukarı çıkamaz.",
  streak: "Üst üste maç yapılan hafta sayısı. Bir hafta boş geçerse sıfırlanır.",
}

function isScope(value: string | undefined): value is LeaderboardScope {
  return typeof value === "string" && (LEADERBOARD_SCOPES as readonly string[]).includes(value)
}

export default async function LeaderboardPage({
  searchParams,
}: {
  searchParams?: { scope?: string; city?: string }
}) {
  const session = await getSessionUser()
  const profile = session?.profile ?? null

  const scope: LeaderboardScope = isScope(searchParams?.scope) ? searchParams.scope : "xp"
  const rawCity = searchParams?.city?.trim() ?? ""
  const city = rawCity.length > 0 && rawCity.length <= 80 ? rawCity : null

  const entries = await loadLeaderboard({ scope, city, limit: PAGE_SIZE })

  const isPublic = profile?.profile_visibility === "public"
  const canOptIn = !isPublic && profile?.is_minor === false
  const onBoard = entries.some((entry) => entry.playerId === session?.user.id)

  const cityOptions = [
    { label: "Türkiye", value: null },
    ...(profile?.city ? [{ label: profile.city, value: profile.city }] : []),
  ]

  return (
    <div className="space-y-12 pb-10">
      <NightBand
        shot="stands"
        eyebrow="Sıralama"
        title={city ? `${city} sıralaması` : "Türkiye sıralaması"}
        lede={SCOPE_BLURB[scope]}
      >
        <div className="flex flex-wrap items-center gap-x-8 gap-y-4">
          <nav aria-label="Sıralama türü" className="flex items-center gap-1">
            {LEADERBOARD_SCOPES.map((option) => {
              const active = option === scope
              const href = buildHref(option, city)
              return (
                <Link
                  key={option}
                  href={href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "border-b-2 px-3 py-2 font-mono text-[0.6875rem] uppercase tracking-[0.12em] transition-colors",
                    active
                      ? "border-gold text-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  {LEADERBOARD_SCOPE_LABELS[option]}
                </Link>
              )
            })}
          </nav>

          {cityOptions.length > 1 ? (
            <nav aria-label="Şehir" className="flex items-center gap-1">
              {cityOptions.map((option) => {
                const active = option.value === city
                return (
                  <Link
                    key={option.label}
                    href={buildHref(scope, option.value)}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "border-b-2 px-3 py-2 font-mono text-[0.6875rem] uppercase tracking-[0.12em] transition-colors",
                      active
                        ? "border-gold text-foreground"
                        : "border-transparent text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {option.label}
                  </Link>
                )
              })}
            </nav>
          ) : null}
        </div>
      </NightBand>

      <section>
        <SectionHead
          n="01"
          title={`İlk ${Math.min(PAGE_SIZE, Math.max(entries.length, 1))}`}
          aside={<span className="label-eyebrow">{LEADERBOARD_SCOPE_LABELS[scope]}</span>}
        />
        <div className="mt-6 space-y-8">
          <LeaderboardTable entries={entries} scope={scope} currentUserId={session?.user.id ?? null} />

          {canOptIn ? (
            <LeaderboardOptIn />
          ) : isPublic && !onBoard ? (
            <p className="border-t border-foreground/15 pt-4 text-sm text-muted-foreground">
              Profilin herkese açık ama bu sayfada değilsin. İlk {PAGE_SIZE} dışındasın ya da
              henüz sonuçlanmış bir maçın yok.
            </p>
          ) : null}
        </div>
      </section>
    </div>
  )
}

/** Query strings are built in one place so a scope switch can never drop the city filter. */
function buildHref(scope: LeaderboardScope, city: string | null): string {
  const params = new URLSearchParams()
  if (scope !== "xp") params.set("scope", scope)
  if (city) params.set("city", city)
  const query = params.toString()
  return query ? `/leaderboard?${query}` : "/leaderboard"
}
