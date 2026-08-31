/**
 * app/(dashboard)/admin/venues/page.tsx
 *
 * Venue approval, and the Stripe Connect state that decides whether a listing can take money.
 *
 * ---------------------------------------------------------------------------
 * WHAT AN ADMIN CAN AND CANNOT FLIP HERE
 * ---------------------------------------------------------------------------
 * `is_active` is in the column-level UPDATE grant and `venues_update_owner` has an
 * `is_admin()` disjunct, so publishing and unpublishing go through the operator's OWN client.
 * No service-role client is needed and none is used: RLS is doing the authorising.
 *
 * `charges_enabled` and `payouts_enabled` are not in any grant. They are a mirror of Stripe's
 * verdict, written only by the `account.updated` webhook on the service role, and that is what
 * makes the restrictive `venues_update_publish_requires_stripe` policy trustworthy — the value
 * in the new row is necessarily the one Stripe last sent. Nothing on this page can change them,
 * and nothing should: the fix for "charges disabled" is the owner completing verification.
 *
 * That policy exempts admins, so an admin CAN publish an unpayable venue. The form refuses to,
 * because a listing that appears in search and rejects every checkout is worse for the venue
 * than not appearing at all. The refusal is re-checked in the action, not just disabled in the
 * markup.
 */

import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { recordAdminAudit } from "@/lib/admin/metrics"
import { requireRole } from "@/lib/rbac"
import { createClient } from "@/lib/supabase/server"

export const dynamic = "force-dynamic"

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const VENUE_SELECT =
  "id, name, slug, city, district, is_active, charges_enabled, payouts_enabled," +
  "stripe_account_id, onboarding_completed_at, created_at," +
  "owner:profiles(display_name,full_name)," +
  "pitches(id)"

/** Hand-written to match `VENUE_SELECT`; postgrest-js cannot infer from a concatenated string. */
interface VenueRow {
  id: string
  name: string
  slug: string
  city: string | null
  district: string | null
  is_active: boolean
  charges_enabled: boolean
  payouts_enabled: boolean
  stripe_account_id: string | null
  onboarding_completed_at: string | null
  created_at: string
  owner: { display_name: string | null; full_name: string | null } | null
  pitches: Array<{ id: string }>
}

/**
 * Publish or unpublish one venue.
 *
 * A Server Action rather than a route handler: this is a form post that ends in a revalidation
 * of the page it was submitted from, and it needs no JSON contract. `requireRole('admin')` runs
 * inside it because a Server Action is a POST endpoint like any other — the layout's gate above
 * it protects a render, not this.
 */
async function setVenueVisibility(formData: FormData): Promise<void> {
  "use server"

  const { user } = await requireRole("admin")

  const venueId = String(formData.get("venueId") ?? "")
  const publish = formData.get("publish") === "true"
  const note = String(formData.get("note") ?? "").trim()

  if (!UUID_PATTERN.test(venueId)) {
    redirect("/admin/venues?error=bad_reference")
  }

  const supabase = await createClient()

  const { data: venue, error: readError } = await supabase
    .from("venues")
    .select("id, name, is_active, charges_enabled")
    .eq("id", venueId)
    .maybeSingle()

  if (readError || !venue) {
    redirect(`/admin/venues?error=not_found&venue=${venueId}`)
  }

  if (venue.is_active === publish) {
    redirect(`/admin/venues?error=no_change&venue=${venueId}`)
  }

  // Re-check what the disabled button already prevents. A disabled attribute is a hint to a
  // browser, not a guarantee about what arrives here.
  if (publish && !venue.charges_enabled) {
    redirect(`/admin/venues?error=not_payable&venue=${venueId}`)
  }

  const { error: updateError } = await supabase
    .from("venues")
    .update({ is_active: publish })
    .eq("id", venueId)

  if (updateError) {
    console.error("[admin/venues] visibility update failed", { code: updateError.code })
    redirect(`/admin/venues?error=write_failed&venue=${venueId}`)
  }

  await recordAdminAudit({
    action: "admin.venue_visibility_changed",
    actorId: user.id,
    entityType: "venues",
    entityId: venueId,
    reason: note.length > 0 ? note : "Not kaydedilmemiş.",
    metadata: {
      venue_name: venue.name,
      from_active: venue.is_active,
      to_active: publish,
      charges_enabled: venue.charges_enabled,
    },
  })

  revalidatePath("/admin/venues")
  redirect(`/admin/venues?updated=${venueId}`)
}

const ERROR_COPY: Record<string, { title: string; body: string }> = {
  bad_reference: {
    title: "Bu işletme referansı geçerli değil",
    body: "Hiçbir şey değişmedi. Sayfayı yenileyip tekrar dene.",
  },
  not_found: {
    title: "Bu işletme sana görünmüyor",
    body: "Silinmiş olabilir ya da yönetici rolün mevcut oturum jetonunda olmayabilir.",
  },
  no_change: {
    title: "Yapılacak bir şey yok",
    body: "İşletme zaten o durumdaydı — başka biri az önce değiştirmiş olabilir.",
  },
  not_payable: {
    title: "Bu işletme henüz yayınlanamaz",
    body:
      "Stripe bağlı hesapta tahsilatı açmamış; her ödeme başarısız olur. " +
      "The owner has to finish verification first.",
  },
  write_failed: {
    title: "Değişiklik işlenmedi",
    body: "Veritabanı güncellemeyi kabul etmedi. Hiçbir şey değişmedi.",
  },
}

interface PageProps {
  searchParams: { error?: string; updated?: string }
}

export default async function AdminVenuesPage({ searchParams }: PageProps) {
  await requireRole("admin")

  const supabase = await createClient()

  const { data, error } = await supabase
    .from("venues")
    .select(VENUE_SELECT)
    // Unpublished first — those are the ones waiting on a decision — then newest.
    .order("is_active", { ascending: true })
    .order("created_at", { ascending: false })
    .limit(200)

  if (error) {
    console.error("[admin/venues] query failed", { code: error.code })
    return (
      <Alert variant="destructive">
        <AlertTitle>İşletme listesi yüklenemedi</AlertTitle>
        <AlertDescription>
          Veritabanı sorguyu reddetti. Sayfayı yenile; sürerse yönetici rolünün mevcut oturum jetonunda olduğunu kontrol et.
        </AlertDescription>
      </Alert>
    )
  }

  const venues = (data ?? []) as unknown as VenueRow[]
  const pending = venues.filter((venue) => !venue.is_active)
  const blocked = venues.filter((venue) => venue.is_active && !venue.charges_enabled)
  const failure = searchParams.error ? ERROR_COPY[searchParams.error] : undefined

  return (
    <div className="space-y-6">
      {failure ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>{failure.title}</AlertTitle>
          <AlertDescription>{failure.body}</AlertDescription>
        </Alert>
      ) : null}

      {searchParams.updated ? (
        <Alert>
          <AlertTitle>İşletme güncellendi</AlertTitle>
          <AlertDescription>
            Değişiklik yayında ve hesabına yazılarak denetim kaydına işlendi.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-3">
        <SummaryCard
          label="Yayın bekliyor"
          value={pending.length}
          hint="Oluşturuldu ama oyunculara görünmüyor"
        />
        <SummaryCard
          label="Canlı"
          value={venues.length - pending.length}
          hint="Yayında ve bulunabilir"
        />
        <SummaryCard
          label="Yayında ama ödeme alınamıyor"
          value={blocked.length}
          hint="Stripe tahsilat kapalıyken yayınlanmış"
          tone={blocked.length > 0 ? "bad" : "neutral"}
        />
      </div>

      {blocked.length > 0 ? (
        <Alert variant="destructive">
          <AlertTitle>
            {blocked.length} published {blocked.length === 1 ? "venue takes" : "venues take"} no
            money
          </AlertTitle>
          <AlertDescription>
            {blocked.map((venue) => venue.name).join(", ")} appear in search, and every checkout
            against them fails. Either the owner finishes Stripe verification or the listing comes
            down.
          </AlertDescription>
        </Alert>
      ) : null}

      {venues.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Henüz işletme yok</CardTitle>
            <CardDescription>
              İşletmeler, bir sahibi kayıt olup kurulumu tamamladığında ortaya çıkar. Yayınlanmamış ve Stripe&apos;a bağlanmamış olarak oluşturulur.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <div className="rounded-lg border border-border">
          <Table>
            <caption className="sr-only">
              İşletmeler; önce yayınlanmamışlar, Stripe Connect durumlarıyla
            </caption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">İşletme</TableHead>
                <TableHead scope="col">Yayın</TableHead>
                <TableHead scope="col">Stripe</TableHead>
                <TableHead scope="col">İşlem</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {venues.map((venue) => (
                <TableRow key={venue.id}>
                  <TableCell className="align-top">
                    <div className="font-medium">{venue.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {[venue.district, venue.city].filter(Boolean).join(", ") || "no location"} ·{" "}
                      {venue.pitches.length} {venue.pitches.length === 1 ? "pitch" : "pitches"}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Owner: {venue.owner?.display_name ?? venue.owner?.full_name ?? "unknown"}
                    </div>
                  </TableCell>

                  <TableCell className="align-top">
                    {venue.is_active ? (
                      <Badge variant="success">yayında</Badge>
                    ) : (
                      <Badge variant="outline">yayında değil</Badge>
                    )}
                  </TableCell>

                  <TableCell className="align-top">
                    <ConnectState venue={venue} />
                  </TableCell>

                  <TableCell className="align-top">
                    <form action={setVenueVisibility} className="flex flex-col gap-2 sm:w-64">
                      <input type="hidden" name="venueId" value={venue.id} />
                      <input type="hidden" name="publish" value={venue.is_active ? "false" : "true"} />
                      <label className="sr-only" htmlFor={`note-${venue.id}`}>
                        Denetim kaydı için not
                      </label>
                      <Input
                        id={`note-${venue.id}`}
                        name="note"
                        placeholder="Denetim kaydı için not (isteğe bağlı)"
                        maxLength={200}
                      />
                      <Button
                        type="submit"
                        size="sm"
                        variant={venue.is_active ? "outline" : "default"}
                        disabled={!venue.is_active && !venue.charges_enabled}
                      >
                        {venue.is_active ? "Unpublish" : "Publish"}
                        <span className="sr-only"> {venue.name}</span>
                      </Button>
                      {!venue.is_active && !venue.charges_enabled ? (
                        <p className="text-xs text-muted-foreground">
                          Stripe tahsilatı açana kadar yayınlanamaz.
                        </p>
                      ) : null}
                    </form>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}

function ConnectState({ venue }: { venue: VenueRow }) {
  if (!venue.stripe_account_id) {
    return (
      <div className="space-y-1">
        <Badge variant="outline">bağlı değil</Badge>
        <p className="text-xs text-muted-foreground">Henüz bağlı hesap yok.</p>
      </div>
    )
  }

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap gap-1">
        <Badge variant={venue.charges_enabled ? "success" : "destructive"}>
          charges {venue.charges_enabled ? "on" : "off"}
        </Badge>
        <Badge variant={venue.payouts_enabled ? "success" : "warning"}>
          payouts {venue.payouts_enabled ? "on" : "off"}
        </Badge>
      </div>
      <p className="font-mono text-xs text-muted-foreground">{venue.stripe_account_id}</p>
      <p className="text-xs text-muted-foreground">
        {venue.onboarding_completed_at ? "Onboarding complete" : "Onboarding unfinished"}
      </p>
    </div>
  )
}

function SummaryCard({
  label,
  value,
  hint,
  tone = "neutral",
}: {
  label: string
  value: number
  hint: string
  tone?: "neutral" | "bad"
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <p
          className={
            tone === "bad" && value > 0
              ? "text-2xl font-semibold tabular-nums text-destructive"
              : "text-2xl font-semibold tabular-nums"
          }
        >
          {value}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
      </CardContent>
    </Card>
  )
}
