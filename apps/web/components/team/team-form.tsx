"use client"

/**
 * components/team/team-form.tsx
 *
 * Found a team, or edit the one you run. `POST /api/teams` and `PATCH /api/teams`.
 *
 * ---------------------------------------------------------------------------------------------
 * THE HANDLE IS SHOWN, NOT ASKED FOR
 * ---------------------------------------------------------------------------------------------
 * `teams.slug` is derived from the name by the same `slugify()` the route uses, so the preview
 * under the name field is exactly what the URL will be — with one caveat the copy states plainly:
 * if another team already holds it, the server appends a suffix. Asking a captain to invent a URL
 * as well as a name is a second decision for no benefit, and letting them type one invites a
 * CHECK-constraint violation they cannot diagnose.
 *
 * The handle is minted once and never changes when the team is renamed. Links live in group chats.
 *
 * ---------------------------------------------------------------------------------------------
 * VALIDATION
 * ---------------------------------------------------------------------------------------------
 * The checks here exist to answer fast and point at the right field. They are not the boundary:
 * the route re-parses the body, the CHECK constraints in `0001_schema.sql` police name length and
 * slug shape, and `teams_insert_own` / `teams_update_captain` decide whether the write lands.
 * Field-level errors that only the server knows are merged into the same error map, so they show
 * up under the input that caused them.
 */

import { useCallback, useId, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { z } from "zod"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { slugify } from "@/lib/teams/slug"
import { toast } from "@/lib/use-toast"
import { cn } from "@/lib/utils"

export interface TeamFormTeam {
  id: string
  name: string
  slug: string
  city: string | null
  description: string | null
  crestUrl: string | null
  isPublic: boolean
}

export interface TeamFormProps {
  /** Omitted to create; supplied to edit. */
  team?: TeamFormTeam
  className?: string
}

interface FormState {
  name: string
  city: string
  description: string
  crestUrl: string
  isPublic: boolean
}

const MAX_DESCRIPTION = 1000

/* ========================================================================== */

export function TeamForm({ team, className }: TeamFormProps) {
  const router = useRouter()
  const isEdit = team !== undefined
  const ids = useFieldIds()

  const [form, setForm] = useState<FormState>(() => ({
    name: team?.name ?? "",
    city: team?.city ?? "",
    description: team?.description ?? "",
    crestUrl: team?.crestUrl ?? "",
    isPublic: team?.isPublic ?? true,
  }))
  const [pending, setPending] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

  // `team` is tested directly rather than through `isEdit` at every property access, so the
  // narrowing is local and obvious instead of leaning on an aliased boolean.
  const slugPreview = useMemo(
    () => (team ? team.slug : slugify(form.name.trim())),
    [form.name, team],
  )

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
      setFormError(null)
      setFieldErrors({})

      const local = validate(form)
      if (Object.keys(local).length > 0) {
        setFieldErrors(local)
        return
      }

      setPending(true)

      const body = {
        ...(team ? { id: team.id } : {}),
        name: form.name.trim(),
        city: form.city.trim(),
        description: form.description.trim(),
        crestUrl: form.crestUrl.trim() === "" ? null : form.crestUrl.trim(),
        isPublic: form.isPublic,
      }

      let response: Response
      try {
        response = await fetch("/api/teams", {
          method: team ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(body),
        })
      } catch {
        setPending(false)
        setFormError("Could not reach the server. Check your connection and try again.")
        return
      }

      const payload: unknown = await response.json().catch(() => null)
      const failure = failureSchema.safeParse(payload)

      if (failure.success) {
        setPending(false)
        setFormError(failure.data.error.message)
        setFieldErrors(mapServerIssues(failure.data.error.details))
        return
      }

      const success = successSchema.safeParse(payload)
      if (!success.success) {
        setPending(false)
        setFormError("The server sent something we could not read. Please try again.")
        return
      }

      const slug = success.data.data.team.slug

      if (team) {
        setPending(false)
        toast({ variant: "success", title: "Takım kaydedildi" })
        router.refresh()
        return
      }

      toast({
        variant: "success",
        title: `${body.name} created`,
        description: "Kaptanı sensin. Hazır olduğunda oyuncu ekle.",
      })
      // Keep `pending` true through the navigation so the button cannot be pressed twice while
      // the new page loads.
      router.push(`/teams/${slug}`)
      router.refresh()
    },
    [form, router, team],
  )

  return (
    <form onSubmit={submit} noValidate className={cn("space-y-5", className)}>
      {formError ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>{isEdit ? "Could not save the team" : "Could not create the team"}</AlertTitle>
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      ) : null}

      <Field
        id={ids.name}
        label="Takım adı"
        error={fieldErrors.name}
        hint={
          team
            ? `The URL stays /teams/${team.slug} — renaming will not move it.`
            : form.name.trim().length > 0
              ? `URL: /teams/${slugPreview} (a suffix is added if it is already taken)`
              : "Two to eighty characters."
        }
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

      <Field
        id={ids.city}
        label="Şehir"
        error={fieldErrors.city}
        hint="İsteğe bağlı. Yakındaki oyuncuların seni bulmasını kolaylaştırır."
      >
        <Input
          id={ids.city}
          value={form.city}
          onChange={(event) => set("city", event.target.value)}
          maxLength={80}
          autoComplete="address-level2"
          aria-invalid={Boolean(fieldErrors.city)}
          aria-describedby={describedBy(ids.city, fieldErrors.city)}
        />
      </Field>

      <Field
        id={ids.description}
        label="Takım hakkında"
        error={fieldErrors.description}
        hint={`Optional. ${MAX_DESCRIPTION - form.description.length} characters left.`}
      >
        <Textarea
          id={ids.description}
          value={form.description}
          onChange={(event) => set("description", event.target.value)}
          maxLength={MAX_DESCRIPTION}
          rows={4}
          aria-invalid={Boolean(fieldErrors.description)}
          aria-describedby={describedBy(ids.description, fieldErrors.description)}
        />
      </Field>

      <Field
        id={ids.crest}
        label="Arma bağlantısı"
        error={fieldErrors.crestUrl}
        hint="İsteğe bağlı. Yüklenmiş bir görsele https bağlantısı."
      >
        <Input
          id={ids.crest}
          type="url"
          inputMode="url"
          value={form.crestUrl}
          onChange={(event) => set("crestUrl", event.target.value)}
          maxLength={2048}
          placeholder="https://"
          aria-invalid={Boolean(fieldErrors.crestUrl)}
          aria-describedby={describedBy(ids.crest, fieldErrors.crestUrl)}
        />
      </Field>

      <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
        <div className="space-y-0.5">
          <Label htmlFor={ids.isPublic}>Takım aramasında listelenir</Label>
          <p id={`${ids.isPublic}-hint`} className="text-xs text-muted-foreground">
            Listelenen bir takım keşifte görünür ve kadrosunu herkes görebilir. Listelenmeyen takıma yalnızca davetle girilir ve kadroyu yalnızca üyeleri okuyabilir.
          </p>
        </div>
        <Switch
          id={ids.isPublic}
          checked={form.isPublic}
          onCheckedChange={(value) => set("isPublic", value)}
          aria-describedby={`${ids.isPublic}-hint`}
        />
      </div>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : isEdit ? "Save changes" : "Create team"}
        </Button>
        {isEdit ? null : (
          <p className="text-xs text-muted-foreground">Takımın kaptanı sen olursun.</p>
        )}
      </div>
    </form>
  )
}

/* -------------------------------------------------------------------------- */
/*  Field primitives                                                           */
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
        // `role="alert"` because local validation failures (see `submit`) never set `formError`,
        // so the destructive Alert above the form stays unmounted and this paragraph is the only
        // thing that changes. Without a live role it is announced to nobody: focus is still on the
        // submit button, `noValidate` has suppressed the browser's own bubble, and the
        // `aria-describedby` link only speaks when the field itself is focused.
        <p id={`${id}-error`} role="alert" className="text-xs font-medium text-destructive">
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

function useFieldIds() {
  const prefix = useId()
  return useMemo(
    () => ({
      name: `${prefix}-name`,
      city: `${prefix}-city`,
      description: `${prefix}-description`,
      crest: `${prefix}-crest`,
      isPublic: `${prefix}-public`,
    }),
    [prefix],
  )
}

function describedBy(id: string, error: string | undefined): string {
  return error ? `${id}-error` : `${id}-hint`
}

/* -------------------------------------------------------------------------- */
/*  Validation and transport                                                   */
/* -------------------------------------------------------------------------- */

function validate(form: FormState): Record<string, string> {
  const errors: Record<string, string> = {}

  const name = form.name.trim()
  if (name.length < 2) errors.name = "Takım adı en az iki karakter olmalı."
  else if (name.length > 80) errors.name = "Takım adı 80 karakterden kısa olmalı."

  if (form.city.trim().length > 80) errors.city = "Keep the city under 80 characters."

  if (form.description.length > MAX_DESCRIPTION) {
    errors.description = `Keep the description under ${MAX_DESCRIPTION} characters.`
  }

  const crest = form.crestUrl.trim()
  if (crest.length > 0) {
    let parsed: URL | null = null
    try {
      parsed = new URL(crest)
    } catch {
      parsed = null
    }
    if (!parsed || parsed.protocol !== "https:") {
      errors.crestUrl = "Give a full https:// URL, or leave it empty."
    }
  }

  return errors
}

const failureSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
})

const successSchema = z.object({
  ok: z.literal(true),
  data: z.object({ team: z.object({ slug: z.string() }) }),
})

const issuesSchema = z.object({
  issues: z.array(z.object({ path: z.string(), message: z.string() })),
})

/** Map the route's `{ issues: [{ path, message }] }` onto this form's field names. */
function mapServerIssues(details: unknown): Record<string, string> {
  const parsed = issuesSchema.safeParse(details)
  if (!parsed.success) return {}

  const errors: Record<string, string> = {}
  for (const issue of parsed.data.issues) {
    if (issue.path.length > 0 && !(issue.path in errors)) errors[issue.path] = issue.message
  }
  return errors
}
