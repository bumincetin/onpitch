/**
 * app/(app)/layout.tsx
 *
 * The signed-in browsing surface: matches, venues, teams, bookings, the player's own profile.
 *
 * `requireRole()` with no arguments means "any authenticated user, whatever their role" — the
 * row-level gate is RLS, and the capability gate is `canAccess()`. This layer only asserts that
 * somebody is signed in, and redirects to `/login?next=…` when they are not.
 *
 * It shares `SiteHeader` and the `night` scope with `(dashboard)` on purpose. Two signed-in
 * shells with two different headers is how an app starts feeling like two apps; there is one
 * chrome, and the only difference between the groups is that the dashboard carries a sidebar.
 *
 * The layout has already resolved the session, so the header takes the role as a prop and never
 * fires a second `auth.getUser()` or flashes the signed-out state on hydration.
 */

import Link from "next/link"

import { SiteHeader } from "@/components/nav/site-header"
import { RouteBanner } from "@/components/three/route-banner"
import { requireRole } from "@/lib/rbac"
import type { AppRole } from "@/lib/rbac"

export const dynamic = "force-dynamic"

const FOOTER_LINKS = [
  { href: "/leagues", label: "Ligler" },
  { href: "/leaderboard", label: "Sıralama" },
  { href: "/privacy", label: "Gizlilik" },
  { href: "/terms", label: "Şartlar" },
] as const

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { profile } = await requireRole()

  const role = (profile.role ?? "player") as AppRole
  const displayName = profile.display_name ?? profile.full_name ?? profile.email ?? null

  return (
    <div className="night flex min-h-screen flex-col bg-background text-foreground">
      <a
        href="#main"
        className="sr-only-focusable sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:ring-2 focus:ring-ring"
      >
        İçeriğe atla
      </a>

      <SiteHeader role={role} displayName={displayName} />

      {/*
        One live pitch per page, framed by the route. It is the layout's job rather than each
        page's because a WebGL context is a scarce resource and one per route is the budget —
        and because a new page then gets the treatment by existing rather than by opting in.
      */}
      <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 pb-10 pt-0 sm:px-6">
        <RouteBanner />
        {children}
      </main>

      <footer className="border-t border-foreground/15">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-4 py-6 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p className="label-eyebrow">
            Halısaha
            <span className="mx-2 text-gold">·</span>
            İki kale, tek saha
          </p>
          <nav aria-label="Alt menü" className="flex flex-wrap gap-5">
            {FOOTER_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="text-sm text-muted-foreground transition-colors hover:text-foreground"
              >
                {link.label}
              </Link>
            ))}
          </nav>
        </div>
      </footer>
    </div>
  )
}
