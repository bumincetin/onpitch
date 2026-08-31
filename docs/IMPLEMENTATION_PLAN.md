# Halisaha — MVP Implementation Plan

> Amateur football platform. Dual-sided marketplace: players & teams on one side, venue owners
> on the other. Pitch booking with Stripe Connect split payments, TrueSkill 2 matchmaking,
> anti-collusion score validation, and realtime live scores.

**Stack:** Next.js 14 (App Router) · React 18 · Tailwind + shadcn/ui · Expo 57 + expo-router +
React Native 0.86 · Supabase (Postgres 15, GoTrue, Realtime, Storage) · Stripe Connect Express ·
pg_cron · FastAPI + scikit-learn sidecar.

---

## 0. Execution order at a glance

Each layer is verified before anything is built on top of it.

| # | Layer | Artefact | Gate before moving on |
|---|-------|----------|------------------------|
| 1 | Schema | `supabase/migrations/0001_schema.sql` | `\d+` on every table; exclusion constraints reject overlaps |
| 2 | Security | `0002_rls.sql` | Zero tables with `relrowsecurity = false`; `EXPLAIN` shows `InitPlan` |
| 3 | Identity | `0003_auth_rbac_gdpr.sql` | JWT carries `user_role`; minor signup forces consent |
| 4 | Rating | `0004_trueskill.sql` | Golden-vector test vs reference TrueSkill values |
| 5 | Integrity | `0005_integrity_consensus.sql` | Digest mismatch is rejected; quorum finalises once |
| 6 | Realtime | `0006_realtime.sql` | Non-participant cannot subscribe to a private topic |
| 7 | Scheduled | `0007_cron_decay.sql` | `cron.job_run_details` shows a successful nightly run |
| 8 | Types | `packages/shared/src/database.ts` | `tsc --noEmit` clean |
| 9 | Web app | `apps/web/app/**`, `apps/web/lib/**` | `next build` clean |
| 10 | Money | Stripe onboarding → checkout → webhook | End-to-end test-mode charge splits correctly |
| 11 | ML | `services/anomaly/` | Service down ⇒ platform still finalises matches |
| 12 | Mobile | `apps/mobile/**` | `tsc --noEmit` clean; `expo export` bundles for android and ios |

Migrations are numbered so `supabase db reset` replays them deterministically. **Never edit an
applied migration** — add `00NN_fix_*.sql` instead.

---

## 1. Database schema (`0001_schema.sql`)

**Goal:** one authoritative DDL file every other artefact compiles against. 19 tables, 9 enums.

Core tables: `profiles`, `teams`, `team_members`, `venues`, `pitches`,
`pitch_availability_blocks`, `bookings`, `matches`, `match_participants`, `player_ratings`,
`player_stats`, `score_reports`, `match_anomaly_flags`, `consensus_approvals`,
`venue_payouts`, `stripe_events`, `parental_consent_requests`, `audit_log`, `notifications`.

### Design decisions

**The database enforces the double-booking invariant.** A pitch booking carries a `tstzrange`,
and the table declares:

```sql
EXCLUDE USING gist (
  pitch_id WITH =,
  time_range WITH &&
) WHERE (status IN ('pending','awaiting_payment','confirmed','completed'))
```

Two concurrent checkout requests for the same slot cannot both succeed regardless of race
timing, retries, or serverless cold starts. The API layer's job is to translate SQLSTATE
`23P01` (`exclusion_violation`) into a clean `409 SLOT_TAKEN`. A design that checks availability
with a `SELECT` and then `INSERT`s loses the race under concurrency.

**Money is integer minor units.** Every monetary column is `*_minor integer` (kuruş/cents). No
floats appear anywhere in the money path, in Postgres or in TypeScript. Ratings are `double
precision`; `numeric` is reserved for geographic coordinates (`numeric(9,6)`) and the bounded
quality, probability and anomaly scores (`numeric(6,5)`, `numeric(8,6)`).

**Rating lives in two tables, deliberately.** `player_ratings` holds the *current* posterior
(`mu`, `sigma`, plus a stored generated `conservative_rating = mu - 3*sigma` for cheap indexed
leaderboards). `player_stats` holds the *immutable per-match record* including
`mu_before/sigma_before/mu_after/sigma_after`, so every rating change is auditable and
replayable when a match is later disputed and reversed.

**`is_minor` is a generated column**, not an application-computed flag:

```sql
is_minor boolean GENERATED ALWAYS AS (private.is_minor_dob(date_of_birth)) STORED
```

Postgres requires generated-column expressions to be **IMMUTABLE**, and `current_date` is only
STABLE, so the predicate is wrapped in an `IMMUTABLE` helper. (For the same reason the DOB
sanity CHECK cannot include a `<= current_date` half.)

`STORED` makes the flag a write-time snapshot. A player who turns 16 keeps `is_minor = true`
until their row is next written. That errs in the protective direction, since nobody silently
loses protection, but the aging-out path needs a nightly job to re-touch birthdays crossing the
threshold or those accounts stay restricted forever. Tracked as `0008_minor_aging.sql`.

16 is the GDPR Art. 8 default; member states may lower it to 13 — see
[SECURITY.md](./SECURITY.md).

**Verification**

```sql
-- overlapping bookings must fail
INSERT INTO bookings (...) VALUES (..., tstzrange(now(), now() + interval '1 hour'), ...);
INSERT INTO bookings (...) VALUES (..., tstzrange(now() + interval '30 min', now() + interval '90 min'), ...);
-- expected: ERROR 23P01 conflicting key value violates exclusion constraint
```

---

## 2. Row Level Security (`0002_rls.sql`)

**Goal:** every table `ENABLE` + `FORCE` RLS, with policies that do not collapse into
sequential scans.

### The wrapped-select rule

```sql
-- FORBIDDEN — auth.uid() is treated as volatile and re-evaluated per candidate row
CREATE POLICY p ON bookings FOR SELECT USING (auth.uid() = booked_by);

-- REQUIRED — the scalar subquery is hoisted to an InitPlan, evaluated exactly once
CREATE POLICY p ON bookings FOR SELECT USING ((select auth.uid()) = booked_by);
```

In the bare form the planner cannot prove the expression is constant, so it cannot push the
comparison down as an index condition. It becomes a per-row `Filter`, which on a table of any
size degrades to a sequential scan plus a function call per row. Wrapping it in `(select ...)`
produces a one-shot `InitPlan` whose result is a constant the planner can feed straight into an
index scan on `booked_by`. On a large `bookings` table that is the difference between an index
lookup and a full-table walk. The same applies to `(select auth.jwt())` and to every helper:
`(select private.owns_venue(venue_id))`.

Confirm the hoist actually happened:

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM public.bookings WHERE pitch_id = '...';
-- want:  InitPlan 1 (returns $0)  +  Index Scan using idx_bookings_booked_by
-- avoid: Seq Scan ... Filter: (auth.uid() = booked_by)
```

CI enforces the rule with a grep over `supabase/migrations` that fails the build on an unwrapped
`auth.uid()`, `auth.jwt()` or `auth.role()` inside a `USING` or `WITH CHECK` clause.

### Supporting rules

- **Index everything a policy touches.** A perfectly hoisted policy still seq-scans if the
  compared column has no index. Every FK and every policy-referenced column gets a B-Tree index
  in `0001`; `0002` adds any the policies revealed. CI re-checks the FK half by querying
  `pg_constraint` for foreign keys whose leading column heads no index.
- **Split policies per command.** Separate `SELECT` / `INSERT` / `UPDATE` / `DELETE` policies
  instead of `FOR ALL`, so a read path never pays to evaluate a write predicate.
- **Helpers are `STABLE SECURITY DEFINER SET search_path = ''`** with fully qualified
  identifiers, so they are cacheable within a statement and immune to `search_path` hijacking.
- **`TO authenticated`** on every policy. An unqualified policy is also evaluated for `anon`.
- **Ledger tables have no `authenticated` policies at all.** `stripe_events`, `audit_log` and
  `parental_consent_requests` are service-role only. RLS with zero policies denies everyone,
  which is the correct default for a webhook ledger.

**Gate:** this query must return zero rows.

```sql
SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity;
```

---

## 3. Auth, RBAC & GDPR Article 8 (`0003_auth_rbac_gdpr.sql`)

**Roles:** `admin`, `venue_owner`, `player`.

1. **`handle_new_user()`** — `AFTER INSERT ON auth.users` trigger creating the `profiles` row
   from `raw_user_meta_data`. It coerces anything that is not `player` / `venue_owner` down to
   `player`: a client controls its own signup metadata, so self-service `admin` must be
   impossible by construction.
2. **`custom_access_token_hook(event jsonb)`** — the GoTrue Auth Hook injecting `user_role`,
   `is_minor` and `parental_consent_status` claims into the JWT. Middleware RBAC therefore costs
   **zero database round-trips** on the hot path, and RLS policies can read
   `(select auth.jwt()) ->> 'user_role'` instead of joining `profiles`. Enable it in
   `supabase/config.toml`:

   ```toml
   [auth.hook.custom_access_token]
   enabled = true
   uri = "pg-functions://postgres/public/custom_access_token_hook"
   ```

   Role changes only take effect on token refresh — force a refresh after any role mutation.
3. **Age gate.** `enforce_minor_privacy()` (BEFORE INSERT/UPDATE on `profiles`) hard-sets
   `location_sharing_enabled = false`, `profile_visibility = 'private'`,
   `marketing_opt_in = false` for minors and raises if anything tries to flip them. The
   `profiles_minor_privacy_locked_check` CHECK constraint backs the trigger, so even a
   service-role write cannot make a minor public by accident. Private-by-default is enforced in
   the database; the UI only reflects it.
4. **Parental consent workflow.**
   - `request_parental_consent(guardian_email, guardian_name)` generates 32 random bytes,
     stores **only** `digest(token,'sha256')`, sets a 7-day expiry, and returns the raw token
     exactly once so the API can email it. The database never holds a usable token; a dump of
     `parental_consent_requests` grants nothing.
   - `verify_parental_consent(raw_token)` hashes the input, matches a pending unexpired row,
     flips `profiles.parental_consent_status = 'granted'`, and writes `audit_log`.
   - `assert_consented(user)` is called by every transacting RPC, so a minor without consent
     cannot book or join a ranked match.
5. **Data-subject rights.** `export_my_data()` (Art. 15/20 portability, returns one `jsonb`
   document) and `request_account_erasure()` (Art. 17). Erasure **pseudonymises** rather than
   hard-deletes: financial rows are retained under the legal-obligation basis (Art. 17(3)(b),
   tax law), with PII replaced by deterministic hashes. Documented in the migration so the
   choice is defensible to a regulator.

---

## 4. TrueSkill 2 rating engine (`0004_trueskill.sql`)

A Bayesian skill posterior per player: `mu` (mean skill) and `sigma` (uncertainty).

**Constants** (held in the single-row `rating_config` table, tunable without a deploy):
`MU0 = 25`, `SIGMA0 = 25/3`, `BETA = SIGMA0/2` (per-match performance noise), `TAU = SIGMA0/100`
(dynamics — skill drifts between matches), `DRAW_PROBABILITY = 0.10`.

**Update, per match:**

1. `sigma_i² += TAU²` — reopen the posterior slightly; without this, ratings freeze and can
   never recover from a bad streak.
2. Team aggregation with partial-play weights `w_i` (TrueSkill 2's substitution support):
   `mu_team = Σ w_i·mu_i`, `sigma_team² = Σ w_i²·sigma_i²`.
3. `c² = sigma_A² + sigma_B² + n·BETA²`, `t = (mu_winner − mu_loser)/c`,
   `eps = icdf((p_draw+1)/2)·sqrt(n)·BETA`.
4. Pick the truncated-Gaussian moments `v/w` from the win or draw pair.
5. `mu_i ± w_i·(sigma_i²/c)·v` and `sigma_i² ·= max(1 − w_i·(sigma_i²/c²)·w_fn, floor)`.
6. **Outcome-magnitude weighting** (the "2" in TrueSkill 2): a bounded multiplier derived from
   the goal margin, `1 + ln(1+margin)/margin_log_divisor` with `margin_log_divisor = 8`, capped
   at `margin_factor_max = 1.35`. A 9–0 friendly nudges harder than a 1–0 but cannot detonate a
   rating. Clamps: `sigma ∈ [0.4, SIGMA0]`, `mu ∈ [1, 60]`.

**Numerics.** `std_normal_cdf` uses `erfc` where available with an Abramowitz–Stegun 7.1.26
fallback for PG15 (< 1e-7 error); `std_normal_icdf` uses Acklam/Moro. The `v`/`w` draw functions
have explicit tail guards — the naive `pdf/cdf` ratio underflows to `0/0` in the far tail and
returns `NaN`, which would silently poison every rating in the match.

**`apply_match_rating(match_id)`** is the transactional entry point: `SELECT ... FOR UPDATE` on
the match, verify it is finalised / ranked / not already rated (`rating_applied_at IS NULL`),
write before+after values into `player_stats`, stamp `rating_applied_at`. It is **idempotent**,
so a webhook retry or a double-click never double-applies a rating.

`match_quality(team_a, team_b)` returns the standard draw-probability quality score, consumed
by matchmaking.

**Gate:** golden-vector test, asserted by the migration itself. Two default-rated players
(25, 25/3), A beats B, standard parameters ⇒ the winner reaches `mu = 29.395831692991514` and
`sigma = 7.171475807009221`, the loser `mu ≈ 20.604`, matching the published TrueSkill reference
values 29.396 / 20.604 / 7.171. The migration raises if either differs by more than 1e-6.

---

## 5. Data integrity & anti-collusion (`0005_integrity_consensus.sql`)

Three escalating layers. Cheap checks run first; the ML service is only consulted for what
survives.

**Layer 1 — rule engine (in-database, synchronous).** `validate_score_report()` BEFORE INSERT:
reporter is an actual participant, kickoff has passed, score is plausible for the format,
report is inside the 48h window, per-reporter rate limit. Rejections carry SQLSTATEs the API
maps to plain-language errors (`PT403`, `PT404`, `PT409`, `PT422`, `PT429`).

**Layer 2 — anomaly detection (external, asynchronous, advisory).**
`anomaly_features(match_id)` builds the feature vector; `matches_pending_anomaly_check(limit)`
feeds the sweep. The Isolation Forest scores it:

> `score = 2^(−E[h(x)] / c(n))` where `E[h(x)]` is the mean path length to the isolating leaf
> and `c(n) = 2H(n−1) − 2(n−1)/n`. A short path means the point was separated from the rest of
> the sample in very few splits, which is what makes it anomalous. A score at or above
> `anomaly_score_threshold()` — 0.62 by default, overridable with `app.anomaly_threshold` —
> sets `requires_consensus`.

Features: score variance across reports, reporting delay, reporter count, opposing-side
agreement, roster-overlap ratio (the same two line-ups meeting repeatedly is the classic
rating-farming signature), historical report deviation, goal difference, kickoff hour, venue
booking volume, reporter account age.

**The ML service is advisory.** If it is unreachable or slow (2.5s timeout), the platform falls
back to the Layer-1 verdict and records `source = 'rule_engine'`. A down sidecar degrades
detection quality; it never blocks a match from finalising.

**Layer 3 — cryptographic peer consensus.** For flagged matches:

1. `open_consensus_round(match_id)` mints a 16-byte nonce.
2. `consensus_payload(match_id)` builds the **canonical** document — sorted keys, no
   whitespace, sorted participant ids, the nonce. The digest is only meaningful if browser and
   server serialise identical bytes, so the ordering is pinned to jsonb's own collation, which
   sorts keys by UTF-8 length first and then bytewise: `nonce, match_id, away_score, home_score,
   reported_at, participant_ids`.
3. The client computes `sha256(canonical)` via `crypto.subtle` and submits it with the vote.
   `submit_consensus_approval` **recomputes the digest server-side and rejects on mismatch.**
   That binds an approval to one exact scoreline: a blank "yes" cannot be harvested and attached
   to an edited score afterwards.
4. `finalize_consensus(match_id)` requires a ⌈2/3⌉ quorum of confirmed participants **with
   approvals from both sides**, then finalises and calls `apply_match_rating`. Row-locked and
   idempotent. A rejection quorum sends the match to `disputed` for admin review.

`signature_alg` is stored per approval rather than fixed in code, so upgrading from
session-derived HMAC to Ed25519 device keys is a data migration rather than a rewrite.

---

## 6. Realtime & WAL (`0006_realtime.sql`)

Two transports, used for different things:

- **Postgres Changes** — WAL-sourced, authorised by re-running the subscriber's `SELECT`
  policy against each changed row. Authoritative but comparatively expensive. Used for
  `matches`, `bookings`, `match_participants`, `notifications`.
- **Broadcast** — a pub/sub topic that does not touch the database per event. Used for
  high-frequency live score ticks.

`matches` gets `REPLICA IDENTITY FULL` because RLS must be evaluated against the OLD row and
`UPDATE` payloads must carry unchanged columns. It costs WAL volume, so **only** `matches` gets
it; everything else keeps default primary-key identity.

**Topic convention.** `packages/shared/src/channels.ts` is the single source of truth for topic
strings and broadcast event names, mirrored character for character by the `realtime.messages`
policies in `0006_realtime.sql` §5. Nothing else builds a topic by string concatenation: a topic
that file cannot produce is a topic no policy authorises, and Realtime fails a private-channel
join with no rows rather than an error, so a typo delivers silence instead of throwing.

| Topic | Builder | Who may read |
|---|---|---|
| `match:<id>` | `matchTopic(id)`, `presenceTopic(id)` | anyone who can `SELECT` the match |
| `match:<id>:private` | `matchPrivateTopic(id)` | rows in `match_participants`, plus admins |
| `venue:<id>` | `venueTopic(id)` | the owning venue owner, plus admins |

`presenceTopic(id)` is an alias of `matchTopic(id)`, not a fourth topic: presence rides the
score channel so there is one socket and one authorisation, and no `presence:*` topic that would
match no policy and therefore never join at all. Every one of these is a private channel and
must be joined with `{ config: { private: true } }` — a channel joined without it performs no
authorisation, because Realtime never consults `realtime.messages`.

Policies parse the UUID out of `realtime.topic()` with an anchored `substring(...)` rather than
a `::uuid` cast, so a malformed topic fails closed instead of raising `22P02` and handing a
prober a distinguishable error. `parseTopic()` on the client is total for the same reason: given
garbage it returns `null`.

**Connection strings** (`.env.example` carries the templates):

| Use | Mode | Port | Notes |
|---|---|---|---|
| Next.js route handlers (serverless) | Supavisor **transaction** | **6543** | `?pgbouncer=true`, prepared statements off. Each invocation is short-lived; transaction mode multiplexes so many concurrent functions share few Postgres backends. |
| Migrations, `pg_cron`, `train.py` | Supavisor session | 5432 | Session state, advisory locks, long jobs. |
| Realtime WAL slot | direct | 5432 | Replication cannot go through a pooler. |

Using session mode from serverless is the classic way to exhaust `max_connections` under load.

---

## 7. Scheduled decay (`0007_cron_decay.sql`)

`decay_inactive_ratings(inactive_days := 30, daily_sigma_growth := 0.03, cap := SIGMA0)`

For players idle > 30 days, grow uncertainty and never touch `mu`:

```sql
sigma := least(cap, sqrt(sigma^2 + days_elapsed * growth^2));
```

Scaling by `days_elapsed` since `last_decay_at` lets a night the cron did not run be absorbed by
the next run rather than silently lost. Batched with a row limit per iteration so it never
long-locks `player_ratings`.

Jobs:

| Job | Schedule | Purpose |
|---|---|---|
| `nightly-rating-decay` | `15 3 * * *` | sigma inflation for inactive players |
| `expire-stale-consensus` | `*/15 * * * *` | finalise or escalate past-deadline consensus rounds |
| `purge-expired-consent-requests` | daily | delete expired parental-consent tokens |

Guarded with `cron.unschedule` so re-running the migration cannot duplicate jobs. Verify with
`SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 20;`.

---

## 8. Type safety

`packages/shared/src/database.ts` mirrors the schema in the exact shape
`supabase gen types typescript` emits — `Database['public']['Tables'][T]['Row' | 'Insert' |
'Update']`, `Enums`, `Functions`. Generated columns (`is_minor`, `conservative_rating`,
`player_stats.rating_delta`) are **omitted from `Insert` and `Update`**; including them would let
TypeScript bless a write Postgres will reject.

The file is currently hand-written and lags migrations 0004/0005 in several places: the argument
names of `match_quality`, the return type of `apply_match_rating`, the fifth `p_signature_alg`
parameter of `submit_consensus_approval`, the RPCs those migrations added, and the
`consensus_nonce` columns. The SQL wins, because it is what the database executes, so
`apps/web/lib/matchmaking/index.ts` exports a narrow `loose()` escape hatch that lets those calls
use the argument names PostgREST actually accepts. `grep 'loose('` finds every site bypassing the
generated types. Regenerate rather than hand-edit once the CLI is available, and delete the
escape hatch when the regeneration lands:

```bash
npm run db:types        # supabase gen types typescript --local > packages/shared/src/database.ts
```

`packages/shared/src/domain.ts` holds what is not a row: branded `MinorUnits`, `BookingQuote`,
`RatingSnapshot`, `AnomalyFeatureVector` (field-for-field identical to the Python `pydantic`
model — the two must be changed together), `ConsensusPayload`, the `ApiResponse<T>` discriminated
union every route returns, and the zod schemas every route validates with. Nothing crossing a
trust boundary is typed by assertion; every such value is parsed.

---

## 9. Workspace & app structure

### The monorepo

The repository is an npm-workspaces monorepo. Root `package.json` declares two workspaces,
`apps/web` and `packages/*`. **`apps/mobile` is deliberately not one of them:** it keeps its own
`package-lock.json` and is installed by a root `postinstall` that runs
`npm --prefix apps/mobile install`, because Expo pins exact React Native and React versions that
would fight the web app's hoisted tree.

```
apps/web/            Next.js 14 App Router  (@halisaha/web)
apps/mobile/         Expo 57 + expo-router  (@halisaha/mobile)
packages/shared/     @halisaha/shared — code both clients import
supabase/            migrations/ · functions/ · config.toml
services/anomaly/    FastAPI + IsolationForest sidecar
docs/ · scripts/progress.mjs · .github/workflows/ci.yml
```

### Why `packages/shared` exists

Two modules would otherwise be copy-pasted into both clients and drift apart:

- **`trueskill.ts`** mirrors `public.trueskill2_update` from `0004_trueskill.sql` numerically:
  same constants, same branch structure, same underflow fallbacks, same clamps. Both clients use
  it to answer "if we win 3–1, what happens to my rating?" without a round trip, and `balance.ts`
  calls it hundreds of times per suggestion. Two forks of it means the web app promises +2.4, the
  phone promises +2.6, and the database awards +1.9, which reads to a player as the platform
  lying.
- **`channels.ts`** holds the realtime topic strings that the `realtime.messages` policies match
  character for character. A forked copy with a one-character difference does not throw; the
  channel joins and delivers nothing.

`database.ts`, `domain.ts` (including the zod schemas both clients validate responses with),
`balance.ts` and `quality.ts` live there for the same reason.

The package has **no build step**. `main`, `types` and the `exports` map point straight at the
TypeScript sources, so `@halisaha/shared/domain` resolves to `packages/shared/src/domain.ts` and
an edit is picked up by `next dev` and by Metro without a rebuild. The cost is a hard constraint
on what may live there: platform-neutral only — no `next/*`, no `react-native`, no `node:*`, no
DOM globals. Anything that cannot satisfy that belongs in an app.

Web resolves the package through the workspace (`"@halisaha/shared": "*"`); mobile links it with
`file:../../packages/shared`. Metro needs four explicit settings for that to work, all in
`apps/mobile/metro.config.js`: watch the workspace root, so shared edits trigger a reload; list
`nodeModulesPaths` nearest-first, so a locally pinned package wins over a hoisted one; set
`disableHierarchicalLookup`, so a stray `packages/shared/node_modules/react` cannot load a second
React and turn every hook into "Invalid hook call"; and keep `unstable_enablePackageExports` on,
since the subpath exports map is the only way `@halisaha/shared/domain` resolves at all.

### App Router

```
apps/web/
  app/
    (auth)/       login · signup · parental-consent · account/password   ← unauthenticated
    (app)/        venues · venues/[slug] · venues/[slug]/[pitchId]
                  bookings · bookings/[id] · checkout/[bookingId]
                  matches · matches/[id] · matches/[id]/live
                  teams · teams/new · teams/[slug] · teams/[slug]/settings
                  players/[id] · notifications
                  account · account/privacy · account/security
    (dashboard)/
      dashboard/  post-login landing; admins land here, not on /admin
      venue/      page · calendar · pitches · bookings · payouts ·
                  onboarding · onboarding/complete
      admin/      page · users · venues · disputes · anomalies · matches/[id]
    api/
      stripe/connect/{onboard,refresh,status,login-link} · stripe/webhook
      bookings/{checkout,[id]/cancel}
      venues/{search,[id]/metrics} · pitches/{route,[id]/slots,[id]/availability}
      matches/{route,[id]/join,[id]/report-score,[id]/consensus}
      teams/{route,[id]/members,[id]/members/[playerId]}
      matchmaking/suggest · notifications/{route,read-all,[id]/read}
      account · gdpr/{export,erase} · auth/parental-consent/{request,verify}
      admin/{metrics,users/[id]/role,matches/[id]/resolve}
      internal/{anomaly/check,bookings/expire-reservations} · health
    auth/{callback,signout} · privacy · terms
    layout.tsx · page.tsx · loading.tsx · error.tsx · not-found.tsx
  components/  ui/ (shadcn primitives) · auth/ · account/ · booking/ · team/ ·
               match/ · notifications/ · venue/ · admin/ · nav/
  lib/         supabase/{client,server,admin,middleware} · stripe · payments · rbac ·
               gdpr · api-response · auth/bearer · booking/availability · teams/slug ·
               notifications/format · realtime/{use-match-channel,use-presence} ·
               matchmaking/ · venue/metrics · admin/metrics · use-toast · utils
  middleware.ts

apps/mobile/
  app/         index · (auth)/{sign-in,sign-up,age-gate} · (tabs)/{index,book,profile}
               venue/[slug] · venue/[slug]/[pitchId] · booking/[id] · bookings
               match/[id]/{index,live,report,consensus} · player/[id] · teams
               settings/{index,privacy,notifications} · +native-intent
  components/  ui/ · booking/ · match/ · profile/
  lib/         supabase · api · env · format · gdpr · data-error · booking/slots ·
               hooks/{use-match-channel,use-notifications}

packages/shared/src/  index · database · domain · trueskill · balance · quality · channels
supabase/             migrations/0001…0007 · functions/{trueskill-update,anomaly-sweep,_shared}
services/anomaly/     FastAPI + IsolationForest sidecar
```

Route groups `(auth)`, `(app)`, `(dashboard)` scope layouts and role guards without appearing
in URLs. Server Components fetch through the cookie-bound client and **rely on RLS as the
security boundary** — an explicit `.eq('owner_id', user.id)` is a query optimisation, never
the authorisation.

`apps/web/middleware.ts` refreshes the session on every request and enforces coarse RBAC from
the JWT claim (`/admin/*` → admin, `/venue/*` → venue_owner|admin, matched so that the public
`/venues` listing is not caught by the `/venue` prefix), falling back to a `profiles` lookup
only when the claim is absent. The claim is only as fresh as the token, so a demoted admin can
still reach `/admin` until the next refresh; the RLS policies behind the page are what stop
them acting.

The mobile app has no middleware equivalent and needs none. React Native has no cookie jar, so
the Expo client sends the same Supabase access token as `Authorization: Bearer <jwt>` and
`apps/web/lib/auth/bearer.ts` resolves it to the same `auth.uid()` the cookie path resolves to,
so every policy in `0002_rls.sql` behaves identically for both. There is no second permission
model for mobile.

---

## 10. Stripe Connect Express onboarding

Express is chosen so **Stripe hosts KYC**: the platform never touches identity documents,
which keeps AML/KYC obligations and PCI scope with Stripe while still allowing a branded flow
and platform-controlled payout schedules.

1. `POST /api/stripe/connect/onboard` → `requireRole('venue_owner','admin')` → reuse or create
   an Express account with `card_payments` + `transfers` requested and
   `metadata.supabase_user_id`. **Idempotency key derived from the user id**, so a double-click
   cannot create two connected accounts for one owner. `stripe_account_id` is persisted with the
   **admin client** — the user must never be able to write their own connected-account id.
2. Account Links are single-use and expire; `/refresh` mints a new one and redirects.
3. `/status` normalises `account.requirements` into
   `{ chargesEnabled, payoutsEnabled, detailsSubmitted, currentlyDue, pastDue, disabledReason }`
   and flips `venues.is_active` once charges **and** payouts are enabled.
4. `/login-link` opens the Express dashboard for the owner.

No route ever accepts an account id from the request body — it is always looked up from the
authenticated session.

---

## 11. Checkout & split payments

**Destination charge**, chosen over direct charges + separate transfers:

```ts
stripe.paymentIntents.create({
  amount: total_minor,
  currency,
  application_fee_amount: platform_fee_minor,         // platform's cut
  transfer_data: { destination: connectedAccountId }, // venue's cut, at capture
  on_behalf_of: connectedAccountId,
  metadata: { booking_id, pitch_id, venue_id, user_id },
}, { idempotencyKey: bookingId })
```

The platform is merchant of record (one charge, one statement descriptor, one refund path, and
disputes land on the platform where support lives). Direct charges would put the venue on the
hook for disputes and fragment the customer experience; separate transfers would need a second
API call that can fail after the money moved.

The checkout route runs these steps in this order, and the order is load-bearing:

1. Authenticate, `requireRole`, assert parental consent for minors.
2. Validate the body with zod. **Never trust a client-sent amount** — recompute from
   `pitches.hourly_rate_minor` × duration server-side.
3. Verify the connected account has `charges_enabled`.
4. **Insert the booking first** with `status = 'awaiting_payment'`, so the exclusion constraint
   atomically reserves the slot. Map `23P01` → `409 SLOT_TAKEN`.
5. Create the PaymentIntent with the booking id as the idempotency key.
6. On Stripe failure, release the booking so a dead reservation cannot hold a slot hostage.

`awaiting_payment` is inside the exclusion predicate, so the row holds the slot from the moment
it commits — and a customer who simply closes the tab produces no Stripe event at all, so no
webhook ever fires to release it. `POST /api/internal/bookings/expire-reservations` sweeps those,
oldest first, on a short interval. It cancels the PaymentIntent *before* releasing the
reservation, so a card completed later cannot land `payment_intent.succeeded` on a freed
booking. The route is guarded by `INTERNAL_API_TOKEN` compared with `timingSafeEqual` and runs
as service_role, since no user session may write `status`, `payment_status` or `cancelled_at`.

**Webhook** (`apps/web/app/api/stripe/webhook/route.ts`). A mistake here is a financial
incident, so:

- `export const runtime = 'nodejs'` and read the **raw** body with `await req.text()`.
  `req.json()` re-serialises the payload, and the signature is computed over the exact bytes,
  so it will never verify.
- `stripe.webhooks.constructEvent(raw, sig, secret)`; 400 on failure without explaining why.
- Two secrets: the account endpoint and the **Connect** endpoint (`account.updated`,
  `payout.*` arrive there).
- **Idempotency:** insert the event id into `stripe_events` first; a conflict means already
  processed ⇒ return 200 immediately. Stripe retries for up to 3 days with at-least-once
  delivery, so exactly-once *processing* is the platform's job.
- Handled: `payment_intent.succeeded` → booking `confirmed`; `payment_intent.payment_failed`;
  `charge.refunded`; `charge.dispute.created` → `disputed`; `account.updated` → onboarding
  state; `payout.paid|failed` → `venue_payouts`.
- Writes use the service-role client (no user session exists). Return 200 for unknown events;
  reserve 5xx for genuinely retryable failures.

```bash
stripe listen --forward-to localhost:3000/api/stripe/webhook
```

---

## 12. Matchmaking

`packages/shared/src/trueskill.ts` is a numerically identical TypeScript mirror of the SQL
engine, used for client-side "what would this cost me" previews and for scoring candidate
line-ups without a round-trip. **The SQL function remains the single source of truth for
persisted ratings**; the mirror never writes. Its constants are the default row of
`rating_config`, which is tunable at runtime, so anything that has to be exact — an audit, a
dispute — reads the server's answer rather than the mirror's.

`balance.ts` splits N players into two sides maximising match quality: snake-draft seed by
conservative rating, then steepest-ascent local search over cross-side swaps under an iteration
budget, respecting goalkeeper coverage and format size. Exhaustive search is 1,716 splits at
7-a-side but 352,716 at 11-a-side, and the same code runs inside a route handler while a player
waits. There is no randomness in the file and ties break on player id, so the same roster always
produces the same suggestion — which makes the algorithm testable and stops "re-roll the teams
until I like them" from being a strategy.

`quality.ts` ranks open matches for one player across five components, each normalised to [0,1]
before weighting and combined as a weighted mean whose weights sum to 1: TrueSkill quality of
that player added to the fixture, Haversine distance to the venue with exponential decay,
kickoff-hour preference, format preference, and the no-show reliability of the players already
in the match. For minors the distance term is not down-weighted but **removed**, and its weight
is redistributed proportionally across the rest, because
`profiles_minor_privacy_locked_check` keeps their `location_sharing_enabled` off.

`apps/web/lib/matchmaking/index.ts` re-exports all three and adds the plumbing every
`app/api/matches/**` handler needs: `callRpc`, the SQLSTATE → `ApiRouteError` mapping that
forwards the curated `PT*` messages verbatim instead of flattening them to a 500, and
`canonicalJsonbText`, which reproduces PostgreSQL's `jsonb::text` rendering so the browser can
recompute a consensus digest byte-for-byte.

Edge Functions: `trueskill-update` (applies ratings for a match id) and `anomaly-sweep`
(batch-scores pending matches via the sidecar) — both deployable with
`supabase functions deploy`.

---

## 13. Anomaly microservice (`services/anomaly/`)

FastAPI + scikit-learn `IsolationForest` (200 estimators, fixed `random_state` for
reproducibility). Endpoints `POST /score`, `POST /score/batch`, `GET /healthz`,
`GET /model/info`.

- **Cold start.** With no trained artefact the service falls back to a documented deterministic
  rule scorer and labels itself `rules-fallback-v1` in the response, so the caller always knows
  which scorer answered.
- **Request signing:** `X-Halisaha-Signature = hex(hmac_sha256(secret, timestamp + '.' + body))`
  with a 300s skew window and `hmac.compare_digest`. The scoring endpoint is not public.
- `train.py` pulls historical features over the **session-mode** connection (5432) — a long
  analytical job has no business on the transaction pooler.

---

## 14. Venue dashboard

Real-time weekly calendar (`apps/web/components/venue/booking-calendar.tsx`) subscribed to
`postgres_changes` on `bookings` filtered to the owner's pitches. Two mechanisms are at work and
should not be conflated: the `pitch_id=in.(…)` filter is a bandwidth filter on the replication
stream, while the `bookings_select_stakeholders` RLS `SELECT` policy is the authorisation.
Owners drag out blackout windows into `pitch_availability_blocks`, where
`pitch_blocks_no_overlap` rejects overlaps and the UI surfaces the rejection as a toast.

Opening hours are wall-clock times in `venues.timezone` while bookings are absolute instants, so
the grid converts each day's opening and closing times through the venue zone rather than
offsetting a UTC day. Skip that and a DST boundary shifts every cell against the bookings drawn
on top of it.

Metrics (`apps/web/lib/venue/metrics.ts`): occupancy = booked slot-minutes ÷ bookable
slot-minutes (honouring opening hours and blackouts), gross revenue, platform fees,
net-to-venue, average booking value, cancellation rate, WoW deltas — SQL-side aggregates, never
N+1 loops. Payouts combine `venue_payouts` with the live Stripe payout schedule.

---

## 15. Live match experience

`use-match-channel.ts` — `apps/web/lib/realtime/` on web, `apps/mobile/lib/hooks/` on mobile —
subscribes to **both** transports and reconciles them: broadcast is fast but lossy, the `matches`
row is truth, last-write-wins on `updated_at`. It handles `SUBSCRIBED` / `CHANNEL_ERROR` /
`TIMED_OUT` / `CLOSED` with backoff reconnect and re-calls `realtime.setAuth()` when the JWT
refreshes. An expired token makes the socket stop delivering with no error and no status change,
so nothing surfaces the failure unless the hook does.

A broadcast score tick is not the score. `matches.home_score` / `away_score` appear in no
column-level UPDATE grant (`0002_rls.sql` §4) — a result can only enter the system through
`score_reports` — so a tick is an ephemeral unofficial count that lets everyone at the pitch
watch the same number go up, and the scoreboard labels the two differently. Ticks carry a
monotonic per-sender `seq` because broadcast has no ordering guarantee across senders, so two
phones tapping at once resolve on `(seq, at)` rather than arrival order.

The scoreboard announces the running score through a single `aria-live="polite"` region carrying
a whole sentence. The consensus panel recomputes the canonical digest in the browser and says in
one line what the vote binds: this exact scoreline.

---

## 16. Test, CI, ship

| Layer | What to test |
|---|---|
| SQL | pgTAP: RLS denies cross-tenant reads; exclusion constraint rejects overlap; TrueSkill golden vectors; decay is idempotent per day |
| Unit | `trueskill.ts` matches SQL to 1e-9; `balance.ts` determinism; fee arithmetic rounding |
| Integration | Stripe test-mode charge → webhook → `bookings.status = 'confirmed'`; replayed webhook is a no-op |
| E2E | minor signup → consent → booking blocked until granted |
| Security | see [SECURITY.md](./SECURITY.md) |

CI (`.github/workflows/ci.yml`) runs four jobs:

- **web** — `tsc --noEmit` for `@halisaha/shared` and `@halisaha/web`, then `next lint` and
  `next build`. It installs with `npm ci --ignore-scripts` to skip the mobile postinstall.
- **mobile** — `npm ci --prefix apps/mobile`, `tsc --noEmit`, then
  `expo export --platform android --platform ios`. A green typecheck says nothing about Metro's
  ability to resolve the monorepo; bundling is what catches an unhoisted transitive dependency
  or a broken `metro.config.js`.
- **migrations** — replays `supabase/migrations/*.sql` in order against a stock `postgres:15`
  service, with the Supabase-managed `auth` / `realtime` objects and roles stubbed in first, then
  asserts three gates: every public table has RLS enabled, no policy contains an unwrapped
  `auth.*()` call, every foreign key heads an index.
- **anomaly** — `pytest` against `services/anomaly`.

**Go-live checklist**

- [ ] Zero `public` tables with RLS disabled
- [ ] `EXPLAIN` shows `InitPlan` on the hot policies
- [ ] Auth hook enabled; a fresh JWT carries `user_role`
- [ ] Live-mode Stripe keys; both webhook secrets set; endpoints registered
- [ ] `PLATFORM_FEE_BPS` confirmed with finance
- [ ] `SUPABASE_SERVICE_ROLE_KEY` server-only — never in a `NEXT_PUBLIC_*` or `EXPO_PUBLIC_*`
      var or a client bundle
- [ ] `INTERNAL_API_TOKEN` set, and the reservation sweep scheduled against it
- [ ] Serverless `DATABASE_URL` on port 6543 with `?pgbouncer=true`
- [ ] `pg_cron` jobs scheduled and observed to run
- [ ] Anomaly service reachable, and verified that the platform still works when it is not
- [ ] Privacy policy + parental-consent copy reviewed by counsel

---

## Deferred past MVP

Tournaments and leagues · in-app chat · push notifications · referee assignment · dynamic
pricing · multi-currency · Ed25519 device-key signing · SHAP-based anomaly explanations · a real
model trained on production data · regenerating `packages/shared/src/database.ts` with the
Supabase CLI and deleting the `loose()` escape hatch.
