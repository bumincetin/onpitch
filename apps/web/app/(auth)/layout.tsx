/**
 * app/(auth)/layout.tsx
 *
 * Shell for the unauthenticated surface: sign in, sign up, and the guardian consent page.
 *
 * Deliberately does NOT gate on a session. `middleware.ts` already bounces a signed-in user off
 * `/login` and `/signup`, and `/parental-consent` must stay reachable to a guardian who has no
 * account at all and never will — putting an auth check here would break the one flow in the
 * product where the visitor is explicitly a third party.
 *
 * The pitch behind the form is the same one the landing page opens on, held at the tunnel shot:
 * low, central, walking in. Signing in should feel like arriving at the ground rather than
 * filling in a portal.
 */

import Link from "next/link"

import { PitchBanner } from "@/components/three/pitch-banner"

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="night relative flex min-h-screen flex-col bg-background text-foreground">
      {/* Fixed, so the form scrolls over a still frame rather than dragging the picture with it. */}
      <PitchBanner shot="tunnel" className="fixed inset-0 overflow-hidden" />

      <header className="relative z-10 border-b border-foreground/15">
        <div className="mx-auto flex h-16 w-full max-w-6xl items-center gap-2.5 px-6">
          <Link href="/" className="flex items-baseline gap-2.5">
            <span className="text-base font-medium uppercase tracking-[0.18em]">OnPitch</span>
            <span aria-hidden="true" className="hidden text-gold sm:inline">
              ·
            </span>
            <span className="label-eyebrow hidden sm:inline">İstanbul</span>
          </Link>
        </div>
      </header>

      <main className="relative z-10 flex flex-1 items-start justify-center px-4 py-10 sm:items-center sm:py-16">
        <div className="w-full max-w-md border border-foreground/15 bg-background/85 p-6 sm:p-8">
          {children}
        </div>
      </main>

      <footer className="relative z-10 border-t border-foreground/15">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 px-6 py-6 sm:flex-row sm:items-center sm:justify-between">
          <p className="label-eyebrow">Amatör futbol, düzene girmiş hâli</p>
          <nav aria-label="Alt menü" className="flex gap-5">
            <Link
              href="/privacy"
              className="text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              Gizlilik
            </Link>
            <Link
              href="/terms"
              className="text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              Şartlar
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  )
}
