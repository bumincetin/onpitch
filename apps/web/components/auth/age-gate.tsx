"use client"

/**
 * components/auth/age-gate.tsx
 *
 * GDPR Article 8 age gate — the first screen of the signup flow.
 *
 * Three outcomes, decided client-side from the birth date so nobody wastes a round trip:
 *
 *   under 13   -> signup is REFUSED, with a sentence explaining why and what to do instead.
 *   13 to 15   -> the flow switches to collecting a guardian's name and email; the account is
 *                 created but cannot book or play until the guardian clicks the emailed link.
 *   16 and up  -> nothing extra; the person consents for themselves.
 *
 * This component is a UX and honesty layer, not a security control — every decision it makes is
 * re-made in Postgres by `private.is_minor_dob()`, `enforce_minor_privacy` and
 * `assert_consented()`. A user who patches the JavaScript gets a 42501 instead of a nice
 * paragraph; that is the correct failure mode.
 *
 * Copy rules followed here, deliberately: address the young person directly, say what happens
 * and why, name the guardian's role without shaming, and never use the word "consent" as though
 * a 13-year-old owes us anything.
 */

import * as React from "react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"
import {
  assessAge,
  DIGITAL_CONSENT_AGE,
  MINIMUM_SIGNUP_AGE,
  MIN_BIRTH_DATE_INPUT_VALUE,
  maxBirthDateInputValue,
  type AgeAssessment,
} from "@/lib/gdpr"

export interface AgeGateValue {
  /** `YYYY-MM-DD`, straight from `<input type="date">`. */
  dateOfBirth: string
  guardianName: string
  guardianEmail: string
}

export const EMPTY_AGE_GATE_VALUE: AgeGateValue = {
  dateOfBirth: "",
  guardianName: "",
  guardianEmail: "",
}

export interface AgeGateProps {
  value: AgeGateValue
  onChange: (next: AgeGateValue) => void
  /** Fires whenever the band changes, so the parent form can enable/disable submit. */
  onAssessmentChange?: (assessment: AgeAssessment) => void
  disabled?: boolean
  /** Namespaces the input ids when more than one gate is on a page. */
  idPrefix?: string
  className?: string
}

export interface AgeGateValidation {
  assessment: AgeAssessment
  /** True when the gate is satisfied and the parent form may submit. */
  ok: boolean
  /** Single, user-facing reason the gate is not satisfied. */
  error: string | null
}

const GUARDIAN_EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/

/**
 * Pure validator, exported so the signup form (and tests) can ask the same question the UI is
 * answering without duplicating the rules.
 */
export function validateAgeGate(value: AgeGateValue, now: Date = new Date()): AgeGateValidation {
  const assessment = assessAge(value.dateOfBirth, now)

  if (assessment.band === "unknown") {
    return { assessment, ok: false, error: "Lütfen doğum tarihini gir." }
  }

  if (assessment.blocked) {
    return { assessment, ok: false, error: assessment.message }
  }

  if (assessment.requiresGuardianConsent) {
    if (value.guardianName.trim().length < 2) {
      return { assessment, ok: false, error: "Lütfen velinin adını gir." }
    }
    if (!GUARDIAN_EMAIL_PATTERN.test(value.guardianEmail.trim())) {
      return {
        assessment,
        ok: false,
        error: "Lütfen velinize ulaşabileceğimiz bir e-posta adresi gir.",
      }
    }
  }

  return { assessment, ok: true, error: null }
}

export function AgeGate({
  value,
  onChange,
  onAssessmentChange,
  disabled = false,
  idPrefix = "age-gate",
  className,
}: AgeGateProps) {
  // Computed on the client only. Deriving it during SSR would risk a hydration mismatch across
  // a UTC midnight boundary, for a `max` attribute that is a convenience, not a rule.
  const [maxDate, setMaxDate] = React.useState<string | undefined>(undefined)
  React.useEffect(() => {
    setMaxDate(maxBirthDateInputValue())
  }, [])

  const assessment = React.useMemo(() => assessAge(value.dateOfBirth), [value.dateOfBirth])

  const lastBandRef = React.useRef<AgeAssessment["band"] | null>(null)
  React.useEffect(() => {
    if (lastBandRef.current !== assessment.band) {
      lastBandRef.current = assessment.band
      onAssessmentChange?.(assessment)
    }
  }, [assessment, onAssessmentChange])

  const dobId = `${idPrefix}-date-of-birth`
  const guardianNameId = `${idPrefix}-guardian-name`
  const guardianEmailId = `${idPrefix}-guardian-email`
  const noticeId = `${idPrefix}-notice`

  const patch = (partial: Partial<AgeGateValue>) => onChange({ ...value, ...partial })

  return (
    <div className={cn("space-y-4", className)}>
      <div className="space-y-2">
        <Label htmlFor={dobId}>Doğum tarihi</Label>
        <Input
          id={dobId}
          name="dateOfBirth"
          type="date"
          required
          autoComplete="bday"
          disabled={disabled}
          min={MIN_BIRTH_DATE_INPUT_VALUE}
          max={maxDate}
          value={value.dateOfBirth}
          onChange={(event) => patch({ dateOfBirth: event.target.value })}
          aria-describedby={assessment.message ? noticeId : `${dobId}-hint`}
          aria-invalid={assessment.blocked || undefined}
        />
        <p id={`${dobId}-hint`} className="text-xs text-muted-foreground">
          We ask because the law sets different rules for players under {DIGITAL_CONSENT_AGE}. We
          store the date itself, never share it, and use it for nothing else.
        </p>
      </div>

      {assessment.band === "under_minimum" && (
        <Alert variant="destructive" id={noticeId}>
          <AlertTitle>Sana henüz hesap oluşturamıyoruz</AlertTitle>
          <AlertDescription>{assessment.message}</AlertDescription>
        </Alert>
      )}

      {assessment.band === "minor" && (
        <div className="space-y-4">
          <Alert id={noticeId}>
            <AlertTitle>
              Bu hesabı bir velinin onaylaması gerekiyor
            </AlertTitle>
            <AlertDescription>
              <p>{assessment.message}</p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
                <li>
                  Konumun kapalı kalır. Maç önerileri bunun yerine şehrini kullanır; kimse nerede olduğunu görmez.
                </li>
                <li>
                  Profilin asla herkese açık olmaz — yalnızca birlikte oynadığın kişiler görebilir.
                </li>
                <li>Sana asla pazarlama e-postası göndermeyiz.</li>
                <li>
                  Onaylayana kadar etrafa bakabilirsin ama saha tutamaz, maça katılamazsın.
                </li>
              </ul>
              <p className="mt-2 text-sm">
                These stay in place until you turn {DIGITAL_CONSENT_AGE} — approval doesn&apos;t
                unlock them.
              </p>
            </AlertDescription>
          </Alert>

          <Separator />

          <fieldset className="space-y-4" disabled={disabled}>
            <legend className="text-sm font-medium">Annen, baban ya da velin</legend>

            <div className="space-y-2">
              <Label htmlFor={guardianNameId}>Ad soyadı</Label>
              <Input
                id={guardianNameId}
                name="guardianName"
                type="text"
                required
                minLength={2}
                maxLength={120}
                autoComplete="off"
                placeholder="Ayşe Yılmaz"
                value={value.guardianName}
                onChange={(event) => patch({ guardianName: event.target.value })}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor={guardianEmailId}>E-posta adresi</Label>
              <Input
                id={guardianEmailId}
                name="guardianEmail"
                type="email"
                required
                maxLength={254}
                autoComplete="off"
                inputMode="email"
                placeholder="parent@example.com"
                value={value.guardianEmail}
                onChange={(event) => patch({ guardianEmail: event.target.value })}
                aria-describedby={`${guardianEmailId}-hint`}
              />
              <p id={`${guardianEmailId}-hint`} className="text-xs text-muted-foreground">
                Onaylaması için tıklayabileceği tek bir e-posta göndeririz. Bağlantı yedi gün sonra geçersiz olur ve adresini başka hiçbir şey için kullanmayız.
              </p>
            </div>
          </fieldset>
        </div>
      )}

      {assessment.band === "minor" && (
        <p className="text-xs text-muted-foreground">
          Not under {DIGITAL_CONSENT_AGE}? Check the date above — we only ask for a guardian when
          the date you entered puts you between {MINIMUM_SIGNUP_AGE} and {DIGITAL_CONSENT_AGE - 1}.
        </p>
      )}
    </div>
  )
}
