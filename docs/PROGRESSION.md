# OnPitch — Progression

Reference for `supabase/migrations/0008_gamification.sql` and
`packages/shared/src/gamification.ts`.

The retention layer: experience, levels, weekly streaks, badges, weekly objectives, rankings,
and the venue owner's equivalent of all of it. Six tables, one write primitive, three read APIs.

---

## The one invariant

**XP is never computed at read time and never incremented by application code.**

Every point that exists has a row in `xp_events` saying where it came from, and
`player_progress.xp` is the running total of that ledger. Three things follow from that and none
of them are optional:

| Property | How it is achieved |
|---|---|
| Auditable — "why am I level 7?" | The ledger is the answer, and the dashboard prints the last twelve rows of it |
| Safe to run twice | Every award carries a `dedupe_key`, under a partial unique index on `(user_id, dedupe_key)`. A second attempt is a no-op, not a duplicate |
| Impossible to forge from a client | No role holds `INSERT` or `UPDATE` on any table here. `award_xp` is `SECURITY DEFINER` and its `EXECUTE` is revoked from `anon` and `authenticated` |

`level` is `GENERATED ALWAYS AS (private.level_for_xp(xp)) STORED`, so it can never disagree with
the XP it is derived from.

---

## The curve

Cumulative XP to reach level *L* is `50 · L · (L − 1)`, so the step from *L* to *L+1* is a flat
`100 · L`.

| Level | 1 | 2 | 3 | 4 | 5 | 10 | 20 | 50 |
|---|---|---|---|---|---|---|---|---|
| XP | 0 | 100 | 300 | 600 | 1 000 | 4 500 | 19 000 | 122 500 |

A finished match is worth roughly 40–120 XP, which puts level 2 at about two matches and level 10
at about a season of weekly football.

**The curve is implemented twice, and pinned.** Postgres owns the stored level;
`packages/shared/src/gamification.ts` has a copy so a client can draw a progress ring and animate
a level-up without a round trip. The migration ends with a self-test over the boundary values,
`assertLevelCurveMatchesSql()` checks the TypeScript against the same list, and the web loader
calls it in development. Editing one side alone fails loudly instead of quietly disagreeing about
somebody's level.

Levels also carry a name, because "Seviye 23" tells another player nothing:

| From level | 1 | 5 | 10 | 20 | 35 | 55 |
|---|---|---|---|---|---|---|
| Rank | Çaylak | Amatör | Sahacı | Veteran | Usta | Efsane |

---

## What earns XP

| Event | Points | Dedupe key |
|---|---|---|
| Played a finalized match | 40 | `match:<id>:played` |
| Won | +35 | `match:<id>:won` |
| Drew | +15 | `match:<id>:drawn` |
| Clean sheet (whole side, not just the keeper) | +20 | `match:<id>:cs` |
| Goals | 10 each, capped at 6 | `match:<id>:goals` |
| Assists | 7 each, capped at 6 | `match:<id>:assists` |
| Filed a score report | 8 | `report:<id>` |
| Voted in a consensus round | 12 | `vote:<id>` |
| Paid for a booking | 25 | `booking:<id>:paid` |
| Weekly streak, from week two | `min(75, 15 · (weeks − 1))` | `streak:<monday>` |
| Badge unlocked | per badge | `ach:<code>` |
| Challenge claimed | per challenge | `chal:<uuid>` |

The goal and assist caps exist so one lopsided friendly cannot buy a level. The streak cap is the
balance point: at 75 a full run is worth about one extra match a week. An earlier 150-point cap
made streak bonuses 40% of all XP awarded in testing, which paid people for turning up more than
for playing.

---

## Streaks are recomputed, not incremented

A weekly streak is the number of consecutive ISO weeks in which a player appeared in a finalized
match. `private.recompute_play_streak()` derives it from the whole match history using
gaps-and-islands — subtract seven days per row from an ordered list of distinct weeks, and every
unbroken run shares an anchor, so a run is a `GROUP BY` rather than a walk.

The first implementation incremented instead, and it was wrong in a way worth recording: an
incremental streak depends on the order events arrive in, so the moment anything is back-dated —
a seeder writing a season oldest-last, an admin correcting a fixture, a delayed finalization —
the newer week is already recorded, the older one looks like a repeat, and the counter silently
stops. The seeded dev database showed every player on a one-week streak after eight consecutive
weeks of football. Recomputing is right afterwards no matter what order it was called in.

Every other counter on `player_progress` is recomputed from its source tables for the same
reason. They are denormalised for read speed, never for arithmetic.

A streak stays live through the whole of the following week; `expire_play_streaks()` runs nightly
and sends one `progress.streak_risk` notification on the Sunday of the grace week — before the
fact, which is the only moment it can change anybody's behaviour.

---

## Badges

Nineteen, seeded in the migration with `ON CONFLICT DO UPDATE` so re-running it edits copy in
place. `code` is the stable identity: renaming one orphans every unlock.

`evaluate_achievements()` is a full re-evaluation rather than an incremental one. It runs once per
finalized match per player, reads a single row, and being total means a catalogue addition
backfills itself the next time anybody plays — no migration-time backfill that has to be right
first time. `player_achievements.rewarded` is what stops a re-evaluation paying the XP twice, and
`unlocked_at` is never cleared: once unlocked, always unlocked.

Every criterion is stated on the badge. Nothing is hidden behind a spoiler — a badge you cannot
work out how to earn is a badge nobody chases.

---

## Weekly challenges

Three per week, created by `ensure_weekly_challenges()` from cron each Monday at 00:05 UTC and,
idempotently, by `my_progress()` on read. `(code, starts_on)` is the identity of one running.

**`baseline` is what makes a weekly challenge weekly.** Progress is
`counter now − counter when the player first saw this challenge`, so "play two matches" means two
*this week* rather than two ever.

That ordering is load-bearing and was wrong at first. `sync_challenge_progress()` is now called
**before** the counters move as well as after: called only afterwards, the first match of the week
was folded into its own baseline and earned nothing, so "play two matches" silently needed three.

Rewards are claimed with a tap, not paid out automatically. XP that lands silently is a number
that changed while nobody was looking; collecting it is the mechanic. The `UPDATE` that flips
`claimed_at` from `NULL` is the lock, so two taps award once.

---

## Privacy

`leaderboard_page()` is `SECURITY DEFINER` because it needs `profiles.display_name` for people the
caller has no column grant to read. It therefore applies the privacy rule itself, and applies more
of it than the policies do:

* `profile_visibility = 'public'` — and the column defaults to `private`, so the leaderboard is
  **opt-in**. The dashboard says so rather than showing an empty table and letting the reader
  wonder.
* `deleted_at is null` — an erased account is gone from every ranking.
* `is_minor = false` — redundant today, because `profiles_minor_privacy_locked_check` already
  refuses a public visibility for an under-16 account. It is checked anyway: a leaderboard is
  exactly the surface where a future relaxation of that constraint would leak children.
* at least one finalized match — somebody who has never played is not on a leaderboard.

`xp_events` and `challenge_progress` are strictly own-row. `player_progress` and unlocked badges
follow `private.can_view_profile()`, so a level badge can appear on a public player page.

---

## Venue owners

`venue_scorecard()` gives a facility owner the same thing a player gets: a number that moves when
they do the right thing, and a plain statement of what moves it.

```
score = 10 × paid bookings + 5 × distinct customers − 15 × cancellations − 40 × disputes
tier  = bronze <250 ≤ silver <700 ≤ gold <1500 ≤ platinum
```

Everything is derived from bookings that already exist — no second write path, nothing to keep in
sync, nothing to backfill. `SECURITY DEFINER` steps around RLS, so the function re-checks
ownership itself and raises `42501` for a caller who is neither the owner nor an admin.

---

## Surfaces

| | Web | Mobile |
|---|---|---|
| Dashboard | `/dashboard` | Panel tab (`app/(tabs)/progress.tsx`) |
| Full ranking | `/leaderboard` (scope + city in the URL) | `app/leaderboard.tsx` (scope in local state) |
| Badge cabinet | `/achievements` | `app/achievements.tsx` |
| Venue standing | `/venue` → "Venue standing" | — |

The web dashboard reads `my_progress()` from a Server Component; the phone goes through
`GET /api/progress`, which wraps the same function. One definition of "a player's progress", two
transports.

The level readout differs on purpose: the web draws an SVG ring, the phone draws a plate with a
hairline bar. An SVG arc in React Native means adding `react-native-svg` — a native module — to a
dependency set pinned to Expo SDK 57, for one decorative circle. The plate says the same three
things in the same vocabulary.

---

## Operating it

| Task | How |
|---|---|
| Backfill a database that already held finished football | `select public.backfill_progression(200);` until it returns 0. `service_role` only |
| Open this week's objectives by hand | `select public.ensure_weekly_challenges();` |
| End lapsed streaks by hand | `select public.expire_play_streaks();` |
| Re-run one match's progression | `select public.apply_match_progression('<match uuid>');` — idempotent |

Two cron jobs are scheduled by the migration: `onpitch-weekly-challenges` (Mondays 00:05 UTC) and
`onpitch-streak-expiry` (daily 03:20 UTC). On a database without `pg_cron` the migration still
applies and the functions still exist; drive them from an Edge Function or an external scheduler,
which is why both are granted to `service_role`.

`player_progress` is in the `supabase_realtime` publication so an open dashboard can watch its own
XP move. `xp_events` deliberately is not: that would put every award on the wire for a screen that
shows twelve of them.
