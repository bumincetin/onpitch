/**
 * GET /api/stripe/connect/status
 *
 * The authoritative read of a venue owner's Connect Express onboarding state, plus the write-back
 * that lets the rest of the product trust the database instead of calling Stripe.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS ROUTE WRITES
 * ---------------------------------------------------------------------------
 * Checkout must not ask Stripe whether a venue can be paid — that is a network round trip on the
 * hot path and a hard dependency on Stripe being up. So `venues.charges_enabled`,
 * `venues.payouts_enabled` and `venues.is_active` are a local mirror of Stripe's verdict, and this
 * route (together with the `account.updated` webhook, which is the push half of the same job)
 * keeps the mirror honest. Reading the status page is therefore also a reconciliation.
 *
 * `venues.is_active` policy, spelled out because it is easy to get wrong:
 *   • On the FIRST time an account reaches `charges_enabled && payouts_enabled`, we stamp
 *     `onboarding_completed_at` and flip `is_active` to true — the venue goes live the moment KYC
 *     clears, with no second click.
 *   • After that, `is_active` belongs to the owner and to admins: it is their publish switch. We
 *     do not keep re-flipping it to true, or a deactivated venue would resurrect on every page
 *     load.
 *   • The one exception is Stripe actively DISABLING the account (`requirements.disabled_reason`
 *     is set — rejected, requirements past due, under review). Then the venue cannot be paid, so
 *     it must not be bookable, and we force `is_active` to false. Failing closed on money is not
 *     negotiable.
 *
 * ---------------------------------------------------------------------------
 * SECURITY
 * ---------------------------------------------------------------------------
 *   • The account id is never accepted from the caller; it is read from the authenticated user's
 *     profile, or from a venue whose ownership is checked explicitly.
 *   • `requirements.*` entries are Stripe's own field identifiers (`individual.id_number`,
 *     `external_account`, …). They name what is missing, never its value, so returning them is
 *     safe — and necessary, since the UI has to tell the owner what to go and do.
 *   • Stripe failures are logged and returned as the stable `STRIPE_ERROR` code.
 *   • The mirror is written with the service-role client: RLS must not let an owner set their own
 *     `charges_enabled`, which would be a trivial path to taking money through an unverified
 *     account.
 */

import { z } from "zod"

import { fail, handleRoute, ok } from "@/lib/api-response"
import { requireRole } from "@/lib/rbac"
import { createAdminClient } from "@/lib/supabase/admin"
import {
  describeStripeError,
  emptyOnboardingState,
  isResourceMissing,
  stripe,
  toOnboardingState,
} from "@/lib/stripe"
import type { Tables } from "@halisaha/shared/database"
import { API_ERROR_CODES, type StripeOnboardingState } from "@halisaha/shared/domain"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const querySchema = z.object({
  venueId: z.string().uuid().optional(),
})

export async function GET(request: Request): Promise<Response> {
  return handleRoute<StripeOnboardingState>(async () => {
    const { user, profile } = await requireRole("venue_owner", "admin")
    const isAdmin = profile.role === "admin"

    const url = new URL(request.url)
    const parsed = querySchema.safeParse({
      venueId: url.searchParams.get("venueId") ?? undefined,
    })
    if (!parsed.success) {
      return fail(API_ERROR_CODES.VALIDATION_FAILED, "Geçersiz tesis referansı.", 422)
    }
    const { venueId } = parsed.data

    /* --- 1. Scope: a specific venue, or the owner's account in general ----- */
    const admin = createAdminClient()
    let venue: Tables<"venues"> | null = null

    if (venueId) {
      const { data, error } = await admin.from("venues").select("*").eq("id", venueId).maybeSingle()
      if (error) {
        console.error("[connect/status] venue lookup failed", { code: error.code })
        return fail(API_ERROR_CODES.INTERNAL, "Tesis yüklenemedi.", 500)
      }
      if (!data) return fail(API_ERROR_CODES.NOT_FOUND, "Tesis bulunamadı.", 404)
      if (data.owner_id !== user.id && !isAdmin) {
        return fail(API_ERROR_CODES.FORBIDDEN, "Bu tesisin sahibi değilsin.", 403)
      }
      venue = data
    }

    const accountId = venue?.stripe_account_id ?? profile.stripe_account_id ?? null

    // Not onboarded at all. A zeroed state is the correct answer, not a 404 — the dashboard
    // renders "start onboarding" from exactly this shape.
    if (!accountId) return ok(emptyOnboardingState())

    /* --- 2. Ask Stripe ----------------------------------------------------- */
    let state: StripeOnboardingState
    try {
      const account = await stripe.accounts.retrieve(accountId)
      state = toOnboardingState(account)
    } catch (error) {
      if (isResourceMissing(error)) {
        // Stored id points at an account that no longer exists (deleted in the dashboard, or a
        // wiped test project). Report "not onboarded" so the UI offers a restart; the onboard
        // route is the only place allowed to replace the stored id.
        console.warn("[connect/status] stored account no longer exists", { accountId })
        return ok(emptyOnboardingState())
      }
      console.error("[connect/status] account retrieve failed", describeStripeError(error))
      return fail(
        API_ERROR_CODES.STRIPE_ERROR,
        "Ödeme hesabının durumu okunamadı. Lütfen tekrar dene.",
        502,
      )
    }

    /* --- 3. Reconcile the local mirror -------------------------------------- */
    // Scope: the named venue, or every venue of this owner already pointing at this account.
    try {
      const scopeQuery = admin.from("venues").select("id")
      const { data: scoped, error: scopeError } = await (venue
        ? scopeQuery.eq("id", venue.id)
        : scopeQuery.eq("stripe_account_id", accountId).eq("owner_id", user.id))
      if (scopeError) throw scopeError

      const targetIds = (scoped ?? []).map((row) => row.id)
      if (targetIds.length > 0) {
        // (a) Always mirror Stripe's capability flags.
        const { error: flagsError } = await admin
          .from("venues")
          .update({
            charges_enabled: state.chargesEnabled,
            payouts_enabled: state.payoutsEnabled,
          })
          .in("id", targetIds)
        if (flagsError) throw flagsError

        // (b) First completion goes live automatically, and only once — the `.is(..., null)`
        //     guard is what stops this from overriding a later manual deactivation.
        if (state.isComplete) {
          const { error: activateError } = await admin
            .from("venues")
            .update({ is_active: true, onboarding_completed_at: new Date().toISOString() })
            .in("id", targetIds)
            .is("onboarding_completed_at", null)
          if (activateError) throw activateError
        }

        // (c) Stripe has disabled the account: fail closed, the venue stops being bookable.
        if (!state.isComplete && state.disabledReason !== null) {
          const { error: deactivateError } = await admin
            .from("venues")
            .update({ is_active: false })
            .in("id", targetIds)
          if (deactivateError) throw deactivateError
        }
      }
    } catch (error) {
      // A mirror that is briefly stale is far better than a 500 on the dashboard. The webhook
      // (`account.updated`) and the next status read both retry this reconciliation.
      const code = (error as { code?: unknown }).code
      console.error("[connect/status] venue reconciliation failed", { code, accountId })
    }

    return ok(state)
  })
}
