/**
 * app/(dashboard)/admin/users/page.tsx
 *
 * Role management.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS NO EMAIL COLUMN
 * ---------------------------------------------------------------------------
 * `0002_rls.sql` §4.1 grants `authenticated` SELECT on ten columns of `profiles` — id,
 * display_name, full_name, avatar_url, role, city, preferred_position, bio,
 * profile_visibility, created_at — and stops there. `email`, `phone`, `date_of_birth`,
 * `guardian_*` and the Stripe identifiers are outside the grant for everyone, because
 * `profiles_select_self_or_visible` deliberately opens rows to strangers (any adult with a
 * public or members-visible profile) and a table-wide grant would hand every one of those
 * fields to any signed-in user.
 *
 * A column privilege is role-level, so it binds an admin exactly as it binds a player, and
 * asking for `email` here would raise 42501 rather than returning a row. This page could route
 * around it with the service-role client. It does not: identifying an account for a role change
 * needs a name and an id, not a contact address, and reading a column the schema withheld is
 * not something a role-management screen should be teaching people to do.
 *
 * The last-admin count is the one thing here that does use the service role, because
 * `deleted_at` is outside the same grant and an erased admin must not be counted as a live one.
 */

import Link from "next/link"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { RoleEditor, type AdminUserRow } from "@/components/admin/role-editor"
import { countLiveAdmins } from "@/lib/admin/metrics"
import { requireRole, APP_ROLES, type AppRole } from "@/lib/rbac"
import { createClient } from "@/lib/supabase/server"
import { cn } from "@/lib/utils"

export const dynamic = "force-dynamic"

const PAGE_SIZE = 100

/**
 * PostgREST's `or=` filter is a comma-separated expression list, so a raw query string with a
 * comma, a parenthesis or a dot would change the shape of the filter rather than the value
 * being matched. Only characters that can appear in a person's name survive.
 */
function sanitiseSearch(raw: string | undefined): string {
  if (!raw) return ""
  return raw
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .trim()
    .slice(0, 60)
}

function parseRoleFilter(raw: string | undefined): AppRole | null {
  return APP_ROLES.find((role) => role === raw) ?? null
}

interface PageProps {
  searchParams: { q?: string; role?: string }
}

export default async function AdminUsersPage({ searchParams }: PageProps) {
  const { user } = await requireRole("admin")

  const search = sanitiseSearch(searchParams.q)
  const roleFilter = parseRoleFilter(searchParams.role)

  const supabase = await createClient()

  let query = supabase
    .from("profiles")
    .select("id, role, display_name, full_name, city, created_at")
    .order("created_at", { ascending: false })
    .limit(PAGE_SIZE)

  if (roleFilter) query = query.eq("role", roleFilter)
  if (search) query = query.or(`display_name.ilike.*${search}*,full_name.ilike.*${search}*`)

  const [profilesResponse, adminCount] = await Promise.all([query, safeAdminCount()])

  if (profilesResponse.error) {
    console.error("[admin/users] query failed", { code: profilesResponse.error.code })
    return (
      <Alert variant="destructive">
        <AlertTitle>Hesap listesi yüklenemedi</AlertTitle>
        <AlertDescription>
          Veritabanı sorguyu reddetti. Sayfayı yenile; sürerse yönetici rolünün mevcut oturum jetonunda olduğunu kontrol et.
        </AlertDescription>
      </Alert>
    )
  }

  const users: AdminUserRow[] = (profilesResponse.data ?? []).map((row) => ({
    id: row.id,
    role: row.role as AppRole,
    displayName: row.display_name,
    fullName: row.full_name,
    city: row.city,
    createdAt: row.created_at,
  }))

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Rolü değiştirmeden önce</CardTitle>
          <CardDescription>
            Yeni rol, jeton verilirken JWT&apos;ye işlenir ve hem ara katman hem RLS bu talebi profil satırından önce okur. Bu yüzden yükseltme kullanıcının bir sonraki girişinde ya da jeton yenilemesinde geçerli olur; düşürme ise açık oturumu sonlandırmaz — erişimi hemen kesmen gerekiyorsa oturumlarını iptal et.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            E-posta adresleri gösterilmez: şema bunları yöneticiler dâhil her okuyucudan saklar. Hesabı görünen adı ve kimliğinin ilk sekiz karakteriyle eşleştir.
          </p>
        </CardContent>
      </Card>

      {adminCount !== null && adminCount <= 1 ? (
        <Alert variant="destructive">
          <AlertTitle>Tek bir yönetici var</AlertTitle>
          <AlertDescription>
            Rol sütunu uygulamadan yazılamaz; o hesap rolünü kaybederse veritabanı erişimi olmadan kimse geri veremez. İkinci bir yönetici ata.
          </AlertDescription>
        </Alert>
      ) : null}

      <form className="flex flex-wrap items-end gap-3" role="search">
        <div className="min-w-[14rem] flex-1 space-y-1">
          <Label htmlFor="user-search">Ada göre ara</Label>
          <Input
            id="user-search"
            name="q"
            type="search"
            defaultValue={search}
            placeholder="Görünen ad ya da ad soyad"
          />
        </div>
        {roleFilter ? <input type="hidden" name="role" value={roleFilter} /> : null}
        <Button type="submit" variant="outline">
          Ara
        </Button>
      </form>

      <nav aria-label="Role göre filtrele" className="flex flex-wrap gap-1">
        <RoleFilterLink label="Bütün roller" href={buildHref(search, null)} active={roleFilter === null} />
        {APP_ROLES.map((role) => (
          <RoleFilterLink
            key={role}
            label={role.replace("_", " ")}
            href={buildHref(search, role)}
            active={roleFilter === role}
          />
        ))}
      </nav>

      <RoleEditor users={users} currentUserId={user.id} adminCount={adminCount ?? 2} />

      {users.length === PAGE_SIZE ? (
        <p className="text-xs text-muted-foreground">
          Showing the {PAGE_SIZE} most recent accounts. Narrow the search to reach older ones.
        </p>
      ) : null}
    </div>
  )
}

function buildHref(search: string, role: AppRole | null): string {
  const params = new URLSearchParams()
  if (search) params.set("q", search)
  if (role) params.set("role", role)
  const query = params.toString()
  return query ? `/admin/users?${query}` : "/admin/users"
}

function RoleFilterLink({
  label,
  href,
  active,
}: {
  label: string
  href: string
  active: boolean
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "true" : undefined}
      className={cn(
        "rounded-md border px-3 py-1.5 text-sm capitalize transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground",
      )}
    >
      {label}
    </Link>
  )
}

/**
 * The last-admin count, or null when it could not be read.
 *
 * A failure here degrades the WARNING, not the page: the authoritative guard lives in
 * `POST /api/admin/users/[id]/role`, which runs the same count and refuses the change. Passing
 * a safe fallback of 2 to the editor means the client-side hint stays quiet and the server has
 * the last word, which is the right way round.
 */
async function safeAdminCount(): Promise<number | null> {
  try {
    return await countLiveAdmins()
  } catch (error) {
    console.error("[admin/users] admin count failed", { code: (error as { code?: unknown }).code })
    return null
  }
}
