/**
 * lib/admin/metrics.ts
 *
 * The admin back office's server-side data layer. Three things live here:
 *
 *   * the platform-wide aggregates behind `/admin` and `GET /api/admin/metrics`;
 *   * `recordAdminAudit` / `listAuditEntries`, the only way this surface touches
 *     `public.audit_log`;
 *   * `applyMatchRuling`, the admin decision on a contested result, shared by the JSON route
 *     and the Server Action behind the review page's form.
 *
 * The last two are here rather than in modules of their own because the file list for this
 * surface is fixed. A single implementation of a security-relevant write is worth more than a
 * tidier filename: two copies would be two places for the actor, or the audit-before-mutate
 * ordering, to drift.
 *
 * ---------------------------------------------------------------------------
 * WHICH CLIENT READS WHAT
 * ---------------------------------------------------------------------------
 * Every aggregate below runs on the CALLER'S cookie-bound client. `bookings_select_stakeholders`,
 * `venues_select_active_or_own` and `matches_select_involved` each carry a `private.is_admin()`
 * disjunct, so the same query returns one venue's rows for an owner and the whole platform for
 * an admin. Nothing here needs to bypass RLS, and if the
 * caller's admin claim is stale the numbers shrink to what they may legitimately see rather
 * than leaking.
 *
 * `recordAdminAudit` is the exception, and it is documented at its own definition.
 *
 * ---------------------------------------------------------------------------
 * WHY THE COUNTS ARE `head: true` AND THE MONEY IS NOT
 * ---------------------------------------------------------------------------
 * Counts go over the wire as `count=exact` with `head: true`: Postgres runs the COUNT and
 * PostgREST returns a Content-Range header and zero rows. Cost is independent of platform
 * size, and twelve of them run concurrently.
 *
 * Money is different. Summing `total_minor` server-side would need either PostgREST's
 * aggregate pushdown — off by default in PostgREST 12 and not something an application module
 * may assume about the deployment — or a SQL aggregate function, and `supabase/migrations` is
 * owned by the schema, not by this app. So the booking window is fetched once, projected down
 * to five integer columns, and folded in memory. One round trip, not one per venue.
 *
 * That fold has a ceiling. Past `MAX_BOOKING_ROWS` the result is marked `truncated` and the
 * UI says so, because a revenue figure that is quietly missing its tail is worse than no
 * figure at all.
 */

import "server-only"

import { z } from "zod"
import type { SupabaseClient } from "@supabase/supabase-js"

import { createAdminClient } from "@/lib/supabase/admin"
import type { Database, Enums, Json, TablesUpdate } from "@halisaha/shared/database"
import { asMinor, DEFAULT_CURRENCY, type MinorUnits } from "@halisaha/shared/domain"

type Client = SupabaseClient<Database>

/* ========================================================================== */
/*  1. The window                                                             */
/* ========================================================================== */

/** Windows the overview offers as one-click choices. Any 1..365 value is accepted. */
export const ADMIN_WINDOW_CHOICES = [7, 30, 90, 365] as const

export const DEFAULT_WINDOW_DAYS = 30

/**
 * `?days=` for both the page and the route handler.
 *
 * `.default()` runs before coercion, so an absent parameter is the default window while a
 * garbage one is a validation failure the route reports as 422 rather than silently rounding
 * to something the operator did not ask for.
 */
export const adminMetricsQuerySchema = z.object({
  days: z.coerce
    .number()
    .int("Window must be a whole number of days.")
    .min(1, "Window must be at least one day.")
    .max(365, "Windows longer than a year are not supported.")
    .default(DEFAULT_WINDOW_DAYS),
})

export type AdminMetricsQuery = z.infer<typeof adminMetricsQuerySchema>

export interface MetricsWindow {
  /** Inclusive lower bound, ISO 8601 UTC. */
  from: string
  /** Exclusive upper bound, ISO 8601 UTC. */
  to: string
  days: number
}

export function resolveWindow(days: number, now: Date = new Date()): MetricsWindow {
  const to = now
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000)
  return { from: from.toISOString(), to: to.toISOString(), days }
}

/* ========================================================================== */
/*  2. The shape                                                              */
/* ========================================================================== */

/**
 * Money for ONE currency. Amounts are never summed across currencies — a platform running
 * TRY and EUR side by side has two revenue figures, not one meaningless total.
 */
export interface CurrencyTotals {
  currency: string
  /** Charged to customers on bookings that reached a successful payment. */
  grossMinor: MinorUnits
  /** The marketplace's application fee on those bookings. */
  platformFeeMinor: MinorUnits
  /** Refunded back out of `grossMinor`, whole or partial. */
  refundedMinor: MinorUnits
  /** `gross - fee - refunded`: what the venues actually keep. */
  netToVenuesMinor: MinorUnits
  paidBookings: number
  averageBookingValueMinor: MinorUnits
}

export interface PlatformMetrics {
  range: MetricsWindow

  /** Per-currency money, ordered by gross descending. Empty when nothing was paid. */
  money: readonly CurrencyTotals[]
  /** The largest-gross currency, or the platform default when the window is empty. */
  primaryCurrency: string
  /**
   * True when the booking fold hit `MAX_BOOKING_ROWS`; every figure in `money` is a lower
   * bound. The four booking COUNTS below are unaffected — they are exact-count queries, not
   * a length of the folded page.
   */
  truncated: boolean

  bookingsCreated: number
  bookingsPaid: number
  bookingsCancelled: number
  bookingsRefunded: number

  venuesTotal: number
  /** Published: `is_active`. What a player can actually find and book. */
  venuesActive: number
  /** Stripe has enabled charges. An active venue that is not payable takes no money. */
  venuesPayable: number

  playersTotal: number
  /** Distinct rated players whose last match falls inside the window. */
  playersActive: number

  matchesInWindow: number
  matchesFinalized: number
  matchesDisputed: number
  matchesAwaitingConsensus: number
  matchesCancelled: number
  /** `finalized / (in window - cancelled)`, in [0,1]. Null when nothing was playable. */
  matchCompletionRate: number | null
  /** `(disputed + awaiting consensus) / (in window - cancelled)`, in [0,1]. */
  disputeRate: number | null

  /** Queue depth right now, ignoring the window: what an admin has left to settle. */
  openDisputes: number
  openConsensusRounds: number
}

/* ========================================================================== */
/*  3. The aggregate                                                          */
/* ========================================================================== */

/**
 * Hard ceiling on the booking fold. 20k rows of five integers is a few megabytes of JSON at
 * worst and a fraction of a second to add up; beyond that the honest answer is "this needs a
 * SQL aggregate", which is a schema change, not an app change.
 */
const MAX_BOOKING_ROWS = 20_000

/** The projection the money fold needs, and nothing else. */
const BOOKING_COLUMNS = "status, payment_status, total_minor, platform_fee_minor, refunded_amount_minor, currency"

interface BookingRow {
  status: Enums<"booking_status">
  payment_status: Enums<"payment_status">
  total_minor: number
  platform_fee_minor: number
  refunded_amount_minor: number
  currency: string
}

/** Payment states in which money actually moved. `failed` and `requires_payment` did not. */
const COLLECTED_PAYMENT_STATES: readonly Enums<"payment_status">[] = [
  "succeeded",
  "refunded",
  "partially_refunded",
]

export interface ComputePlatformMetricsInput {
  /** MUST be the caller's cookie-bound client. See the module header. */
  supabase: Client
  days?: number
  now?: Date
}

export async function computePlatformMetrics({
  supabase,
  days = DEFAULT_WINDOW_DAYS,
  now = new Date(),
}: ComputePlatformMetricsInput): Promise<PlatformMetrics> {
  const range = resolveWindow(days, now)

  const [
    bookingsResponse,
    bookingsCreated,
    bookingsPaid,
    bookingsCancelled,
    bookingsRefunded,
    venuesTotal,
    venuesActive,
    venuesPayable,
    playersTotal,
    playersActive,
    matchesTotal,
    finalized,
    disputed,
    awaitingConsensus,
    cancelledMatches,
    openDisputes,
    openConsensusRounds,
  ] = await Promise.all([
    supabase
      .from("bookings")
      .select(BOOKING_COLUMNS)
      .gte("created_at", range.from)
      .lt("created_at", range.to)
      // One over the ceiling, so "we hit the ceiling" is detectable rather than assumed.
      .limit(MAX_BOOKING_ROWS + 1),

    // The four booking counters are counted by the database rather than derived from the fold
    // above. The fold is capped at MAX_BOOKING_ROWS, so `rows.length` freezes at the ceiling on
    // a busy window and would report 20,000 bookings as if it were the real number. These are
    // `head: true` counts: no rows cross the wire and the cost does not grow with the platform,
    // so only the money totals stay tied to the fold.
    countOf(bookingsInWindow(supabase, range)),
    countOf(bookingsInWindow(supabase, range).in("payment_status", COLLECTED_PAYMENT_STATES)),
    countOf(bookingsInWindow(supabase, range).eq("status", "cancelled")),
    countOf(bookingsInWindow(supabase, range).gt("refunded_amount_minor", 0)),

    countOf(supabase.from("venues").select("id", { count: "exact", head: true })),
    countOf(supabase.from("venues").select("id", { count: "exact", head: true }).eq("is_active", true)),
    countOf(
      supabase.from("venues").select("id", { count: "exact", head: true }).eq("charges_enabled", true),
    ),

    countOf(supabase.from("profiles").select("id", { count: "exact", head: true }).eq("role", "player")),
    countOf(
      supabase
        .from("player_ratings")
        .select("player_id", { count: "exact", head: true })
        .gte("last_match_at", range.from),
    ),

    countOf(matchesInWindow(supabase, range)),
    countOf(matchesInWindow(supabase, range).eq("status", "finalized")),
    countOf(matchesInWindow(supabase, range).eq("status", "disputed")),
    countOf(matchesInWindow(supabase, range).eq("status", "requires_consensus")),
    countOf(matchesInWindow(supabase, range).eq("status", "cancelled")),

    countOf(supabase.from("matches").select("id", { count: "exact", head: true }).eq("status", "disputed")),
    countOf(
      supabase.from("matches").select("id", { count: "exact", head: true }).eq("requires_consensus", true),
    ),
  ])

  if (bookingsResponse.error) throw bookingsResponse.error

  // `as unknown as`: BOOKING_COLUMNS is a shared const rather than an inline literal, so
  // postgrest-js cannot infer the row type from it. The projection above is what makes this
  // assertion true — change one and change the other.
  const allRows = (bookingsResponse.data ?? []) as unknown as BookingRow[]
  const truncated = allRows.length > MAX_BOOKING_ROWS
  const rows = truncated ? allRows.slice(0, MAX_BOOKING_ROWS) : allRows

  const money = foldMoney(rows)
  const playableMatches = matchesTotal - cancelledMatches
  const contested = disputed + awaitingConsensus

  return {
    range,
    money,
    primaryCurrency: money[0]?.currency ?? DEFAULT_CURRENCY,
    truncated,

    bookingsCreated,
    bookingsPaid,
    bookingsCancelled,
    bookingsRefunded,

    venuesTotal,
    venuesActive,
    venuesPayable,

    playersTotal,
    playersActive,

    matchesInWindow: matchesTotal,
    matchesFinalized: finalized,
    matchesDisputed: disputed,
    matchesAwaitingConsensus: awaitingConsensus,
    matchesCancelled: cancelledMatches,
    matchCompletionRate: playableMatches > 0 ? finalized / playableMatches : null,
    disputeRate: playableMatches > 0 ? contested / playableMatches : null,

    openDisputes,
    openConsensusRounds,
  }
}

/**
 * `bookings` restricted to the window, as a counting builder — a fresh one each time, because a
 * PostgREST builder accumulates its filters and cannot be reused for two different predicates.
 * Mirrors the `created_at` bounds the money fold uses, so the counts and the totals describe the
 * same set of rows.
 */
function bookingsInWindow(supabase: Client, range: MetricsWindow) {
  return supabase
    .from("bookings")
    .select("id", { count: "exact", head: true })
    .gte("created_at", range.from)
    .lt("created_at", range.to)
}

/** `matches` restricted to kickoffs inside the window, as a fresh builder each time. */
function matchesInWindow(supabase: Client, range: MetricsWindow) {
  return supabase
    .from("matches")
    .select("id", { count: "exact", head: true })
    .gte("kickoff_at", range.from)
    .lt("kickoff_at", range.to)
}

/**
 * Await a `head: true` count query and return the number.
 *
 * A count query that errors throws rather than reporting zero: an admin looking at a silent
 * `0` cannot tell "nothing happened" from "the query was refused", and would act on the wrong
 * one of those two.
 */
async function countOf(query: PromiseLike<{ count: number | null; error: unknown }>): Promise<number> {
  const { count, error } = await query
  if (error) throw error
  return count ?? 0
}

/** Group by currency, add up, sort by gross descending. */
function foldMoney(rows: readonly BookingRow[]): CurrencyTotals[] {
  interface Accumulator {
    gross: number
    fee: number
    refunded: number
    paid: number
  }
  const byCurrency = new Map<string, Accumulator>()

  for (const row of rows) {
    if (!COLLECTED_PAYMENT_STATES.includes(row.payment_status)) continue

    const currency = row.currency.toLowerCase()
    const bucket = byCurrency.get(currency) ?? { gross: 0, fee: 0, refunded: 0, paid: 0 }
    bucket.gross += row.total_minor
    bucket.fee += row.platform_fee_minor
    bucket.refunded += row.refunded_amount_minor
    bucket.paid += 1
    byCurrency.set(currency, bucket)
  }

  const totals: CurrencyTotals[] = []
  for (const [currency, bucket] of byCurrency) {
    totals.push({
      currency,
      grossMinor: asMinor(bucket.gross),
      platformFeeMinor: asMinor(bucket.fee),
      refundedMinor: asMinor(bucket.refunded),
      netToVenuesMinor: asMinor(bucket.gross - bucket.fee - bucket.refunded),
      paidBookings: bucket.paid,
      // Integer division on minor units. Rounding down by at most one kurus on an average is
      // the right trade against reintroducing floats into a money path.
      averageBookingValueMinor: asMinor(bucket.paid > 0 ? Math.round(bucket.gross / bucket.paid) : 0),
    })
  }

  return totals.sort((a, b) => b.grossMinor - a.grossMinor)
}

/* ========================================================================== */
/*  4. The audit shim                                                         */
/* ========================================================================== */

/**
 * Actions this surface appends. Kept as a closed union so a typo becomes a compile error
 * instead of an unsearchable audit row.
 */
export type AdminAuditAction =
  | "admin.role_changed"
  | "admin.match_resolved"
  | "admin.match_score_overridden"
  | "admin.match_voided"
  | "admin.match_resolve_failed"
  | "admin.venue_visibility_changed"

export interface AdminAuditEntry {
  action: AdminAuditAction
  /** The signed-in admin performing the action. Goes into `metadata`, for the reason below. */
  actorId: string
  entityType: "profiles" | "matches" | "venues"
  entityId: string
  /** Free-text justification typed by the operator. Required by every caller. */
  reason: string
  metadata: Record<string, Json>
}

/**
 * PostgREST call shape for `public.log_audit`.
 *
 * The generated `Database["public"]["Functions"]` map does not list `log_audit` — 0003 grants
 * it to `service_role` only, and the generator emits the user-facing surface — so
 * `SupabaseClient<Database>.rpc()` will not accept the name. This interface restates the exact
 * signature from `0003_auth_rbac_gdpr.sql` §2 and nothing else, which keeps the call typed
 * without reaching for `any`.
 */
interface AuditRpcClient {
  rpc(
    fn: "log_audit",
    args: {
      p_action: string
      p_entity_type: string | null
      p_entity_id: string | null
      p_metadata: Json
    },
  ): PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>
}

/**
 * Append one row to `public.audit_log` through `public.log_audit`.
 *
 * SERVICE ROLE, deliberately, and this is the one place in the admin surface that needs it.
 * `0002_rls.sql` §4.8 gives `authenticated` no grant at all on `audit_log` and `0003` grants
 * `log_audit` to `service_role` only: the accountability trail is unreadable and unwritable by
 * the subjects it records, admins included. There is no policy that could express "an admin
 * may append but not amend" — the table is deliberately outside PostgREST's reach.
 *
 * `log_audit` takes the actor from `auth.uid()` and refuses to accept one as a parameter, so
 * that a caller can never attribute an action to somebody else. Under the service role there
 * is no JWT, so the stored `actor_id` column is NULL and the operator's id is carried in
 * `metadata.actor_id` instead. That is a real trade and it is visible in the data: read
 * `metadata.actor_id` when the row's `action` starts with `admin.`.
 *
 * Role changes get a second, independent row for free — `trg_profiles_audit_role_change` fires
 * inside the UPDATE's own transaction, so the fact of the change is recorded whatever happens
 * to the call below. The entry this function writes is the one carrying the operator and the
 * reason.
 *
 * @returns whether the row was written. Callers decide what an unwritten audit row means for
 *          their operation; for anything irreversible it must mean "refuse".
 */
export async function recordAdminAudit(entry: AdminAuditEntry): Promise<boolean> {
  const admin = createAdminClient()
  const auditor = admin as unknown as AuditRpcClient

  const { error } = await auditor.rpc("log_audit", {
    p_action: entry.action,
    p_entity_type: entry.entityType,
    p_entity_id: entry.entityId,
    p_metadata: {
      ...entry.metadata,
      actor_id: entry.actorId,
      reason: entry.reason,
      recorded_by: "admin_console",
    },
  })

  if (error) {
    console.error("[admin/audit] log_audit failed", {
      action: entry.action,
      entityId: entry.entityId,
      code: error.code,
      message: error.message,
    })
    return false
  }

  return true
}

/* ========================================================================== */
/*  5. Reading the trail back                                                 */
/* ========================================================================== */

export interface AuditEntry {
  id: number
  actorId: string | null
  action: string
  entityType: string | null
  entityId: string | null
  metadata: Json
  createdAt: string
}

export interface ListAuditOptions {
  limit?: number
  /** Restrict to one subject, e.g. a single match under review. */
  entityId?: string
  /** Prefix filter on `action`, e.g. `"admin."` for operator actions only. */
  actionPrefix?: string
}

/**
 * Read the accountability trail.
 *
 * Service role for the same reason `recordAdminAudit` writes with it: `audit_log` has zero
 * grants for `authenticated`, so an admin's own client returns nothing at all. Callers MUST
 * have passed `requireRole('admin')` before reaching this — there is no RLS underneath to
 * catch a mistake here.
 */
export async function listAuditEntries(options: ListAuditOptions = {}): Promise<AuditEntry[]> {
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 200)
  const admin = createAdminClient()

  let query = admin
    .from("audit_log")
    .select("id, actor_id, action, entity_type, entity_id, metadata, created_at")
    .order("created_at", { ascending: false })
    .limit(limit)

  if (options.entityId) query = query.eq("entity_id", options.entityId)
  if (options.actionPrefix) query = query.like("action", `${options.actionPrefix}%`)

  const { data, error } = await query
  if (error) throw error

  return (data ?? []).map((row) => ({
    id: row.id,
    actorId: row.actor_id,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    metadata: row.metadata,
    createdAt: row.created_at,
  }))
}

/**
 * How many admins the platform has, excluding erased accounts.
 *
 * Service role, and the reason is a column grant rather than a policy: `0002_rls.sql` §4.1
 * hands `authenticated` SELECT on ten columns of `profiles` and `deleted_at` is not one of
 * them, so a cookie-bound client cannot filter erased rows out. Counting an erased admin as
 * live would let the genuinely last admin demote themselves and lock every operator out of
 * the platform, which is the exact failure this count exists to prevent.
 */
export async function countLiveAdmins(): Promise<number> {
  const admin = createAdminClient()
  const { count, error } = await admin
    .from("profiles")
    .select("id", { count: "exact", head: true })
    .eq("role", "admin")
    .is("deleted_at", null)

  if (error) throw error
  return count ?? 0
}

/* ========================================================================== */
/*  6. Match rulings                                                          */
/* ========================================================================== */

/**
 * The admin ruling on a contested match, as one function.
 *
 * It lives here rather than inside the route handler because two transports need it: the JSON
 * endpoint `POST /api/admin/matches/[id]/resolve`, and the Server Action behind the form on
 * `/admin/matches/[id]`. A second copy would be a second place for the audit-before-mutate
 * ordering to drift.
 *
 * ---------------------------------------------------------------------------
 * ORDER OF OPERATIONS, AND WHY IT IS THIS ORDER
 * ---------------------------------------------------------------------------
 * 1. `finalize_consensus` FIRST, on the CALLER'S client. It is granted to `authenticated` and
 *    admits an admin through `private.is_integrity_admin()`, it is row-locked and idempotent,
 *    and it is the only path that can ratify a peer-agreed scoreline. Calling it before the
 *    override means a quorum that landed while the admin was reading the file wins, and the
 *    admin is then told they are overwriting a finalised result instead of clobbering one they
 *    never saw.
 *
 *    It cannot carry the admin's scoreline: it finalises from `consensus_payload()` — the
 *    most-corroborated report — and counts only votes bound to that exact digest. An admin
 *    decision has a different evidentiary basis, so it is a different write.
 *
 * 2. The audit entry SECOND, before anything mutates. If it cannot be written the ruling is
 *    refused and nothing changes. An unlogged override of a finalised result is the one outcome
 *    this function must make impossible, and refusing is the only way to guarantee that without
 *    a transaction spanning two connections.
 *
 * 3. The score THIRD, on the service-role client. `home_score`, `away_score`,
 *    `score_confirmed_at` and `requires_consensus` appear in no column-level UPDATE grant at all
 *    (`0002_rls.sql` §4.5): the schema's rule is that a score enters the system only through
 *    `score_reports`. An admin ruling is the documented exception and has to be made outside
 *    PostgREST, because no grant could express it.
 *
 * 4. Ratings LAST. `apply_match_rating` is service-role only and idempotent — it returns 0
 *    without touching anything once `rating_applied_at` is stamped. A match whose ratings were
 *    already applied keeps them: `trg_matches_guard_rating_idempotency` refuses a reset unless
 *    the transaction sets `app.allow_rating_reset`, which PostgREST cannot do. The result says
 *    so plainly rather than implying the new scoreline moved anybody's mu.
 */

export interface MatchRulingInput {
  /** MUST be the caller's cookie-bound client: RLS decides whether they may see this match. */
  supabase: Client
  /** The signed-in admin. Callers must have passed `requireRole('admin')` already. */
  actorId: string
  matchId: string
  outcome: "finalize" | "void"
  /** Required when `outcome` is `finalize`. */
  homeScore?: number
  awayScore?: number
  reason: string
  /** Required to proceed once the match is already finalised. */
  acknowledgeOverwrite?: boolean
}

export interface MatchRulingApplied {
  status: "applied"
  matchId: string
  outcome: "finalized" | "voided"
  homeScore: number | null
  awayScore: number | null
  previousStatus: Enums<"match_status">
  previousScore: { home: number; away: number } | null
  overwroteConfirmedResult: boolean
  /** `decision` from `finalize_consensus`, or null when it was not called or it failed. */
  consensusDecision: string | null
  ratingsAppliedNow: number
  ratingsAlreadyApplied: boolean
  /** True when the score stands but the TrueSkill pass did not run. Somebody must re-run it. */
  ratingPassFailed: boolean
  message: string
}

export type MatchRulingResult =
  | MatchRulingApplied
  | { status: "not_found" }
  | {
      status: "needs_acknowledgement"
      currentStatus: Enums<"match_status">
      currentScore: { home: number; away: number } | null
      ratingsAlreadyApplied: boolean
      consensusDecision: string | null
      message: string
    }
  | { status: "failed"; stage: "read" | "audit" | "update"; message: string }

/** `finalize_consensus` answers with a JSON object whose only guaranteed key is `decision`. */
const consensusVerdictSchema = z.object({ decision: z.string() }).passthrough()

export async function applyMatchRuling(input: MatchRulingInput): Promise<MatchRulingResult> {
  const { supabase, actorId, matchId, outcome, reason } = input

  /* --- 0. Matches, through the caller's client -------------------------- */
  // `matches_select_involved` -> `can_manage_match` -> `is_admin` authorises this. An admin
  // whose claim has gone stale gets no row, which is the correct answer.
  const { data: before, error: beforeError } = await supabase
    .from("matches")
    .select("id, status, requires_consensus")
    .eq("id", matchId)
    .maybeSingle()

  if (beforeError) {
    console.error("[admin/ruling] match lookup failed", { code: beforeError.code })
    return { status: "failed", stage: "read", message: "Bu maç yüklenemedi." }
  }
  if (!before) return { status: "not_found" }

  /* --- 1. Let the players have the last word first ------------------------ */
  let consensusDecision: string | null = null
  if (before.requires_consensus) {
    const { data: verdict, error: verdictError } = await supabase.rpc("finalize_consensus", {
      p_match_id: matchId,
    })

    if (verdictError) {
      // A stuck round is precisely why an admin is here. Note that the close failed and carry on
      // with the manual ruling rather than blocking on it.
      console.error("[admin/ruling] finalize_consensus failed", { code: verdictError.code })
    } else {
      const decoded = consensusVerdictSchema.safeParse(verdict)
      consensusDecision = decoded.success ? decoded.data.decision : null
    }
  }

  /* --- 2. Re-read: the call above may have moved the match ---------------- */
  const { data: current, error: currentError } = await supabase
    .from("matches")
    .select("id, status, home_score, away_score, score_confirmed_at, rating_applied_at, is_ranked")
    .eq("id", matchId)
    .maybeSingle()

  if (currentError || !current) {
    console.error("[admin/ruling] re-read failed", { code: currentError?.code })
    return {
      status: "failed",
      stage: "read",
      message: "Uzlaşma turu kapatıldıktan sonra maç yeniden okunamadı.",
    }
  }

  const alreadyConfirmed = current.score_confirmed_at !== null || current.status === "finalized"
  const previousScore =
    current.home_score !== null && current.away_score !== null
      ? { home: current.home_score, away: current.away_score }
      : null

  /* --- 3. Refuse a silent overwrite --------------------------------------- */
  if (alreadyConfirmed && input.acknowledgeOverwrite !== true) {
    return {
      status: "needs_acknowledgement",
      currentStatus: current.status,
      currentScore: previousScore,
      ratingsAlreadyApplied: current.rating_applied_at !== null,
      consensusDecision,
      message:
        consensusDecision === "finalized"
          ? "The players ratified this result while you were reviewing it. Re-read the file, and " +
            "confirm the overwrite if you still want to replace their scoreline."
          : "This match is already finalised. Confirm the overwrite to replace the confirmed result.",
    }
  }

  /* --- 4. Accountability BEFORE the mutation ------------------------------ */
  const action: AdminAuditAction = alreadyConfirmed
    ? "admin.match_score_overridden"
    : outcome === "void"
      ? "admin.match_voided"
      : "admin.match_resolved"

  const auditRecorded = await recordAdminAudit({
    action,
    actorId,
    entityType: "matches",
    entityId: matchId,
    reason,
    metadata: {
      outcome,
      previous_status: current.status,
      previous_home_score: current.home_score,
      previous_away_score: current.away_score,
      previous_score_confirmed_at: current.score_confirmed_at,
      next_home_score: input.homeScore ?? null,
      next_away_score: input.awayScore ?? null,
      overwrote_confirmed_result: alreadyConfirmed,
      ratings_already_applied: current.rating_applied_at !== null,
      consensus_decision: consensusDecision,
    },
  })

  if (!auditRecorded) {
    return {
      status: "failed",
      stage: "audit",
      message:
        "Karar uygulanmadı: denetim kaydı yazılamadı. Hiçbir şey değişmedi.",
    }
  }

  /* --- 5. The write -------------------------------------------------------- */
  const admin = createAdminClient()
  const patch: TablesUpdate<"matches"> =
    outcome === "finalize"
      ? {
          home_score: input.homeScore ?? null,
          away_score: input.awayScore ?? null,
          status: "finalized",
          score_confirmed_at: new Date().toISOString(),
          requires_consensus: false,
          consensus_deadline: null,
        }
      : {
          status: "cancelled",
          requires_consensus: false,
          consensus_deadline: null,
        }

  const { data: after, error: updateError } = await admin
    .from("matches")
    .update(patch)
    .eq("id", matchId)
    .select("id, status, home_score, away_score, rating_applied_at, is_ranked")
    .maybeSingle()

  if (updateError || !after) {
    console.error("[admin/ruling] update failed", { code: updateError?.code })
    await recordAdminAudit({
      action: "admin.match_resolve_failed",
      actorId,
      entityType: "matches",
      entityId: matchId,
      reason,
      metadata: { stage: "update", code: String(updateError?.code ?? "unknown") },
    })
    return { status: "failed", stage: "update", message: "Karar işlenmedi." }
  }

  /* --- 6. Ratings ---------------------------------------------------------- */
  const ratingsAlreadyApplied = after.rating_applied_at !== null
  let ratingsAppliedNow = 0
  let ratingPassFailed = false

  if (outcome === "finalize" && after.is_ranked && !ratingsAlreadyApplied) {
    const { data: rated, error: ratingError } = await admin.rpc("apply_match_rating", {
      p_match_id: matchId,
    })
    if (ratingError) {
      // The score stands; only the TrueSkill pass failed. Report it rather than showing a clean
      // success — somebody has to re-run it.
      console.error("[admin/ruling] apply_match_rating failed", { code: ratingError.code })
      ratingPassFailed = true
      await recordAdminAudit({
        action: "admin.match_resolve_failed",
        actorId,
        entityType: "matches",
        entityId: matchId,
        reason,
        metadata: { stage: "rating", code: String(ratingError.code ?? "unknown") },
      })
    } else {
      ratingsAppliedNow = typeof rated === "number" ? rated : 0
    }
  }

  return {
    status: "applied",
    matchId,
    outcome: outcome === "finalize" ? "finalized" : "voided",
    homeScore: after.home_score,
    awayScore: after.away_score,
    previousStatus: before.status,
    previousScore,
    overwroteConfirmedResult: alreadyConfirmed,
    consensusDecision,
    ratingsAppliedNow,
    ratingsAlreadyApplied,
    ratingPassFailed,
    message: rulingMessage({
      outcome,
      ratingsAppliedNow,
      ratingsAlreadyApplied,
      ratingPassFailed,
      overwrote: alreadyConfirmed,
    }),
  }
}

function rulingMessage(input: {
  outcome: "finalize" | "void"
  ratingsAppliedNow: number
  ratingsAlreadyApplied: boolean
  ratingPassFailed: boolean
  overwrote: boolean
}): string {
  if (input.outcome === "void") {
    return input.ratingsAlreadyApplied
      ? "Maç iptal edildi. Önceki sonucun puanları zaten işlenmişti ve yerinde duruyor — " +
          "geri almak veritabanı tarafında yeniden hesaplama gerektirir."
      : "Maç iptal edildi. Hiçbir puan işlenmedi."
  }

  const opening = input.overwrote
    ? "Onaylı sonuç değiştirildi ve denetim kaydına yazıldı."
    : "Sonuç kaydedildi."

  if (input.ratingPassFailed) {
    return `${opening} Puanlama adımı başarısız oldu ve yeniden çalıştırılmalı; skorun kendisi kaydedildi.`
  }
  if (input.ratingsAppliedNow > 0) {
    return `${opening} ${input.ratingsAppliedNow} oyuncu puanlandı.`
  }
  if (input.ratingsAlreadyApplied) {
    return (
      `${opening} Bu maçın puanları zaten işlenmişti ve değiştirilmedi: ` +
      "yeni skor kimsenin mu veya sigma değerini oynatmıyor."
    )
  }
  return `${opening} Hiçbir puan işlenmedi — maç derecesiz.`
}
