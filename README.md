# Halisaha

A dual-sided marketplace for amateur football: players and teams book pitches from venue owners,
play the match, and report the score.

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
- **Watch live** over Supabase Realtime: broadcast for score ticks, Postgres Changes for the
  state that has to be right, both authorised by RLS.

## Layout

```
apps/web/          Next.js 14 App Router, React 18, TypeScript strict, Tailwind + shadcn/ui
apps/mobile/       Expo SDK 57, expo-router, React Native 0.86, React 19
packages/shared/   database.ts · domain.ts · trueskill.ts · balance.ts · quality.ts · channels.ts
supabase/          migrations 0001…0007 · functions/ (Deno edge) · config.toml
services/anomaly/  FastAPI + scikit-learn IsolationForest sidecar
scripts/           progress.mjs — the build dashboard
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
              · booking · teams · admin · notifications · api-response
```

## Quick start

Node 20+, the Supabase CLI (hoisted into `node_modules/.bin`, so `npx supabase` works), Docker
running for the local stack.

```bash
npm install                            # root workspaces, then apps/mobile via postinstall
cp .env.example apps/web/.env.local    # fill in Supabase + Stripe keys
npx supabase start                     # Postgres 15, GoTrue, Realtime, Storage, Studio on :54323
npx supabase db reset                  # replays migrations 0001…0007
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
| `npm run db:reset` | `supabase db reset` |
| `npm run db:types` | regenerates `packages/shared/src/database.ts` from the local database |
| `npm run stripe:listen` | forwards Stripe events to `localhost:3000/api/stripe/webhook` |
| `npm run install:mobile` | reinstalls `apps/mobile` on its own lockfile |
| `npm run progress` | serves the build dashboard on `localhost:4321` |

CI (`.github/workflows/ci.yml`) runs the web typecheck/lint/build, the mobile typecheck and a
Metro bundle for both platforms, the sidecar's pytest suite, and a policy lint that replays all
seven migrations against Postgres 15 and fails if any table lacks RLS, any policy uses an
unwrapped `auth.uid()`, or any foreign key is unindexed.

## Documentation

| Doc | What's in it |
|---|---|
| [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) | The build in order — schema, RLS, auth/GDPR, TrueSkill, integrity, realtime, app, payments — with the reasoning behind each decision |
| [docs/DATA_MODEL.md](docs/DATA_MODEL.md) | Tables, enums, constraints and the entity diagram |
| [docs/API.md](docs/API.md) | Route handler reference, request and response shapes |
| [docs/SECURITY.md](docs/SECURITY.md) | Trust boundaries, threat model, GDPR positions, pre-release checklist |
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | Setup, migrations, Stripe wiring, connection strings, troubleshooting |
| [docs/PRODUCTION.md](docs/PRODUCTION.md) | What has been verified in this repository, what has not, and the deployment steps |
| [apps/mobile/README.md](apps/mobile/README.md) | The Expo client: Metro monorepo resolution, routes, deep links, sessions |
| [services/anomaly/README.md](services/anomaly/README.md) | The Isolation Forest sidecar: endpoints, HMAC signing, retraining |

## Before changing anything

**RLS is the security boundary.** All 21 tables in `public` have it enabled: 0002 writes the
policies for the 19 created in 0001, and 0004 and 0005 cover the two they add. Server Components
filter for speed; the database is what decides what a user is allowed to read.
Every policy wraps its auth call in a scalar subquery — `(select auth.uid()) = user_id` — because
the bare form is re-evaluated per row and collapses the plan into a sequential scan.

**Money is an integer count of minor units, recomputed server-side.** No floats anywhere in
`lib/payments.ts`; division happens once inside `slotPriceMinor()` and is rounded immediately. The
price the client sends is never the price that is charged.

**The database enforces the invariants.** A `tstzrange` exclusion constraint on
`bookings (pitch_id, time_range)` rejects a double booking. `profiles_minor_privacy_locked_check`
plus the `enforce_minor_privacy` trigger pin an under-16 account's privacy defaults. The primary
key on `stripe_events.id` makes webhook processing exactly-once.
