/**
 * lib/site-url.ts
 *
 * The app's own absolute origin, and the only safe way to build a URL onto it.
 *
 * This lived in `lib/stripe.ts` until the metadata routes needed it. `app/robots.ts`,
 * `app/sitemap.ts` and `app/manifest.ts` all have to name the site's origin, and importing it
 * from the Stripe module would pull the whole Stripe SDK into three static metadata routes that
 * take no payments. `lib/stripe.ts` re-exports both functions, so its callers are unchanged and
 * there is still exactly one definition of what this app's origin is.
 *
 * The rule that matters: the origin comes from configuration, NEVER from the request's `Host`
 * header. Building a Stripe `return_url` or a password-reset link from a header is host-header
 * injection — an attacker sends `Host: evil.example`, the user completes a real flow, and the
 * redirect at the end of it lands them on the attacker's site carrying whatever the flow appends.
 */

/**
 * Absolute origin, no trailing slash. Configuration first, Vercel's own hostname second, and in
 * production nothing else — a missing value is a deploy that cannot build a correct redirect, so
 * it fails loudly rather than emitting `http://localhost:3000` links into a live email.
 */
export function siteOrigin(): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL
  if (configured && configured.trim() !== "") {
    try {
      return new URL(configured).origin
    } catch {
      throw new Error(`NEXT_PUBLIC_SITE_URL is not a valid absolute URL: "${configured}"`)
    }
  }

  const vercel = process.env.VERCEL_URL
  if (vercel && vercel.trim() !== "") return `https://${vercel}`

  if (process.env.NODE_ENV !== "production") return "http://localhost:3000"

  throw new Error("NEXT_PUBLIC_SITE_URL must be set in production for Stripe redirect URLs.")
}

/**
 * Absolute URL for a **same-origin path**. Rejects anything that is not a rooted path, so a
 * caller-supplied `returnPath` can never turn into an open redirect out of a payments flow.
 * (`@/types/domain`'s `onboardingSchema` enforces the same rule at the request boundary; this is
 * the defence in depth behind it.)
 */
export function buildSiteUrl(path: string, params?: Record<string, string | undefined>): string {
  // `//evil.com` and `/\evil.com` are both protocol-relative in a browser and would resolve to a
  // different origin. Reject them before `new URL()` ever sees them.
  if (!path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\")) {
    throw new Error(`Expected a same-origin path beginning with "/", received "${path}"`)
  }
  const origin = siteOrigin()
  const url = new URL(path, origin)
  if (url.origin !== origin) {
    throw new Error("Refusing to build a cross-origin redirect URL.")
  }
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined && value !== "") url.searchParams.set(key, value)
  }
  return url.toString()
}

/**
 * The name every `/api/stripe/connect/*` handler already imports. Kept as an alias rather than
 * renamed at ~20 call sites for no behavioural gain.
 */
export { siteOrigin as resolveSiteOrigin }
