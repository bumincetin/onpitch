/**
 * app/(dashboard)/leagues/page.tsx
 *
 * The city leagues: five divisions, thirteen-week seasons, promotion and relegation.
 *
 * City and division are query parameters rather than client state, so a table is a link a
 * captain can paste into a group chat. Both are read against fixed lists — the division against
 * the enum, the city against the set of cities that actually have a live season — so neither can
 * be pointed anywhere the RPC would not go anyway.
 *
 * The page opens on the reader's own city when they have one, because a national picker is not
 * useful to somebody who plays in Kadıköy on Tuesdays.
 */

import type { Metadata } from "next"

import { NightBand, SectionHead } from "@/components/dashboard/night-band"
import { DivisionLadder, LeagueTable } from "@/components/leagues/league-table"
import { MyLeagueCard } from "@/components/leagues/my-league-card"
import { getSessionUser } from "@/lib/rbac"
import { loadLeagueCities, loadLeagueTable, loadMyLeagues } from "@/lib/leagues"
import { cn } from "@/lib/utils"
import {
  DIVISIONS,
  DIVISION_LABELS,
  LEAGUE_RULES,
  daysLeft,
  type Division,
} from "@halisaha/shared/leagues"
import Link from "next/link"

export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "Ligler",
  description: "Şehir ligleri, puan durumu, yükselme ve düşme.",
}

function isDivision(value: string | undefined): value is Division {
  return typeof value === "string" && (DIVISIONS as readonly string[]).includes(value)
}

export default async function LeaguesPage({
  searchParams,
}: {
  searchParams?: { city?: string; division?: string }
}) {
  const session = await getSessionUser()
  const profile = session?.profile ?? null

  const [cities, mine] = await Promise.all([loadLeagueCities(), loadMyLeagues()])

  // The city has to be one that actually has a season, or `league_table()` answers with nothing
  // and the page looks broken rather than empty.
  const requested = searchParams?.city?.trim()
  const known = cities.map((entry) => entry.city)
  const city =
    (requested && known.includes(requested) ? requested : null) ??
    (profile?.city && known.includes(profile.city) ? profile.city : null) ??
    mine[0]?.city ??
    known[0] ??
    null

  const division: Division = isDivision(searchParams?.division)
    ? searchParams.division
    : (mine.find((entry) => entry.city === city)?.division ?? "bronze")

  const season = cities.find((entry) => entry.city === city) ?? null
  const standings = city ? await loadLeagueTable(city, division, season?.seasonId ?? null) : []
  const myTeamIds = mine.map((entry) => entry.teamId)

  const hrefFor = (next: { city?: string; division?: Division }) => {
    const params = new URLSearchParams()
    const c = next.city ?? city
    const d = next.division ?? division
    if (c) params.set("city", c)
    if (d !== "bronze") params.set("division", d)
    const query = params.toString()
    return query ? `/leagues?${query}` : "/leagues"
  }

  return (
    <div className="space-y-14 pb-10">
      <NightBand
        shot="aerial"
        eyebrow={season ? `${season.seasonName} · ${season.city}` : "Şehir ligleri"}
        title={city ? `${city} ${DIVISION_LABELS[division]} Ligi` : "Şehir ligleri"}
        lede={
          season
            ? `Sezon ${LEAGUE_RULES.seasonWeeks} hafta sürer ve bitmesine ${daysLeft(
                season.endsOn,
              )} gün var. Aynı şehirden iki takımın oynadığı her kesinleşmiş maç tabloya işlenir.`
            : "Henüz açılmış bir sezon yok. Aynı şehirden iki takım maç yapıp sonucu kesinleştirdiğinde şehrin ligi açılır."
        }
      >
        {cities.length > 0 ? (
          <div className="flex flex-wrap items-center gap-x-8 gap-y-4">
            <nav aria-label="Şehir" className="flex flex-wrap items-center gap-1">
              {cities.map((entry) => {
                const on = entry.city === city
                return (
                  <Link
                    key={entry.city}
                    href={hrefFor({ city: entry.city })}
                    aria-current={on ? "page" : undefined}
                    className={cn(
                      "border-b-2 px-3 py-2 font-mono text-[0.6875rem] uppercase tracking-[0.12em] transition-colors",
                      on
                        ? "border-gold text-foreground"
                        : "border-transparent text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {entry.city}
                    <span className="ml-2 opacity-60">{entry.teams}</span>
                  </Link>
                )
              })}
            </nav>

            <DivisionLadder
              active={division}
              hrefFor={(next) => hrefFor({ division: next })}
            />
          </div>
        ) : null}
      </NightBand>

      {mine.length > 0 ? (
        <section>
          <SectionHead n="01" title="Takımların" />
          <div className="mt-6 grid gap-px border border-foreground/15 bg-foreground/15 sm:grid-cols-2 lg:grid-cols-3">
            {mine.map((entry) => (
              <MyLeagueCard key={`${entry.seasonId}-${entry.teamId}`} entry={entry} />
            ))}
          </div>
        </section>
      ) : null}

      <section>
        <SectionHead
          n={mine.length > 0 ? "02" : "01"}
          title={`${DIVISION_LABELS[division]} · puan durumu`}
          aside={<span className="label-eyebrow nums">{standings.length} takım</span>}
        />
        <div className="mt-6">
          <LeagueTable
            standings={standings}
            division={division}
            highlightTeamIds={myTeamIds}
          />
        </div>
      </section>

      <section>
        <SectionHead n={mine.length > 0 ? "03" : "02"} title="Nasıl işliyor" />
        <div className="mt-6 grid gap-8 lg:grid-cols-3">
          <div>
            <p className="label-eyebrow">Lig neresi</p>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              Lig bir şehirdir. Amatör futbol yereldir; salı akşamı Kadıköy&apos;den Ankara&apos;ya
              maça gidilmez. Bir maçın tabloya işlenmesi için iki takımın da aynı şehirden olması
              gerekir.
            </p>
          </div>
          <div>
            <p className="label-eyebrow">Puanlama</p>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              Galibiyet 3, beraberlik 1 puan. Eşitlikte önce averaj, sonra atılan gol sayısı
              bakılır. Puan ve averaj veritabanında sonuçlardan üretilir; elle değiştirilemez.
            </p>
          </div>
          <div>
            <p className="label-eyebrow">Çıkma ve düşme</p>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              Sezon sonunda ilk {LEAGUE_RULES.promote} takım bir üst lige çıkar, son{" "}
              {LEAGUE_RULES.relegate} takım bir alt lige düşer. Ligde{" "}
              {LEAGUE_RULES.minimumForMovement} takımdan az varsa kimse yer değiştirmez. Hiç maç
              yapmamış takım düşmez — lige ara vermek bedava olmalı.
            </p>
          </div>
        </div>
      </section>
    </div>
  )
}
