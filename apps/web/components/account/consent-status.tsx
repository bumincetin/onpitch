"use client"

/**
 * components/account/consent-status.tsx
 *
 * Where a young player finds out whether their guardian has approved the account, and how to
 * chase it up.
 *
 * ---------------------------------------------------------------------------
 * THE TOKEN NEVER APPEARS HERE
 * ---------------------------------------------------------------------------
 * `public.request_parental_consent()` returns the raw token exactly once, into
 * `issueGuardianConsent()` on the server, which hands it to the mail transport and drops it.
 * Postgres only ever stored `digest(token,'sha256')`. `POST /api/auth/parental-consent/request`
 * answers with a request id, a MASKED guardian address and an expiry — and that is all this
 * component has to render. There is no code path here that could print a link, and there must
 * never be one: a consent link on screen is a consent link the child can click themselves.
 *
 * The guardian address is masked for the same reason the route masks it. The account owner
 * typed it, so it is not secret from them, but a stolen session should not be able to read a
 * parent's full address back out of the UI. Re-typing it to resend is a second signal that the
 * person at the keyboard knows who the guardian is.
 *
 * The masking happens on the SERVER, before the value becomes a prop. Props of a client
 * component are serialised into the RSC flight payload that ships inside the HTML, so masking
 * at render time here would still have left the full address in the page source. This component
 * therefore never receives the raw column — see app/(app)/account/privacy/page.tsx.
 */

import { useCallback, useId, useState } from "react"
import { useRouter } from "next/navigation"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { CONSENT_TOKEN_TTL_DAYS, DIGITAL_CONSENT_AGE } from "@/lib/gdpr"
import { toast } from "@/lib/use-toast"
import { cn } from "@/lib/utils"
import type { Enums } from "@halisaha/shared/database"
import { isApiOk, type ApiResponse } from "@halisaha/shared/domain"

export interface ConsentStatusProps {
  status: Enums<"consent_status">
  /** `profiles.guardian_email`, ALREADY masked by the server. The raw address never gets here. */
  guardianEmailMasked: string | null
  guardianName: string | null
  /** `profiles.parental_consent_at`, ISO. */
  grantedAt: string | null
  className?: string
}

interface ConsentRequestData {
  requestId: string | null
  guardianEmailMasked: string
  expiresAt: string
  /** False when the mail provider failed. The request itself is still live. */
  delivered: boolean
}

interface StatusPresentation {
  label: string
  variant: "default" | "secondary" | "success" | "warning" | "destructive" | "outline"
  headline: string
  detail: string
}

const PRESENTATION: Readonly<Record<Enums<"consent_status">, StatusPresentation>> = {
  not_required: {
    label: "Gerekmiyor",
    variant: "secondary",
    headline: "No guardian approval needed",
    detail: `This account is ${DIGITAL_CONSENT_AGE} or over, so nothing is waiting on a parent or guardian.`,
  },
  pending: {
    label: "Veli onayı bekleniyor",
    variant: "warning",
    headline: "Waiting for a guardian to approve",
    detail:
      "Booking a pitch and joining a match are paused until the approval email is followed. " +
      "Everything else — your profile, your ratings, browsing venues — works as normal.",
  },
  granted: {
    label: "Onaylandı",
    variant: "success",
    headline: "A guardian has approved this account",
    detail: "Booking and matches are open. A guardian can withdraw this at any time.",
  },
  revoked: {
    label: "Geri çekildi",
    variant: "destructive",
    headline: "A guardian withdrew their approval",
    detail:
      "Booking and matches are paused. Send a new approval email below when a guardian is ready " +
      "to restore access.",
  },
}

function formatDate(iso: string | null): string | null {
  if (!iso) return null
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return null
  return new Intl.DateTimeFormat("tr-TR", {
    dateStyle: "long",
    timeZone: "Europe/Istanbul",
  }).format(parsed)
}

export function ConsentStatus({
  status,
  guardianEmailMasked,
  guardianName,
  grantedAt,
  className,
}: ConsentStatusProps) {
  const router = useRouter()
  const baseId = useId()

  const [name, setName] = useState(guardianName ?? "")
  const [email, setEmail] = useState("")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState<ConsentRequestData | null>(null)

  const presentation = PRESENTATION[status]
  const canResend = status === "pending" || status === "revoked"
  const maskedOnFile = guardianEmailMasked

  const submit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      setError(null)

      if (name.trim().length < 2) {
        setError("Enter the name of the parent or guardian who will approve the account.")
        return
      }
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
        setError("That email address does not look right.")
        return
      }

      setPending(true)
      try {
        const response = await fetch("/api/auth/parental-consent/request", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ guardianName: name.trim(), guardianEmail: email.trim() }),
        })
        const payload = (await response.json()) as ApiResponse<ConsentRequestData>

        if (!isApiOk(payload)) {
          setError(payload.error.message)
          return
        }

        setSent(payload.data)
        setEmail("")
        toast({
          title: payload.data.delivered ? "Approval email sent" : "Approval request created",
          variant: payload.data.delivered ? "success" : "warning",
        })
        router.refresh()
      } catch {
        setError("Could not reach the server. Nothing was sent.")
      } finally {
        setPending(false)
      }
    },
    [email, name, router],
  )

  const id = (suffix: string): string => `${baseId}-${suffix}`
  const granted = formatDate(grantedAt)

  return (
    <div className={cn("space-y-4", className)}>
      <div className="flex flex-wrap items-center gap-3">
        <Badge variant={presentation.variant}>{presentation.label}</Badge>
        <p className="text-sm font-medium">{presentation.headline}</p>
      </div>

      <p className="text-sm text-muted-foreground">{presentation.detail}</p>

      <dl className="grid gap-3 rounded-md border p-4 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted-foreground">Veli</dt>
          <dd className="mt-1">{guardianName ?? "Not recorded"}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted-foreground">
            Veli e-postası
          </dt>
          <dd className="mt-1 font-mono text-xs sm:text-sm">
            {maskedOnFile ?? "Not recorded"}
          </dd>
        </div>
        {granted ? (
          <div className="sm:col-span-2">
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">Onay tarihi</dt>
            <dd className="mt-1">{granted}</dd>
          </div>
        ) : null}
      </dl>

      {sent ? (
        <Alert variant={sent.delivered ? "success" : "warning"}>
          <AlertTitle>
            {sent.delivered ? "Approval email on its way" : "Request created, email not confirmed"}
          </AlertTitle>
          <AlertDescription>
            {sent.delivered
              ? `We sent an approval link to ${sent.guardianEmailMasked}. It works for ${CONSENT_TOKEN_TTL_DAYS} days.`
              : `The request for ${sent.guardianEmailMasked} is saved and the link is live for ${CONSENT_TOKEN_TTL_DAYS} days, but our mail provider did not confirm delivery. Ask your guardian to check their spam folder before sending another.`}
          </AlertDescription>
        </Alert>
      ) : null}

      {canResend ? (
        <form onSubmit={submit} className="space-y-4 rounded-md border p-4" noValidate>
          <div>
            <h4 className="text-sm font-medium">Onay e-postasını tekrar gönder</h4>
            <p className="mt-1 text-xs text-muted-foreground">
              Re-enter your guardian&rsquo;s address — we only keep it masked here. A link lasts{" "}
              {CONSENT_TOKEN_TTL_DAYS} days and at most three can be open at once.
            </p>
          </div>

          {error ? (
            <Alert variant="destructive">
              <AlertTitle>Bunu gönderemedik</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          <fieldset className="grid gap-4 sm:grid-cols-2" disabled={pending}>
            <legend className="sr-only">Veli bilgileri</legend>

            <div className="space-y-2">
              <Label htmlFor={id("guardian-name")}>Veli adı</Label>
              <Input
                id={id("guardian-name")}
                name="guardianName"
                autoComplete="off"
                value={name}
                maxLength={120}
                onChange={(event) => setName(event.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor={id("guardian-email")}>Veli e-postası</Label>
              <Input
                id={id("guardian-email")}
                name="guardianEmail"
                type="email"
                inputMode="email"
                autoComplete="off"
                value={email}
                maxLength={254}
                placeholder={maskedOnFile ?? "guardian@example.com"}
                aria-describedby={id("guardian-email-hint")}
                onChange={(event) => setEmail(event.target.value)}
              />
              <p id={id("guardian-email-hint")} className="text-xs text-muted-foreground">
                {maskedOnFile
                  ? `On file: ${maskedOnFile}. Type it in full to confirm.`
                  : "No guardian address on file yet."}
              </p>
            </div>
          </fieldset>

          <Button type="submit" disabled={pending}>
            {pending ? "Sending…" : "Send approval email"}
          </Button>
        </form>
      ) : null}
    </div>
  )
}
