import type { MetadataRoute } from "next"
import { createClient } from "@supabase/supabase-js"

import type { Database } from "@halisaha/shared/database"

import { siteOrigin } from "@/lib/site-url"

/**
 * app/sitemap.ts
 *
 * Only two kinds of URL belong in here: the handful of static pages, and one entry per **active,
 * publicly listed** venue. Everything else in the app is behind a session.
 *
 * The venue query runs through the plain ANON client on purpose — no cookies, no service role.
 * That is not a shortcut; it is the check. `venues_select_active_anon` in 0002_rls.sql is the
 * policy that decides what a logged-out visitor may see, so a venue that reaches this list is
 * one a crawler could have fetched anyway. Building the sitemap with the service-role key would
 * bypass RLS and could publish the URL of a venue that is deliberately unlisted — a sitemap is
 * the one file whose whole purpose is to be read by strangers.
 *
 * `revalidate` keeps this off the per-request path. A new venue appears within the hour, which
 * is far faster than any crawler revisits.
 */
export const revalidate = 3600

const STATIC_PATHS: Array<{ path: string; priority: number; changeFrequency: MetadataRoute.Sitemap[number]["changeFrequency"] }> = [
  { path: "/", priority: 1, changeFrequency: "weekly" },
  { path: "/venues", priority: 0.9, changeFrequency: "daily" },
  { path: "/matches", priority: 0.7, changeFrequency: "daily" },
  { path: "/teams", priority: 0.6, changeFrequency: "weekly" },
  { path: "/login", priority: 0.3, changeFrequency: "yearly" },
  { path: "/signup", priority: 0.4, changeFrequency: "yearly" },
  { path: "/privacy", priority: 0.2, changeFrequency: "yearly" },
  { path: "/terms", priority: 0.2, changeFrequency: "yearly" },
]

async function activeVenues(): Promise<Array<{ slug: string; updated_at: string | null }>> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  // A build without Supabase configured still needs to produce a valid sitemap of static pages
  // rather than failing the build over a directory listing.
  if (!url || !key) return []

  try {
    const supabase = createClient<Database>(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const { data, error } = await supabase
      .from("venues")
      .select("slug, updated_at")
      .eq("is_active", true)
      .order("updated_at", { ascending: false })
      // A sitemap file may hold 50,000 URLs; this cap is about response size and the fact that
      // a directory this size would need splitting into an index anyway.
      .limit(5000)

    if (error) {
      console.error("[sitemap] venue listing failed", { code: error.code })
      return []
    }
    return data ?? []
  } catch (error) {
    // Never fail a build or a request over the sitemap. A short sitemap is a minor SEO loss; a
    // 500 on /sitemap.xml tells a crawler the site is broken.
    console.error("[sitemap] venue listing threw", error)
    return []
  }
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const origin = siteOrigin()
  const now = new Date()

  const staticEntries: MetadataRoute.Sitemap = STATIC_PATHS.map((entry) => ({
    url: `${origin}${entry.path}`,
    lastModified: now,
    changeFrequency: entry.changeFrequency,
    priority: entry.priority,
  }))

  const venueEntries: MetadataRoute.Sitemap = (await activeVenues()).map((venue) => ({
    url: `${origin}/venues/${venue.slug}`,
    lastModified: venue.updated_at ? new Date(venue.updated_at) : now,
    changeFrequency: "weekly",
    priority: 0.8,
  }))

  return [...staticEntries, ...venueEntries]
}
