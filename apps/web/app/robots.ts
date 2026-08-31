import type { MetadataRoute } from "next"

import { siteOrigin } from "@/lib/site-url"

/**
 * app/robots.ts
 *
 * The disallow list is not SEO tuning — it is the second half of an access-control decision.
 *
 * Every path below is already behind `requireRole()` or an RLS policy, so a crawler that fetched
 * one would get a redirect to the login page rather than any data. What the list actually
 * prevents is those login redirects being crawled, indexed, and then surfaced in search results
 * as bare URLs that look like a user's private page — `/bookings/<uuid>` in a search snippet
 * leaks that the booking exists even when its contents never do.
 *
 * `/api/` is listed for the same reason plus one more: a crawler hitting `POST`-only handlers
 * with `GET` generates a steady trickle of 405s that make real errors harder to see in the logs.
 *
 * A non-production deployment (a preview build, a staging domain) disallows everything. A
 * preview URL that gets indexed competes with the real site for its own keywords and is
 * miserable to get removed afterwards.
 */
export default function robots(): MetadataRoute.Robots {
  const isProduction = process.env.NODE_ENV === "production" && process.env.VERCEL_ENV !== "preview"

  if (!isProduction) {
    return {
      rules: [{ userAgent: "*", disallow: "/" }],
    }
  }

  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: [
          "/api/",
          "/auth/", // callback and signout, both of which act on a session
          "/account/",
          "/bookings/",
          "/checkout/",
          "/notifications/",
          "/dashboard",
          "/venue/", // the owner console; `/venues/` (plural) is the public directory
          "/admin/",
        ],
      },
    ],
    sitemap: `${siteOrigin()}/sitemap.xml`,
    host: siteOrigin(),
  }
}
