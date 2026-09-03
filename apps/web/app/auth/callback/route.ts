/**
 * app/auth/callback/route.ts
 *
 * Where every email-borne auth link lands: signup confirmation, magic link, password recovery,
 * email-change confirmation. It exchanges whatever credential GoTrue put in the URL for a real
 * session cookie, then forwards the browser on.
 *
 * It handles both shapes Supabase emits, because which one you get depends on the email template
 * a project happens to be using:
 *
 *   * `?code=…`                — the PKCE flow (`exchangeCodeForSession`)
 *   * `?token_hash=…&type=…`   — the newer server-side templates (`verifyOtp`)
 *
 * It also closes the Article 8 loop. When a project has email confirmation ON there is no
 * session at the moment of signup, so the browser cannot ask for a guardian consent email —
 * `request_parental_consent` reads `auth.uid()`. This route is the first moment a minor's
 * session exists, so it issues the consent request here, using the guardian details the signup
 * form stashed in `user_metadata`.
 */

import { NextResponse, type NextRequest } from "next/server"

import { createClient } from "@/lib/supabase/server"
import { assessAge, issueGuardianConsent, maskEmail } from "@/lib/gdpr"
import type { Database, Tables } from "@onpitch/shared/database"
import type { SupabaseClient, User } from "@supabase/supabase-js"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Same-origin paths only — see `middleware.ts` for why this matters on an auth endpoint. */
function safeNextPath(candidate: string | null, fallback = "/dashboard"): string {
  if (!candidate || !candidate.startsWith("/")) return fallback
  if (candidate.length > 1 && (candidate[1] === "/" || candidate[1] === "\\")) return fallback
  return candidate
}

/**
 * Builds an absolute redirect target.
 *
 * Behind a load balancer, `request.nextUrl.origin` is the internal host (`localhost:3000` on
 * Vercel), which would send the user to a hostname that does not exist. `x-forwarded-host` is
 * the public one. It is only trusted in production, where the platform sets it; in development
 * anyone could.
 */
function absoluteUrl(request: NextRequest, path: string): string {
  const forwardedHost = request.headers.get("x-forwarded-host")
  const isProduction = process.env.NODE_ENV === "production"

  if (process.env.NEXT_PUBLIC_SITE_URL) {
    return new URL(path, process.env.NEXT_PUBLIC_SITE_URL).toString()
  }
  if (isProduction && forwardedHost) {
    const protocol = request.headers.get("x-forwarded-proto") ?? "https"
    return `${protocol}://${forwardedHost}${path}`
  }
  return new URL(path, request.nextUrl.origin).toString()
}

/**
 * The narrow slice of the client that `public.my_profile()` needs.
 *
 * The RPC is defined in `0002_rls.sql` (5.1a) but is absent from the generated
 * `Database["public"]["Functions"]` map, so the typed `rpc()` overload does not accept its name.
 */
interface MyProfileRpcClient {
  rpc(fn: "my_profile"): PromiseLike<{
    data: unknown
    error: { message: string; code?: string } | null
  }>
}

const OTP_TYPES = ["signup", "invite", "magiclink", "recovery", "email_change", "email"] as const
type OtpType = (typeof OTP_TYPES)[number]

function readOtpType(value: string | null): OtpType | null {
  return value && (OTP_TYPES as readonly string[]).includes(value) ? (value as OtpType) : null
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl
  const next = safeNextPath(searchParams.get("next"))

  // GoTrue can bounce the user straight back with an error (expired link, cancelled consent on a
  // social provider). Never echo `error_description` into the page — map it to a fixed key.
  if (searchParams.get("error")) {
    return NextResponse.redirect(absoluteUrl(request, "/login?error=auth_callback_failed"))
  }

  const supabase = await createClient()

  const code = searchParams.get("code")
  const tokenHash = searchParams.get("token_hash")
  const otpType = readOtpType(searchParams.get("type"))

  let authError: { message: string } | null = null

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    authError = error
  } else if (tokenHash && otpType) {
    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type: otpType })
    authError = error
  } else {
    return NextResponse.redirect(absoluteUrl(request, "/login?error=auth_callback_failed"))
  }

  if (authError) {
    return NextResponse.redirect(absoluteUrl(request, "/login?error=auth_callback_failed"))
  }

  // A recovery link is not a sign-in: send the user to set a new password, not to the app.
  if (otpType === "recovery") {
    return NextResponse.redirect(absoluteUrl(request, "/account/password"))
  }

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (user) {
    await maybeIssueGuardianConsent(supabase, user, request.nextUrl.origin)
  }

  return NextResponse.redirect(absoluteUrl(request, next))
}

/**
 * Fires the guardian consent email for a minor who has just confirmed their address.
 *
 * Idempotent enough in practice: it only acts while `parental_consent_status` is `'pending'`,
 * and `request_parental_consent` itself caps a minor at three live requests. Once the guardian
 * approves, the status flips to `'granted'` and this becomes a no-op. A minor who confirms their
 * email twice therefore gets at most a resend, which is the behaviour a parent would expect
 * anyway.
 *
 * NEVER throws. A mail provider outage must not turn a successful email confirmation into a
 * broken auth callback — the account exists, the consent request can be resent from settings.
 */
async function maybeIssueGuardianConsent(
  supabase: SupabaseClient<Database>,
  user: User,
  origin: string,
): Promise<void> {
  try {
    // Read through `my_profile()`, not a direct select. Of the six columns needed here only
    // `full_name` is inside the column-scoped SELECT grant in 0002_rls.sql (4.1) —
    // date_of_birth, is_minor, parental_consent_status, guardian_email, guardian_name and a
    // `deleted_at` predicate are all outside it, and a projected or WHERE-clause column the
    // caller may not read makes the whole statement a 42501. That refusal used to be
    // indistinguishable from "not a minor", so no guardian consent email was ever sent.
    const { data: profileData, error: profileError } = await (
      supabase as unknown as MyProfileRpcClient
    ).rpc("my_profile")

    if (profileError) {
      // eslint-disable-next-line no-console
      console.error(
        "[auth/callback] my_profile() failed:",
        profileError.code,
        profileError.message,
      )
      return
    }

    // `returns public.profiles`: the row object, or a one-element array on some deployments, or
    // null when the row is missing or soft-deleted.
    const profile = (Array.isArray(profileData) ? profileData[0] : profileData) as
      | Tables<"profiles">
      | null
      | undefined

    if (!profile) return
    if (profile.parental_consent_status !== "pending") return

    const assessment = assessAge(profile.date_of_birth)
    // `is_minor` is a write-time snapshot, so fall back to it only when there is no birth date.
    const minor = assessment.band === "minor" || (assessment.band === "unknown" && profile.is_minor === true)
    if (!minor) return

    const metadata = (user.user_metadata ?? {}) as Record<string, unknown>
    const guardianEmail =
      profile.guardian_email ??
      (typeof metadata["guardian_email"] === "string" ? metadata["guardian_email"] : null)

    if (!guardianEmail) return

    const guardianName =
      profile.guardian_name ??
      (typeof metadata["guardian_name"] === "string" ? metadata["guardian_name"] : null)

    const result = await issueGuardianConsent(supabase, {
      guardianEmail,
      guardianName,
      minorName: profile.full_name,
      origin,
    })

    if (!result.ok) {
      // Safe to log: `reason` and `message` come from our own RPC and carry no token.
      // eslint-disable-next-line no-console
      console.warn(
        `[auth/callback] guardian consent not issued for ${maskEmail(guardianEmail)}: ` +
          `${result.reason} — ${result.message}`,
      )
    }
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(
      "[auth/callback] guardian consent kick-off failed:",
      error instanceof Error ? error.message : error,
    )
  }
}
