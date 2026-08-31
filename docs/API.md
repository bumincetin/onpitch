# Halisaha — API Reference

Every route handler lives in `apps/web/app/api/**`, runs on the Node runtime
(`export const runtime = 'nodejs'`), is `force-dynamic`, parses its input with a zod schema from
`packages/shared/src/domain.ts` (imported as `@halisaha/shared/domain`), and returns the
`ApiResponse<T>` discriminated union:

```ts
type ApiResponse<T> =
  | { ok: true;  data: T }
  | { ok: false; error: { code: string; message: string; details?: Json } }
```

`lib/api-response.ts` is the only place that union is serialised. It stamps
`Cache-Control: no-store` and `Vary: Cookie` on every response, and turns thrown Zod failures,
Postgres SQLSTATEs and Stripe errors into a stable `code` plus a generic message, with the detail
going to the server log.

Auth arrives over either transport: the Supabase session cookie that `@supabase/ssr` writes, or
`Authorization: Bearer <access token>`, which is what the Expo app sends because it has no cookie
jar. `createRouteClient()` picks whichever is present, and both carry the same Supabase session,
so `auth.uid()` and every RLS policy behave identically. Roles come from the JWT `user_role`
claim; `requireRole()` re-reads `profiles` where a stale claim would matter.

Cross-origin browser callers (Expo Web) are answered only for the origins in
`MOBILE_ALLOWED_ORIGINS` — see `apps/web/next.config.mjs`. Native React Native sends no `Origin`
and needs no entry.

Shared error codes: `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_FAILED`,
`RATE_LIMITED`, `INTERNAL`, plus the route-specific ones listed below.

---

## Payments

### `POST /api/stripe/connect/onboard`
`venue_owner | admin`. Creates or reuses a Stripe Connect **Express** account and returns a
single-use onboarding Account Link. Idempotency key is derived from the user id, so a
double-click cannot create two connected accounts.

→ `{ url: string; accountId: string }`

### `GET /api/stripe/connect/refresh`
Account Links expire and are single-use. Mints a fresh one and `302`s to it. This is the
`refresh_url` Stripe calls.

### `GET /api/stripe/connect/status`
Normalises `account.requirements` and flips `venues.is_active` once charges **and** payouts are
enabled.

→ `{ accountId, chargesEnabled, payoutsEnabled, detailsSubmitted, disabledReason, currentlyDue[], eventuallyDue[], pastDue[], pendingVerification[] }`

### `GET /api/stripe/connect/login-link`
Express Dashboard link for the owning venue owner (or admin).

### `POST /api/bookings/checkout`
The split payment. Body: `{ pitchId, startsAt, endsAt, teamId? }`.

Order of operations — see [IMPLEMENTATION_PLAN §11](./IMPLEMENTATION_PLAN.md#11-checkout--split-payments):
auth → consent gate for minors → **server-side price recomputation** → connected-account
`charges_enabled` check → **insert booking first** (the `tstzrange` exclusion constraint
reserves the slot atomically) → create the destination-charge PaymentIntent with
`application_fee_amount` + `transfer_data.destination`, idempotency-keyed on the booking id.

The booking lands as `awaiting_payment`, which already holds the slot. A customer who closes the
tab produces no Stripe event at all, so the reservation is released by
`POST /api/internal/bookings/expire-reservations` rather than by a webhook.

→ `{ bookingId, clientSecret, publishableKey, quote }`

| Error code | Status | Meaning |
|---|---|---|
| `SLOT_TAKEN` | 409 | SQLSTATE `23P01` — someone else won the race |
| `CONSENT_REQUIRED` | 403 | minor without granted parental consent |
| `VENUE_NOT_PAYABLE` | 409 | connected account cannot accept charges yet |
| `PRICE_UNAVAILABLE` | 422 | pitch inactive or outside opening hours |

### `POST /api/bookings/[id]/cancel`
Policy-aware refund: full outside the cancellation window, partial inside.
`refund_application_fee` and `reverse_transfer` are set by policy, never by the caller.
Idempotent.

### `POST /api/stripe/webhook`
Stripe is the caller, so the HMAC signature over the raw body is the authentication — there is
no session and no cookie, and the route is excluded from both the middleware matcher and the CORS
rules. Reads the raw body with `req.text()`, verifies against both the account and Connect
secrets, inserts the event id into `stripe_events` for exactly-once processing, then dispatches:

| Event | Effect |
|---|---|
| `payment_intent.succeeded` | booking → `confirmed`, payment → `succeeded`, notify both parties |
| `payment_intent.payment_failed` / `.canceled` | booking released |
| `charge.refunded` | `refunded` / `partially_refunded` |
| `charge.dispute.created` | audit row + venue owner notification; `bookings.status` is left alone so the disputed slot is not released while the chargeback is answered |
| `account.updated` | venue onboarding state, `venues.is_active` |
| `payout.paid` / `payout.failed` | `venue_payouts` |

Returns 200 for unknown events. 5xx only for genuinely retryable failures — Stripe retries with
backoff for three days.

---

## Matches & matchmaking

### `POST /api/matches`
Creates a match (optionally bound to a booking), auto-enrols the creator, stores
`match_quality` and `predicted_draw_probability`. The insert goes through the caller's own
client, so `matches_insert_organiser` decides whether this person may attach this match to that
booking; the two quality columns are written by the service-role client because they are absent
from the `authenticated` INSERT grant.

### `GET /api/matches`
Filterable discovery list: `?city=&format=&status=&from=&to=&openOnly=&limit=&offset=`
(`limit` ≤ 100, default 25). `matches_select_involved` restricts SELECT to people already in a
match, which is the wrong shape for discovery, so this handler is the authorisation boundary
instead: authenticated callers only, future and non-cancelled matches only, and a projection
that carries counts rather than participant identities.

### `POST /api/matches/[id]/join`
Capacity, consent, and duplicate checks; assigns the side that improves balance.

### `POST /api/matches/[id]/report-score`
Body: `{ homeScore, awayScore, clientReportedAt }`. Inserts a `score_reports` row — the BEFORE
INSERT trigger runs the anti-griefing rules and its SQLSTATEs surface as clean errors — then
calls `evaluate_score_consensus`, fires the anomaly check, and applies ratings when the verdict
is `finalized` and `requires_consensus` is false.

→ `{ verdict: 'finalized' | 'requires_consensus' | 'awaiting_opponent', variance, reportsCount }`

The trigger's SQLSTATEs map to codes rather than 500s: `PT403` → `FORBIDDEN` (403) for a
non-participant, `PT422` → `REPORT_REJECTED` (422) for a report the rules refuse, `PT429` →
`RATE_LIMITED` (429), and a duplicate report (`23505`) → `REPORT_REJECTED` (409).

### `GET /api/matches/[id]/consensus`
Round state: canonical payload, digest, who has voted, quorum needed, deadline.

### `POST /api/matches/[id]/consensus`
Body: `{ decision: 'approve' | 'reject', clientDigest, signature }`. The server **recomputes**
`sha256(canonical_payload)` and answers `DIGEST_MISMATCH` (409) when it differs, so an approval
binds to one exact scoreline. On quorum, finalises and applies ratings.

### `GET /api/matchmaking/suggest`
`?limit=&city=&format=&withinKm=`. Ranked open matches for the caller: rating proximity,
distance, kickoff preference, no-show history. Scored in `lib/matchmaking/quality.ts`; the roster
is reduced to anonymous `(mu, sigma)` pairs before scoring, and only aggregates reach the
payload. The distance term is skipped entirely for minors, whose location sharing is off by
design.

---

## Venues & pitches

### `GET /api/venues/search`
Pitch discovery, and the same endpoint the mobile app browses with.
`?q=&city=&format=&surface=&indoor=&maxPriceMinor=&date=&limit=&offset=`.

The venue and pitch reads run on the caller's client, so `venues_select_active_or_own` and
`pitches_select_visible` decide what exists for this request. A `date` filter adds exactly two
more queries — one bookings read, one blocks read, covering every pitch on the shortlist — and
the grid is folded in memory by `lib/booking/availability.ts`. Those two run on the service-role
client and project interval boundaries only: no `booked_by`, no blackout reason.

→ `{ results: VenueSearchItem[], count, limit, offset, hasMore, filters }`, where each item
carries `fromPriceMinor`, `isPayable`, and its pitches with `availableSlots` / `nextAvailableAt`
for the requested day.

### `GET /api/venues/[id]/metrics`
`?from=&to=` → `{ occupancyRate, revenueMinor, platformFeeMinor, netMinor, bookingCount, averageBookingValueMinor, cancellationRate, deltas }`.
SQL-side aggregates; occupancy honours opening hours and blackout blocks.

### `GET /api/pitches` · `POST /api/pitches` · `PATCH /api/pitches`
Venue-owner CRUD. `GET ?venueId=…` lists one venue's pitches. PATCH sits on the collection and
takes the target as `id` in the body, so every pitch write goes through one validated route
rather than a `supabase.from('pitches').update(...)` in the browser.

All three verbs use the caller's cookie- or bearer-bound client, so `pitches_insert_venue_owner`,
`pitches_update_venue_owner` and the column-level grants are the boundary; `venue_id` is
insertable but not updatable, so a pitch cannot be moved to a venue the caller does not own. An
update matching no row answers 404 rather than confirming somebody else's pitch exists.

→ `{ pitches: Pitch[] }` · `{ pitch: Pitch }`

### `GET /api/pitches/[id]/slots`
`?date=YYYY-MM-DD&days=1` → the bookable grid for one pitch, in the venue's timezone. Prices come
from the same `slotPriceMinor()` that `POST /api/bookings/checkout` charges with, so the grid
cannot quote one figure and the card be charged another.

The free/busy read runs as service_role, contained three ways: the caller's own client resolves
the pitch first (an invisible pitch 404s before the admin client exists), the elevated queries
project `time_range` and `block_range` and nothing else, and they are pinned to this pitch and
this window. A grid is a forecast — the exclusion constraint reserves the slot at checkout, so
the picker handles `SLOT_TAKEN` by refetching.

→ `{ pitch, venue, grid, generatedAt }`

### `GET /api/pitches/[id]/availability`
`?from=&to=` → the bookings and blackout blocks overlapping a window, for the venue calendar.

### `POST /api/pitches/[id]/availability`
Creates a blackout window in `pitch_availability_blocks`. There is no pre-flight overlap query:
`pitch_blocks_no_overlap` is the serialisation point, and its SQLSTATE `23P01` surfaces as
`409 BLOCK_OVERLAP`.

### `DELETE /api/pitches/[id]/availability`
`?blockId=…` removes one blackout window. → `{ blockId }`

---

## Progression

Full design notes in `docs/PROGRESSION.md`.

### `GET /api/progress`
Any signed-in user. The caller's whole progression state plus recent form and the next fixture,
in one round trip. Wraps `public.my_progress()`, which reads `auth.uid()` itself and takes no
arguments — there is nothing a caller could point at somebody else.

The RPC WRITES before it reads: it opens this week's challenges and captures the caller's
baseline. That is why this is a function rather than a view, and why the phone goes through this
route instead of reading the tables directly.

```jsonc
{ "progress": { "xp": 1494, "level": 5, "levelFloor": 1000, "nextLevelAt": 1500,
                "currentStreakWeeks": 8, "longestStreakWeeks": 8, "lastPlayedOn": "2026-08-23",
                "counters": { "matchesPlayed": 9, "goals": 9, /* 14 more */ },
                "achievements": [ /* every badge, with progress */ ],
                "challenges":   [ /* this week, with claim state */ ],
                "recentEvents": [ /* last 12 ledger rows */ ] },
  "form": ["draw", "loss", "win", "win", "loss"],   // oldest first
  "nextFixture": { "matchId": "…", "kickoffAt": "…", "timezone": "Europe/Istanbul", /* … */ } }
```

Parse with `playerProgressSchema` from `@halisaha/shared/gamification`; the RPC answers with
`jsonb`, which is opaque on the wire.

### `POST /api/challenges/[id]/claim`
Any signed-in user. Collects a completed weekly objective's XP. The whole transaction is
`public.claim_challenge()`: the `UPDATE` that flips `claimed_at` from `NULL` is the lock, so two
taps award once.

`{ "claimed": false, "xp": 0 }` is a **200, not an error** — it means the reward was already
collected or the challenge is not finished, both of which a client renders rather than reports.
`404 NOT_FOUND` when the challenge does not exist.

### `GET /api/leaderboard`
Open to signed-out callers: a ranking nobody can see before signing up recruits nobody.

`?scope=xp|rating|streak` (default `xp`) · `?city=` exact match · `?limit=` 1–100 (default 25) ·
`?offset=` 0–5000.

`public.leaderboard_page()` decides who is publishable — public, non-deleted, non-minor profiles
with at least one finalized match — so this handler adds no filtering of its own. Note the
consequence: `profiles.profile_visibility` defaults to `private`, so the leaderboard is opt-in and
a caller can be absent from their own request.

### `GET /api/venues/[id]/scorecard`
`venue_owner | admin`, and must own the venue. `?days=` 1–365 (default 90).

Paid, completed, cancelled and disputed bookings over the window, distinct customers, net take
after platform fee and refunds, plus a score and a tier. Ownership is checked twice: the role gate
here stops a player's request doing any database work, and `venue_scorecard()` raises `42501`
itself because `SECURITY DEFINER` has already stepped around RLS. A caller who does not own the
venue gets `404`, which does not confirm that it exists.

---

## Leagues

Full design notes in `docs/LEAGUES.md`.

### `GET /api/leagues`
Any signed-in user. The caller's own league positions, plus every city with a season running today.

`my_leagues()` reads `auth.uid()` itself and deliberately IGNORES `teams.is_public` — your own
team's position is yours to see whether or not the team is listed publicly. It also opens the
season for every city the caller's teams belong to before answering, so a squad that has not played
yet appears in a table rather than nowhere.

```jsonc
{ "mine": [ { "teamName": "…", "city": "İstanbul", "division": "bronze",
              "position": 1, "teamsInDivision": 2, "played": 8, "points": 11, /* … */ } ],
  "cities": [ { "city": "İstanbul", "seasonName": "2026 · 3. Sezon",
                "endsOn": "2026-10-04", "teams": 2 } ] }
```

### `GET /api/leagues/table`
Open to signed-out callers: a league table is the product's best recruiting page.

`?city=` required · `?division=bronze|silver|gold|platinum|diamond` (default `bronze`) ·
`?seasonId=` optional, otherwise the season running today.

`league_table()` publishes only teams whose `is_public` is set, because it is SECURITY DEFINER and
re-applies the rule RLS would have applied. Note the consequence: a private team is absent even for
its own members here — `GET /api/leagues` is the route that answers "where do MY teams stand".

The first column is `place`, not `position`: the latter is a reserved word in Postgres.

---

## Teams

### `GET /api/teams`
`?scope=mine|discover&q=&city=&limit=` (≤ 50, default 24). `scope` narrows what is asked for;
`teams_select_public_or_member` decides what is allowed.

→ `{ teams: TeamSummary[] }` — each with `memberCount` (active rows only), `viewerRole` and
`viewerIsOwner`.

### `POST /api/teams` · `PATCH /api/teams`
Create and edit, both on the caller's own client under `teams_insert_own` and
`teams_update_captain`. PATCH takes the target as `id` in the body. `slug` is minted once from
the name and is deliberately not editable — a team's URL has already been pasted into group
chats.

Creation is three statements in a fixed order: insert the team, insert the owner's roster row
(which lands as `member`, since `role` is outside the INSERT grant), then update that row to
`captain`. Steps 2 and 3 are best-effort — ownership alone confers captaincy in every RLS
predicate — so a failure there is logged and the team is still returned.

→ `{ team: TeamSummary }`

### `POST /api/teams/[id]/members`
Adds somebody by `playerId`, email, or display name. Owner, captain and vice-captain may add;
`team_members_insert_captain_or_self_join` is what enforces it underneath.

The email path runs through the service-role client, because `profiles.email` is outside the
SELECT grant and a column privilege covers a WHERE clause as well as a projection. Four limits
keep it from becoming an address-book oracle: captain-confirmed first, exact match only, id and
display name returned and nothing else, and the id re-read through the caller's own client so a
miss reports "not found".

→ `{ member }` (201 on a new row)

### `DELETE /api/teams/[id]/members?playerId=…`
Leaving or removal. The verb is DELETE; the statement is an UPDATE that sets `left_at`, because
`private.is_match_participant()` resolves historical line-ups through `team_members` and
`player_stats` rows carry a `team_id`. Re-joining reuses the same row and resets the rank to
`member`.

→ `{ playerId, leftAt }`

### `PATCH /api/teams/[id]/members/[playerId]`
Changes a rank or a squad number, with two different bars in one handler: `role` needs owner or
captain, `jerseyNumber` needs the player themselves or anyone who can manage the roster. A body
carrying both must clear both.

Two guards keep the team administrable: a rank change may not empty the captain set, and the
owner's rank stays captain because `private.is_team_captain()` is true for them regardless.
`uq_team_members_jersey` is UNIQUE on `(team_id, jersey_number)` for active members, so a race
for number 10 comes back as a 409, never a 500.

→ `{ member }`

---

## Account, identity & compliance

### `PATCH /api/account`
The one write path for a person's own profile row. The schema is `.strict()` and lists only the
columns inside the `authenticated` UPDATE grant, so a body naming `role`, `is_minor`,
`stripe_account_id`, `date_of_birth` or `deleted_at` gets a 422 naming the field instead of a 500
from a refused UPDATE. Guardian columns belong to the consent route, not here.

For a minor, `enforcePrivacyDefaults()` refuses `location_sharing_enabled`, public visibility and
marketing opt-in up front — the same decisions `enforce_minor_privacy` and
`profiles_minor_privacy_locked_check` make in Postgres.

`avatar_url` must be a public object in this project's Supabase Storage, in the `avatars` bucket,
under a folder named for the caller's own user id (taken from the session, never from the body).
The object is then fetched with HEAD and its content type and length re-checked.

### `POST /api/auth/parental-consent/request`
Calls `request_parental_consent`, receives the one-time raw token **server-side only**, and
emails the guardian. The token is never logged and never returned to the browser.

### `POST /api/auth/parental-consent/verify`
Body: `{ token }` → `verify_parental_consent`. Grants consent and unblocks transacting. The
guardian following the emailed link is not an account holder, so this runs on the service-role
client — `public.verify_parental_consent` is granted to `service_role` alone.
`CONSENT_TOKEN_INVALID` covers unknown, used and expired tokens alike.

### `GET /api/gdpr/export`
Art. 15/20. Returns `export_my_data()` as a downloadable JSON attachment.

### `POST /api/gdpr/erase`
Art. 17. Requires a typed confirmation string. Pseudonymises PII and soft-deletes; financial
records are retained under Art. 17(3)(b) — see [SECURITY.md](./SECURITY.md#3-gdpr-positions).

---

## Notifications

### `GET /api/notifications`
`?filter=all|unread&limit=&before=` (≤ 50, default 20). Keyset pagination on `created_at`, since
an offset would re-read skipped rows and shift under a reader while new notifications arrive.
`notifications_select_own` is the boundary — `user_id = auth.uid()`, with no admin escape hatch.

Rows never reach the client raw: `formatNotification()` resolves each deep link against the
caller's role and the routes that exist, so the payload keys stay a server-side detail.

→ `NotificationPage` — the formatted rows, the unread count, and the next cursor.

### `POST /api/notifications/[id]/read`
Marks one notification read. The `authenticated` grant covers the `read_at` column only, so this
handler could not change a notification's text if it tried. Idempotent: `.is('read_at', null)`
keeps the original timestamp, and a second call returns 200 with that timestamp rather than
looking like a failure.

### `POST /api/notifications/read-all`
Clears the badge in one statement, same grants and the same `read_at` guard. Returns the number
of rows it actually changed plus the unread count read back afterwards, so a notification
arriving mid-flight does not leave the bell stale.

---

## Admin

`middleware.ts` guards `/admin/*` by literal prefix, which `/api/admin/*` does not match, so
every route here calls `requireRole('admin')` itself — and that check re-reads the profile row
rather than trusting a JWT claim that can be an hour old.

### `GET /api/admin/metrics`
`?days=` → `{ metrics: PlatformMetrics, generatedAt }`. Every read inside
`computePlatformMetrics` goes through the caller's own client, so RLS re-derives the role per
row.

### `POST /api/admin/users/[id]/role`
Changes one account's `app_role`. `role` is outside the `authenticated` UPDATE grant, so no
policy can grant it and the only path is this route on the service-role client, with every guard
RLS would have applied re-stated in TypeScript — including the last-admin count, which excludes
soft-deleted profiles. Body carries the new role and a reason of at least 10 characters for the
audit trail.

→ `{ userId, previousRole, role, auditRecorded, reauthRequired, message }`

`reauthRequired` is always true: `user_role` is minted when a token is issued, never patched into
a live one. A promotion does not take effect until the next refresh, and a demotion does not
revoke access — removing an active abuser needs a session revocation.

### `POST /api/admin/matches/[id]/resolve`
Writes the official score for a match the players could not settle, or voids the fixture. Body:
`{ outcome: 'finalize' | 'void', homeScore?, awayScore?, reason }` — `reason` is 10 to 1000
characters and goes into the audit trail; scores are capped at 30 goals, the same ceiling
`validate_score_report` enforces on a player-filed report.

The handler is transport only. The ruling itself is `applyMatchRuling` in `lib/admin/metrics.ts`,
which the Server Action behind the admin form also calls, so the audit-before-mutate ordering
cannot drift between the two entry points.

---

## Internal

Both routes are server-to-server, guarded by `INTERNAL_API_TOKEN` presented as a bearer token or
`X-Internal-Token` and compared with `timingSafeEqual`. Neither has a user session; both run as
service_role.

### `POST /api/internal/anomaly/check`
Sends the `AnomalyFeatureVector` to the Python sidecar with an HMAC-SHA256 signature and a 2.5s
timeout, then persists the verdict via `record_anomaly_verdict`.

A sidecar failure is not fatal. If it is unreachable or non-2xx, the route falls back to the
in-database rule-engine verdict and records `source = 'rule_engine'`. A match must never be
blocked from finalising because an ML service is down.

Sidecar contract:

```jsonc
// request
{ "matchId": "uuid", "scoreVariance": 4.0, "reportingDelaySeconds": 120,
  "reporterCount": 2, "opposingReportAgreement": 0.0, "participantOverlapRatio": 0.9,
  "historicalReportDeviation": 2.1, "goalDiff": 9, "kickoffHour": 23,
  "venueBookingsLast7d": 1, "reporterAccountAgeDays": 2 }

// response
{ "matchId": "uuid", "anomalyScore": 0.78, "isAnomalous": true, "leafDepth": 3,
  "averagePathLength": 4.1, "modelVersion": "if-v1", "threshold": 0.62,
  "reasons": ["score variance in the 99th percentile", "reporter account age < 7 days"] }
```

### `POST /api/internal/bookings/expire-reservations`
Sweeps reservations left `awaiting_payment` past the 30-minute TTL. A customer who abandons
checkout produces no Stripe event, and `awaiting_payment` is inside the
`bookings_no_double_booking` predicate, so without this the slot is held forever.

The PaymentIntent is cancelled **first** and the booking released only once it can no longer take
money; an intent Stripe will not confirm dead is deferred to the next run. `pg_cron` cannot call
Stripe, which is why this is a route rather than a database job. Each call handles at most 200
reservations, oldest first. Invoke it every five minutes.

→ `{ examined, released, paid, deferred, ttlMinutes, cutoff }`

---

## Operations

### `GET /api/health`
Liveness probe, and the only route in `app/api/**` that takes no credentials at all. It answers
"is this deployment serving route handlers?" and deliberately touches neither Postgres nor
Stripe: a probe that queried the database would report the API down during a Supabase blip the
app can survive, and the mobile client talks to Supabase directly anyway. The response carries no
session-derived or configuration-derived values.

The Expo app pings it on cold start and after a network error, to tell "the API is unreachable"
apart from "your session expired".

→ `{ status: 'ok', service: 'halisaha-web', time, uptimeSeconds }`

---

## Realtime channels

Not HTTP, but part of the public surface. Topics are built in `packages/shared/src/channels.ts`
(`@halisaha/shared/channels`) and authorised by `realtime.messages` policies. Web and mobile
import the same builders, so a topic string cannot drift between the two clients.

| Topic | Transport | Who |
|---|---|---|
| `match:<id>` | broadcast + postgres_changes | anyone who can `SELECT` the match |
| `match:<id>:private` | broadcast | confirmed participants |
| `venue:<id>` | postgres_changes on `bookings` | the owning venue owner |

`presenceTopic(id)` returns `matchTopic(id)` on purpose: presence rides the score channel, so a
match costs one join and one ACL rather than two.

Clients must re-call `realtime.setAuth()` on JWT refresh, or the socket stops delivering
silently.
