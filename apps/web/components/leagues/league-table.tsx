import Link from "next/link"

import { cn } from "@/lib/utils"
import {
  DIVISION_COLORS,
  DIVISION_LABELS,
  LEAGUE_RULES,
  zoneFor,
  type Division,
  type LeagueStanding,
} from "@onpitch/shared/leagues"

/**
 * A division's standings, set as a printed table.
 *
 * The promotion and relegation zones are marked with a coloured left edge rather than a filled
 * row, for the same reason badges are marks and not tiles here: at table density a block of
 * colour reads as noise. The legend under the table states the rule in words, because a reader
 * who is two points off the drop needs to know how many go down, not just that their row has a
 * red edge.
 *
 * `zoneFor()` is shared with the phone AND mirrors `close_season()` in 0009 — including the rule
 * that nobody moves out of a division with fewer than six teams, so a small table is drawn with
 * no zones at all rather than with zones that will not fire.
 */

export interface LeagueTableProps {
  standings: readonly LeagueStanding[]
  division: Division
  /** Marks the viewer's own rows. */
  highlightTeamIds?: readonly string[]
  className?: string
}

export function LeagueTable({
  standings,
  division,
  highlightTeamIds = [],
  className,
}: LeagueTableProps) {
  if (standings.length === 0) {
    return (
      <p className={cn("text-sm text-muted-foreground", className)}>
        Bu ligde henüz maç oynanmamış. Aynı şehirden iki takım karşılaşıp sonucu kesinleştirdiğinde
        tablo dolmaya başlar.
      </p>
    )
  }

  const tint = DIVISION_COLORS[division]
  const movementApplies = standings.length >= LEAGUE_RULES.minimumForMovement

  return (
    <div className={cn("space-y-4", className)}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[38rem] border-collapse text-sm">
          <caption className="sr-only">
            {DIVISION_LABELS[division]} ligi puan durumu. Sıralama puana, sonra averaja, sonra
            atılan gole göredir.
          </caption>
          <thead>
            <tr className="border-b border-foreground/20">
              <th scope="col" className="label-eyebrow w-10 py-2 text-left">
                #
              </th>
              <th scope="col" className="label-eyebrow py-2 text-left">
                Takım
              </th>
              <th scope="col" className="label-eyebrow py-2 text-right">
                O
              </th>
              <th scope="col" className="label-eyebrow py-2 text-right">
                G
              </th>
              <th scope="col" className="label-eyebrow py-2 text-right">
                B
              </th>
              <th scope="col" className="label-eyebrow py-2 text-right">
                M
              </th>
              <th scope="col" className="label-eyebrow hidden py-2 text-right sm:table-cell">
                A
              </th>
              <th scope="col" className="label-eyebrow hidden py-2 text-right sm:table-cell">
                Y
              </th>
              <th scope="col" className="label-eyebrow py-2 text-right">
                Av
              </th>
              <th scope="col" className="label-eyebrow py-2 text-right">
                P
              </th>
            </tr>
          </thead>
          <tbody>
            {standings.map((row) => {
              const zone = zoneFor(row.place, standings.length, division)
              const mine = highlightTeamIds.includes(row.teamId)

              return (
                <tr
                  key={row.teamId}
                  aria-current={mine ? "true" : undefined}
                  className={cn(
                    "border-b border-foreground/10 last:border-b-0",
                    mine && "bg-gold/10",
                  )}
                >
                  <td className="py-3 pl-2">
                    <span className="flex items-center gap-2">
                      <span
                        aria-hidden="true"
                        className="block h-4 w-0.5"
                        style={{
                          backgroundColor:
                            zone === "promotion"
                              ? "hsl(var(--teal))"
                              : zone === "relegation"
                                ? "hsl(var(--vermilion))"
                                : "transparent",
                        }}
                      />
                      <span className="nums font-mono text-xs text-muted-foreground">
                        {String(row.place).padStart(2, "0")}
                      </span>
                    </span>
                  </td>
                  <td className="py-3">
                    <Link
                      href={`/teams/${row.teamSlug}`}
                      className="underline decoration-transparent underline-offset-4 transition-colors hover:decoration-gold"
                    >
                      {row.teamName}
                    </Link>
                    {mine ? <span className="sr-only"> (senin takımın)</span> : null}
                  </td>
                  <td className="nums py-3 text-right text-muted-foreground">{row.played}</td>
                  <td className="nums py-3 text-right">{row.won}</td>
                  <td className="nums py-3 text-right text-muted-foreground">{row.drawn}</td>
                  <td className="nums py-3 text-right text-muted-foreground">{row.lost}</td>
                  <td className="nums hidden py-3 text-right text-muted-foreground sm:table-cell">
                    {row.goalsFor}
                  </td>
                  <td className="nums hidden py-3 text-right text-muted-foreground sm:table-cell">
                    {row.goalsAgainst}
                  </td>
                  <td className="nums py-3 text-right text-muted-foreground">
                    {row.goalDifference > 0 ? `+${row.goalDifference}` : row.goalDifference}
                  </td>
                  <td className="nums py-3 pr-1 text-right font-mono" style={{ color: tint }}>
                    {row.points}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <p className="border-t border-foreground/15 pt-3 text-xs leading-relaxed text-muted-foreground">
        {movementApplies ? (
          <>
            <span className="inline-block h-2 w-0.5 bg-teal align-middle" aria-hidden="true" /> İlk{" "}
            {LEAGUE_RULES.promote} takım bir üst lige çıkar.{" "}
            <span className="ml-2 inline-block h-2 w-0.5 bg-vermilion align-middle" aria-hidden="true" />{" "}
            Son {LEAGUE_RULES.relegate} takım bir alt lige düşer. Hiç maç yapmamış takım düşmez.
          </>
        ) : (
          <>
            Bu ligde {LEAGUE_RULES.minimumForMovement} takımdan az var; sezon sonunda kimse çıkmaz
            ya da düşmez. {LEAGUE_RULES.minimumForMovement} takıma ulaşınca ilk{" "}
            {LEAGUE_RULES.promote} çıkar, son {LEAGUE_RULES.relegate} düşer.
          </>
        )}
      </p>
    </div>
  )
}

/** The division ladder as a row of chips, with the current one marked. */
export function DivisionLadder({
  active,
  hrefFor,
  className,
}: {
  active: Division
  hrefFor: (division: Division) => string
  className?: string
}) {
  const divisions: Division[] = ["diamond", "platinum", "gold", "silver", "bronze"]

  return (
    <nav aria-label="Lig seviyesi" className={cn("flex flex-wrap items-center gap-1", className)}>
      {divisions.map((division) => {
        const on = division === active
        return (
          <Link
            key={division}
            href={hrefFor(division)}
            aria-current={on ? "page" : undefined}
            className={cn(
              "flex items-center gap-2 border-b-2 px-3 py-2 font-mono text-[0.6875rem] uppercase tracking-[0.12em] transition-colors",
              on ? "text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
            style={on ? { borderBottomColor: DIVISION_COLORS[division] } : undefined}
          >
            <span
              aria-hidden="true"
              className="block h-2 w-2 rotate-45 border"
              style={{
                borderColor: DIVISION_COLORS[division],
                backgroundColor: on ? DIVISION_COLORS[division] : "transparent",
              }}
            />
            {DIVISION_LABELS[division]}
          </Link>
        )
      })}
    </nav>
  )
}
