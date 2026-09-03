"use client"

/**
 * components/account/profile-form.tsx
 *
 * The editable half of `/account`.
 *
 * The field list is not a design choice, it is the UPDATE grant from `0002_rls.sql` §4.1 minus
 * the guardian columns, which belong to the consent flow. `role`, `is_minor`,
 * `parental_consent_status`, `date_of_birth`, `email` and both Stripe ids are outside that
 * grant, so a form that offered them would be offering a write Postgres refuses. They are shown
 * as read-only facts on the page instead, each with the reason it cannot be changed here.
 *
 * Only CHANGED fields are sent. A PATCH that repeats every value would bump `updated_at` on a
 * no-op save, and it would also mean the privacy switches — which live in a sibling component
 * against the same endpoint — could be clobbered by whatever this form happened to be holding.
 *
 * Client-side limits mirror the zod schema in `app/api/account/route.ts` so the user gets the
 * error before the round trip. The route re-parses; this is feedback, not validation.
 */

import { useCallback, useId, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { z } from "zod"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { toast } from "@/lib/use-toast"
import { cn } from "@/lib/utils"
import { isApiOk, type ApiResponse } from "@onpitch/shared/domain"

/** Field -> max length, mirroring `optionalText(n)` in the route. */
const LIMITS = {
  fullName: 120,
  displayName: 60,
  phone: 24,
  city: 80,
  preferredPosition: 40,
  bio: 500,
} as const

type FieldName = keyof typeof LIMITS

interface FormState {
  fullName: string
  displayName: string
  phone: string
  city: string
  preferredPosition: string
  bio: string
}

export interface ProfileFormProps {
  initial: {
    fullName: string | null
    displayName: string | null
    phone: string | null
    city: string | null
    preferredPosition: string | null
    bio: string | null
  }
  className?: string
}

interface AccountPatchResult {
  updated: string[]
}

/** Suggestions only — `preferred_position` is free text in the schema, deliberately. */
const POSITIONS = [
  "Goalkeeper",
  "Centre-back",
  "Full-back",
  "Defensive midfield",
  "Central midfield",
  "Winger",
  "Striker",
] as const

const PHONE_PATTERN = /^\+?[\d\s()./-]{7,24}$/

function toForm(initial: ProfileFormProps["initial"]): FormState {
  return {
    fullName: initial.fullName ?? "",
    displayName: initial.displayName ?? "",
    phone: initial.phone ?? "",
    city: initial.city ?? "",
    preferredPosition: initial.preferredPosition ?? "",
    bio: initial.bio ?? "",
  }
}

/** "" means "clear this column", which is why the comparison is against a normalised null. */
function normalise(value: string): string | null {
  const trimmed = value.trim()
  return trimmed.length === 0 ? null : trimmed
}

function validate(form: FormState): Partial<Record<FieldName, string>> {
  const errors: Partial<Record<FieldName, string>> = {}

  for (const key of Object.keys(LIMITS) as FieldName[]) {
    if (form[key].trim().length > LIMITS[key]) {
      errors[key] = `Keep this under ${LIMITS[key]} characters.`
    }
  }

  const phone = form.phone.trim()
  if (phone.length > 0 && !PHONE_PATTERN.test(phone)) {
    errors.phone = "Use digits, spaces and + ( ) - only."
  }

  return errors
}

/**
 * `ApiError.details` is `Json`, so it is parsed rather than trusted. The route emits
 * `{ issues: [{ path, message }] }` for a schema failure; anything else lands on the form-level
 * banner instead of being silently dropped onto no field at all.
 */
const serverDetailsSchema = z
  .object({
    issues: z.array(z.object({ path: z.string(), message: z.string() })),
  })
  .partial()
  .passthrough()

function mapServerIssues(details: unknown): Partial<Record<FieldName, string>> {
  const parsed = serverDetailsSchema.safeParse(details)
  if (!parsed.success || !parsed.data.issues) return {}

  const mapped: Partial<Record<FieldName, string>> = {}
  for (const issue of parsed.data.issues) {
    if (issue.path in LIMITS) mapped[issue.path as FieldName] = issue.message
  }
  return mapped
}

export function ProfileForm({ initial, className }: ProfileFormProps) {
  const router = useRouter()
  const baseId = useId()

  const [saved, setSaved] = useState(() => toForm(initial))
  const [form, setForm] = useState<FormState>(() => toForm(initial))
  const [pending, setPending] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<FieldName, string>>>({})

  const dirtyFields = useMemo(
    () =>
      (Object.keys(LIMITS) as FieldName[]).filter(
        (key) => normalise(form[key]) !== normalise(saved[key]),
      ),
    [form, saved],
  )

  const set = useCallback((key: FieldName, value: string) => {
    setForm((previous) => ({ ...previous, [key]: value }))
    setFieldErrors((previous) => {
      if (!(key in previous)) return previous
      const next = { ...previous }
      delete next[key]
      return next
    })
  }, [])

  const submit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      setFormError(null)

      const local = validate(form)
      if (Object.keys(local).length > 0) {
        setFieldErrors(local)
        return
      }
      if (dirtyFields.length === 0) return

      const body: Record<string, string | null> = {}
      for (const key of dirtyFields) body[key] = normalise(form[key])

      setPending(true)
      try {
        const response = await fetch("/api/account", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(body),
        })
        const payload = (await response.json()) as ApiResponse<AccountPatchResult>

        if (!isApiOk(payload)) {
          setFormError(payload.error.message)
          setFieldErrors(mapServerIssues(payload.error.details))
          return
        }

        setSaved(form)
        toast({ title: "Profil kaydedildi", variant: "success" })
        // The header, the player page and the match roster all render these on the server.
        router.refresh()
      } catch {
        setFormError("Could not reach the server. Check your connection and try again.")
      } finally {
        setPending(false)
      }
    },
    [dirtyFields, form, router],
  )

  const id = (name: string): string => `${baseId}-${name}`
  const describedBy = (name: FieldName, hint: boolean): string | undefined => {
    const parts: string[] = []
    if (hint) parts.push(id(`${name}-hint`))
    if (fieldErrors[name]) parts.push(id(`${name}-error`))
    return parts.length > 0 ? parts.join(" ") : undefined
  }

  return (
    <form onSubmit={submit} className={cn("space-y-6", className)} noValidate>
      {formError ? (
        <Alert variant="destructive">
          <AlertTitle>Bunu kaydedemedik</AlertTitle>
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      ) : null}

      <fieldset className="grid gap-5 sm:grid-cols-2" disabled={pending}>
        <legend className="sr-only">Bilgilerin</legend>

        <div className="space-y-2">
          <Label htmlFor={id("displayName")}>Görünen ad</Label>
          <Input
            id={id("displayName")}
            name="displayName"
            value={form.displayName}
            maxLength={LIMITS.displayName}
            autoComplete="nickname"
            aria-invalid={Boolean(fieldErrors.displayName)}
            aria-describedby={describedBy("displayName", true)}
            onChange={(event) => set("displayName", event.target.value)}
          />
          <p id={id("displayName-hint")} className="text-xs text-muted-foreground">
            Takım arkadaşlarının kadroda ve sıralamada gördüğü ad.
          </p>
          <FieldError id={id("displayName-error")} message={fieldErrors.displayName} />
        </div>

        <div className="space-y-2">
          <Label htmlFor={id("fullName")}>Ad soyad</Label>
          <Input
            id={id("fullName")}
            name="fullName"
            value={form.fullName}
            maxLength={LIMITS.fullName}
            autoComplete="name"
            aria-invalid={Boolean(fieldErrors.fullName)}
            aria-describedby={describedBy("fullName", true)}
            onChange={(event) => set("fullName", event.target.value)}
          />
          <p id={id("fullName-hint")} className="text-xs text-muted-foreground">
            Rezervasyon makbuzlarında kullanılır. Diğer oyunculara gösterilmez.
          </p>
          <FieldError id={id("fullName-error")} message={fieldErrors.fullName} />
        </div>

        <div className="space-y-2">
          <Label htmlFor={id("phone")}>Telefon</Label>
          <Input
            id={id("phone")}
            name="phone"
            type="tel"
            inputMode="tel"
            value={form.phone}
            maxLength={LIMITS.phone}
            autoComplete="tel"
            placeholder="+90 5xx xxx xx xx"
            aria-invalid={Boolean(fieldErrors.phone)}
            aria-describedby={describedBy("phone", true)}
            onChange={(event) => set("phone", event.target.value)}
          />
          <p id={id("phone-hint")} className="text-xs text-muted-foreground">
            Bunu yalnızca ödemesini yaptığın rezervasyonun işletmesi görebilir.
          </p>
          <FieldError id={id("phone-error")} message={fieldErrors.phone} />
        </div>

        <div className="space-y-2">
          <Label htmlFor={id("city")}>Şehir</Label>
          <Input
            id={id("city")}
            name="city"
            value={form.city}
            maxLength={LIMITS.city}
            autoComplete="address-level2"
            aria-invalid={Boolean(fieldErrors.city)}
            aria-describedby={describedBy("city", true)}
            onChange={(event) => set("city", event.target.value)}
          />
          <p id={id("city-hint")} className="text-xs text-muted-foreground">
            Konum paylaşımı kapalıyken eşleşmenin sana yakın maçları nasıl bulduğu.
          </p>
          <FieldError id={id("city-error")} message={fieldErrors.city} />
        </div>

        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor={id("preferredPosition")}>Tercih ettiğin mevki</Label>
          <Input
            id={id("preferredPosition")}
            name="preferredPosition"
            list={id("positions")}
            value={form.preferredPosition}
            maxLength={LIMITS.preferredPosition}
            aria-invalid={Boolean(fieldErrors.preferredPosition)}
            aria-describedby={describedBy("preferredPosition", true)}
            onChange={(event) => set("preferredPosition", event.target.value)}
          />
          <datalist id={id("positions")}>
            {POSITIONS.map((position) => (
              <option key={position} value={position} />
            ))}
          </datalist>
          <p id={id("preferredPosition-hint")} className="text-xs text-muted-foreground">
            Serbest metin — bir öneri seç ya da kendin yaz. Takım dengeleme bunu değil, reytingini kullanır.
          </p>
          <FieldError
            id={id("preferredPosition-error")}
            message={fieldErrors.preferredPosition}
          />
        </div>

        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor={id("bio")}>Hakkında</Label>
          <Textarea
            id={id("bio")}
            name="bio"
            rows={4}
            value={form.bio}
            maxLength={LIMITS.bio}
            aria-invalid={Boolean(fieldErrors.bio)}
            aria-describedby={describedBy("bio", true)}
            onChange={(event) => set("bio", event.target.value)}
          />
          <p id={id("bio-hint")} className="text-xs text-muted-foreground">
            {form.bio.trim().length}/{LIMITS.bio} characters. Visible to anyone who can see your
            profile.
          </p>
          <FieldError id={id("bio-error")} message={fieldErrors.bio} />
        </div>
      </fieldset>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending || dirtyFields.length === 0}>
          {pending ? "Saving…" : "Save changes"}
        </Button>
        {dirtyFields.length > 0 && !pending ? (
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setForm(saved)
              setFieldErrors({})
              setFormError(null)
            }}
          >
            Vazgeç
          </Button>
        ) : null}
        <p aria-live="polite" className="text-xs text-muted-foreground">
          {pending
            ? "Saving your changes…"
            : dirtyFields.length === 0
              ? "Everything is saved."
              : `${dirtyFields.length} unsaved ${dirtyFields.length === 1 ? "change" : "changes"}.`}
        </p>
      </div>
    </form>
  )
}

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null
  return (
    <p id={id} className="text-xs font-medium text-destructive">
      {message}
    </p>
  )
}
