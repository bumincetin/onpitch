/**
 * GET /api/stripe/connect/login-link
 *
 * Mints a single-use link into the **Stripe Express Dashboard** for a connected account.
 *
 * This is the other half of the Express bargain. Because Stripe hosts KYC, Stripe also hosts the
 * account's ongoing self-service: payout schedule and history, bank account changes, tax details,
 * re-verification when a document expires. We do not rebuild any of that, and — critically — we
 * never proxy it. The owner is handed a URL and goes to Stripe; identity documents, bank
 * credentials, and balance detail stay outside our systems, exactly as during onboarding.
 *
 * Properties of a login link that shape this handler:
 *   • It is a **bearer credential** for someone's payout account. It is returned to the
 *     authenticated owner over TLS, never logged, never persisted, never put in a redirect we
 *     record, and never included in the audit metadata below.
 *   • It is short-lived and single-use. Mint one per click; do not cache it, and do not attach an
 *     idempotency key (replaying one would hand back a consumed link).
 *   • Stripe only issues it for an Express account that has actually submitted its details. An
 *     account still mid-KYC gets `VENUE_NOT_PAYABLE` from us with an explanation, rather than a
 *     raw Stripe error.
 *
 * Authorisation: `venue_owner | admin`, and the account id comes from the authenticated user's
 * own profile — or from a venue whose `owner_id` is checked against the session. Nothing about
 * which account to open is taken from the request beyond an ownership-checked venue UUID.
 */

import { z } from "zod"

import { fail, handleRoute, ok } from "@/lib/api-response"
import { requireRole } from "@/lib/rbac"
import { createAdminClient } from "@/lib/supabase/admin"
import { describeStripeError, isResourceMissing, stripe } from "@/lib/stripe"
import type { Tables } from "@halisaha/shared/database"
import { API_ERROR_CODES } from "@halisaha/shared/domain"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const querySchema = z.object({
  venueId: z.string().uuid().optional(),
})

/**
 * What the dashboard button consumes. The URL is the payload; treat it as a secret client-side.
 * Intentionally not exported — a Next.js route module's export surface is validated at build
 * time, so route files keep to handlers and segment config only.
 */
interface StripeLoginLinkResult {
  url: string
  accountId: string
  /** ISO-8601 instant the link was created. Links are valid for a short window after this. */
  createdAt: string
}

export async function GET(request: Request): Promise<Response> {
  return handleRoute<StripeLoginLinkResult>(async () => {
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

    /* --- Resolve the account, ownership-checked ---------------------------- */
    const admin = createAdminClient()
    let venue: Tables<"venues"> | null = null

    if (venueId) {
      const { data, error } = await admin.from("venues").select("*").eq("id", venueId).maybeSingle()
      if (error) {
        console.error("[connect/login-link] venue lookup failed", { code: error.code })
        return fail(API_ERROR_CODES.INTERNAL, "Tesis yüklenemedi.", 500)
      }
      if (!data) return fail(API_ERROR_CODES.NOT_FOUND, "Tesis bulunamadı.", 404)
      if (data.owner_id !== user.id && !isAdmin) {
        return fail(API_ERROR_CODES.FORBIDDEN, "Bu tesisin sahibi değilsin.", 403)
      }
      venue = data
    }

    const accountId = venue?.stripe_account_id ?? profile.stripe_account_id ?? null
    if (!accountId) {
      return fail(
        API_ERROR_CODES.NOT_FOUND,
        "Henüz ödeme hesabı yok. Önce kurulumu tamamla.",
        404,
      )
    }

    /* --- Pre-flight: Stripe refuses a login link before details_submitted --- */
    // Checking ourselves turns an opaque `StripeInvalidRequestError` into an actionable code the
    // dashboard can render as "finish onboarding" instead of "something went wrong".
    try {
      const account = await stripe.accounts.retrieve(accountId)

      if (account.type !== "express") {
        // Login links exist only for Express. A Standard account has its own full dashboard and
        // we must not pretend otherwise.
        console.warn("[connect/login-link] non-express account", {
          accountId,
          type: account.type,
        })
        return fail(
          API_ERROR_CODES.VENUE_NOT_PAYABLE,
          "Bu ödeme hesabı Express panelini kullanmıyor.",
          409,
        )
      }

      if (account.details_submitted !== true) {
        return fail(
          API_ERROR_CODES.VENUE_NOT_PAYABLE,
          "Ödeme panelini açmadan önce kurulumu tamamla.",
          409,
        )
      }
    } catch (error) {
      if (isResourceMissing(error)) {
        console.warn("[connect/login-link] stored account no longer exists", { accountId })
        return fail(
          API_ERROR_CODES.NOT_FOUND,
          "Henüz ödeme hesabı yok. Önce kurulumu tamamla.",
          404,
        )
      }
      console.error("[connect/login-link] account retrieve failed", describeStripeError(error))
      return fail(
        API_ERROR_CODES.STRIPE_ERROR,
        "Ödeme sağlayıcısına ulaşılamadı. Lütfen tekrar dene.",
        502,
      )
    }

    /* --- Mint the link ------------------------------------------------------ */
    try {
      const loginLink = await stripe.accounts.createLoginLink(accountId)

      // Audit the fact, never the credential.
      const { error: auditError } = await admin.from("audit_log").insert({
        actor_id: user.id,
        action: "stripe.connect.login_link_created",
        entity_type: "venue",
        entity_id: venue?.id ?? null,
        metadata: { account_id: accountId, on_behalf_of_owner: isAdmin && venue?.owner_id !== user.id },
      })
      if (auditError) {
        console.warn("[connect/login-link] audit insert failed", { code: auditError.code })
      }

      const payload: StripeLoginLinkResult = {
        url: loginLink.url,
        accountId,
        createdAt: new Date(loginLink.created * 1000).toISOString(),
      }
      return ok(payload)
    } catch (error) {
      console.error("[connect/login-link] login link create failed", describeStripeError(error))
      return fail(
        API_ERROR_CODES.STRIPE_ERROR,
        "Ödeme paneli açılamadı. Lütfen tekrar dene.",
        502,
      )
    }
  })
}
