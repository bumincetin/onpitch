/**
 * app/(app)/account/security/page.tsx
 *
 * Password, sessions, and the way out.
 *
 * ---------------------------------------------------------------------------
 * SESSIONS
 * ---------------------------------------------------------------------------
 * There is no per-device session list here, and inventing one would be a lie. Supabase Auth
 * keeps refresh tokens in `auth.refresh_tokens`, a schema no application role can read — RLS
 * does not apply to it and no policy grants access — so nothing this page could query would
 * enumerate "your devices". What IS true and useful is that `POST /auth/signout` calls
 * `signOut({ scope: 'global' })`, which revokes every refresh token this account holds. That is
 * the whole remedy, so it gets stated plainly rather than dressed up as a device manager.
 *
 * ---------------------------------------------------------------------------
 * PASSWORD
 * ---------------------------------------------------------------------------
 * `UpdatePasswordForm` is reused rather than reimplemented. It calls
 * `supabase.auth.updateUser({ password })`, which acts on whatever session the browser holds —
 * a recovery session on `/account/password`, and an ordinary signed-in session here. Same call,
 * same GoTrue rules, one copy of the length and error handling.
 *
 * The sign-out control is a real form POST, not a fetch. It keeps working with JavaScript
 * disabled or still loading, and `/auth/signout` refuses GET on purpose so that a third-party
 * `<img src>` cannot log anyone out.
 */

import type { Metadata } from "next"
import Link from "next/link"

import { UpdatePasswordForm } from "@/components/auth/update-password-form"
import { NotificationBell } from "@/components/notifications/notification-bell"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { MINIMUM_PASSWORD_LENGTH } from "@/lib/gdpr"
import { requireRole } from "@/lib/rbac"
import { createClient } from "@/lib/supabase/server"
import { cn } from "@/lib/utils"

export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "Güvenlik",
  description: "Şifreni değiştir ve her yerden çıkış yap.",
}

const ACCOUNT_TABS = [
  { href: "/account", label: "Profil" },
  { href: "/account/privacy", label: "Gizlilik ve veri" },
  { href: "/account/security", label: "Güvenlik" },
] as const

function formatMoment(iso: string | null): string {
  if (!iso) return "Not recorded"
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return "Not recorded"
  return new Intl.DateTimeFormat("tr-TR", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "Europe/Istanbul",
  }).format(parsed)
}

export default async function SecurityPage() {
  const { user, profile } = await requireRole()
  const supabase = await createClient()

  const { count } = await supabase
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .is("read_at", null)

  return (
    <div className="space-y-6">
      <AccountHeader current="/account/security" unreadCount={count ?? 0} userId={user.id} />

      <Card>
        <CardHeader>
          <CardTitle>Şifreni değiştir</CardTitle>
          <CardDescription>
            At least {MINIMUM_PASSWORD_LENGTH} characters. Changing it here does not sign you out
            of your other devices — use the button below for that.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <UpdatePasswordForm />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Oturumlar</CardTitle>
          <CardDescription>
            Bu hesabın nerelerde açık olduğu ve hepsini tek seferde nasıl kapatacağın.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <dl className="grid gap-5 sm:grid-cols-2">
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                Giriş yapan
              </dt>
              <dd className="mt-1 break-words text-sm font-medium">
                {profile.email ?? user.email ?? "Unknown"}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                Son görülme
              </dt>
              <dd className="mt-1 text-sm font-medium">{formatMoment(profile.last_seen_at)}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                Son giriş
              </dt>
              <dd className="mt-1 text-sm font-medium">
                {formatMoment(user.last_sign_in_at ?? null)}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                E-posta doğrulandı
              </dt>
              <dd className="mt-1 text-sm font-medium">
                {user.email_confirmed_at ? formatMoment(user.email_confirmed_at) : "Not confirmed"}
              </dd>
            </div>
          </dl>

          <Alert>
            <AlertTitle>Cihaz listesi tutmuyoruz</AlertTitle>
            <AlertDescription>
              Yenileme jetonları uygulamanın okuyamadığı bir şemada durur; bu yüzden burada dürüstçe &ldquo;iPhone, İstanbul, iki saat önce&rdquo; yazan bir ekran olamaz. Yapabileceğimiz şey hepsini birden iptal etmek: bu, hesabın kullandığı her tarayıcı ve telefondan çıkış yapar.
            </AlertDescription>
          </Alert>

          {/* A form POST rather than fetch: it survives JavaScript being off, and /auth/signout
              refuses GET so that a third-party page cannot trigger it with an <img>. */}
          <form action="/auth/signout" method="post" className="flex flex-wrap items-center gap-3">
            <Button type="submit" variant="destructive">
              Her yerden çıkış yap
            </Button>
            <p className="text-xs text-muted-foreground">
              Giriş sayfasına döner ve şifreni yeniden girmen gerekir.
            </p>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Erişimini kaybettiysen</CardTitle>
          <CardDescription>Kaybettiğin şey şifreyse ne yapman gerektiği.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <p>
            Sign out, then use{" "}
            <Link href="/login" className="underline underline-offset-4">
              giriş sayfası
            </Link>{" "}
            to request a recovery link. It arrives by email and lands on a page that sets a new
            password without needing the old one.
          </p>
          <p>
            Bu hesaptaki e-posta adresine artık erişemiyorsan başka bir şey yapmadan önce destekle iletişime geç — okuyamadığın bir adrese gönderilen kurtarma bağlantısı, hiç bağlantı olmamasından daha kötüdür.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}

/* -------------------------------------------------------------------------- */

/**
 * Repeated verbatim across the three account pages: a Next page module may only export
 * `default`, `metadata` and the route-segment config, so this cannot be hoisted out of one page
 * and imported by the others.
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
