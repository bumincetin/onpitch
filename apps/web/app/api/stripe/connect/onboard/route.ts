/**
 * POST /api/stripe/connect/onboard
 *
 * Starts — or resumes — Stripe Connect **Express** onboarding for a venue owner and returns a
 * single-use hosted KYC link.
 *
 * ---------------------------------------------------------------------------
 * WHY EXPRESS, AND WHO CARRIES WHAT
 * ---------------------------------------------------------------------------
 * Express means Stripe hosts the whole know-your-customer flow. We create an account *shell*
 * (country, email, business type, the two capabilities we need) and then hand the owner an
 * Account Link. Everything sensitive — legal name, date of birth, national identifier, identity
 * documents, bank account — is collected on `connect.stripe.com`, verified by Stripe, and never
 * transits or rests on our infrastructure. Practical consequences:
 *
 *   • Identity documents are outside our breach blast radius and outside our GDPR Art. 9 / Art. 32
 *     obligations for that data class. We hold an opaque `acct_…` id and a set of booleans.
 *   • AML and sanctions screening is Stripe's programme, not a model we own and must defend.
 *   • Card data likewise never touches this origin, keeping us in PCI SAQ-A rather than SAQ-D.
 *
 * What the PLATFORM still owns, because bookings are **destination charges**
 * (`transfer_data.destination` + `application_fee_amount` on a charge created on OUR account):
 *
 *   • We are the merchant of record. Disputes land on the platform balance and the platform pays
 *     the dispute fee; clawing it back from the venue takes an explicit transfer reversal.
 *   • Refunds come out of the platform balance. Refunding a customer without reversing the
 *     transfer means the venue keeps the money and we absorb the difference — a deliberate policy
 *     choice made per refund, never a default.
 *   • We sold the booking, so service failures (double-booked pitch, closed venue) are ours in
 *     consumer law regardless of who processed the payment.
 *   • Account Links are bearer credentials for completing someone's KYC. Single-use, short-lived,
 *     never logged, never persisted, never emailed from here.
 *
 * ---------------------------------------------------------------------------
 * SECURITY NOTES SPECIFIC TO THIS HANDLER
 * ---------------------------------------------------------------------------
 *   • The connected-account id is NEVER read from the request. It comes from the authenticated
 *     user's own `profiles` row (or the venue they demonstrably own). Accepting `accountId` from
 *     a body would let any venue owner mint onboarding links against someone else's account.
 *   • `stripe_account_id` is written with the SERVICE-ROLE client, and RLS must not grant the
 *     user write access to that column. It is a server-assigned fact about a KYC subject, not
 *     user-editable profile data.
 *   • Both writes are compare-and-set (`.is("stripe_account_id", null)`), so two racing requests
 *     cannot overwrite an id that is already routing money.
 *   • `return_url` / `refresh_url` are built from `NEXT_PUBLIC_SITE_URL`, never from the request
 *     `Host` header, and any caller-supplied path must match `^/[^/\\]` — an open redirect out of
 *     a payments flow is a phishing primitive.
 *   • Stripe error text is logged, never returned; the client sees the stable `STRIPE_ERROR` code.
 */

import type Stripe from "stripe"

import { fail, handleRoute, ok } from "@/lib/api-response"
import { requireRole } from "@/lib/rbac"
import { createAdminClient } from "@/lib/supabase/admin"
import {
  CONNECT_REFRESH_PATH,
  CONNECT_RETURN_PATH,
  HALISAHA_MCC,
  buildSiteUrl,
  connectAccountIdempotencyKey,
  describeStripeError,
  isPubliclyReachableOrigin,
  isResourceMissing,
  isStripeError,
  resolveSiteOrigin,
  stripe,
} from "@/lib/stripe"
import type { Tables } from "@halisaha/shared/database"
import { API_ERROR_CODES, onboardingSchema, type StripeOnboardingLink } from "@halisaha/shared/domain"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Venue = Tables<"venues">

export async function POST(request: Request): Promise<Response> {
  return handleRoute<StripeOnboardingLink>(async () => {
    /* --- 1. Authenticate and authorise before touching anything ----------- */
    const { user, profile } = await requireRole("venue_owner", "admin")
    const isAdmin = profile.role === "admin"

    /* --- 2. Parse the body. An empty body is valid: the schema defaults. --- */
    const rawBody: unknown = await request
      .json()
      .catch(() => ({}))
    const parsed = onboardingSchema.safeParse(rawBody ?? {})
    if (!parsed.success) {
      return fail(
        API_ERROR_CODES.VALIDATION_FAILED,
        "Kurulum isteği geçersizdi.",
        422,
        { issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
      )
    }
    const input = parsed.data

    /* --- 3. Resolve the venue this onboarding is for ----------------------- */
    // Reads go through the service-role client and the ownership check is written out explicitly
    // below, so this handler is correct independently of which RLS policies happen to be live.
    const admin = createAdminClient()
    let venue: Venue | null = null

    if (input.venueId) {
      const { data, error } = await admin
        .from("venues")
        .select("*")
        .eq("id", input.venueId)
        .maybeSingle()

      if (error) {
        console.error("[connect/onboard] venue lookup failed", { code: error.code })
        return fail(API_ERROR_CODES.INTERNAL, "Tesis yüklenemedi.", 500)
      }
      if (!data) {
        return fail(API_ERROR_CODES.NOT_FOUND, "Tesis bulunamadı.", 404)
      }
      if (data.owner_id !== user.id && !isAdmin) {
        // Same message and status as "not found" would also be defensible; FORBIDDEN is clearer
        // here because the caller already knows the venue exists (they typed its id).
        return fail(API_ERROR_CODES.FORBIDDEN, "Bu tesisin sahibi değilsin.", 403)
      }
      venue = data
    } else {
      // No venue named: onboard against the owner's first venue, if they have one. Onboarding
      // with no venue at all is legitimate — the owner can create the account first and attach
      // venues afterwards.
      const { data, error } = await admin
        .from("venues")
        .select("*")
        .eq("owner_id", user.id)
        .order("created_at", { ascending: true })
        .limit(1)

      if (error) {
        console.error("[connect/onboard] venue lookup failed", { code: error.code })
        return fail(API_ERROR_CODES.INTERNAL, "Tesislerin yüklenemedi.", 500)
      }
      venue = data?.[0] ?? null
    }

    /* --- 4. Find the existing connected account, or create one ------------- */
    // Rule: one connected account per owner. The profile holds the canonical id; a venue may
    // carry its own only if it was already onboarded separately, and we never overwrite a
    // non-null id, because money may already be routing to it.
    let accountId: string | null = venue?.stripe_account_id ?? profile.stripe_account_id ?? null
    let account: Stripe.Account | null = null

    if (accountId) {
      try {
        account = await stripe.accounts.retrieve(accountId)
      } catch (error) {
        if (isResourceMissing(error)) {
          // The account was deleted in the Stripe dashboard, or this is a stale id from a wiped
          // test-mode project. Recoverable: fall through and mint a fresh one.
          console.warn("[connect/onboard] stored account no longer exists", { accountId })
          accountId = null
        } else {
          console.error("[connect/onboard] account retrieve failed", describeStripeError(error))
          return fail(
            API_ERROR_CODES.STRIPE_ERROR,
            "Ödeme sağlayıcısına ulaşılamadı. Lütfen tekrar dene.",
            502,
          )
        }
      }
    }

    if (!account) {
      const origin = resolveSiteOrigin()
      const email = input.email ?? venue?.contact_email ?? profile.email ?? user.email ?? undefined
      // The venue's registered country wins over the request: it is the jurisdiction the business
      // actually operates in, and a connected account's country is immutable after creation.
      const country = (venue?.country ?? input.country).toUpperCase()

      const params: Stripe.AccountCreateParams = {
        type: "express",
        country,
        business_type: input.businessType,
        capabilities: {
          // `card_payments` lets the destination account be settled for card charges;
          // `transfers` lets us move the venue's share to it. Both are requested up front so
          // Stripe collects every requirement in one KYC pass instead of two.
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        business_profile: {
          name: venue?.name ?? profile.display_name ?? profile.full_name ?? undefined,
          mcc: HALISAHA_MCC,
          // Stripe rejects business_profile.url values it cannot reach, and every localhost or
          // preview origin is unreachable, so send it only when it is plausibly public.
          ...(isPubliclyReachableOrigin(origin)
            ? { url: venue ? `${origin}/venues/${venue.slug}` : origin }
            : {}),
        },
        metadata: {
          supabase_user_id: user.id,
          venue_id: venue?.id ?? "",
          platform: "halisaha",
        },
      }
      if (email) params.email = email

      try {
        account = await stripe.accounts.create(params, {
          // Derived from the authenticated user id (scoped by venue so a second venue's params
          // cannot collide with a key created for the first). Two concurrent submissions from one
          // double-clicked button replay a single POST /v1/accounts, so an owner can never end up
          // with two connected accounts and two half-finished KYC files.
          idempotencyKey: connectAccountIdempotencyKey(user.id, venue?.id ?? "no-venue"),
        })
      } catch (error) {
        if (isStripeError(error) && error.type === "StripeIdempotencyError") {
          // Same key, different parameters — an earlier attempt used a different email or country.
          // Safe to ask for a retry: the key expires after 24h and any account the first attempt
          // did create is already persisted below.
          console.warn("[connect/onboard] idempotency conflict", describeStripeError(error))
          return fail(
            API_ERROR_CODES.STRIPE_ERROR,
            "Devam eden bir kurulum denemesi var. Sayfayı yenileyip tekrar dene.",
            409,
          )
        }
        console.error("[connect/onboard] account create failed", describeStripeError(error))
        return fail(
          API_ERROR_CODES.STRIPE_ERROR,
          "Ödeme sağlayıcısıyla kurulum başlatılamadı. Lütfen tekrar dene.",
          502,
        )
      }
      accountId = account.id
    }

    // From here on `account` is guaranteed non-null on every path, so this is the id of record.
    const connectedAccountId: string = account.id

    /* --- 5. Persist the account id server-side ----------------------------- */
    // Compare-and-set: only ever write over NULL. If the row already carries an id, a concurrent
    // request won the race and we keep theirs rather than repointing an account that may already
    // be receiving transfers.
    if (!profile.stripe_account_id) {
      const { error } = await admin
        .from("profiles")
        .update({ stripe_account_id: connectedAccountId })
        .eq("id", user.id)
        .is("stripe_account_id", null)

      if (error) {
        // Failing here is the safe outcome: the idempotency key means a retry reuses the very
        // same Stripe account rather than orphaning one. Handing out a link for an account we
        // failed to record would be the unsafe outcome.
        console.error("[connect/onboard] could not persist profile account id", {
          code: error.code,
        })
        return fail(
          API_ERROR_CODES.INTERNAL,
          "Ödeme hesabın kaydedilemedi. Lütfen tekrar dene.",
          500,
        )
      }
    }

    if (venue && !venue.stripe_account_id) {
      const { error } = await admin
        .from("venues")
        .update({ stripe_account_id: connectedAccountId })
        .eq("id", venue.id)
        .is("stripe_account_id", null)

      if (error) {
        console.error("[connect/onboard] could not persist venue account id", { code: error.code })
        return fail(
          API_ERROR_CODES.INTERNAL,
          "Tesisin ödeme hesabına bağlanamadı. Lütfen tekrar dene.",
          500,
        )
      }
    }

    /* --- 6. Mint the single-use Account Link ------------------------------- */
    // Deliberately NOT idempotency-keyed: Account Links are single-use and expire in minutes, so
    // replaying a key would hand the owner a consumed or dead link.
    const linkParams: Stripe.AccountLinkCreateParams = {
      account: connectedAccountId,
      refresh_url: buildSiteUrl(input.refreshPath ?? CONNECT_REFRESH_PATH, { venueId: venue?.id }),
      return_url: buildSiteUrl(input.returnPath ?? CONNECT_RETURN_PATH, { venueId: venue?.id }),
      type: "account_onboarding",
      // `currently_due` asks only for what blocks the account today. `eventually_due` front-loads
      // the horizon too; it is a longer first session and measurably worse for completion rates.
      collection_options: { fields: "currently_due" },
    }

    let link: Stripe.AccountLink
    try {
      link = await stripe.accountLinks.create(linkParams)
    } catch (error) {
      console.error("[connect/onboard] account link create failed", describeStripeError(error))
      return fail(
        API_ERROR_CODES.STRIPE_ERROR,
        "Kurulum formu açılamadı. Lütfen tekrar dene.",
        502,
      )
    }

    /* --- 7. Audit. Best-effort: never fail the flow on a logging problem. -- */
    // Awaited rather than fire-and-forget: a serverless invocation can be frozen the instant the
    // response is returned, which silently drops a dangling promise.
    try {
      const { error } = await admin.from("audit_log").insert({
        actor_id: user.id,
        action: "stripe.connect.onboarding_link_created",
        entity_type: "venue",
        entity_id: venue?.id ?? null,
        // The link URL itself is a bearer credential and is deliberately absent from the metadata.
        metadata: {
          account_id: connectedAccountId,
          reused_existing_account: Boolean(profile.stripe_account_id ?? venue?.stripe_account_id),
          business_type: input.businessType,
        },
      })
      if (error) console.warn("[connect/onboard] audit insert failed", { code: error.code })
    } catch (error) {
      console.warn("[connect/onboard] audit insert threw", describeStripeError(error))
    }

    const payload: StripeOnboardingLink = {
      url: link.url,
      accountId: connectedAccountId,
      expiresAt: new Date(link.expires_at * 1000).toISOString(),
    }
    return ok(payload)
  })
}
