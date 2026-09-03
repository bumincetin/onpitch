"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { Menu, X } from "lucide-react"

import { MessagesBadge } from "@/components/messaging/messages-badge"
import { Avatar } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { AppRole } from "@/lib/rbac"

/**
 * Global site header.
 *
 * Presentational and role-aware, but it does NOT fetch: the role, the avatar and the unread
 * count are passed down from a Server Component that already has the session, so the header
 * never triggers a second auth round trip and never flashes the signed-out state on hydration.
 *
 * The active link is underlined in the PERSON's accent (`border-user`), not the brand's gold:
 * the shell is theirs once they are signed in, and the colour they picked is how it says so.
 *
 * Hiding a link the user's role cannot use is a courtesy, not a control. Every destination is
 * independently gated by middleware and, row by row, by RLS.
 */

export interface SiteHeaderProps {
  /** Null when nobody is signed in. */
  role?: AppRole | null
  /** Shown in the account button; falls back to the email local part upstream. */
  displayName?: string | null
  /** For the avatar in the corner. */
  userId?: string | null
  avatarUrl?: string | null
  /** Threads with something unread, server-counted for first paint. */
  unreadMessages?: number
  className?: string
}

interface NavLink {
  href: string
  label: string
}

const PUBLIC_LINKS: readonly NavLink[] = [{ href: "/#nasil-calisir", label: "Nasıl çalışır" }]

const LINKS_BY_ROLE: Record<AppRole, readonly NavLink[]> = {
  player: [
    { href: "/dashboard", label: "Panelim" },
    { href: "/matches", label: "Maçlar" },
    { href: "/leagues", label: "Ligler" },
    { href: "/leaderboard", label: "Sıralama" },
  ],
  venue_owner: [
    { href: "/venue", label: "İşletme paneli" },
    { href: "/venue/calendar", label: "Takvim" },
    { href: "/venue/bookings", label: "Rezervasyonlar" },
    { href: "/venue/payouts", label: "Ödemeler" },
  ],
  admin: [
    { href: "/dashboard", label: "Panel" },
    { href: "/matches", label: "Maçlar" },
    { href: "/leaderboard", label: "Sıralama" },
  ],
}

function isActive(pathname: string, href: string): boolean {
  if (href.includes("#")) return false
  if (href === "/") return pathname === "/"
  return pathname === href || pathname.startsWith(`${href}/`)
}

export function SiteHeader({
  role = null,
  displayName,
  userId = null,
  avatarUrl = null,
  unreadMessages = 0,
  className,
}: SiteHeaderProps) {
  const pathname = usePathname()
  const [menuOpen, setMenuOpen] = React.useState(false)

  const links = role ? LINKS_BY_ROLE[role] : PUBLIC_LINKS

  // Any navigation closes the mobile sheet; without this it stays open over the new page.
  React.useEffect(() => {
    setMenuOpen(false)
  }, [pathname])

  return (
    <header className={cn("sticky top-0 z-40 w-full border-b bg-background/95 backdrop-blur", className)}>
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center gap-4 px-6">
        <Link href="/" className="flex shrink-0 items-baseline gap-2.5">
          <span className="text-base font-medium uppercase tracking-[0.18em]">OnPitch</span>
          <span aria-hidden="true" className="hidden text-user sm:inline">·</span>
          <span className="label-eyebrow hidden sm:inline">İstanbul</span>
        </Link>

        <nav aria-label="Ana menü" className="ml-10 hidden items-center gap-1 md:flex">
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              aria-current={isActive(pathname, link.href) ? "page" : undefined}
              className={cn(
                "border-b-2 px-3 py-2 font-mono text-[0.6875rem] font-medium uppercase tracking-[0.12em] transition-colors",
                isActive(pathname, link.href)
                  ? "border-user text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="ml-auto hidden items-center gap-1 md:flex">
          {role && userId ? (
            <>
              <MessagesBadge userId={userId} initialUnread={unreadMessages} />
              <Link
                href="/account"
                className="ml-1 flex items-center gap-2.5 rounded-md py-1 pl-1 pr-3 transition-colors hover:bg-accent"
                aria-label="Hesabım"
              >
                <Avatar name={displayName} src={avatarUrl} size="sm" />
                <span className="max-w-[10rem] truncate text-sm text-muted-foreground">{displayName ?? "Hesabım"}</span>
              </Link>
              {/* A real form POST, not fetch: sign-out must clear the auth cookies through a
                  route handler, and a form keeps working if JavaScript never loads. */}
              <form action="/auth/signout" method="post">
                <Button variant="ghost" size="sm" type="submit">
                  Çıkış
                </Button>
              </form>
            </>
          ) : (
            <>
              <Button variant="ghost" size="sm" asChild>
                <Link href="/login">Giriş yap</Link>
              </Button>
              <Button size="sm" asChild>
                <Link href="/signup">Üye ol</Link>
              </Button>
            </>
          )}
        </div>

        <div className="ml-auto flex items-center gap-1 md:hidden">
          {role && userId ? <MessagesBadge userId={userId} initialUnread={unreadMessages} /> : null}
          <Button
            variant="ghost"
            size="icon"
            aria-expanded={menuOpen}
            aria-controls="site-header-mobile-nav"
            aria-label={menuOpen ? "Menüyü kapat" : "Menüyü aç"}
            onClick={() => setMenuOpen((open) => !open)}
          >
            {menuOpen ? <X /> : <Menu />}
          </Button>
        </div>
      </div>

      {menuOpen ? (
        <div id="site-header-mobile-nav" className="border-t md:hidden">
          <nav aria-label="Ana menü" className="mx-auto flex max-w-7xl flex-col gap-1 p-4">
            {role && userId ? (
              <Link href="/account" className="mb-2 flex items-center gap-3 rounded-md px-3 py-2 hover:bg-accent">
                <Avatar name={displayName} src={avatarUrl} size="md" />
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{displayName ?? "Hesabım"}</span>
                  <span className="label-eyebrow">Hesap ve görünüm</span>
                </span>
              </Link>
            ) : null}
            {links.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                aria-current={isActive(pathname, link.href) ? "page" : undefined}
                className={cn(
                  "rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  isActive(pathname, link.href)
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                )}
              >
                {link.label}
              </Link>
            ))}
            {role && userId ? <MessagesBadge userId={userId} initialUnread={unreadMessages} variant="row" /> : null}

            <div className="mt-2 flex flex-col gap-2 border-t pt-3">
              {role ? (
                <form action="/auth/signout" method="post">
                  <Button variant="outline" size="sm" type="submit" className="w-full">
                    Çıkış yap
                  </Button>
                </form>
              ) : (
                <>
                  <Button variant="outline" size="sm" asChild>
                    <Link href="/login">Giriş yap</Link>
                  </Button>
                  <Button size="sm" asChild>
                    <Link href="/signup">Üye ol</Link>
                  </Button>
                </>
              )}
            </div>
          </nav>
        </div>
      ) : null}
    </header>
  )
}
