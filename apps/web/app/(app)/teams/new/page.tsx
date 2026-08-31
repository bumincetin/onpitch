/**
 * app/(app)/teams/new/page.tsx
 *
 * Found a team.
 *
 * Any signed-in account may create one — `teams_insert_own` requires only that `owner_id` is the
 * caller, and there is no role gate above it. A venue owner running a house team is a normal
 * thing, not an edge case.
 *
 * The page itself is a thin server shell. Everything interactive lives in `<TeamForm />`, which
 * posts to `/api/teams` and navigates to the new team once the slug comes back.
 */

import type { Metadata } from "next"
import Link from "next/link"

import { TeamForm } from "@/components/team/team-form"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { requireRole } from "@/lib/rbac"

export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "Takım kur",
  description: "Kadronu kur, kimin oynayacağını seç, sonuçlarını bir arada tut.",
}

export default async function NewTeamPage() {
  await requireRole()

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <nav aria-label="Sayfa yolu" className="text-sm text-muted-foreground">
        <Link href="/teams" className="hover:underline">
          Takımlar
        </Link>
        <span aria-hidden="true"> / </span>
        <span className="text-foreground">Yeni</span>
      </nav>

      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Takım kur</h1>
        <p className="text-sm text-muted-foreground">
          Kaptan sen olursun. Ad dışındaki her şey isteğe bağlı ve sonradan değiştirilebilir.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Takım bilgileri</CardTitle>
          <CardDescription>
            Listelenen bir takım aramada çıkar ve kadrosunu herkes okuyabilir. Listelenmeyen takıma yalnızca davetle girilir. İstediğin an iki yöne de geçebilirsin.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <TeamForm />
        </CardContent>
      </Card>
    </div>
  )
}
