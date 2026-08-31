# Halısaha

A dual-sided marketplace for amateur football in Turkey: players and teams book floodlit pitches
from venue owners, play the match, and report the score. The interface is Turkish throughout,
including API error messages.

- **Book a pitch** and pay through Stripe Connect Express. A destination charge sends the money
  to the venue's connected account and keeps `application_fee_amount` (`PLATFORM_FEE_BPS`, 10%
  by default) on the platform.
- **Get matched** by a TrueSkill 2 rating engine implemented in PL/pgSQL, mirrored in TypeScript
  for client-side previews. A nightly `pg_cron` job widens sigma for anyone who has not played in
  30 days, so an idle rating becomes uncertain rather than quietly stale.
- **Report scores** through three layers: an in-database rule engine, an Isolation Forest sidecar,
  and a peer-consensus round that opens when the anomaly score clears
  `public.anomaly_score_threshold()` (0.62).
- **Run a venue** from a dashboard with an availability calendar, occupancy, revenue, and the
  Stripe payout schedule.
- **Climb a city league.** Five divisions, bronze to diamond, on 13-week seasons from a fixed
  epoch. The top two go up and the bottom two come down, but only in a division with at least six
  teams — promoting out of a four-team table is noise, not achievement. Tables, promotion and
  relegation are all computed in SQL (`close_season()`, `roll_over_seasons()`).
- **Keep playing.** An XP ledger with a derived level (`50·L·(L−1)`), weekly streaks recomputed
  by gaps-and-islands so back-dated results cannot silently break a run, 19 badges, and weekly
  challenges with baselines.
- **Watch live** over Supabase Realtime: broadcast for score ticks, Postgres Changes for the
  state that has to be right, both authorised by RLS.

The interface is built around procedural Three.js scenes of floodlit pitches at night — one
WebGL context per page, a frame-time resolution governor, and a `prefers-reduced-motion` path
that renders a still. See [docs/DESIGN.md](docs/DESIGN.md).

## Layout

```
apps/web/          Next.js 14 App Router, React 18, TypeScript strict, Tailwind + shadcn/ui
apps/mobile/       Expo SDK 57, expo-router, React Native 0.86, React 19
packages/shared/   database.ts · domain.ts · trueskill.ts · balance.ts · quality.ts
                   · channels.ts · gamification.ts · leagues.ts
supabase/          migrations 0001…0010 · functions/ (Deno edge) · config.toml
services/anomaly/  FastAPI + scikit-learn IsolationForest sidecar
scripts/           check-schema-drift.mjs · generate-mobile-assets.mjs · seed-dev.mjs
                   · progress.mjs
docs/
```

`apps/web` and `packages/*` are npm workspaces. `apps/mobile` is not: Metro and the Expo SDK
pin their own dependency versions, so it keeps a separate `package-lock.json` and is installed by
the root `postinstall` hook (`npm --prefix apps/mobile install`). `packages/shared` reaches it
through a `file:` dependency, which is why the root install has to run first.

Inside `apps/web`:

```
app/          (auth) (app) (dashboard) route groups, api/ route handlers, auth/ callbacks
components/   ui/ (shadcn primitives) · account · admin · auth · booking · match · nav
              · notifications · team · venue
lib/          supabase clients · stripe · payments · rbac · gdpr · realtime · matchmaking
              · booking · teams · admin · notifications · api-response · env
              · rate-limit · site-url · progress · leagues
components/three/  the night-pitch scenes: world · players · scene · textures · palette
```

## Quick start

Node 20+, the Supabase CLI (hoisted into `node_modules/.bin`, so `npx supabase` works), Docker
running for the local stack.

```bash
npm install                            # root workspaces, then apps/mobile via postinstall
cp .env.example apps/web/.env.local    # fill in Supabase + Stripe keys
npx supabase start                     # Postgres 15, GoTrue, Realtime, Storage, Studio on :54323
npx supabase db reset                  # replays migrations 0001…0010
npm run dev                            # Next.js on http://localhost:3000
```

The template lives at the repository root but the copy belongs in `apps/web/`. `npm run dev`
runs `next dev` with `apps/web` as its working directory, and Next loads `.env.local` from there;
a copy left at the root is never read.

In a second terminal, so webhook deliveries reach the local route handler:

```bash
npm run stripe:listen             # prints the whsec_… to paste into STRIPE_WEBHOOK_SECRET
```

For the phone:

```bash
cp apps/mobile/.env.example apps/mobile/.env    # EXPO_PUBLIC_API_URL must be your LAN address
npm run dev:mobile                              # expo start
```

`npm run dev` has to stay up while the mobile app runs — the Expo client calls the same
`/api/**` route handlers the web app does, with the Supabase access token as a bearer header.

The anomaly sidecar is optional. Without it, `POST /api/internal/anomaly/check` records a
rule-engine verdict and everything downstream behaves the same. To run it, see
[services/anomaly/README.md](services/anomaly/README.md).

## Environment

| File | Read by |
|---|---|
| `apps/web/.env.local` (from the root `.env.example`) | the Next.js app |
| `apps/mobile/.env` (from `apps/mobile/.env.example`) | Expo, inlined into the bundle at build time |
| `services/anomaly/.env` (from `services/anomaly/.env.example`) | the FastAPI sidecar, exported into its process |

Two values must be byte-identical across files: `ANOMALY_SERVICE_SECRET` (Next.js signs, the
sidecar verifies) and `INTERNAL_API_TOKEN` (the Edge Functions and cron present it to
`/api/internal/*`). Edge Functions read their own copies, set with `supabase secrets set` —
`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are injected by the platform
and do not need setting.

## Scripts

Run from the repository root.

| Script | What it does |
|---|---|
| `npm run dev` | `next dev` in `apps/web` |
| `npm run dev:mobile` | `expo start` in `apps/mobile` |
| `npm run build` | `next build` in `apps/web` |
| `npm run lint` | `next lint` in `apps/web` |
| `npm run typecheck` | `tsc --noEmit` across the workspaces, then `apps/mobile` |
| `npm test` | vitest in `packages/shared` and `apps/web` — 120 tests |
| `npm run verify` | typecheck, then lint, then test. What CI runs, in one command |
| `npm run db:reset` | `supabase db reset` |
| `npm run db:types` | **read the warning below before running this** |
| `npm run stripe:listen` | forwards Stripe events to `localhost:3000/api/stripe/webhook` |
| `npm run install:mobile` | reinstalls `apps/mobile` on its own lockfile |
| `npm run progress` | serves the build dashboard on `localhost:4321` |

> **`npm run db:types` will destroy work.** `packages/shared/src/database.ts` is maintained **by
> hand**, and the generator discards every doc comment in it — which columns are `GENERATED`,
> which is `citext`, that `venues.timezone` is an IANA zone used to render slot grids. Running it
> overwrites all of that with a bare type. The script is kept for reading the generated output
> and diffing it by eye, not for piping over the file. What keeps hand-maintenance safe is
> `scripts/check-schema-drift.mjs`, which CI runs against the migrated schema and which compares
> table names, column names and nullability.

## CI

`.github/workflows/ci.yml`, four jobs on every push:

| Job | What it proves |
|---|---|
| **web** | typecheck, lint, both unit suites, and a production build |
| **mobile** | typecheck plus a real Metro bundle for android and ios — a green typecheck says nothing about Metro's ability to resolve the monorepo |
| **migrations** | replays all ten migrations into a stock Postgres 15, then runs four gates |
| **anomaly** | the sidecar's pytest suite |

The four database gates, each of which has caught something real:

1. **Every table in `public` has RLS enabled.**
2. **No unwrapped `auth.uid()` in a policy** — the bare form is re-evaluated per row and
   collapses the plan into a sequential scan. Comments are stripped before matching, because
   `0002_rls.sql` documents the forbidden pattern in prose and would otherwise fail on its own
   explanation.
3. **Every foreign key is indexed** — an RLS policy filtering on an unindexed FK still scans.
4. **`database.ts` matches the migrated schema** — table names, column names, nullability.

The unit suites are not incidental coverage. Where logic exists twice — TrueSkill, the XP level
curve, the division ladder — the TypeScript copy is pinned against the same fixture the
migration's own `do $selftest$` block asserts, so the two cannot silently diverge. See
[docs/PRODUCTION.md](docs/PRODUCTION.md) section 1.

## Documentation

| Doc | What's in it |
|---|---|
| [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) | The build in order — schema, RLS, auth/GDPR, TrueSkill, integrity, realtime, app, payments — with the reasoning behind each decision |
| [docs/DATA_MODEL.md](docs/DATA_MODEL.md) | Tables, enums, constraints and the entity diagram |
| [docs/DESIGN.md](docs/DESIGN.md) | The night-pitch 3D system: camera splines, the `data-shot` contract, the performance governor |
| [docs/PROGRESSION.md](docs/PROGRESSION.md) | XP, levels, streaks, badges and weekly challenges |
| [docs/LEAGUES.md](docs/LEAGUES.md) | City leagues: divisions, seasons, promotion and relegation |
| [docs/API.md](docs/API.md) | Route handler reference, request and response shapes |
| [docs/SECURITY.md](docs/SECURITY.md) | Trust boundaries, threat model, GDPR positions, pre-release checklist |
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | Setup, migrations, Stripe wiring, connection strings, troubleshooting |
| [docs/PRODUCTION.md](docs/PRODUCTION.md) | What has been verified in this repository, what has not, and the deployment steps |
| [apps/mobile/README.md](apps/mobile/README.md) | The Expo client: Metro monorepo resolution, routes, deep links, sessions |
| [services/anomaly/README.md](services/anomaly/README.md) | The Isolation Forest sidecar: endpoints, HMAC signing, retraining |

## Before changing anything

**RLS is the security boundary.** All 31 tables in `public` have it enabled. Server Components
filter for speed; the database is what decides what a user is allowed to read. `rate_limits` is
the one table with RLS enabled and **no policies at all** — deny-by-default for every role,
reachable only through the SECURITY DEFINER `consume_rate_limit()`.
Every policy wraps its auth call in a scalar subquery — `(select auth.uid()) = user_id` — because
the bare form is re-evaluated per row and collapses the plan into a sequential scan.

**Money is an integer count of minor units, recomputed server-side.** No floats anywhere in
`lib/payments.ts`; division happens once inside `slotPriceMinor()` and is rounded immediately. The
price the client sends is never the price that is charged.

**The database enforces the invariants.** A `tstzrange` exclusion constraint on
`bookings (pitch_id, time_range)` rejects a double booking. `profiles_minor_privacy_locked_check`
plus the `enforce_minor_privacy` trigger pin an under-16 account's privacy defaults. The primary
key on `stripe_events.id` makes webhook processing exactly-once. League points and goal
difference are `GENERATED` columns, so a standings row cannot disagree with its own results.

**Configuration fails at server start, not at the first customer.** `apps/web/lib/env.ts` is one
zod schema for the whole environment and `instrumentation.ts` runs it before the first request.
It refuses configurations that parse key-by-key and are still wrong — a Stripe secret key with no
webhook secret takes the money and leaves the booking `pending`. Note it is a *runtime* gate:
`next build` does not run the hook, and a failed check makes every request answer 500 rather than
exiting the process, so the deployment's health check has to be an HTTP one. See
[docs/PRODUCTION.md](docs/PRODUCTION.md) section 1a.
