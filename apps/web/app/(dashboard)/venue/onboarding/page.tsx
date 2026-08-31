/**
 * app/(dashboard)/venue/onboarding/page.tsx — getting a venue live.
 *
 * Four gates stand between signing up and taking a booking, and an owner who cannot see all four
 * gets stuck on whichever one they forgot:
 *
 *   1. a venue row exists
 *   2. it has at least one bookable pitch
 *   3. Stripe has verified the connected account (`charges_enabled`)
 *   4. the venue is published (`is_active`)
 *
 * So the page is a checklist, not a wizard: every step is visible and reachable at all times,
 * because an owner returning from Stripe three days later needs to see WHERE they are, not be
 * marched back through step one.
 *
 * ---------------------------------------------------------------------------
 * THE VENUE FORM IS A SERVER ACTION
 * ---------------------------------------------------------------------------
 * `createVenue` runs on the server with the caller's cookie-bound client, so `venues_insert_owner`
 * and the column-level INSERT grant are the boundary — `owner_id` is stamped from the verified
 * session, never from the form, and `stripe_account_id` / `charges_enabled` / `is_active` are not
 * in the INSERT grant at all, so a crafted POST physically cannot mint a venue that claims to be
 * payable. It is a progressively-enhanced `<form>`: it works before hydration and without any
 * client JavaScript.
 *
 * `slug` is derived rather than asked for. A unique violation (23505) on the slug is retried with
 * a fresh suffix instead of being shown to the owner, who neither chose nor cares about it.
 */

import Link from "next/link"
import { headers } from "next/headers"
import { revalidatePath } from "next/cache"
import { redirect } from "next/navigation"

import { ConnectOnboardingCard } from "@/components/venue/connect-onboarding-card"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { Textarea } from "@/components/ui/textarea"
import { requireRole } from "@/lib/rbac"
import { createClient } from "@/lib/supabase/server"
import { emptyOnboardingState, resolveSiteOrigin } from "@/lib/stripe"
import { cn } from "@/lib/utils"
import { resolveDashboardVenue } from "@/lib/venue/metrics"
import type { TablesInsert } from "@halisaha/shared/database"
import { isApiOk, type ApiResponse, type StripeOnboardingState } from "@halisaha/shared/domain"

export const dynamic = "force-dynamic"

const STATUS_TIMEOUT_MS = 5_000

const PRIMARY_LINK =
  "inline-flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium " +
  "text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none " +
  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"

const OUTLINE_LINK =
  "inline-flex h-9 items-center justify-center rounded-md border border-border bg-background px-4 " +
  "text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"

interface PageProps {
  searchParams: { venue?: string; error?: string }
}

export default async function VenueOnboardingPage({ searchParams }: PageProps) {
  const { user, profile } = await requireRole("venue_owner", "admin")
  const supabase = await createClient()

  const { venue } = await resolveDashboardVenue(supabase, user.id, {
    requestedId: searchParams.venue,
    isAdmin: profile.role === "admin",
  })

  if (!venue) {
    return (
      <div className="space-y-4">
        <StepHeader step={1} total={4} title="İşletmeni anlat" />
        {searchParams.error ? (
          <Alert variant="destructive" role="alert">
            <AlertTitle>İşletme oluşturulamadı</AlertTitle>
            <AlertDescription>{decodeURIComponent(searchParams.error)}</AlertDescription>
          </Alert>
        ) : null}
        <CreateVenueForm defaultEmail={profile.email ?? user.email ?? ""} />
      </div>
    )
  }

  const [pitchCount, onboarding] = await Promise.all([
    countBookableSahalar(supabase, venue.id),
    fetchOnboardingState(venue.id),
  ])

  const steps = [
    {
      label: "İşletme oluşturuldu",
      done: true,
      detail: `${venue.name}${venue.city ? ` · ${venue.city}` : ""} · ${venue.timezone}`,
      href: null,
      cta: null,
    },
    {
      label: "En az bir rezerve edilebilir saha",
      done: pitchCount > 0,
      detail:
        pitchCount > 0
          ? `${pitchCount} bookable ${pitchCount === 1 ? "pitch" : "pitches"}`
          : "Nothing can be booked until a pitch exists.",
      href: "/venue/pitches",
      cta: "Saha ekle",
    },
    {
      label: "Hakediş hesabı Stripe tarafından doğrulandı",
      done: onboarding.isComplete,
      detail: describeOnboarding(onboarding),
      href: null,
      cta: null,
    },
    {
      label: "İşletme yayınlandı",
      done: venue.is_active,
      detail: venue.is_active
        ? "Players can find and book this venue."
        : "Publishing turns on automatically the moment Stripe verifies you.",
      href: null,
      cta: null,
    },
  ]

  const remaining = steps.filter((step) => !step.done).length

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>
            {remaining === 0 ? "You are live" : `${remaining} step${remaining === 1 ? "" : "s"} to go`}
          </CardTitle>
          <CardDescription>
            {remaining === 0
              ? "Everything is set up. Bookings will show on your calendar as they come in."
              : "Work down the list — each item is independent, so you can do them in any order."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="space-y-3">
            {steps.map((step, index) => (
              <li key={step.label} className="flex items-start gap-3">
                <StepMark done={step.done} index={index + 1} />
                <div className="min-w-0 flex-1">
                  <p className={cn("text-sm font-medium", step.done && "text-muted-foreground")}>
                    {step.label}
                  </p>
                  <p className="text-xs text-muted-foreground">{step.detail}</p>
                </div>
                {!step.done && step.href && step.cta ? (
                  <Link href={step.href} className={OUTLINE_LINK}>
                    {step.cta}
                  </Link>
                ) : null}
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>

      <ConnectOnboardingCard
        state={onboarding}
        venueId={venue.id}
        returnPath="/venue/onboarding/complete"
      />

      {remaining === 0 ? (
        <div className="flex flex-wrap gap-3">
          <Link href="/venue" className={PRIMARY_LINK}>
            Panele git
          </Link>
          <Link href="/venue/calendar" className={OUTLINE_LINK}>
            Takvimi aç
          </Link>
        </div>
      ) : null}
    </div>
  )
}

/* ========================================================================== */
/*  Step 1 — create the venue                                                 */
/* ========================================================================== */

function CreateVenueForm({ defaultEmail }: { defaultEmail: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>İşletmen</CardTitle>
        <CardDescription>
          Şimdilik ad, adres ve saat dilimi; fotoğraflar, olanaklar ve açıklama sonra gelebilir. Bütün çalışma saatleri ve rezervasyon saatleri bu saat diliminde gösterilir, o yüzden onu doğru gir.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={createVenue} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="venue-name">İşletme adı</Label>
            <Input
              id="venue-name"
              name="name"
              required
              minLength={2}
              maxLength={120}
              autoComplete="organization"
              placeholder="Kadıköy Halı Saha"
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="venue-city">Şehir</Label>
              <Input
                id="venue-city"
                name="city"
                maxLength={80}
                autoComplete="address-level2"
                placeholder="İstanbul"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="venue-district">İlçe</Label>
              <Input id="venue-district" name="district" maxLength={80} placeholder="Kadıköy" />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="venue-address">Açık adres</Label>
            <Input
              id="venue-address"
              name="addressLine1"
              maxLength={200}
              autoComplete="street-address"
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="venue-phone">Telefon</Label>
              <Input id="venue-phone" name="phone" type="tel" maxLength={32} autoComplete="tel" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="venue-email">İletişim e-postası</Label>
              <Input
                id="venue-email"
                name="contactEmail"
                type="email"
                maxLength={254}
                defaultValue={defaultEmail}
                autoComplete="email"
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="venue-timezone">Saat dilimi</Label>
              <Input
                id="venue-timezone"
                name="timezone"
                defaultValue="Europe/Istanbul"
                required
                maxLength={64}
                aria-describedby="venue-timezone-hint"
              />
              <p id="venue-timezone-hint" className="text-xs text-muted-foreground">
                IANA saat dilimi adı, örn. Europe/Istanbul.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="venue-country">Ülke</Label>
              <Input
                id="venue-country"
                name="country"
                defaultValue="TR"
                required
                maxLength={2}
                pattern="[A-Za-z]{2}"
                aria-describedby="venue-country-hint"
              />
              <p id="venue-country-hint" className="text-xs text-muted-foreground">
                İki harfli kod. Stripe seni bu ülkede doğrular ve sonradan değiştirilemez.
              </p>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="venue-description">Açıklama</Label>
            <Textarea
              id="venue-description"
              name="description"
              rows={3}
              maxLength={2000}
              placeholder="Işıklandırılmış iki adet 7 kişilik saha, soyunma odaları, ücretsiz otopark."
            />
          </div>

          <Separator />

          <Button type="submit">İşletmeyi oluştur</Button>
        </form>
      </CardContent>
    </Card>
  )
}

/**
 * Create the venue owned by the caller.
 *
 * RLS is the boundary; `owner_id` comes from `requireRole()`'s verified session and never from
 * the submitted form. Failures come back as `?error=` on the same page rather than as a thrown
 * 500, because a validation problem is a normal thing for a form to have.
 */
async function createVenue(formData: FormData): Promise<void> {
  "use server"

  const { user } = await requireRole("venue_owner", "admin")
  const supabase = await createClient()

  const name = readField(formData, "name").slice(0, 120)
  if (name.length < 2) {
    redirect(`/venue/onboarding?error=${encodeURIComponent("The venue name is too short.")}`)
  }

  const timezone = readField(formData, "timezone") || "Europe/Istanbul"
  if (!isValidTimeZone(timezone)) {
    redirect(
      `/venue/onboarding?error=${encodeURIComponent(
        `"${timezone}" is not a recognised IANA timezone. Try Europe/Istanbul.`,
      )}`,
    )
  }

  const country = (readField(formData, "country") || "TR").toUpperCase()
  if (!/^[A-Z]{2}$/.test(country)) {
    redirect(
      `/venue/onboarding?error=${encodeURIComponent("Country must be a two-letter code, e.g. TR.")}`,
    )
  }

  const base: Omit<TablesInsert<"venues">, "slug"> = {
    owner_id: user.id,
    name,
    city: readField(formData, "city") || null,
    district: readField(formData, "district") || null,
    address_line1: readField(formData, "addressLine1") || null,
    phone: readField(formData, "phone") || null,
    contact_email: readField(formData, "contactEmail") || null,
    description: readField(formData, "description") || null,
    country,
    timezone,
  }

  // Up to three attempts: the slug carries a random suffix, so a 23505 is a collision to retry,
  // not an error for the owner to read and act on.
  let lastError: { code?: string } | null = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { data, error } = await supabase
      .from("venues")
      .insert({ ...base, slug: slugify(name) })
      .select("id")
      .single()

    if (!error && data) {
      revalidatePath("/venue", "layout")
      redirect(`/venue/onboarding?venue=${data.id}`)
    }
    if (error?.code !== "23505") {
      lastError = error
      break
    }
    lastError = error
  }

  console.error("[venue/onboarding] venue insert failed", { code: lastError?.code })
  redirect(
    `/venue/onboarding?error=${encodeURIComponent(
      "Could not create the venue. Please check the details and try again.",
    )}`,
  )
}

/* ========================================================================== */
/*  Pieces                                                                    */
/* ========================================================================== */

function StepHeader({ step, total, title }: { step: number; total: number; title: string }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Step {step} of {total}
      </p>
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
    </div>
  )
}

function StepMark({ done, index }: { done: boolean; index: number }) {
  return done ? (
    <span
      className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white dark:bg-emerald-500"
      aria-hidden="true"
    >
      <svg viewBox="0 0 16 16" className="h-3 w-3" focusable="false">
        <path
          d="M4 8.5l2.5 2.5L12 5.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  ) : (
    <span
      className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-border text-[10px] font-medium tabular-nums text-muted-foreground"
      aria-hidden="true"
    >
      {index}
    </span>
  )
}

/* ========================================================================== */
/*  Data                                                                      */
/* ========================================================================== */

async function countBookableSahalar(
  supabase: Awaited<ReturnType<typeof createClient>>,
  venueId: string,
): Promise<number> {
  // RLS is the boundary; head+count avoids transferring rows we only want to count.
  const { count, error } = await supabase
    .from("pitches")
    .select("id", { count: "exact", head: true })
    .eq("venue_id", venueId)
    .eq("is_active", true)

  if (error) {
    console.error("[venue/onboarding] pitch count failed", { code: error.code })
    return 0
  }
  return count ?? 0
}

/**
 * Ask our own status route, forwarding the session cookie, because that route also reconciles
 * `venues.charges_enabled` with Stripe as a side effect. Timed out and fallback-guarded so a slow
 * Stripe call cannot hang the render.
 */
async function fetchOnboardingState(venueId: string): Promise<StripeOnboardingState> {
  try {
    const cookie = (await headers()).get("cookie") ?? ""
    const response = await fetch(
      `${resolveSiteOrigin()}/api/stripe/connect/status?venueId=${encodeURIComponent(venueId)}`,
      {
        headers: cookie ? { cookie } : undefined,
        cache: "no-store",
        signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
      },
    )
    const payload = (await response.json()) as ApiResponse<StripeOnboardingState>
    return isApiOk(payload) ? payload.data : emptyOnboardingState()
  } catch (error) {
    console.error("[venue/onboarding] status route unreachable", {
      name: (error as { name?: unknown }).name,
    })
    return emptyOnboardingState()
  }
}

function describeOnboarding(state: StripeOnboardingState): string {
  if (state.isComplete) return "Charges and payouts are both enabled."
  if (state.accountId === null) return "Not started — Stripe collects and holds your details."
  if (state.disabledReason) {
    return `Paused by Stripe — reason code ${state.disabledReason}. Continue verification below.`
  }
  if (state.currentlyDue.length > 0) {
    return `${state.currentlyDue.length} item${state.currentlyDue.length === 1 ? "" : "s"} still needed.`
  }
  return "Submitted — Stripe is reviewing your details."
}

/* ========================================================================== */
/*  Helpers                                                                   */
/* ========================================================================== */

function readField(formData: FormData, name: string): string {
  const value = formData.get(name)
  return typeof value === "string" ? value.trim() : ""
}

/**
 * Name → lowercase kebab slug matching the `^[a-z0-9]+(-[a-z0-9]+)*$` CHECK, with a short random
 * suffix so two "Kadıköy Halı Saha"s can coexist.
 *
 * Turkish letters are transliterated explicitly BEFORE `NFD` normalisation, because `ı` and `İ`
 * do not decompose the way `ü` and `ç` do — stripping combining marks alone would turn "Halı"
 * into "hal" and lose the vowel.
 */
function slugify(name: string): string {
  const transliterated = name
    .replace(/[ıİ]/g, "i")
    .replace(/[şŞ]/g, "s")
    .replace(/[ğĞ]/g, "g")
    .replace(/[çÇ]/g, "c")
    .replace(/[öÖ]/g, "o")
    .replace(/[üÜ]/g, "u")

  const base = transliterated
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "")

  const suffix = Math.random().toString(36).slice(2, 7)
  return base.length > 0 ? `${base}-${suffix}` : `venue-${suffix}`
}

/** True when the runtime's ICU data knows this IANA zone. */
function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("tr-TR", { timeZone: zone })
    return true
  } catch {
    return false
  }
}
