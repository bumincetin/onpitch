/**
 * app/(dashboard)/admin/layout.tsx
 *
 * The back-office shell. Everything under `/admin` renders inside it.
 *
 * ---------------------------------------------------------------------------
 * THE ROLE GATE
 * ---------------------------------------------------------------------------
 * `requireRole('admin')` sits here rather than being repeated in every page, so there is one
 * place to audit and no way to add a page under `/admin` that forgets it.
 *
 * It is not the same check the middleware already made, and neither replaces the other:
 *
 *   middleware  → reads the `user_role` JWT claim. Cheap, zero database round trips, and up to
 *                 a token lifetime stale. It REDIRECTS, which is a routing decision.
 *   requireRole → revalidates the token against the Auth server and reads the profile row, so a
 *                 role changed a minute ago is honoured immediately. It THROWS, which is an
 *                 authorisation decision.
 *   RLS         → decides which rows exist. It is the only one of the three that a bug in the
 *                 other two cannot bypass.
 *
 * The route handlers under `app/api/admin/**` repeat `requireRole('admin')` for a further
 * reason: the middleware matcher tests the literal prefix `/admin`, which `/api/admin/...` does
 * not match, and a layout gates a render rather than a fetch.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS LAYOUT CARRIES ITS OWN NAV
 * ---------------------------------------------------------------------------
 * `components/nav/dashboard-nav.tsx` is shared with the player and venue surfaces and lists no
 * `/admin/*` destination, so without a section nav here the back office would be reachable only
 * by typing URLs. The active tab is resolved from the pathname the middleware stamps on every
 * request, which keeps the whole shell in the server graph — a client component calling
 * `usePathname()` would ship JavaScript to compute a `className`.
 */

import { headers } from "next/headers"
import Link from "next/link"

import { requireRole } from "@/lib/rbac"
import { PATHNAME_HEADER } from "@/lib/supabase/middleware"
import { cn } from "@/lib/utils"

export const dynamic = "force-dynamic"

const SECTIONS: ReadonlyArray<{ href: string; label: string; exact?: boolean }> = [
  { href: "/admin", label: "Genel bakış", exact: true },
  { href: "/admin/disputes", label: "İtirazlar" },
  { href: "/admin/anomalies", label: "Anomaliler" },
  { href: "/admin/venues", label: "İşletmeler" },
  { href: "/admin/users", label: "Kullanıcılar" },
]

function isActive(pathname: string, href: string, exact?: boolean): boolean {
  if (exact) return pathname === href
  return pathname === href || pathname.startsWith(`${href}/`)
}

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const { profile } = await requireRole("admin")

  const stamped = (await headers()).get(PATHNAME_HEADER) ?? "/admin"
  const queryIndex = stamped.indexOf("?")
  const pathname = queryIndex === -1 ? stamped : stamped.slice(0, queryIndex)

  const operator = profile.display_name ?? profile.full_name ?? profile.email ?? "admin"

  return (
    /*
      The pages in this segment are written in English while the document is `lang="tr"`.
      Declaring the switch on the segment root is what lets a screen reader change voice
      instead of reading English with Turkish phonetics (WCAG 3.1.2 Language of Parts).
      The player surface one level up is Turkish and carries no override.
    */
    <div lang="en" className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Platform yönetimi</h1>
        <p className="text-sm text-muted-foreground">
          Giriş yapan: {operator}. Buradaki her karar ve rol değişikliği, hesabına yazılarak
          audit log with your account against it.
        </p>
      </div>

      <nav aria-label="Yönetim bölümleri" className="border-b border-border">
        <ul className="-mb-px flex flex-wrap gap-1">
          {SECTIONS.map((section) => {
            const active = isActive(pathname, section.href, section.exact)
            return (
              <li key={section.href}>
                <Link
                  href={section.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "inline-flex items-center border-b-2 px-3 py-2 text-sm font-medium transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                    active
                      ? "border-primary text-foreground"
                      : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
                  )}
                >
                  {section.label}
                </Link>
              </li>
            )
          })}
        </ul>
      </nav>

      {children}
    </div>
  )
}
