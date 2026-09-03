"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import {
  Award,
  CalendarDays,
  CreditCard,
  LayoutDashboard,
  ListChecks,
  ListOrdered,
  MapPin,
  MessageCircle,
  Shield,
  Trophy,
  UserRound,
  Wallet,
  type LucideIcon,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import type { AppRole } from "@/lib/rbac"

/**
 * Sidebar navigation for the signed-in areas.
 *
 * The role arrives as a prop from the Server Component layout that already resolved the
 * session; this component never queries Supabase. Rendering fewer links is a UX decision —
 * middleware still refuses the URL and RLS still refuses the rows.
 */

export interface DashboardNavProps {
  role: AppRole
  /** Optional per-item counters, e.g. `{ "/venue/bookings": 3 }` for pending approvals. */
  badges?: Readonly<Record<string, number>>
  className?: string
}

interface NavItem {
  href: string
  label: string
  icon: LucideIcon
  /** Match only the exact path — used for section roots like `/venue`. */
  exact?: boolean
}

interface NavSection {
  heading: string
  items: readonly NavItem[]
}

const PLAYER_NAV: readonly NavSection[] = [
  {
    heading: "Oyun",
    items: [
      { href: "/dashboard", label: "Panelim", icon: LayoutDashboard, exact: true },
      { href: "/matches", label: "Maçlar", icon: Trophy },
      { href: "/leagues", label: "Ligler", icon: Shield },
      { href: "/leaderboard", label: "Sıralama", icon: ListOrdered },
      { href: "/achievements", label: "Rozetler", icon: Award },
    ],
  },
  {
    heading: "Sen",
    items: [
      { href: "/messages", label: "Mesajlar", icon: MessageCircle },
      { href: "/account", label: "Hesap ve görünüm", icon: UserRound },
    ],
  },
]

const VENUE_OWNER_NAV: readonly NavSection[] = [
  {
    heading: "İşletme",
    items: [
      { href: "/venue", label: "Genel bakış", icon: LayoutDashboard, exact: true },
      { href: "/venue/calendar", label: "Takvim", icon: CalendarDays },
      { href: "/venue/pitches", label: "Sahalar", icon: MapPin },
      { href: "/venue/bookings", label: "Rezervasyonlar", icon: ListChecks },
    ],
  },
  {
    heading: "Finans",
    items: [
      { href: "/venue/payouts", label: "Ödemeler", icon: Wallet },
      { href: "/venue/onboarding", label: "Stripe kurulumu", icon: CreditCard },
    ],
  },
  {
    heading: "Sen",
    items: [
      { href: "/messages", label: "Mesajlar", icon: MessageCircle },
      { href: "/account", label: "Hesap ve görünüm", icon: UserRound },
    ],
  },
]

const ADMIN_NAV: readonly NavSection[] = [
  {
    heading: "Yönetim",
    items: [
      { href: "/dashboard", label: "Panel", icon: LayoutDashboard, exact: true },
      { href: "/matches", label: "Maçlar", icon: Trophy },
      { href: "/leagues", label: "Ligler", icon: Shield },
      { href: "/leaderboard", label: "Sıralama", icon: ListOrdered },
      { href: "/messages", label: "Mesajlar", icon: MessageCircle },
    ],
  },
]

const NAV_BY_ROLE: Record<AppRole, readonly NavSection[]> = {
  player: PLAYER_NAV,
  venue_owner: VENUE_OWNER_NAV,
  admin: ADMIN_NAV,
}

function isActive(pathname: string, item: NavItem): boolean {
  if (item.exact === true) return pathname === item.href
  return pathname === item.href || pathname.startsWith(`${item.href}/`)
}

export function DashboardNav({ role, badges, className }: DashboardNavProps) {
  const pathname = usePathname()
  const sections = NAV_BY_ROLE[role]

  return (
    <nav aria-label="Panel menüsü" className={cn("flex flex-col gap-8", className)}>
      {sections.map((section) => (
        <div key={section.heading} className="flex flex-col gap-3">
          <h2 className="label-eyebrow">{section.heading}</h2>
          <ul className="flex flex-col">
            {section.items.map((item) => {
              const active = isActive(pathname, item)
              const count = badges?.[item.href]
              const Icon = item.icon
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex items-center gap-3 border-l-2 py-2 pl-3 text-sm transition-colors",
                      active
                        ? "border-user text-foreground"
                        : "border-transparent text-muted-foreground hover:border-foreground/25 hover:text-foreground",
                    )}
                  >
                    <Icon aria-hidden="true" className="size-4 shrink-0" />
                    <span className="truncate">{item.label}</span>
                    {count !== undefined && count > 0 ? (
                      <Badge className="ml-auto bg-user tabular-nums text-primary-foreground">
                        {count}
                      </Badge>
                    ) : null}
                  </Link>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </nav>
  )
}
