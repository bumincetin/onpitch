/**
 * app/auth/signout/route.ts
 *
 * POST-only sign-out.
 *
 * GET is deliberately refused. A `GET /auth/signout` can be triggered by any third-party page
 * with an `<img src>` or a prefetch, which is a login-CSRF nuisance: it logs people out of a
 * site they are using from a page they merely visited. Requiring POST means the request has to
 * come from a form or from `fetch`, both of which are same-origin gestures.
 *
 * A `<form method="post" action="/auth/signout">` in a Server Component is enough — no client
 * JavaScript needed anywhere in the app to sign out.
 */

import { NextResponse, type NextRequest } from "next/server"

import { createClient } from "@/lib/supabase/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

function redirectTarget(request: NextRequest, path: string): string {
  if (process.env.NEXT_PUBLIC_SITE_URL) {
    return new URL(path, process.env.NEXT_PUBLIC_SITE_URL).toString()
  }
  const forwardedHost = request.headers.get("x-forwarded-host")
  if (process.env.NODE_ENV === "production" && forwardedHost) {
    const protocol = request.headers.get("x-forwarded-proto") ?? "https"
    return `${protocol}://${forwardedHost}${path}`
  }
  return new URL(path, request.nextUrl.origin).toString()
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (user) {
    // 'global' revokes every refresh token for this user, so a stolen session on another device
    // dies too. Signing out is one of the few moments a user can act on a suspicion, and the
    // cost of the extra round trip is irrelevant here.
    await supabase.auth.signOut({ scope: "global" })
  }

  // 303 so the browser follows with GET. A 307 would replay the POST against the login page.
  const response = NextResponse.redirect(redirectTarget(request, "/login?message=signed_out"), {
    status: 303,
  })
  response.headers.set("Cache-Control", "no-store")
  return response
}

/** Answers a stray GET honestly instead of 404-ing, and says how to do it properly. */
export async function GET() {
  return NextResponse.json(
    {
      ok: false,
      error: {
        code: "METHOD_NOT_ALLOWED",
        message: "Çıkış için POST /auth/signout kullanın. Oturum kapatma CSRF'sini engellemek için GET reddedilir.",
      },
    },
    { status: 405, headers: { Allow: "POST" } },
  )
}
