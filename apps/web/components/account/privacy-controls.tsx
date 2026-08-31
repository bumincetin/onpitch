"use client"

/**
 * components/account/privacy-controls.tsx
 *
 * The three switches that `enforce_minor_privacy` and `profiles_minor_privacy_locked_check`
 * hard-lock for an under-16 account: location sharing, profile visibility and marketing email.
 *
 * ---------------------------------------------------------------------------
 * WHY A MINOR SEES THEM AT ALL
 * ---------------------------------------------------------------------------
 * They are rendered OFF and DISABLED, never hidden. `lib/gdpr.ts` states the reasoning where the
 * rule lives, and it is worth repeating at the point of use: hiding a control teaches a young
 * user that the platform is opaque and leaves them unable to tell a policy from a bug. A greyed
 * switch with one sentence next to it is the Art. 12 answer, and it is also how they learn the
 * setting is waiting for them at 16.
 *
 * No disabled switch is ever included in a PATCH body. The database would reject the statement,
 * and a form that knowingly sends a doomed write is a form that will one day show a constraint
 * violation to a fifteen-year-old.
 *
 * ---------------------------------------------------------------------------
 * SAVING
 * ---------------------------------------------------------------------------
 * Each switch saves on its own, immediately, and rolls back visually if the route refuses. The
 * alternative — a Save button under three toggles — leaves a privacy setting looking changed
 * while it is not, which is the one place in the app where that gap is unacceptable.
 */

import { useCallback, useId, useState } from "react"
import { useRouter } from "next/navigation"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { DIGITAL_CONSENT_AGE, type LockedPrivacyField } from "@/lib/gdpr"
import { toast } from "@/lib/use-toast"
import { cn } from "@/lib/utils"
import {
  isApiOk,
  type ApiResponse,
  type ProfileVisibility,
} from "@halisaha/shared/domain"

export interface PrivacyControlsProps {
  /** Effective values, already run through `enforcePrivacyDefaults()` on the server. */
  locationSharingEnabled: boolean
  profileVisibility: ProfileVisibility
  marketingOptIn: boolean
  /** From `enforcePrivacyDefaults().lockedFields`. Empty for an adult. */
  lockedFields: readonly LockedPrivacyField[]
  className?: string
}

interface AccountPatchResult {
  privacy: {
    locationSharingEnabled: boolean
    profileVisibility: ProfileVisibility
    marketingOptIn: boolean
  }
}

/** The PATCH key each switch writes. */
type SwitchKey = "locationSharingEnabled" | "profileVisibility" | "marketingOptIn"

/**
 * One sentence, said once, for every locked control. `lib/gdpr.ts` ships longer per-field copy;
 * the requirement here is a single plain statement of the rule, with the per-field detail
 * carried by each control's own description.
 */
function minorNotice(): string {
  return `This account is registered as under ${DIGITAL_CONSENT_AGE}, so location sharing, a public profile and marketing email stay off until then.`
}

export function PrivacyControls({
  locationSharingEnabled,
  profileVisibility,
  marketingOptIn,
  lockedFields,
  className,
}: PrivacyControlsProps) {
  const router = useRouter()
  const baseId = useId()

  const [location, setLocation] = useState(locationSharingEnabled)
  const [visibility, setVisibility] = useState<ProfileVisibility>(profileVisibility)
  const [marketing, setMarketing] = useState(marketingOptIn)

  /**
   * `profile_visibility` has three values and this is one switch, so turning "public" off has to
   * choose between `members` and `private`. It restores whichever the account was last on rather
   * than picking one: a `private` profile that gets toggled public and back must not quietly end
   * up `members`, which is strictly more open than where it started.
   */
  const [nonPublicVisibility, setNonPublicVisibility] = useState<ProfileVisibility>(
    profileVisibility === "public" ? "private" : profileVisibility,
  )
  const [busy, setBusy] = useState<SwitchKey | null>(null)
  const [error, setError] = useState<string | null>(null)

  const locked = (field: LockedPrivacyField): boolean => lockedFields.includes(field)
  const isMinorAccount = lockedFields.length > 0

  const save = useCallback(
    async (key: SwitchKey, value: boolean | ProfileVisibility, rollback: () => void) => {
      setError(null)
      setBusy(key)
      try {
        const response = await fetch("/api/account", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ [key]: value }),
        })
        const payload = (await response.json()) as ApiResponse<AccountPatchResult>

        if (!isApiOk(payload)) {
          rollback()
          setError(payload.error.message)
          return
        }

        // Trust the server's post-trigger values over the optimistic ones.
        setLocation(payload.data.privacy.locationSharingEnabled)
        setVisibility(payload.data.privacy.profileVisibility)
        setMarketing(payload.data.privacy.marketingOptIn)
        toast({ title: "Gizlilik ayarları kaydedildi", variant: "success" })
        router.refresh()
      } catch {
        rollback()
        setError("Sunucuya ulaşılamadı. Hiçbir şey değişmedi.")
      } finally {
        setBusy(null)
      }
    },
    [router],
  )

  const id = (name: string): string => `${baseId}-${name}`

  return (
    <div className={cn("space-y-6", className)}>
      {isMinorAccount ? (
        <Alert>
          <AlertTitle>Bu üçü kilitli</AlertTitle>
          <AlertDescription>{minorNotice()}</AlertDescription>
        </Alert>
      ) : null}

      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Bu ayar kaydedilmedi</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {/* ---- location sharing ------------------------------------------------ */}
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <Label
            htmlFor={id("location")}
            className={cn(locked("location_sharing_enabled") && "text-muted-foreground")}
          >
            Konumumu paylaş
          </Label>
          <p id={id("location-hint")} className="text-sm text-muted-foreground">
            Açıkken maç bulucu tarayıcına nerede olduğunu sorabilir ve açık maçları mesafeye göre sıralar — 3 km&apos;deki sahayı 20 km&apos;dekinin üstüne koyar. Konum yalnızca bu sıralama için kullanılır ve atılır; sakladığımız şey bu anahtarın cevabıdır, koordinatların değil. Kapalıyken maçlar profilindeki şehre göre sıralanır; bu daha kabadır ama aynı ilçedeki aynı maçları bulur.
          </p>
        </div>
        <Switch
          id={id("location")}
          checked={locked("location_sharing_enabled") ? false : location}
          disabled={busy !== null || locked("location_sharing_enabled")}
          aria-describedby={
            locked("location_sharing_enabled")
              ? `${id("location-hint")} ${id("location-locked")}`
              : id("location-hint")
          }
          onCheckedChange={(next) => {
            const previous = location
            setLocation(next)
            void save("locationSharingEnabled", next, () => setLocation(previous))
          }}
        />
      </div>
      {locked("location_sharing_enabled") ? (
        <p id={id("location-locked")} className="sr-only">
          Disabled because this account is under {DIGITAL_CONSENT_AGE}.
        </p>
      ) : null}

      <Separator />

      {/* ---- public profile -------------------------------------------------- */}
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <Label
            htmlFor={id("visibility")}
            className={cn(locked("profile_visibility") && "text-muted-foreground")}
          >
            Herkese açık profil
          </Label>
          <p id={id("visibility-hint")} className="text-sm text-muted-foreground">
            On, any signed-in player can open your profile and see your display name, city,
            position, bio and rating. Off,{" "}
            {nonPublicVisibility === "members"
              ? "only players you have shared a match with can."
              : "nobody but you can."}{" "}
            {locked("profile_visibility")
              ? "Teammates can still find you; strangers and search engines cannot."
              : ""}
          </p>
        </div>
        <Switch
          id={id("visibility")}
          checked={locked("profile_visibility") ? false : visibility === "public"}
          disabled={busy !== null || locked("profile_visibility")}
          aria-describedby={
            locked("profile_visibility")
              ? `${id("visibility-hint")} ${id("visibility-locked")}`
              : id("visibility-hint")
          }
          onCheckedChange={(next) => {
            const previous = visibility
            if (!next && previous !== "public") setNonPublicVisibility(previous)
            const value: ProfileVisibility = next ? "public" : nonPublicVisibility
            setVisibility(value)
            void save("profileVisibility", value, () => setVisibility(previous))
          }}
        />
      </div>
      {locked("profile_visibility") ? (
        <p id={id("visibility-locked")} className="sr-only">
          Disabled because this account is under {DIGITAL_CONSENT_AGE}.
        </p>
      ) : null}

      <Separator />

      {/* ---- marketing ------------------------------------------------------- */}
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <Label
            htmlFor={id("marketing")}
            className={cn(locked("marketing_opt_in") && "text-muted-foreground")}
          >
            Ara sıra Halısaha e-postası
          </Label>
          <p id={id("marketing-hint")} className="text-sm text-muted-foreground">
            Yılda birkaç kez yakınındaki yeni sahalar ve ürün haberleri. Rezervasyon onayları, iadeler ve maç uyarıları pazarlama değildir ve her hâlükârda gelmeye devam eder.
          </p>
        </div>
        <Switch
          id={id("marketing")}
          checked={locked("marketing_opt_in") ? false : marketing}
          disabled={busy !== null || locked("marketing_opt_in")}
          aria-describedby={
            locked("marketing_opt_in")
              ? `${id("marketing-hint")} ${id("marketing-locked")}`
              : id("marketing-hint")
          }
          onCheckedChange={(next) => {
            const previous = marketing
            setMarketing(next)
            void save("marketingOptIn", next, () => setMarketing(previous))
          }}
        />
      </div>
      {locked("marketing_opt_in") ? (
        <p id={id("marketing-locked")} className="sr-only">
          Disabled because this account is under {DIGITAL_CONSENT_AGE}.
        </p>
      ) : null}

      <p aria-live="polite" className="text-xs text-muted-foreground">
        {busy ? "Saving…" : "Changes save as you make them."}
      </p>
    </div>
  )
}
