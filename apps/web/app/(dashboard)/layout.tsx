/**
 * app/(dashboard)/layout.tsx
 *
 * The signed-in application shell. Everything in the `(dashboard)` route group — the player
 * dashboard and the whole venue-owner SaaS surface alike — renders inside it.
 *
 * `(dashboard)` is a ROUTE GROUP: the parentheses keep it out of the URL, so this wraps `/venue`,
 * `/venue/calendar`, `/dashboard` and friends without adding a path segment. That matters because
 * `middleware.ts` matches on the literal prefixes `/venue` and `/dashboard`, and `lib/stripe.ts`
 * hard-codes `/venue/onboarding/complete` as the Connect return URL.
 *
 * ---------------------------------------------------------------------------
 * WHY `requireRole()` WITH NO ARGUMENTS
 * ---------------------------------------------------------------------------
 * This layer only asserts "somebody is signed in", because it is shared with the player surface.
 * The ROLE gate lives one level down, in `venue/layout.tsx`. Three checks stack up by the time a
 * venue page renders and each does a different job:
 *
 *   middleware  → cheap JWT claim check, so a wrong-role request never reaches a render
 *   requireRole → authoritative: revalidates the token AND reads the profile row
 *   RLS         → the only thing that decides which ROWS exist for this user
 *
 * The middleware alone is not enough (it trusts a claim in a cookie), and `requireRole` alone is
 * not enough (it says nothing about row ownership). Neither can be removed.
 *
 * ---------------------------------------------------------------------------
 * NAVIGATION
 * ---------------------------------------------------------------------------
 * `SiteHeader` and `DashboardNav` are shared components and both take the role as a PROP. This
 * layout has already resolved the session, so passing it down means the nav never fires a second
 * `auth.getUser()` and never flashes the signed-out state on hydration. Rendering fewer links is
 * a courtesy; middleware and RLS are what actually refuse a URL and its rows.
 *
 * The sidebar is hidden below `lg`, where `SiteHeader`'s own mobile menu carries the same
 * destinations — one nav on screen at a time, never two competing ones.
 */

import { DashboardNav } from "@/components/nav/dashboard-nav"
import { SiteHeader } from "@/components/nav/site-header"
import { getSessionUser, requireRole } from "@/lib/rbac"
import type { AppRole } from "@/lib/rbac"

export const dynamic = "force-dynamic"

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  // Redirects to /login?next=… when signed out. Everything below this line has a session.
  await requireRole()

  // Deduped by Next against the `requireRole()` call above: same request, same fetch.
  const session = await getSessionUser()
  const profile = session?.profile
  const role = (profile?.role ?? "player") as AppRole
  const displayName = profile?.display_name ?? profile?.full_name ?? profile?.email ?? null

  return (
    /*
      `night` is the landing page's scope, applied to the whole signed-in shell so the product
      is one design rather than a dark front door onto a light app. It is NOT `dark`: that is
      the user's own theme choice and it still governs every page outside this group.

      No `lang` override here any more. The player surface below is Turkish, like the document,
      and the two segments that are still written in English — `venue/` and `admin/` — declare
      `lang="en"` on their own layouts. Stating it once at this level would have been a lie
      about half the tree (WCAG 3.1.2 Language of Parts).
    */
    <div className="night flex min-h-screen flex-col bg-background text-foreground">
      <SiteHeader role={role} displayName={displayName} />

      <div className="mx-auto flex w-full max-w-7xl flex-1 gap-10 px-4 py-8 sm:px-6">
        <aside className="hidden w-52 shrink-0 lg:block">
          <div className="sticky top-24">
            <DashboardNav role={role} />
          </div>
        </aside>

        <main id="main" className="min-w-0 flex-1">
          {children}
        </main>
      </div>
    </div>
  )
}
