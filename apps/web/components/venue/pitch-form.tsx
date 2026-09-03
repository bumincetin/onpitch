"use client"

/**
 * components/venue/pitch-form.tsx
 *
 * Create and edit a pitch, in a dialog, against `POST` / `PATCH /api/pitches`.
 *
 * ---------------------------------------------------------------------------
 * MONEY
 * ---------------------------------------------------------------------------
 * Owners think in lira; the database, Stripe and every `*_minor` column think in kuruş. The input
 * is therefore MAJOR units and the conversion happens exactly once, at submit, through `toMinor`
 * — which rounds half away from zero and throws on a non-finite value rather than letting a float
 * become a fractional charge. There is no float anywhere downstream of this component: what it
 * sends is an integer, and `createPitchSchema` refuses anything else.
 *
 * ---------------------------------------------------------------------------
 * VALIDATION
 * ---------------------------------------------------------------------------
 * Client-side checks here exist to give fast, specific feedback — they are NOT the boundary. The
 * route re-parses with `createPitchSchema` / `updatePitchSchema`, and RLS plus the column-level
 * grants in 0002_rls.sql decide whether the write lands at all. A field-level error map from the
 * server is merged into the same UI, so a rule that only the server knows still lands on the
 * right input.
 */

import { useCallback, useEffect, useId, useMemo, useState } from "react"
import { useRouter } from "next/navigation"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import { Constants, type Enums, type Tables } from "@onpitch/shared/database"
import {
  DEFAULT_CURRENCY,
  fromMinor,
  isApiOk,
  toMinor,
  type ApiResponse,
} from "@onpitch/shared/domain"

type Pitch = Tables<"pitches">

export interface PitchFormProps {
  venueId: string
  /** Omitted for "create"; supplied for "edit". */
  pitch?: Pitch
  /** Rendered as the dialog trigger. Defaults to a sensible button. */
  trigger?: React.ReactNode
  /** Currency for the rate field. Falls back to the pitch's, then the platform default. */
  currency?: string
  className?: string
}

interface FormState {
  name: string
  format: Enums<"match_format">
  surface: Enums<"pitch_surface">
  isIndoor: boolean
  capacity: string
  hourlyRateMajor: string
  openingTime: string
  closingTime: string
  slotMinutes: string
  isActive: boolean
}

const FORMAT_LABELS: Readonly<Record<Enums<"match_format">, string>> = {
  five_a_side: "5 kişilik",
  six_a_side: "6 kişilik",
  seven_a_side: "7 kişilik",
  eight_a_side: "8 kişilik",
  eleven_a_side: "11 kişilik",
}

const SURFACE_LABELS: Readonly<Record<Enums<"pitch_surface">, string>> = {
  natural_grass: "Natural grass",
  artificial_turf: "Artificial turf",
  hybrid: "Hybrid",
  indoor_court: "Indoor court",
}

/** Matches the `slot_minutes` CHECK (15..240) with the values anyone actually sells. */
const SLOT_OPTIONS = ["30", "45", "60", "90", "120"] as const

export function PitchForm({ venueId, pitch, trigger, currency, className }: PitchFormProps) {
  const router = useRouter()
  const isEdit = Boolean(pitch)
  const activeCurrency = (currency ?? pitch?.currency ?? DEFAULT_CURRENCY).toLowerCase()

  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [form, setForm] = useState<FormState>(() => initialState(pitch, activeCurrency))

  const ids = useFieldIds()

  // Reopening after a cancel must not show the half-edited previous attempt.
  useEffect(() => {
    if (!open) return
    setForm(initialState(pitch, activeCurrency))
    setFormError(null)
    setFieldErrors({})
  }, [open, pitch, activeCurrency])

  const set = useCallback(<K extends keyof FormState>(key: K, value: FormState[K]) => {
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
      setPending(true)
      setFormError(null)
      setFieldErrors({})

      const local = validate(form)
      if (Object.keys(local).length > 0) {
        setFieldErrors(local)
        setPending(false)
        return
      }

      let hourlyRateMinor: number
      try {
        hourlyRateMinor = toMinor(Number(form.hourlyRateMajor), activeCurrency)
      } catch {
        setFieldErrors({ hourlyRateMajor: "Enter a valid hourly rate." })
        setPending(false)
        return
      }

      const body = {
        ...(isEdit ? { id: pitch!.id } : { venueId }),
        name: form.name.trim(),
        format: form.format,
        surface: form.surface,
        isIndoor: form.isIndoor,
        capacity: form.capacity.trim() === "" ? null : Number(form.capacity),
        hourlyRateMinor,
        currency: activeCurrency,
        openingTime: form.openingTime,
        closingTime: form.closingTime,
        slotMinutes: Number(form.slotMinutes),
        isActive: form.isActive,
      }

      try {
        const response = await fetch("/api/pitches", {
          method: isEdit ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(body),
        })
        const payload = (await response.json()) as ApiResponse<{ pitch: Pitch }>

        if (!isApiOk(payload)) {
          setFormError(payload.error.message)
          setFieldErrors(mapServerIssues(payload.error.details))
          setPending(false)
          return
        }

        setOpen(false)
        setPending(false)
        // The pitch list is a Server Component; refreshing re-runs its RLS-scoped query rather
        // than trusting a client-side cache to have guessed the new row correctly.
        router.refresh()
      } catch {
        setFormError("Could not reach the server. Check your connection and try again.")
        setPending(false)
      }
    },
    [activeCurrency, form, isEdit, pitch, router, venueId],
  )

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button variant={isEdit ? "outline" : "default"} size={isEdit ? "sm" : "default"}>
            {isEdit ? "Edit" : "Add pitch"}
          </Button>
        )}
      </DialogTrigger>

      <DialogContent className={cn("max-h-[90vh] overflow-y-auto sm:max-w-lg", className)}>
        <DialogHeader>
          <DialogTitle>{isEdit ? `Edit ${pitch?.name}` : "Add a pitch"}</DialogTitle>
          <DialogDescription>
            Çalışma saatleri, işletmenin saat dilimindeki duvar saatidir. Saatlik ücret, müşterinin ödediği tam fiyattır &mdash; platform komisyonu senin payından düşer, üstüne eklenmez.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} noValidate className="space-y-4">
          {formError ? (
            <Alert variant="destructive" role="alert">
              <AlertTitle>Saha kaydedilemedi</AlertTitle>
              <AlertDescription>{formError}</AlertDescription>
            </Alert>
          ) : null}

          <Field
            id={ids.name}
            label="Ad"
            error={fieldErrors.name}
            hint="Shown to players, e.g. “Pitch 1” or “Indoor court”."
          >
            <Input
              id={ids.name}
              value={form.name}
              onChange={(event) => set("name", event.target.value)}
              maxLength={80}
              required
              autoComplete="off"
              aria-invalid={Boolean(fieldErrors.name)}
              aria-describedby={describedBy(ids.name, fieldErrors.name)}
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field id={ids.format} label="Format" error={fieldErrors.format}>
              <Select
                value={form.format}
                onValueChange={(value) => set("format", value as Enums<"match_format">)}
              >
                <SelectTrigger id={ids.format}>
                  <SelectValue placeholder="Format seç" />
                </SelectTrigger>
                <SelectContent>
                  {Constants.public.Enums.match_format.map((value) => (
                    <SelectItem key={value} value={value}>
                      {FORMAT_LABELS[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field id={ids.surface} label="Zemin" error={fieldErrors.surface}>
              <Select
                value={form.surface}
                onValueChange={(value) => set("surface", value as Enums<"pitch_surface">)}
              >
                <SelectTrigger id={ids.surface}>
                  <SelectValue placeholder="Zemin seç" />
                </SelectTrigger>
                <SelectContent>
                  {Constants.public.Enums.pitch_surface.map((value) => (
                    <SelectItem key={value} value={value}>
                      {SURFACE_LABELS[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              id={ids.rate}
              label={`Hourly rate (${activeCurrency.toUpperCase()})`}
              error={fieldErrors.hourlyRateMajor}
              hint="Müşterinin bir saat için ödediği tutar."
            >
              <Input
                id={ids.rate}
                type="number"
                inputMode="decimal"
                min="0"
                step="0.01"
                value={form.hourlyRateMajor}
                onChange={(event) => set("hourlyRateMajor", event.target.value)}
                required
                aria-invalid={Boolean(fieldErrors.hourlyRateMajor)}
                aria-describedby={describedBy(ids.rate, fieldErrors.hourlyRateMajor)}
              />
            </Field>

            <Field
              id={ids.capacity}
              label="Kapasite"
              error={fieldErrors.capacity}
              hint="İsteğe bağlı. Sahanın aldığı toplam oyuncu."
            >
              <Input
                id={ids.capacity}
                type="number"
                inputMode="numeric"
                min="1"
                max="60"
                value={form.capacity}
                onChange={(event) => set("capacity", event.target.value)}
                aria-invalid={Boolean(fieldErrors.capacity)}
                aria-describedby={describedBy(ids.capacity, fieldErrors.capacity)}
              />
            </Field>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field id={ids.opening} label="Açılış" error={fieldErrors.openingTime}>
              <Input
                id={ids.opening}
                type="time"
                value={form.openingTime}
                onChange={(event) => set("openingTime", event.target.value)}
                required
                aria-invalid={Boolean(fieldErrors.openingTime)}
                aria-describedby={describedBy(ids.opening, fieldErrors.openingTime)}
              />
            </Field>

            <Field id={ids.closing} label="Kapanış" error={fieldErrors.closingTime}>
              <Input
                id={ids.closing}
                type="time"
                value={form.closingTime}
                onChange={(event) => set("closingTime", event.target.value)}
                required
                aria-invalid={Boolean(fieldErrors.closingTime)}
                aria-describedby={describedBy(ids.closing, fieldErrors.closingTime)}
              />
            </Field>

            <Field id={ids.slot} label="Saat dilimi uzunluğu" error={fieldErrors.slotMinutes}>
              <Select value={form.slotMinutes} onValueChange={(value) => set("slotMinutes", value)}>
                <SelectTrigger id={ids.slot}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SLOT_OPTIONS.map((value) => (
                    <SelectItem key={value} value={value}>
                      {value} dk
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>

          <div className="space-y-3 rounded-md border border-border p-3">
            <ToggleRow
              id={ids.indoor}
              label="Kapalı"
              description="Üstü kapalı ya da tamamen kapalı."
              checked={form.isIndoor}
              onCheckedChange={(value) => set("isIndoor", value)}
            />
            <ToggleRow
              id={ids.active}
              label="Rezerve edilebilir"
              description="Sahayı silmeden oyunculardan gizlemek için kapat."
              checked={form.isActive}
              onCheckedChange={(value) => set("isActive", value)}
            />
          </div>

          <DialogFooter className="gap-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Vazgeç
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : isEdit ? "Save changes" : "Create pitch"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/* -------------------------------------------------------------------------- */
/*  Field primitives                                                          */
/* -------------------------------------------------------------------------- */

function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string
  label: string
  hint?: string
  error?: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="text-xs font-medium text-destructive">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  )
}

function ToggleRow({
  id,
  label,
  description,
  checked,
  onCheckedChange,
}: {
  id: string
  label: string
  description: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="space-y-0.5">
        <Label htmlFor={id}>{label}</Label>
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {description}
        </p>
      </div>
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onCheckedChange}
        aria-describedby={`${id}-hint`}
      />
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  State helpers                                                             */
/* -------------------------------------------------------------------------- */

function useFieldIds() {
  const prefix = useId()
  return useMemo(
    () => ({
      name: `${prefix}-name`,
      format: `${prefix}-format`,
      surface: `${prefix}-surface`,
      rate: `${prefix}-rate`,
      capacity: `${prefix}-capacity`,
      opening: `${prefix}-opening`,
      closing: `${prefix}-closing`,
      slot: `${prefix}-slot`,
      indoor: `${prefix}-indoor`,
      active: `${prefix}-active`,
    }),
    [prefix],
  )
}

function initialState(pitch: Pitch | undefined, currency: string): FormState {
  return {
    name: pitch?.name ?? "",
    format: pitch?.format ?? "seven_a_side",
    surface: pitch?.surface ?? "artificial_turf",
    isIndoor: pitch?.is_indoor ?? false,
    capacity: pitch?.capacity != null ? String(pitch.capacity) : "",
    hourlyRateMajor:
      pitch != null ? String(fromMinor(pitch.hourly_rate_minor, currency)) : "",
    openingTime: trimSeconds(pitch?.opening_time ?? "08:00"),
    closingTime: trimSeconds(pitch?.closing_time ?? "23:00"),
    slotMinutes: String(pitch?.slot_minutes ?? 60),
    isActive: pitch?.is_active ?? true,
  }
}

/** `<input type="time">` wants `HH:MM`; Postgres hands back `HH:MM:SS`. */
function trimSeconds(value: string): string {
  return value.length >= 5 ? value.slice(0, 5) : value
}

function validate(form: FormState): Record<string, string> {
  const errors: Record<string, string> = {}

  if (form.name.trim().length === 0) errors.name = "Sahaya bir ad ver."
  if (form.name.trim().length > 80) errors.name = "Ad 80 karakterden kısa olmalı."

  const rate = Number(form.hourlyRateMajor)
  if (form.hourlyRateMajor.trim() === "" || !Number.isFinite(rate) || rate <= 0) {
    errors.hourlyRateMajor = "Enter an hourly rate greater than zero."
  }

  if (form.capacity.trim() !== "") {
    const capacity = Number(form.capacity)
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 60) {
      errors.capacity = "Capacity must be a whole number between 1 and 60."
    }
  }

  // A closing time at or before the opening time is an OVERNIGHT session (20:00 -> 02:00), not
  // an error: the schema, the pricing engine and the calendar all model it by projecting onto a
  // continuous [open, close + 24h) axis, so the slot-length check has to measure the same span.
  const openMinute = timeToMinutes(form.openingTime)
  const rawCloseMinute = timeToMinutes(form.closingTime)
  const closeMinute = rawCloseMinute <= openMinute ? rawCloseMinute + 24 * 60 : rawCloseMinute

  const slot = Number(form.slotMinutes)
  if (!Number.isInteger(slot) || slot < 15 || slot > 240) {
    errors.slotMinutes = "Slot length must be between 15 and 240 minutes."
  } else if (closeMinute - openMinute < slot) {
    errors.slotMinutes = "The opening window is shorter than one slot."
  }

  return errors
}

function timeToMinutes(value: string): number {
  const [hour = "0", minute = "0"] = value.split(":")
  return Number(hour) * 60 + Number(minute)
}

/**
 * Map the route's `{ issues: [{ path, message }] }` onto this form's field names. The server
 * speaks the camelCase schema path, which is the same key the state uses, apart from the money
 * field where the form holds MAJOR units under a different name.
 */
function mapServerIssues(details: unknown): Record<string, string> {
  const errors: Record<string, string> = {}
  if (typeof details !== "object" || details === null) return errors

  const issues = (details as { issues?: unknown }).issues
  if (!Array.isArray(issues)) return errors

  for (const issue of issues) {
    if (typeof issue !== "object" || issue === null) continue
    const path = (issue as { path?: unknown }).path
    const message = (issue as { message?: unknown }).message
    if (typeof path !== "string" || typeof message !== "string") continue
    const field = path === "hourlyRateMinor" ? "hourlyRateMajor" : path
    if (!(field in errors)) errors[field] = message
  }
  return errors
}

function describedBy(id: string, error: string | undefined): string {
  return error ? `${id}-error` : `${id}-hint`
}
