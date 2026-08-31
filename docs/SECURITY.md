# Halisaha — Security & Compliance Notes

Companion to [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md). This file states the trust
boundaries, the threat model, and the compliance positions the code takes, so a reviewer can
check the implementation against a stated intent.

---

## 1. Trust boundaries

| Boundary | Enforced by | Notes |
|---|---|---|
| Browser → Postgres (anon key) | **RLS** | The anon key is public by design. RLS decides which rows a user may read and write. |
| Browser → Route Handler | zod parse + `requireRole` | Every body goes through `schema.parse`; nothing is cast into shape. |
| Mobile app → Route Handler | `Authorization: Bearer <jwt>`, verified with `supabase.auth.getUser(token)` | `apps/web/lib/auth/bearer.ts` accepts only a three-segment compact JWS under 4 KB, then GoTrue checks the signature, the expiry, and whether the session has been revoked. `createRouteClient()` in `apps/web/lib/supabase/server.ts` sends that token to PostgREST, so `auth.uid()` and every policy resolve exactly as they do for a cookie session. |
| Cross-origin browser → `/api/*` | CORS header rules in `apps/web/next.config.mjs` | One rule per origin named in `MOBILE_ALLOWED_ORIGINS`, each echoed back on its own — no `*` on routes that accept an `Authorization` header, and no `Access-Control-Allow-Credentials`, because the mobile transport is a bearer token rather than a cookie. `/api/stripe/webhook` sits outside the rules' source pattern, as it does outside the middleware matcher. Native React Native sends no `Origin` and is not subject to CORS; the rules exist for Expo Web and for a browser-hosted build. With the variable unset, a production build allows no cross-origin access and a development build allows the Expo ports on localhost. |
| Server → Postgres (service role) | Code review + `import 'server-only'` | Bypasses RLS entirely. |
| Stripe → Route Handler | HMAC signature over the raw body | Two secrets (account + Connect endpoints). |
| Next.js → anomaly sidecar | HMAC-SHA256 + timestamp skew window | The ML service is never publicly reachable. |
| Realtime socket → topics | `realtime.messages` RLS + per-row `SELECT` policy | Topic strings are parsed defensively and fail closed. |

The service-role key reads and writes every row of every table for every user. It must never
appear in a `NEXT_PUBLIC_*` variable, a client component, an edge middleware bundle, or a log
line. `apps/web/lib/supabase/admin.ts` starts with `import 'server-only'`, so a stray client
import is a build error rather than a production incident, and it repeats the check at runtime
with a `typeof window` guard.

Three kinds of work legitimately reach for it:

- **No user session exists.** The Stripe webhook, the `/api/internal/*` jobs, and
  `POST /api/auth/parental-consent/verify`, whose caller is a guardian following an emailed link
  rather than an account holder.
- **The column is outside the `authenticated` grant.** `venues.stripe_account_id`,
  `profiles.role`, and `matches.match_quality` / `predicted_draw_probability`. A client that
  could write its own match quality could advertise a stacked fixture as balanced.
- **The correct answer needs rows RLS hides from the caller.** Match discovery, the anonymised
  free/busy reads behind `/api/pitches/[id]/slots` and `/api/venues/search`, rating and consensus
  finalisation, and the exact-email roster lookup in `/api/teams/[id]/members`. Each of those
  routes becomes the authorisation boundary itself: it resolves the target through the caller's
  own RLS-bound client first, and the elevated query projects counts and interval boundaries
  rather than anything that names a person.

---

## 2. Threat model

### Financial

| Threat | Mitigation |
|---|---|
| Client tampers with the booking price | Amount is recomputed server-side from `pitches.hourly_rate_minor`; the client's number is never read. |
| Double charge on retry / double-click | `idempotencyKey = bookingId` on the PaymentIntent; `stripe_events` ledger on the webhook. |
| Replayed or forged webhook | `constructEvent` signature verification over the raw bytes; unknown/duplicate event ids short-circuit to 200. |
| Two customers book the same slot | Postgres `EXCLUDE USING gist` on `(pitch_id, time_range)` rejects the overlapping insert with SQLSTATE `23P01`, before any application code has a say. |
| Venue owner points payouts at another account | `stripe_account_id` is written only by the admin client from the authenticated session; no route accepts it as input. |
| Refund abuse | Refund policy computed server-side; `refund_application_fee` / `reverse_transfer` set by policy, not by the caller. |
| An unpaid reservation holds a slot indefinitely | `POST /api/internal/bookings/expire-reservations` cancels the PaymentIntent first and releases the booking only once the intent can no longer take money. |

### Rating integrity

| Threat | Mitigation |
|---|---|
| Self-reported score inflation (griefing) | Layer 1 rule engine: participant-only, post-kickoff, plausible score, 48h window, rate limit. |
| Collusion / rating farming between two rosters | Roster-overlap ratio and repeat-pairing frequency are anomaly features; a flagged match needs peer consensus. |
| Approval harvesting ("sign a blank cheque") | Approvals carry a **sha256 of the canonical payload**, recomputed and verified server-side, so an approval binds to one exact scoreline. |
| Double-applied ratings | `apply_match_rating` is row-locked and gated on `rating_applied_at IS NULL`. |
| Sybil accounts voting in consensus | Quorum requires approvals **from both sides**; reporter account age is an anomaly feature. |

### Identity & access

| Threat | Mitigation |
|---|---|
| Self-service privilege escalation to `admin` | `handle_new_user` coerces client-supplied roles down to `player`; `role` is absent from the `authenticated` UPDATE grant, so PostgREST cannot write it for anyone, admins included. The only path is `POST /api/admin/users/[id]/role`, which holds the service-role key and re-states every guard in TypeScript. |
| Stale role after a demotion | Role lives in the JWT; force a token refresh on role change. Sensitive server actions re-check against `profiles`. A live abuser needs a session revocation, not a role change. |
| Stolen or revoked bearer token replayed from a device | `verifyBearerToken` always ends in `supabase.auth.getUser(token)`, which sees sign-out, password change and admin ban. Locally decoded claims can only shortcut to a rejection, never to an approval. |
| `search_path` hijack of SECURITY DEFINER helpers | Every definer function is `SET search_path = ''` with fully qualified identifiers. |
| Enumerating other users | `can_view_profile` honours `profile_visibility`; minors are always private. The email lookup on `/api/teams/[id]/members` is exact-match only, runs only after the caller is confirmed a captain, and re-reads the id it finds through the caller's own client — so it answers "is this the person I can already see?" rather than "who owns this address?". |

---

## 3. GDPR positions

**Article 8 — children's consent.** The code uses **16** as the digital-consent age (the
Regulation's default). Member states may lower it to 13; the threshold lives in exactly two
places — the `is_minor` generated column and the client-side age gate — so changing
jurisdiction is a one-line migration plus a constant. Under-13 signups are refused outright.
The Expo client runs the same gate in `(auth)/age-gate.tsx` before it collects any account
details; that copy exists to explain the refusal, while `private.is_minor_dob()`,
`enforce_minor_privacy` and `assert_consented()` are what decide it.

**Private by default for minors** (Art. 25, data protection by design) is enforced in the
database: a CHECK constraint plus a BEFORE trigger, so `location_sharing_enabled`,
public visibility, and marketing opt-in are impossible for a minor even via a service-role
write or a direct SQL session. The matchmaking distance term is skipped for minors rather than
silently reading a location that should not exist.

**Consent tokens are never stored.** Only `sha256(token)` is persisted, with a 7-day expiry and
a nightly purge. A database dump yields no usable consent links. The raw token is returned
exactly once, to the server, and is never logged or sent to the browser.

**Article 15/20 — access & portability.** `export_my_data()` returns a single JSON document
covering profile, bookings, matches, stats, ratings and consent records, served as a download.

**Article 17 — erasure, with a documented limit.** Erasure pseudonymises PII in place and
soft-deletes the profile, but **retains financial records** (bookings, payment references, payouts)
under Art. 17(3)(b) — compliance with a legal obligation, i.e. tax and accounting retention.
The retention is written into the migration, so nobody later "fixes" it by hard-deleting
invoices.

**Article 30 / accountability.** `audit_log` records role changes, consent grants and
revocations, and erasure requests.

**Data minimisation.** Latitude/longitude are stored only for venues (business addresses) and
never for players. IPs are stored as hashes only, for abuse detection.

---

## 4. Review checklist

Run through this before every release touching money, auth, or RLS.

- [ ] No bare `auth.uid()` / `auth.jwt()` anywhere in a policy — all wrapped in `(select ...)`
- [ ] Every table in `public` has RLS enabled **and** forced
- [ ] Every FK and policy-referenced column is indexed
- [ ] No `FOR ALL` policies on tables with asymmetric read/write rules
- [ ] Every `SECURITY DEFINER` function sets `search_path = ''`
- [ ] Webhook reads `req.text()`, not `req.json()`
- [ ] Webhook is idempotent via `stripe_events` and returns 200 for unknown events
- [ ] No route accepts an amount, an account id, or a role from the request body
- [ ] `SUPABASE_SERVICE_ROLE_KEY` absent from every client bundle (`grep` the `apps/web/.next` output)
- [ ] Every bearer caller is resolved through `supabase.auth.getUser(token)`, never from decoded claims
- [ ] `MOBILE_ALLOWED_ORIGINS` lists exact origins only, and `/api/stripe/webhook` is still outside the CORS source pattern
- [ ] Anomaly-service failure path exercised: the platform still finalises matches
- [ ] Minor account cannot set location sharing, public visibility, or marketing opt-in
- [ ] Minor without granted consent cannot complete a checkout
