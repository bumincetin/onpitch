/**
 * app/(app)/account/privacy/page.tsx
 *
 * Privacy switches, the guardian-consent record, and both GDPR rights in one place.
 *
 * The privacy values are computed here with `enforcePrivacyDefaults()` rather than read straight
 * off the row. `profiles.is_minor` is a STORED generated column — a write-time snapshot — so a
 * profile that has aged past 16 still carries `is_minor = true` until the row is next written.
 * `enforcePrivacyDefaults` prefers the birth date when it has one, which means this page tells a
 * newly-16-year-old the truth on the day rather than on their next profile save.
 *
 * The consent card is rendered whenever there is a consent story to tell. An adult account sits
 * at `not_required` and gets one line saying so, because "nothing is pending" is itself worth
 * knowing on a page about parental controls.
 */

import type { Metadata } from "next"
import Link from "next/link"

import { ConsentStatus } from "@/components/account/consent-status"
import { DataExportCard } from "@/components/account/data-export-card"
import { DeleteAccountDialog } from "@/components/account/delete-account-dialog"
import { MessagingControls } from "@/components/account/messaging-controls"
import { PrivacyControls } from "@/components/account/privacy-controls"
import { loadBlockedUsers } from "@/lib/messaging"
import { MESSAGING_POLICIES, type MessagingPolicy } from "@onpitch/shared/profile"
import { NotificationBell } from "@/components/notifications/notification-bell"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { DIGITAL_CONSENT_AGE, enforcePrivacyDefaults, maskEmail } from "@/lib/gdpr"
import { requireRole } from "@/lib/rbac"
import { createClient } from "@/lib/supabase/server"
import { cn } from "@/lib/utils"

export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "Gizlilik ve veri",
  description: "Diğer oyuncuların ne göreceğini belirle ve KVKK/GDPR haklarını kullan.",
}

const ACCOUNT_TABS = [
  { href: "/account", label: "Profil" },
  { href: "/account/privacy", label: "Gizlilik ve veri" },
  { href: "/account/security", label: "Güvenlik" },
] as const

export default async function PrivacyPage() {
  const { user, profile } = await requireRole()
  const supabase = await createClient()

  const { count } = await supabase
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .is("read_at", null)

  const privacy = enforcePrivacyDefaults(profile)
  const isMinorAccount = privacy.lockedFields.length > 0
  const blocked = await loadBlockedUsers(supabase)
  const messagingPolicy: MessagingPolicy = (MESSAGING_POLICIES as readonly string[]).includes(profile.messaging_policy)
    ? (profile.messaging_policy as MessagingPolicy)
    : "teammates"

  return (
    <div className="space-y-6">
      <AccountHeader current="/account/privacy" unreadCount={count ?? 0} userId={user.id} />

      <Card>
        <CardHeader>
          <CardTitle>Başkaları ne görüyor</CardTitle>
          <CardDescription>
            Üç ayar; her biri değiştirdiğin anda kaydedilir.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <PrivacyControls
            locationSharingEnabled={privacy.values.location_sharing_enabled}
            profileVisibility={privacy.values.profile_visibility}
            marketingOptIn={privacy.values.marketing_opt_in}
            lockedFields={privacy.lockedFields}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Kim sana mesaj gönderebilir</CardTitle>
          <CardDescription>
            Sohbetler yalnızca iki tarafın da hesabında durur; bir yıl sonra silinir, hesabını silersen yazdıkların
            hemen kaldırılır. Engellediğin biri sana ulaşamaz ve bundan haberi olmaz.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <MessagingControls policy={messagingPolicy} minor={isMinorAccount} blocked={blocked} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Veli onayı</CardTitle>
          <CardDescription>
            {isMinorAccount
              ? `Accounts under ${DIGITAL_CONSENT_AGE} need a parent or guardian to approve booking and match features (GDPR Art. 8).`
              : "Nerede a guardian approval would appear if this account needed one."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {/* Masked HERE, on the server. Every prop of a client component is serialised into
              the RSC flight payload embedded in the HTML, so passing the raw column would put
              the guardian's full address in the page source no matter what the component drew. */}
          <ConsentStatus
            status={profile.parental_consent_status}
            guardianEmailMasked={profile.guardian_email ? maskEmail(profile.guardian_email) : null}
            guardianName={profile.guardian_name}
            grantedAt={profile.parental_consent_at}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Sende tuttuğumuz her şeyi indir</CardTitle>
          <CardDescription>
            GDPR md. 15 ve md. 20 — erişim ve makine tarafından okunabilir biçimde taşınabilirlik.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DataExportCard />
        </CardContent>
      </Card>

      <Card className="border-destructive/50">
        <CardHeader>
          <CardTitle>Bu hesabı sil</CardTitle>
          <CardDescription>
            GDPR md. 17. Kişisel bilgiler kaldırılır; rezervasyon ve ödeme kayıtları vergi mevzuatı gerektirdiği için takma adlaştırılmış hâlde saklanır.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Geri alma yok, bekleme süresi yok. Yalnızca bir sezon ara veriyorsan çıkış yapman yeter — kullanılmadığı için hiçbir şey silinmez.
          </p>
          <DeleteAccountDialog />
          <p className="text-xs text-muted-foreground">
            Our full retention policy is in the{" "}
            <Link href="/privacy" className="underline underline-offset-4">
              gizlilik bildirimi
            </Link>
            .
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
