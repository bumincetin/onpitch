/**
 * GET /api/stripe/connect/refresh
 *
 * The `refresh_url` we hand Stripe when we create an onboarding Account Link.
 *
 * Account Links are **single-use and short-lived** — a few minutes. That is a deliberate design
 * choice by Stripe, not an inconvenience: the link is a bearer credential that lets whoever holds
 * it complete KYC for a connected account, so it must not survive being pasted into a chat, left
 * open in a tab overnight, or replayed from browser history. When one expires (or the owner
 * reloads a stale page, or backs out of the flow), Stripe bounces the browser here, and this
 * handler mints a fresh one and `302`s straight into it. The owner sees a momentary redirect
 * rather than an error.
 *
 * Because the browser arrives from Stripe, the response is a redirect rather than JSON:
 *   • success            -> 302 to the new Account Link
 *   • no connected account, or Stripe refuses -> 302 to `/venue/onboarding` with an `error` code
 *     the page can render, so the owner lands somewhere actionable instead of on raw JSON.
 * Genuinely unexpected exceptions still fall through to `handleRoute()` and become an
 * `ApiResponse` 500.
 *
 * Security:
 *   • `requireRole('venue_owner','admin')` first — the session, not the URL, decides whose
 *     account is being onboarded.
 *   • The account id is read from the authenticated user's profile (or a venue they own). The
 *     only accepted query parameter is a venue UUID, and it is ownership-checked.
 *   • This route NEVER creates a connected account. If there is nothing to refresh, that is a
 *     signal to restart onboarding, not to silently open a second KYC file.
 *   • The minted URL is put in a `Location` header and nowhere else — never logged, never stored.
 */

import type Stripe from "stripe"
import { z } from "zod"

import { fail, handleRoute } from "@/lib/api-response"
import { requireRole } from "@/lib/rbac"
import { createAdminClient } from "@/lib/supabase/admin"
import {
  CONNECT_ONBOARDING_PATH,
  CONNECT_REFRESH_PATH,
  CONNECT_RETURN_PATH,
  buildSiteUrl,
  describeStripeError,
  stripe,
} from "@/lib/stripe"
import type { Tables } from "@onpitch/shared/database"
import { API_ERROR_CODES } from "@onpitch/shared/domain"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const querySchema = z.object({
  venueId: z.string().uuid().optional(),
})

/** 302 with caching explicitly off — a cached redirect to a consumed link is a dead end. */
function redirectTo(url: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: url,
      "Cache-Control": "no-store, no-cache, must-revalidate",
      Vary: "Cookie",
    },
  })
}

export async function GET(request: Request): Promise<Response> {
  return handleRoute(async () => {
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

    /* --- Resolve the venue (if any) and the account to refresh ------------- */
    const admin = createAdminClient()
    let venue: Tables<"venues"> | null = null

    if (venueId) {
      const { data, error } = await admin.from("venues").select("*").eq("id", venueId).maybeSingle()
      if (error) {
        console.error("[connect/refresh] venue lookup failed", { code: error.code })
        return redirectTo(buildSiteUrl(CONNECT_ONBOARDING_PATH, { error: "lookup_failed" }))
      }
      if (!data || (data.owner_id !== user.id && !isAdmin)) {
        // Do not distinguish "missing" from "not yours" on a redirect surface.
        return redirectTo(buildSiteUrl(CONNECT_ONBOARDING_PATH, { error: "venue_not_found" }))
      }
      venue = data
    }

    const accountId = venue?.stripe_account_id ?? profile.stripe_account_id ?? null
    if (!accountId) {
      // Nothing to refresh. Send them back to start onboarding properly (which is the only place
      // an account is created), rather than creating one from a redirect Stripe triggered.
      return redirectTo(buildSiteUrl(CONNECT_ONBOARDING_PATH, { error: "no_connected_account" }))
    }

    /* --- Mint a brand-new link every time --------------------------------- */
    // No idempotency key: replaying one here would return the very link that just expired.
    const params: Stripe.AccountLinkCreateParams = {
      account: accountId,
      refresh_url: buildSiteUrl(CONNECT_REFRESH_PATH, { venueId: venue?.id }),
      return_url: buildSiteUrl(CONNECT_RETURN_PATH, { venueId: venue?.id }),
      type: "account_onboarding",
      collection_options: { fields: "currently_due" },
    }

    try {
      const link = await stripe.accountLinks.create(params)
      return redirectTo(link.url)
    } catch (error) {
      // Never echo Stripe's text into a page the owner sees; log it, redirect with a stable code.
      console.error("[connect/refresh] account link create failed", describeStripeError(error))
      return redirectTo(buildSiteUrl(CONNECT_ONBOARDING_PATH, { error: "stripe_link_failed" }))
    }
  })
}
