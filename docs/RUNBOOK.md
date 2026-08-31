# Halisaha — Runbook

Setup, operations, and the commands for both. Companion to
[IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md).

---

## 1. Prerequisites

| Tool | Version | Why |
|---|---|---|
| Node | ≥ 20 (22/24 fine) | Next.js 14, Expo SDK 57 |
| npm | ≥ 10 | lockfile v3, workspaces |
| Supabase CLI | latest | local Postgres, migrations, type generation, Edge Functions |
| Docker Desktop | running | `supabase start` needs it |
| Stripe CLI | latest | webhook forwarding in dev |
| Python | 3.12 | anomaly sidecar |

```bash
npm i -g supabase          # or: scoop install supabase / brew install supabase/tap/supabase
scoop install stripe       # or: brew install stripe/stripe-cli/stripe
```

The CLI is also a dev dependency of `apps/web` and is hoisted into `node_modules/.bin`, so
`npx supabase` works after the install below without a global one.

---

## 2. First run

Run everything from the repository root. `apps/web` and `packages/*` are npm workspaces;
`apps/mobile` is not (see §10), and the root `postinstall` hook installs it on its own lockfile.

```bash
npm install                              # workspaces, then apps/mobile via postinstall

cp .env.example apps/web/.env.local      # then fill it in (see §3)

supabase start                           # boots Postgres, GoTrue, Realtime, Storage in Docker
supabase db reset                        # replays supabase/migrations/0001…0007 in order
npm run db:types                         # writes packages/shared/src/database.ts

npm run dev                              # @halisaha/web, http://localhost:3000
```

`next dev` runs with `apps/web` as its working directory, which is where Next reads `.env.local`
from. `npm run db:types` wraps `supabase gen types typescript --local`; the generated `Database`
type is imported by both apps as `@halisaha/shared/database`, so regenerate it after every
migration rather than editing it.

In a second terminal:

```bash
npm run stripe:listen
# = stripe listen --forward-to localhost:3000/api/stripe/webhook
# copy the printed whsec_... into STRIPE_WEBHOOK_SECRET, restart dev
```

Optional third terminal — the anomaly sidecar:

```bash
cd services/anomaly
python -m venv .venv && . .venv/Scripts/activate    # PowerShell: .venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

The app runs fine without it — scoring falls back to the in-database rule engine.

---

## 3. Environment variables

`apps/web/.env.local` (from the root `.env.example`):

| Variable | Where | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | client + server | project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | client + server | public by design; RLS is the guard |
| `SUPABASE_SERVICE_ROLE_KEY` | **server only** | bypasses RLS — never expose |
| `DATABASE_URL` | serverless | Supavisor **transaction** mode, port **6543**, `?pgbouncer=true` |
| `DIRECT_URL` | migrations / cron / training | session mode, port 5432 |
| `STRIPE_SECRET_KEY` | server | `sk_test_…` / `sk_live_…` |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | client | Payment Element |
| `STRIPE_WEBHOOK_SECRET` | server | account endpoint |
| `STRIPE_CONNECT_WEBHOOK_SECRET` | server | Connect endpoint (`account.updated`, `payout.*`) |
| `PLATFORM_FEE_BPS` | server | basis points; `1000` = 10% |
| `ANOMALY_SERVICE_URL` | server | e.g. `http://localhost:8000` |
| `ANOMALY_SERVICE_SECRET` | server + sidecar | HMAC signing key, must match |
| `INTERNAL_API_TOKEN` | server + Edge Functions | guards `/api/internal/*` |
| `RESEND_API_KEY` | server | guardian consent email; dev logs instead |
| `NEXT_PUBLIC_SITE_URL` | both | Stripe return/refresh URLs, email links |
| `MOBILE_ALLOWED_ORIGINS` | build time | comma-separated bare origins that may call `/api/*` cross-origin. Unset in a production build means no cross-origin access at all; unset in development allows the Expo ports on localhost. Native React Native sends no `Origin` and needs no entry. |

`apps/mobile/.env` carries its own four values — see §10.

### Connection string shapes

```
# serverless route handlers — transaction mode
postgresql://postgres.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:6543/postgres?pgbouncer=true

# migrations, pg_cron, analytics — session mode
postgresql://postgres.<ref>:<pw>@aws-0-<region>.pooler.supabase.com:5432/postgres
```

Transaction mode returns the connection to the pool at COMMIT, so hundreds of concurrent
function invocations share a handful of Postgres backends. It does **not** support prepared
statements or session-level state — hence `?pgbouncer=true`. Long jobs and anything needing
advisory locks or `SET` must use session mode.

---

## 4. Migrations

Applied in filename order. **Never edit a migration that has run anywhere real** — write a new
one.

```bash
supabase migration new add_something     # scaffolds a timestamped file
supabase db reset                        # local: drop + replay everything
supabase db push                         # remote: apply pending
supabase db diff -f my_change            # capture dashboard changes as a migration
```

Post-migration verification:

```sql
-- 1. no table left without RLS
SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname='public' AND c.relkind='r' AND NOT c.relrowsecurity;

-- 2. policies are hoisted, not per-row
EXPLAIN (ANALYZE) SELECT * FROM public.bookings LIMIT 50;   -- expect InitPlan + Index Scan

-- 3. cron jobs registered
SELECT jobid, jobname, schedule, active FROM cron.job;
SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 20;

-- 4. realtime publication contents
SELECT tablename FROM pg_publication_tables WHERE pubname='supabase_realtime';
```

Then run `npm run db:types` so `packages/shared/src/database.ts` matches the new schema; both the
web and the mobile typechecks read it.

---

## 5. Auth hook

The custom access token hook must be enabled or every JWT will lack `user_role` and middleware
will fall back to a database lookup on every request.

Local — `supabase/config.toml`:

```toml
[auth.hook.custom_access_token]
enabled = true
uri = "pg-functions://postgres/public/custom_access_token_hook"
```

Hosted — Dashboard → Authentication → Hooks → Customize Access Token → select
`public.custom_access_token_hook`.

Verify: sign in, decode the access token, confirm `user_role`, `is_minor`,
`parental_consent_status` are present. The mobile app sends that same token as
`Authorization: Bearer`, so a missing claim shows up identically on both clients.

---

## 6. Edge Functions

```bash
supabase functions deploy trueskill-update
supabase functions deploy anomaly-sweep
supabase secrets set ANOMALY_SERVICE_URL=... ANOMALY_SERVICE_SECRET=... INTERNAL_API_TOKEN=...
supabase functions serve trueskill-update --no-verify-jwt   # local
```

---

## 7. Stripe setup

**Dev:** `npm run stripe:listen`, then `stripe trigger payment_intent.succeeded`.

**Production endpoints** — register two:

1. Account events: `payment_intent.succeeded`, `payment_intent.payment_failed`,
   `payment_intent.canceled`, `charge.refunded`, `charge.dispute.created`,
   `checkout.session.completed`, `application_fee.created`
2. **Connect** events: `account.updated`, `payout.paid`, `payout.failed`

Enable Connect in the dashboard, set the platform profile and branding (Express onboarding uses
it), and configure the payout schedule.

**Test cards:** `4242 4242 4242 4242` success · `4000 0000 0000 9995` declined ·
`4000 0025 0000 3155` requires 3DS.

---

## 8. Common operations

**Reprocess a failed webhook**

```sql
SELECT id, type, processing_error FROM stripe_events
WHERE processed_at IS NULL ORDER BY received_at DESC;
DELETE FROM stripe_events WHERE id = 'evt_...';   -- then replay from the Stripe dashboard
```

**Force a rating recompute for one match**

```sql
UPDATE matches SET rating_applied_at = NULL WHERE id = '...';
SELECT public.apply_match_rating('...');
```

**Run the decay job by hand**

```sql
SELECT public.decay_inactive_ratings();          -- returns rows touched
```

**Sweep unpaid reservations** — `POST /api/internal/bookings/expire-reservations` with the
`INTERNAL_API_TOKEN` as a bearer (or `X-Internal-Token`). Schedule it every five minutes; each
call handles at most 200 reservations, oldest first, and reports
`{ examined, released, paid, deferred, ttlMinutes, cutoff }`.

**Resolve a stuck disputed match** — admin sets the score, then
`SELECT public.finalize_consensus('<match_id>');`, or
`POST /api/admin/matches/[id]/resolve` with an `outcome` and a reason for the audit trail.

**Check a venue's onboarding state** — `GET /api/stripe/connect/status` as that owner, or
`stripe accounts retrieve acct_...` and read `requirements.currently_due`.

---

## 9. Deployment

**App → Vercel.** Build `@halisaha/web`. Set every server env var (no `NEXT_PUBLIC_` prefix on
secrets), point `DATABASE_URL` at port 6543, and set `NEXT_PUBLIC_SITE_URL` to the production
origin so Stripe return URLs resolve. `MOBILE_ALLOWED_ORIGINS` is read at build time, so a change
to it needs a redeploy. The webhook route must stay on the Node runtime.

**Database → Supabase.** Enable `pg_cron`, `pgcrypto`, `btree_gist` in Extensions. Apply
migrations with `supabase db push`. Enable the auth hook. Confirm Realtime is on for the
publication tables.

**Sidecar → any container host.** Build `services/anomaly/Dockerfile`, set
`ANOMALY_SERVICE_SECRET` to match the app, and keep it on a private network — it should not be
reachable from the internet.

---

## 10. The mobile app

`apps/mobile` is an Expo SDK 57 / expo-router client that calls the same `/api/**` route handlers
the web app does, with the Supabase access token as `Authorization: Bearer`. `npm run dev` has to
stay up while it runs.

```bash
cp apps/mobile/.env.example apps/mobile/.env    # then fill it in
npm run dev                                     # terminal 1: Next.js, which serves /api/**
npm run dev:mobile                              # terminal 2: expo start
```

`npm run dev:mobile` runs `expo start` in that workspace: press `a` for Android, `i` for iOS, or
scan the QR code. `npm run install:mobile` reinstalls it on its own lockfile.

### Environment

Four values, all `EXPO_PUBLIC_*` because Babel inlines them into the bundle at build time. None
of them is a secret; the service-role key and the Stripe secret key stay in `apps/web/.env.local`.

| Variable | Notes |
|---|---|
| `EXPO_PUBLIC_SUPABASE_URL` | project URL, same project as the web app |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | anon key; RLS is still the boundary |
| `EXPO_PUBLIC_API_URL` | origin of the Next.js app serving `/api/**`, no trailing slash |
| `EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY` | optional. `POST /api/bookings/checkout` returns `publishableKey`, so payments work without it; setting it mounts `StripeProvider` at launch, which is what the Apple Pay / Google Pay availability checks need. |

The first three throw on import when missing (`apps/mobile/lib/env.ts`), so a misconfigured build
fails at launch with the variable name rather than later inside GoTrue.

`EXPO_PUBLIC_API_URL` is the one that bites: `http://localhost:3000` resolves to the phone
itself.

| Where the app runs | What to set |
|---|---|
| Physical device on the same Wi-Fi | `http://<your-lan-ip>:3000` |
| Android emulator | `http://10.0.2.2:3000` |
| iOS simulator | `http://localhost:3000` |

Values are baked into the bundle, so after editing `.env` restart with `npx expo start --clear`.
A warm Metro cache keeps serving the old ones.

### Two dependency facts that will trip you up

**`apps/mobile` is deliberately outside the npm workspaces and pins React 19.**
`react-native@0.86.3` declares `react: ^19.2.3` (and `@types/react: ^19.1.1`) as peers, so the app
installs `react@19.2.3`. `apps/web` stays on React 18.3 because Next 14 does not support React 19.
Both versions therefore exist in the tree at once: `apps/mobile` keeps its own `package-lock.json`
and `node_modules`, and `metro.config.js` sets `resolver.disableHierarchicalLookup = true` so a
file in `packages/shared/src` cannot resolve `react` upwards and load a second copy. Two Reacts in
one bundle shows up as "Invalid hook call" pointing at the wrong component.

**`apps/mobile/tsconfig.json` sets `customConditions: ["react-native-legacy-deep-imports"]`,
replacing the `["react-native"]` it would otherwise inherit from `expo/tsconfig.base`.** React
Native 0.86.3 publishes two sets of types through its `exports` map: the generated strict API
(`types_generated/`) under the `react-native-strict-api` condition, and the legacy `types/` plus
`Libraries/*.d.ts` under `default`. The app's screens and `lib/` are written against the legacy
set, so the condition list has to keep resolution off the strict one. `npm run typecheck` at the
root runs the workspace typechecks and then `tsc --noEmit` in `apps/mobile`, which is where a
wrong condition list surfaces.

The rest — Metro's `watchFolders`, `nodeModulesPaths` and `unstable_enablePackageExports`, the
route layout, deep links, and why the session lives in AsyncStorage rather than SecureStore — is
in [apps/mobile/README.md](../apps/mobile/README.md).

---

## 11. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Queries return zero rows for a logged-in user | RLS policy mismatch | Check the policy `USING` clause and that the JWT has the expected claims |
| Query is fast in SQL editor, slow from the app | Editor runs as service role | Re-test as `authenticated`; check for a bare `auth.uid()` |
| `too many connections` | Session mode from serverless | Move `DATABASE_URL` to port 6543 with `?pgbouncer=true` |
| Webhook signature always fails | Body was parsed as JSON | Use `await req.text()`; ensure Node runtime |
| Realtime stops delivering after ~1h | JWT expired on the socket | Re-call `realtime.setAuth()` on token refresh |
| `account.updated` never arrives | Registered on the account endpoint | Register a **Connect** endpoint with its own secret |
| Cron job never runs | `pg_cron` not enabled, or scheduled in the wrong database | Enable the extension; `cron.job` lives in `postgres` |
| Ratings unchanged after a match | `rating_applied_at` already set, or `requires_consensus` | Inspect the match row; resolve consensus first |
| Slot still held long after an abandoned checkout | Nothing is calling the sweeper — Stripe emits no event when a customer closes the tab | Schedule `POST /api/internal/bookings/expire-reservations` |
| Mobile app: every call fails with a network error | `EXPO_PUBLIC_API_URL` points at `localhost`, which on a device is the device | Set the LAN address (or `10.0.2.2` on the Android emulator) and restart with `npx expo start --clear` |
| Mobile app: an edited `.env` value has no effect | Values are inlined at bundle time and Metro cached the old bundle | `npx expo start --clear` |
| Mobile app: 401 on every route while the web app is fine | Expired or revoked access token, or no `Authorization` header reaching the route | Sign in again; confirm the request carries `Authorization: Bearer <jwt>` |
| Expo Web: CORS error on `/api/*` | The origin is not in `MOBILE_ALLOWED_ORIGINS`, or the variable changed without a redeploy | Add the exact origin (scheme, host, port, nothing else) and rebuild |
| Mobile: "Invalid hook call" pointing at the wrong component | Two copies of React in the bundle | Check `metro.config.js` — `disableHierarchicalLookup` and `nodeModulesPaths` — then reinstall with `npm run install:mobile` |
