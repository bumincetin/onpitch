# Go live — web, Android and iOS, at minimal cost

A step-by-step launch checklist. It tells you what to click and what to pay; the *why* behind
each setting is in [PRODUCTION.md](./PRODUCTION.md), and day-two operations are in
[RUNBOOK.md](./RUNBOOK.md). Follow the steps in order — each one assumes the ones before it.

Everything that can be prepared in the repository already is:

| Prepared | Where |
|---|---|
| Vercel project settings (root directory, install without the mobile postinstall, Frankfurt region) | `apps/web/vercel.json` |
| EAS build and submit profiles for both platforms | `apps/mobile/eas.json` |
| Store metadata, bundle ids, permissions, icons | `apps/mobile/app.json`, `apps/mobile/assets/` |
| One-click build + submit of Android and iOS together | GitHub → Actions → **Mobile release** |
| CI that proves typecheck, lint, tests, web build, Metro bundle, migration replay | `.github/workflows/ci.yml` |
| Runtime env validation that refuses to boot a misconfigured production | `apps/web/lib/env.ts` |

What is left is accounts, keys and payments, which only you can do.

---

## 0. What it costs

Cheapest configuration that is honest about the terms of service. Prices are list prices as of
September 2026 — check the vendor page before paying.

| Item | Cost | Notes |
|---|---|---|
| **Apple Developer Program** | **$99 / year** | Required to ship on iOS at all. Enrol early: individual enrolment can take days, an organisation (needs a D-U-N-S number) can take weeks. |
| **Google Play developer account** | **$25 once** | New personal accounts must run a closed test with 12 testers for 14 days before the production track unlocks. Start that clock on day one. |
| **Supabase** | Free tier to launch; **$25 / month Pro** when real users arrive | Free projects pause after 7 days without activity and have no daily backups. Enable Pro before you take the first real booking. |
| **Vercel** | **$20 / month Pro** | The Hobby plan is for non-commercial projects, and this app takes payments. |
| **Expo EAS** | Free tier | A monthly allowance of cloud builds per platform is included; a store release needs two builds. Pay per build only if you exceed it. |
| **Stripe** | No fixed cost | Per-transaction fees plus Connect fees. Nothing to pay up front. |
| **Resend** (transactional email) | Free tier | Required in production: `env.ts` refuses to boot without `RESEND_API_KEY`, because guardian-consent emails have no other transport. |
| **Domain** | ~$10–15 / year | Any registrar. Needed for Stripe return URLs, universal links and the email sender. |
| Anomaly sidecar | $0 to start | Optional. Without it the rule engine alone runs and everything downstream works. Add a ~$5/month container later. |

**Fixed yearly minimum: about $125 (Apple + Google + domain). Monthly at launch: $45 (Vercel Pro
+ Supabase Pro), less if you stay on Supabase Free for a soft launch.**

---

## 1. Accounts (day 1 — some of these have waiting periods)

1. **Apple Developer Program** → https://developer.apple.com/programs/enroll — pay $99, wait for
   approval. Then in App Store Connect create the app record: name, bundle id
   `com.halisaha.app` (change it in `apps/mobile/app.json` first if you want another), primary
   language Turkish.
2. **Google Play Console** → https://play.google.com/console — pay $25, verify identity, create
   the app with package `com.halisaha.app`. Fill the Data safety form: the app blocks location,
   camera and microphone (see `android.blockedPermissions` in `app.json`), collects account data
   and payment data through Stripe.
3. **Supabase** → https://supabase.com/dashboard → New project, region **Frankfurt
   (eu-central-1)** to match `apps/web/vercel.json`. Save the database password.
4. **Stripe** → https://dashboard.stripe.com — activate the account (business details, bank
   account), enable **Connect**. Stay in test mode until step 6.
5. **Vercel** → https://vercel.com — team on Pro, "Import Git Repository" → `bumincetin/onpitch`.
6. **Expo** → https://expo.dev — create an account and an organisation; free plan.
7. **Resend** → https://resend.com — add and verify your domain (SPF + DKIM records at the
   registrar). Create an API key.
8. **Domain** — buy it; point it at Vercel in step 4 below.

---

## 2. Database (Supabase)

Follow [PRODUCTION.md §3](./PRODUCTION.md#3-supabase) exactly. In short:

```bash
npm i -g supabase
supabase login
supabase link --project-ref <ref>       # from the dashboard URL
supabase db push                        # replays supabase/migrations/0001…0010
supabase functions deploy trueskill-update
supabase functions deploy anomaly-sweep
supabase secrets set INTERNAL_API_TOKEN=<32 random bytes hex> ANOMALY_SERVICE_SECRET=<32 random bytes hex>
```

Before `db push`: Dashboard → Database → Extensions → enable `pg_cron` (the others are created
by the migrations). After: Authentication → Hooks → **Customize Access Token** →
`public.custom_access_token_hook`. Then run the four verification queries in PRODUCTION.md §3.5.

Generate the two tokens with `openssl rand -hex 32` (or `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`).
Keep them: the web app needs the same values.

Authentication → URL configuration: Site URL `https://<your-domain>`, add
`https://<your-domain>/auth/callback` and `halisaha://` to the redirect allow-list.

---

## 3. Payments (Stripe, test mode first)

Follow [PRODUCTION.md §4](./PRODUCTION.md#4-stripe). You need two webhook endpoints, both at
`https://<your-domain>/api/stripe/webhook`, and their two signing secrets. Create them **after**
the web app is deployed (step 4) so the URL exists; until then use test keys.

---

## 4. Web (Vercel)

1. Project → Settings → General → **Root Directory: `apps/web`**. The commands come from
   `apps/web/vercel.json`; leave the overrides empty.
2. Settings → Environment Variables → add every line of the root `.env.example` with real
   values. The ones that matter most:

   | Variable | Value |
   |---|---|
   | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase → Settings → API |
   | `SUPABASE_SERVICE_ROLE_KEY` | same page; **secret** |
   | `DATABASE_URL` | Supabase → Connect → Transaction pooler, port **6543**, append `?pgbouncer=true&connection_limit=1` |
   | `DIRECT_URL` | Session pooler, port 5432 |
   | `NEXT_PUBLIC_SITE_URL` | `https://<your-domain>` — https, no trailing slash |
   | `STRIPE_SECRET_KEY`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | test keys now, live keys in step 6 |
   | `STRIPE_WEBHOOK_SECRET`, `STRIPE_CONNECT_WEBHOOK_SECRET` | from step 3 |
   | `INTERNAL_API_TOKEN`, `ANOMALY_SERVICE_SECRET` | the same values you gave Supabase |
   | `RESEND_API_KEY`, `RESEND_FROM_EMAIL` | from Resend; sender on your verified domain |
   | `PLATFORM_FEE_BPS` | `1000` = 10 % |
   | `MOBILE_ALLOWED_ORIGINS` | leave unset; native apps send no Origin header |

   Leave `ANOMALY_SERVICE_URL` and `SMTP_URL` unset.
3. Settings → Domains → add your domain; set the DNS records Vercel shows.
4. Deploy (push to `main`, or Deployments → Redeploy). The build fails loudly if a required
   variable is missing — that is `lib/env.ts` doing its job; read the message, fix, redeploy.
5. Open `https://<your-domain>/api/health`. Then run steps 1–3 of the smoke test in
   [PRODUCTION.md §8](./PRODUCTION.md#8-post-deploy-smoke-test).

---

## 5. Mobile — both platforms at once (EAS)

### 5a. One-time setup on your machine

```bash
npm i -g eas-cli
eas login
cd apps/mobile
eas init                     # links the folder to a project in your Expo organisation
```

`eas init` writes `extra.eas.projectId` into `app.json`. Commit that change.

### 5b. Credentials (EAS stores them; nothing goes in the repo)

```bash
eas credentials --platform ios       # sign in with your Apple ID; let EAS create the distribution
                                     # certificate and provisioning profile
eas credentials --platform android   # let EAS generate and hold the upload keystore
```

For **submission without prompts** (what the GitHub workflow needs):

- **iOS**: App Store Connect → Users and Access → Integrations → App Store Connect API →
  generate a key with *App Manager* role. Run `eas credentials --platform ios` again and add it
  as the ASC API key.
- **Android**: Play Console → Setup → API access → create a service account with *Release
  manager* on the app, download its JSON. Run `eas credentials --platform android` and upload it
  as the Google Service Account key.
- In `apps/mobile/eas.json` → `submit.production.ios`, add `"ascAppId": "<numeric App Store
  Connect app id>"` and `"appleTeamId": "<team id>"`. Both are shown in App Store Connect.

### 5c. Environment for the builds

Expo → your project → **Environment variables**. Create these for the `production` and
`preview` environments (they are the names `eas.json` references):

| Name | Value |
|---|---|
| `EXPO_PUBLIC_SUPABASE_URL` | same as web |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | same as web |
| `EXPO_PUBLIC_API_URL_PRODUCTION` | `https://<your-domain>` |
| `EXPO_PUBLIC_API_URL_PREVIEW` | a Vercel preview URL, or the same domain |
| `EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY_LIVE` | Stripe live publishable key |
| `EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY_TEST` | Stripe test publishable key |

### 5d. Build and submit both platforms with one click

GitHub → Settings → Secrets and variables → Actions → new secret **`EXPO_TOKEN`** (Expo →
Account settings → Access tokens).

Then GitHub → **Actions → Mobile release → Run workflow**:

1. First run: profile `preview`, platform `all`, submit off. Install the Android APK from the EAS
   build page on a phone; install the iOS build through TestFlight after uploading it manually
   once (`eas submit --platform ios --profile production` locally) or use the simulator build.
2. When it works: profile `production`, platform `all`, **submit on**. EAS builds both, then
   sends Android to the Play **internal testing** track as a draft and iOS to **TestFlight**.

Or from your machine, same thing:

```bash
cd apps/mobile
eas build --profile production --platform all --auto-submit
```

### 5e. Store listings

Both consoles need the same assets; prepare them once:

- App name, short and long description (Turkish, optionally English), category *Sports*.
- Screenshots: at least 2 per device class. Take them from the preview build on a 6.7" iPhone
  and a Pixel-size Android; Play also wants a 1024×500 feature graphic.
- Privacy policy URL: `https://<your-domain>/privacy` (the page exists). Terms:
  `https://<your-domain>/terms`.
- App Privacy (Apple) / Data safety (Google): account data, payment via Stripe, no tracking, no
  location.
- Apple *Sign in* review note: provide a test account (player) and a test venue account.

Play: promote internal → closed testing (12 testers, 14 days for a new personal account) →
production. Apple: TestFlight → submit for review from the same build. Reviews take 1–3 days.

---

## 6. Switch to live payments

1. Stripe → toggle **live mode** → copy the live secret and publishable keys.
2. Register the two webhook endpoints again in live mode (webhooks are per mode) and copy the two
   live signing secrets.
3. Vercel → update `STRIPE_SECRET_KEY`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`,
   `STRIPE_WEBHOOK_SECRET`, `STRIPE_CONNECT_WEBHOOK_SECRET` → Redeploy.
   `env.ts` rejects a test key in a production build, so a missed one fails the boot rather than
   silently taking fake money.
4. Book a real slot for a small amount, refund it, confirm the payout appears on the connected
   account's dashboard.

---

## 7. Launch-day checks

- [ ] Web: `/api/health` returns ok; sign-up, booking with test card, match with two accounts,
      score report → consensus → finalised (PRODUCTION.md §8 steps 1–9).
- [ ] Coach flow: create a match, open **Maç günü → Maç planı**, build a line-up, export the
      cheat sheet to a phone, run **Canlı**, finish into the debrief, share the WhatsApp card.
- [ ] Mobile: same match on web and the TestFlight/Play build; a score tick appears on both.
- [ ] Email: sign up with an under-16 date of birth; the guardian mail arrives from your domain.
- [ ] Supabase: `select jobname, active from cron.job` shows 3 active jobs.
- [ ] Stripe: both webhook endpoints show recent 200s.
- [ ] Bundle leak check from PRODUCTION.md §5 (service-role key not in client JS).

---

## 8. After launch: JavaScript fixes without a store review

`expo-updates` is not installed (PRODUCTION.md §10). `runtimeVersion` is already declared, so
adding it later is additive: `npx expo install expo-updates`, `eas update:configure`, rebuild once,
and from then on `eas update --channel production` ships a JS-only fix in minutes. Native changes
(new permissions, new native modules) still need a store release through the workflow above.

---

## Decisions you still own

- **Name and bundle id.** The store record uses `Halisaha` / `com.halisaha.app` from
  `apps/mobile/app.json`. If the product ships as *OnPitch*, change `name`, `slug`, `scheme`,
  `bundleIdentifier`, `package` and the Stripe `merchantIdentifier` **before** the first
  submission; a bundle id cannot be changed after the app exists in a store.
- **Apple Pay / Google Pay.** Off by default. Apple Pay needs a merchant id registered in your
  Apple developer account and entered in `app.json`.
- **Sidecar.** Ship without it. Turn it on when you have real match data to train on.
