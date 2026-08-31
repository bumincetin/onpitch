/**
 * app/(app)/account/page.tsx
 *
 * Profile editing.
 *
 * The page is split the way the database is: what a person may change goes into
 * `<ProfileForm />`, and what the schema will not let them change is rendered as a read-only
 * fact with the reason attached. That is not padding — `date_of_birth` is absent from the UPDATE
 * grant precisely because `is_minor` is a STORED generated column recomputed on every write, so
 * a self-serve birth-date edit would be a one-request escape from the entire Art. 8 consent gate
 * (0002_rls.sql §4.1 spells it out). Telling someone "ask us" beats an input that silently 403s.
 *
 * `requireRole()` with no arguments is "any signed-in user"; the `(app)` layout has already
 * called it, so this is a deduped read rather than a second round trip.
 *
 * The sub-navigation is repeated on each of the three account pages rather than hoisted into a
 * layout, because a layout would also wrap `/account/password` — which lives in the `(auth)`
 * group precisely so that it works from a recovery link with no role claim yet.
 */

import type { Metadata } from "next"
import Link from "next/link"

import { AvatarUpload } from "@/components/account/avatar-upload"
import { ProfileForm } from "@/components/account/profile-form"
import { NotificationBell } from "@/components/notifications/notification-bell"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { requireRole } from "@/lib/rbac"
import { createClient } from "@/lib/supabase/server"
import { cn } from "@/lib/utils"

export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "Hesap",
  description: "Adın, fotoğrafın ve futbol profilin.",
}

const ACCOUNT_TABS = [
  { href: "/account", label: "Profil" },
  { href: "/account/privacy", label: "Gizlilik ve veri" },
  { href: "/account/security", label: "Güvenlik" },
] as const

const ROLE_LABELS: Readonly<Record<string, string>> = {
  player: "Player",
  venue_owner: "Venue owner",
  admin: "Administrator",
}

function formatDate(iso: string | null): string {
  if (!iso) return "Not recorded"
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return "Not recorded"
  return new Intl.DateTimeFormat("tr-TR", {
    dateStyle: "long",
    timeZone: "Europe/Istanbul",
  }).format(parsed)
}

export default async function AccountPage() {
  const { user, profile } = await requireRole()
  const supabase = await createClient()

  const { count } = await supabase
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .is("read_at", null)

  const displayName = profile.display_name ?? profile.full_name ?? "Your profile"

  return (
    <div className="space-y-6">
      <AccountHeader current="/account" unreadCount={count ?? 0} userId={user.id} />

      <Card>
        <CardHeader>
          <CardTitle>Fotoğraf</CardTitle>
          <CardDescription>
            İsteğe bağlı. On kişilik bir kadro listesinde seni bulmayı kolaylaştırır.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AvatarUpload
            userId={user.id}
            avatarUrl={profile.avatar_url}
            displayName={displayName}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Bilgilerin</CardTitle>
          <CardDescription>
            Görünen adın ve şehrin, başkalarının seni bulmak için gerçekten kullandığı iki alan.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ProfileForm
            initial={{
              fullName: profile.full_name,
              displayName: profile.display_name,
              phone: profile.phone,
              city: profile.city,
              preferredPosition: profile.preferred_position,
              bio: profile.bio,
            }}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Bu hesapta değiştirilemez</CardTitle>
          <CardDescription>
            Bunlar buradan değiştirilemez. Her biri bu ekranda gizlendiği için değil, veritabanında kilitli olduğu için değiştirilemez.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-5 sm:grid-cols-2">
            <ReadOnlyFact
              term="E-posta adresi"
              value={profile.email ?? user.email ?? "Not recorded"}
              note="Giriş kimliğin. Değiştirmek yeni adresi yeniden doğrulamayı gerektirir; bu da bu formdan değil, giriş akışından yürür."
            />
            <ReadOnlyFact
              term="Hesap türü"
              value={ROLE_LABELS[profile.role] ?? profile.role}
              note="Roller kendine atanamaz. Kısıtlayıcı bir politika bu sütunu değiştiren her güncellemeyi reddeder; kimse kendini yükseltemez."
            />
            <ReadOnlyFact
              term="Doğum tarihi"
              value={formatDate(profile.date_of_birth)}
              note="Her yazmada 16 yaş altı işareti bundan türetildiği için kilitli. Gerçek bir düzeltme için destekle iletişime geç; işlem onay akışına geri döner."
            />
            <ReadOnlyFact
              term="Üyelik başlangıcı"
              value={formatDate(profile.created_at)}
              note="Hesap oluşturulurken belirlendi."
            />
          </dl>
        </CardContent>
      </Card>
    </div>
  )
}

/* -------------------------------------------------------------------------- */

function ReadOnlyFact({
  term,
  value,
  note,
}: {
  term: string
  value: string
  note: string
}) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{term}</dt>
      <dd className="mt-1 break-words text-sm font-medium">{value}</dd>
      <dd className="mt-1 text-xs text-muted-foreground">{note}</dd>
    </div>
  )
}

/**
 * The account chrome. It is repeated verbatim in `privacy/page.tsx` and `security/page.tsx`
 * rather than exported from here: a Next page module may only export `default`, `metadata` and
 * the route-segment config, and any other export is a build-time type error.
 */
function AccountHeader({
  current,
  unreadCount,
  userId,
}: {
  current: string
  unreadCount: number
  userId: string
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Hesap</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Profilin, başkalarının ne gördüğü ve nasıl giriş yaptığın.
          </p>
        </div>
        <NotificationBell userId={userId} initialUnreadCount={unreadCount} />
      </div>

      <nav aria-label="Hesap bölümleri">
        <ul className="flex flex-wrap gap-1 border-b">
          {ACCOUNT_TABS.map((tab) => {
            const active = tab.href === current
            return (
              <li key={tab.href}>
                <Link
                  href={tab.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "inline-flex h-10 items-center rounded-t-md border-b-2 px-3 text-sm font-medium transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    active
                      ? "border-primary text-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  {tab.label}
                </Link>
              </li>
            )
          })}
          <li className="ml-auto">
            <Link
              href="/notifications"
              className="inline-flex h-10 items-center rounded-t-md border-b-2 border-transparent px-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Notifications
              {unreadCount > 0 ? (
                <Badge variant="secondary" className="ml-2">
                  {unreadCount}
                </Badge>
              ) : null}
            </Link>
          </li>
        </ul>
      </nav>
    </div>
  )
}
