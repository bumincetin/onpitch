# Halisaha — Production Deployment

What has been verified in this repository, what has not, and the exact steps to close the gap.

---

> Looking for the ordered, click-by-click launch checklist with costs? That is
> [GO_LIVE.md](./GO_LIVE.md). This document is the reference it points back to.

## 1. Verification status

Run in this repository, passing:

| Check | Command | Result |
|---|---|---|
| Shared package types | `npm run typecheck --workspace @halisaha/shared` | clean |
| Web types | `npm run typecheck --workspace @halisaha/web` | clean |
| Mobile types | `npm --prefix apps/mobile run typecheck` | clean |
| Shared unit tests | `npm run test --workspace @halisaha/shared` | 43 passing |
| Web unit tests | `npm run test --workspace @halisaha/web` | 77 passing |
| Lint | `npm run lint` | clean |
| Web production build | `npm run build` | 38/38 static pages, no prerender errors |
| Mobile bundle, Android | `npx expo export --platform android` | 5.3 MB bundle |
| Migration replay | CI job `migrations` | all 10 files, clean database |
| Policy lint | CI job `migrations` | 0 unwrapped `auth.uid()` |
| RLS coverage | CI job `migrations` | every table in `public` |
| FK indexing | CI job `migrations` | 0 unindexed foreign keys |
| Type/schema agreement | CI job `migrations` | `database.ts` matches 31 tables |

The unit suites are not incidental coverage. Each one pins a value that exists twice — once in
SQL and once in TypeScript — where a silent divergence would be expensive:

| Suite | What it pins | Against |
|---|---|---|
| `trueskill.test.ts` | the golden 1v1 vector, 29.396 / 7.171 | `0004_trueskill.sql`'s own self-test |
| `gamification.test.ts` | the level curve `50·L·(L−1)` at every boundary | `private.level_for_xp` in 0008 |
| `leagues.test.ts` | promotion / relegation zones | `close_season()` in 0009 |
| `rbac.test.ts` | the whole role × resource × action matrix | the RLS policies in 0002 |
| `api-response.test.ts` | that no thrown secret reaches the wire | — |
| `env.test.ts` | each fail-fast configuration rule | — |

Not verified here, because it needs credentials or a device. Do these before launch:

| Check | Why it cannot be done here |
|---|---|
| Migrations applied to a real Supabase project | Needs a project and a database password |
| A Stripe test charge splitting to a connected account | Needs live Connect onboarding and API keys |
| Webhook signature verification against real Stripe deliveries | Needs a registered endpoint and its secret |
| JWT carrying `user_role` | Needs the auth hook enabled on a real project |
| `pg_cron` jobs firing | Needs the extension enabled on a hosted instance |
| PaymentSheet on a device | Needs a native build |
| Realtime delivery under RLS | Needs a real socket with a real JWT |
| The CSP against the live Stripe flow | Needs a real 3-D Secure challenge in a real browser |
| EAS build and store submission | Needs an Expo account and signing credentials |

CI runs the first table on every push and replays all ten migrations against a Postgres 15
service container.

---

## 1a. Fail-fast configuration

`apps/web/lib/env.ts` is the single schema for the process environment, and
`apps/web/instrumentation.ts` calls it once per server process before the first request. A
deploy missing a required variable fails immediately, instead of starting, serving, taking a
booking, and failing when Stripe posts the first webhook.

**Exactly what happens, measured rather than assumed — this decides your health check:**

| | |
|---|---|
| `next build` | Does **not** run the hook. A build with a broken environment **succeeds**. This is a runtime gate, not a build gate. |
| `next start` | Runs the hook. On failure the process **still binds the port and still logs "Ready"** — Next prints that before the hook resolves — and then answers **500 to every request**, logging the full error each time. |

So a misconfigured deploy serves nothing, but it does hold an open socket. **The health check
must be an HTTP check on a real path.** A TCP check sees the open port, reports healthy, and
routes live traffic to a service that can only return 500.

The rules that are not simply "is it set":

| Rule | The failure it prevents |
|---|---|
| `STRIPE_SECRET_KEY` requires `STRIPE_WEBHOOK_SECRET` | Money in, booking stuck in `pending`: the charge succeeds and the confirming webhook fails signature verification |
| Connect webhook secret must differ from the platform one | Stripe signs them separately; reusing one rejects every `account.updated`, so an owner who finishes KYC never becomes payable |
| Both Stripe keys must be the same mode | Live and test keys authenticate fine and then disagree about every object id |
| No `sk_test_` / `pk_test_` in production | The mistake that looks like it works: the flow completes, the dashboard shows payments, no money moves |
| `NEXT_PUBLIC_SITE_URL` required, and https, in production | Redirect URLs cannot be guessed safely, and a host-header fallback is injectable. Secure cookies are not sent over http |
| `INTERNAL_API_TOKEN` required in production | Without it `/api/internal/*` answers 503 to pg_cron, so abandoned checkouts hold their slots forever |
| `RESEND_API_KEY` required in production | Parental-consent emails have no other transport and the link is not logged in production, so an under-16 signup can never be approved |
| `ANOMALY_SERVICE_URL` and `_SECRET` together or neither | A URL with no key 401s every request and silently falls back to the rule engine |

Errors list **every** problem at once and echo **no values** — a validation error that printed
the offending value would write the service-role key into the deploy log of the build that
failed to start.

---

## 1b. Response headers

`next.config.mjs` sets a Content-Security-Policy on every response, plus HSTS, `nosniff`,
`X-Frame-Options: DENY`, a `Permissions-Policy` denying geolocation platform-wide, and
`Cross-Origin-Opener-Policy`.

**Be honest about what the CSP does and does not do.** `script-src` includes `'unsafe-inline'`,
because the App Router serves hydration data through inline `<script>` tags and the only strict
alternative — a per-request nonce set in middleware — forces every page to render dynamically,
which would cost the static prerendering of every one of those 38 pages. So this policy does **not**
stop XSS.

It is still worth having for what it does stop: `object-src 'none'`, `base-uri 'self'`,
`form-action 'self'`, `frame-ancestors 'none'`, and src allowlists that mean an injected
`<script src>` can only load from Stripe or ourselves. XSS defence proper is upstream — React
escapes by default and there is no `dangerouslySetInnerHTML` anywhere in the app.

Moving to a nonce is the next improvement here, and its cost is the loss of static generation.

---

## 1c. Schema drift

`packages/shared/src/database.ts` is maintained **by hand**. `npm run db:types` would regenerate
it, but the generated output discards every doc comment, and those comments carry real
information: which columns are `GENERATED`, which is `citext`, that `venues.timezone` is an IANA
zone used to render slot grids.

`scripts/check-schema-drift.mjs` is what makes that choice safe. It runs in CI after the
migrations replay and compares table names, column names and nullability against the real
schema. It does not compare SQL types — see the script header for why that would produce false
failures people learn to ignore.

Run it locally against a running Supabase:

```bash
docker exec supabase_db_halisaha psql -U postgres -d postgres -tA \
  -f /tmp/dump.sql > live-schema.json      # scripts/dump-public-schema.sql
node scripts/check-schema-drift.mjs live-schema.json
```

It found four real drifts the first time it ran: `public.rate_limits` from 0010 was never
declared, and three `GENERATED ALWAYS AS ... STORED` columns added by 0008 and 0009 were typed
non-nullable. Postgres does not infer `NOT NULL` for a generated column even when its expression
cannot produce one, so those types asserted something the database did not.


---

## 2. Repository layout

```
apps/web/          Next.js 14 — npm workspace
packages/shared/   types, zod schemas, TrueSkill, matchmaking, realtime topics — npm workspace
apps/mobile/       Expo 57 — NOT a workspace, separate install (see below)
supabase/          migrations 0001..0007, Edge Functions, config.toml
services/anomaly/  FastAPI + IsolationForest sidecar
```

**`apps/mobile` is deliberately outside the npm workspaces.** React Native 0.86 peers React
`^19.2.3`; Next 14 needs React 18. In a single workspace npm hoists one of them to the root, and
whichever loses, a hoisted package binds the wrong React and fails at render time rather than at
install time — `styled-jsx` returning a null hook dispatcher during SSR is what this looked like
in practice. The mobile app therefore has its own `package-lock.json` and its own tree, and
consumes `packages/shared` through a `file:` link that Metro already watches. The root
`postinstall` runs its install, so `npm install` at the root still sets up everything.

Two other version facts a maintainer will otherwise rediscover the hard way:

- Mobile dependency versions come from `node_modules/expo/bundledNativeModules.json`, not from
  npm `latest`. Expo SDK 57 pairs with React Native **0.86.3**. Use `npx expo install <pkg>`
  rather than `npm install <pkg>` in `apps/mobile`.
- `apps/mobile/tsconfig.json` sets `customConditions: ["react-native-legacy-deep-imports"]`.
  React Native ships two type sets; the app is written against the long-standing one, and the
  new codegen set has a different `ViewStyle`.

---

## 3. Supabase

1. Create the project. Note the region — the Supavisor host in your connection strings depends
   on it.
2. **Extensions** → enable `pgcrypto`, `btree_gist`, `citext`, `pg_cron`, `pg_stat_statements`.
   Migration `0001` creates the first three in the `extensions` schema; `pg_cron` must be
   enabled from the dashboard before `0007` runs.
3. **Apply migrations**

   ```bash
   supabase link --project-ref <ref>
   supabase db push
   ```

4. **Enable the auth hook** → Authentication → Hooks → Customize Access Token →
   `public.custom_access_token_hook`. Without it every JWT lacks `user_role`, middleware falls
   back to a profile lookup on every request, and the RLS policies that read the claim behave as
   if everyone were a `player`.
5. **Verify** — each of these must come back as stated:

   ```sql
   -- no table without RLS
   select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname='public' and c.relkind='r' and not c.relrowsecurity;        -- 0 rows

   -- cron jobs registered
   select jobname, schedule, active from cron.job;                             -- 3 rows

   -- realtime publication
   select tablename from pg_publication_tables where pubname='supabase_realtime';

   -- a policy is hoisted, not per-row
   explain (analyze) select * from public.bookings limit 50;                   -- InitPlan, not Seq Scan+Filter
   ```

6. **Edge Functions**

   ```bash
   supabase functions deploy trueskill-update
   supabase functions deploy anomaly-sweep
   supabase secrets set ANOMALY_SERVICE_URL=... ANOMALY_SERVICE_SECRET=... INTERNAL_API_TOKEN=...
   ```

### Connection strings

| Consumer | Mode | Port | Notes |
|---|---|---|---|
| Next.js route handlers | Supavisor transaction | **6543** | `?pgbouncer=true`; no prepared statements |
| Migrations, `pg_cron`, `train.py` | Supavisor session | 5432 | session state, advisory locks |
| Realtime WAL slot | direct | 5432 | replication cannot go through a pooler |

Serverless functions on session mode is how you exhaust `max_connections` under load.

---

## 4. Stripe

1. Enable Connect, set the platform profile and branding (Express onboarding renders it), and
   set the payout schedule.
2. Register **two** webhook endpoints against `https://<site>/api/stripe/webhook`:

   | Endpoint | Events |
   |---|---|
   | Account | `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.canceled`, `charge.refunded`, `charge.dispute.created`, `checkout.session.completed`, `application_fee.created` |
   | **Connect** | `account.updated`, `payout.paid`, `payout.failed` |

   Each has its own signing secret: `STRIPE_WEBHOOK_SECRET` and
   `STRIPE_CONNECT_WEBHOOK_SECRET`. Registering only the first means venue onboarding state and
   payouts never update.
3. Confirm `PLATFORM_FEE_BPS` with whoever owns the commercials. It is basis points; `1000` is
   10%.

### Test before switching to live keys

```bash
stripe listen --forward-to localhost:3000/api/stripe/webhook
stripe trigger payment_intent.succeeded
```

Then check the booking moved to `confirmed`, `stripe_events` has one row for the event, and
replaying the same event changes nothing.

---

## 5. Web (Vercel)

- Root directory `apps/web`. Install runs at the repo root so the shared workspace resolves.
- Environment: everything in [RUNBOOK.md](./RUNBOOK.md) §3. Secrets must not carry the
  `NEXT_PUBLIC_` prefix.
- `DATABASE_URL` on port 6543 with `?pgbouncer=true`.
- `NEXT_PUBLIC_SITE_URL` must be the production origin, or Stripe's return and refresh URLs
  point at the wrong host.
- `MOBILE_ALLOWED_ORIGINS` lists the origins allowed to call `/api/*` with a Bearer token.
- The webhook route must stay on the Node runtime. It reads the raw request body, and the Edge
  runtime would break signature verification.

After deploying, grep the client bundle for the service-role key. It should not appear:

```bash
grep -r "$(echo $SUPABASE_SERVICE_ROLE_KEY | cut -c1-20)" apps/web/.next/static/ && echo LEAK
```

---

## 6. Mobile (EAS)

`apps/mobile/eas.json` defines three profiles. `apps/mobile/app.json` carries the store metadata.

```bash
npm i -g eas-cli && eas login
cd apps/mobile
eas build --profile production --platform all
eas submit --profile production --platform all
```

| Profile | Distribution | Android artifact | Purpose |
|---|---|---|---|
| `development` | internal | APK | dev client, points at `10.2.2:3000` for the emulator |
| `preview` | internal | APK | internal testers, test Stripe keys |
| `production` | store | AAB | store binaries, live keys, `autoIncrement` build numbers |

**The `env` blocks in `eas.json` are load-bearing.** Babel inlines every `EXPO_PUBLIC_*` value
into the bundle at build time, and EAS builders never see `apps/mobile/.env` — it is gitignored
and not uploaded. A production build with them unset ships a bundle pointing at `undefined` and
fails at the first request. Set these as EAS project secrets:

| Secret | Used by |
|---|---|
| `EXPO_PUBLIC_SUPABASE_URL` | every profile |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | every profile |
| `EXPO_PUBLIC_API_URL_PREVIEW` | preview |
| `EXPO_PUBLIC_API_URL_PRODUCTION` | production |
| `EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY_TEST` | preview |
| `EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY_LIVE` | production |

None of these are secrets in the real sense: the anon key is filtered by RLS on every table and
the publishable key can only create payment methods. The service-role key and the Stripe secret
key are server-side only and appear nowhere in the mobile project.

### Icons and splash

`apps/mobile/assets/` is **generated**, not committed by hand:

```bash
node scripts/generate-mobile-assets.mjs
```

It draws the launcher icon, the Android adaptive foreground, the splash mark and the web favicon
from the same `NIGHT` palette as the 3D scenes, and writes them as PNGs (the encoder is in the
script; it adds no dependency). Re-run it after changing the palette. An iOS build with no
`AppIcon` is rejected at upload, so this is a submission blocker, not a nicety.

### What `app.json` now asserts, and why

- `ios.config.usesNonExemptEncryption: false` — without it App Store Connect asks the export
  compliance question on **every** upload and holds the build until it is answered. The app uses
  only standard HTTPS, which is exempt.
- `ios.infoPlist.NSAppTransportSecurity.NSAllowsArbitraryLoads: false` — no cleartext exception
  ships in the binary. A dev build against a LAN `http://` address uses `expo run:ios`.
- `android.permissions: []` with location, camera and microphone explicitly blocked — the
  manifest merger adds several by default. This is the client-side half of the same guarantee
  the database makes: `profiles_minor_privacy_locked_check` pins `location_sharing_enabled` off
  for under-16 accounts, and an app that cannot request location cannot be made to leak one.
- `runtimeVersion: { policy: "appVersion" }` — `expo-updates` is not installed, so nothing is
  served OTA today. Declaring it now means adding OTA later cannot ship a bundle to a binary
  lacking the native modules it needs.

`merchantIdentifier` in the `@stripe/stripe-react-native` plugin is still
`merchant.com.halisaha.app`. Replace it with the real Apple merchant id before enabling Apple
Pay, or the payment sheet will not offer it.

---

## 7. Anomaly sidecar

```bash
cd services/anomaly
docker build -t halisaha-anomaly .
docker run -e ANOMALY_SERVICE_SECRET=... -p 8000:8000 halisaha-anomaly
```

Keep it on a private network. `ANOMALY_SERVICE_SECRET` must match the web app's, because the
caller signs each request with HMAC-SHA256 over `timestamp + '.' + body`.

It ships with no trained model and falls back to a deterministic rule scorer labelled
`rules-fallback-v1`. Train it once there is production data:

```bash
python train.py --database-url "$DIRECT_URL"   # session mode, port 5432
```

**Verify the failure path before launch.** Stop the service and confirm a match still finalises,
recording `source = 'rule_engine'`. Anomaly detection is advisory; nothing may block on it.

---

## 8. Post-deploy smoke test

Run in order. Each step depends on the previous one.

1. Sign up as a player. Decode the JWT and confirm `user_role` is present.
2. Sign up as a venue owner, complete Stripe Express onboarding, confirm
   `GET /api/stripe/connect/status` reports `chargesEnabled` and `payoutsEnabled`, and that
   `venues.is_active` flipped.
3. Create a pitch. Confirm it appears in `/venues` search.
4. Book a slot with test card `4242 4242 4242 4242`. Confirm the booking is `confirmed`, the
   PaymentIntent carries `application_fee_amount`, and the connected account received the rest.
5. Attempt the same slot from a second account. Expect `409 SLOT_TAKEN`, not a 500.
6. Cancel and confirm the refund matches the policy the UI displayed.
7. Create a match, join from two accounts, report conflicting scores. Confirm it goes to
   `requires_consensus` and the consensus round opens.
8. Approve from both sides. Confirm the match finalises and `player_ratings` moved.
9. Report the same score twice. Confirm ratings are applied once (`rating_applied_at`).
10. Sign up with a date of birth under 16. Confirm the guardian email is sent, that booking is
    blocked until consent is granted, and that the privacy toggles are locked off.
11. Request a GDPR export and confirm it contains only that user's rows.
12. Open the same match on web and mobile and confirm a score update appears on both.
13. Wait for the nightly window, then check `cron.job_run_details` for a successful
    `nightly-rating-decay`.

---

## 9. Operating it

**Watch:** `stripe_events` rows with `processed_at is null` (failed webhooks), matches stuck in
`requires_consensus` past `consensus_deadline`, `cron.job_run_details` failures, connected
accounts with `requirements.past_due`, and Supavisor pool saturation.

**Reprocess a failed webhook**

```sql
select id, type, processing_error from stripe_events where processed_at is null;
delete from stripe_events where id = 'evt_...';   -- then replay from the Stripe dashboard
```

**Recompute a match's rating**

```sql
update matches set rating_applied_at = null where id = '...';
select public.apply_match_rating('...');
```

More procedures in [RUNBOOK.md](./RUNBOOK.md) §8.

---

## 10. Known gaps

Carried deliberately, listed so nobody discovers them at 2am.

- **The CSP does not stop XSS.** `script-src` carries `'unsafe-inline'` for the App Router's
  hydration scripts. See §1b for what it does stop and what moving to a nonce would cost.
- **Guardian email delivery is a stub** with a provider-agnostic interface. `lib/env.ts` now
  refuses to boot a production build without `RESEND_API_KEY`, so this can no longer be
  discovered by a minor failing to sign up — but the SMTP branch remains a placeholder that
  reports `delivered: false`, and `env.ts` rejects `SMTP_URL` without Resend for that reason.
- **The anomaly model is untrained.** The rule fallback is honest about this in its
  `modelVersion`, but detection quality is limited until `train.py` runs on real data.
- **Consensus signatures are session-derived HMAC**, not device-bound Ed25519. The
  `signature_alg` column exists so this is a data migration rather than a rewrite.
- **Rate limiting is fail-open.** `consume_rate_limit()` runs in Postgres, and
  `apps/web/lib/rate-limit.ts` lets a request through if the limiter itself errors. That is the
  right trade — a limiter outage must not become a site outage — but it means the limits are a
  brake on abuse, not a guarantee under database failure.
- **Rate-limit windows are fixed, not sliding.** A caller can spend a full window's budget at
  the end of one window and again at the start of the next. Sizing accounts for this; a sliding
  window costs a row per request.
- **No load testing.** The RLS policies are written for index use and CI proves the indexes
  exist, but nothing here has been run against production-scale data. The leaderboard and league
  table queries are the ones to watch first.
- **`expo-doctor` reports TypeScript 5.9 where Expo 57 prefers 6.0.** The rest of the monorepo
  is on 5.x; upgrading is a separate, deliberate change.
- **No OTA updates.** `expo-updates` is not installed, so a JavaScript fix needs a store
  release. `runtimeVersion` is already declared so adding it is additive.
- **The sitemap lists venues only.** Match and team pages are behind a session and correctly
  excluded; there is no public content marketing surface beyond the venue directory yet.

### Closed since the last revision

- ~~`profiles.is_minor` needs a nightly re-touch job~~ — `public.refresh_aged_out_minors()`
  exists in `0007_cron_decay.sql` §4a. Its `UPDATE` names `parental_consent_status` in the SET
  list **on purpose**: the audit trigger is `after update OF parental_consent_status`, so a
  version that only touched `updated_at` would age accounts out silently and unaudited. The
  header of `0010_hardening.sql` records this, because it is exactly the kind of thing a later
  reader would "simplify".
- ~~No unit tests~~ — 120 across the two workspaces, run in CI. See §1.
- ~~Nothing validates the environment~~ — see §1a.
- ~~`database.ts` can drift from the schema unnoticed~~ — see §1c.
- ~~No `eas.json`, no app icon~~ — see §6.

