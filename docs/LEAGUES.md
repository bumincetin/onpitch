# Halısaha — Şehir Ligleri / City Leagues

Reference for `supabase/migrations/0009_leagues.sql` and `packages/shared/src/leagues.ts`.

Five divisions, thirteen-week seasons, promotion and relegation, one league per city.

---

## Why a city

A league is a **city**, not a country. Amateur football is local — nobody drives from Kadıköy to
Ankara for a Tuesday night game — so a national table would rank people who can never play each
other, and every position in it would be an accident of who happened to be in the same fixture
list.

A match counts toward the league when it is **finalized**, has **two teams**, has a **score**, and
**both teams are from the same city**. A friendly against a side from another city is still
football, still rated by TrueSkill, still worth XP — it just is not a league fixture, because it
is not a fixture either side's rivals can be measured against.

---

## The ladder

| | Bronz | Gümüş | Altın | Platin | Elmas |
|---|---|---|---|---|---|
| rank | 1 | 2 | 3 | 4 | 5 |

`private.division_rank()` reads the enum's own order, so **the enum is append-only**: inserting a
tier in the middle silently renumbers everything above it. `divisionRank()` /`divisionAt()` in
`@halisaha/shared/leagues` mirror it, and both ends are pinned — the migration's self-test and
`assertDivisionLadderMatchesSql()` check the same round trip.

---

## Seasons

Thirteen weeks (91 days), aligned to a fixed epoch of **Monday 5 January 2026**, so every city's
seasons start on the same Monday. Alignment is not cosmetic: it is what lets a player who moves
city carry a comparable record, and what stops "season 3" meaning two different date ranges in two
different tables.

`ensure_city_season(city, on)` is idempotent on `(city, starts_on)` and is called from cron, from
the finalize trigger, and from `my_leagues()` on read.

**Only one season per city is ever live.** `my_leagues()`, `league_cities()` and `league_table()`
all filter on the window containing today rather than on `status = 'active'` alone — a historical
import opens seasons whose windows have already closed, and until the nightly rollover reaches
them a player would otherwise see the same team once per open season. `backfill_leagues()` calls
`roll_over_seasons()` at the end for the same reason.

---

## Scoring and order

Three for a win, one for a draw. `points` and `goal_difference` are **GENERATED STORED**, so a
standings row can never disagree with the results behind it — the same discipline as
`player_progress.level` in 0008.

Ordered by points, then goal difference, then goals scored, then team name. `idx_league_entries_standings`
covers exactly that.

---

## Promotion and relegation

At the end of a season, per division:

| Rule | Why |
|---|---|
| Top **2** go up | Two rather than one because amateur divisions are small and a single slot makes a season turn on one fixture |
| Bottom **2** go down | Symmetric, same reason |
| Nobody moves below **6** teams | A four-team table is not a competition; relegating somebody out of it would be arbitrary |
| A team that played **no fixtures** is ranked last but is **not relegated** | The league should cost nothing to sit out. Punishing absence pushes exactly the casual sides this product is for out of the bottom division |
| Elmas cannot promote, Bronz cannot relegate | `division_at()` clamps, and `close_season()` says so explicitly so the intent survives a refactor |

`close_season()` also opens the next season and carries every team into it at its new division, so
a returning player finds a table with their team already in it rather than an empty page. Promotion
pays 300 XP per squad member, a title 500, and every player gets a `league.season_closed`
notification — a season that ended in silence is a season nobody noticed they were in.

Idempotent: a season already `closed` returns 0 without touching anything.

---

## Idempotence

`league_results` is keyed on `match_id`. Counting a match twice is therefore **impossible** rather
than merely unlikely: the second insert conflicts, and the standings update is skipped. Same
discipline as `xp_events.dedupe_key` in 0008 and `stripe_events.id` in 0001 — a trigger that can
fire twice has to be written so that it does not matter.

The trigger is separate from the progression trigger in 0008 even though both fire on the same
status transition, so a fault in either subsystem cannot take the other down with it.

---

## Privacy

`league_table()` is SECURITY DEFINER because it joins `teams` for a name and crest, so it
re-applies the visibility rule `teams_select_public_or_member` would have applied: **only public
teams appear**. `my_leagues()` deliberately ignores that flag — your own team's position is yours
to see whether or not the team is listed publicly.

RLS is read-only for every client on all three tables. Every write goes through a SECURITY DEFINER
function, which is what stops a captain editing their own points total.

---

## Operating it

| Task | How |
|---|---|
| Count matches that predate the migration | `select public.backfill_leagues(500);` until it returns 0. `service_role` only |
| Close a season by hand | `select public.close_season('<season uuid>');` — idempotent |
| Roll over every lapsed season | `select public.roll_over_seasons();` |
| Open a city's season | `select public.ensure_city_season('İstanbul');` |

One cron job: `halisaha-league-rollover`, daily at 03:40 UTC. On a database without `pg_cron` the
migration still applies and the functions still exist; drive `roll_over_seasons()` from an Edge
Function, which is why it is granted to `service_role`.

---

## Surfaces

| | Web | Mobile |
|---|---|---|
| Tables and the ladder | `/leagues` (city + division in the URL) | `app/leagues.tsx` (local state) |
| Your own position | `/dashboard` → "Lig durumun" | Panel tab → "Ligler →" |
| API | `GET /api/leagues`, `GET /api/leagues/table` | same two routes |

The web page puts city and division in the query string so a table is a link a captain can paste
into a group chat. The phone keeps them in local state, because a phone has no URL bar to paste
from.
