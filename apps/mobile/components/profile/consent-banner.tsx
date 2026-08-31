/**
 * components/profile/consent-banner.tsx
 *
 * What a young player sees while their account is waiting on a guardian.
 *
 * It renders for exactly two states of `profiles.parental_consent_status`: `pending`, where the
 * approval email has gone out and nobody has clicked it, and `revoked`, where a guardian used
 * their withdrawal right under GDPR Art. 7(3). In both, `private.assert_consented()` refuses the
 * booking and ranked-match paths in Postgres, so the banner is telling the truth about a rule that
 * is already enforced rather than performing a check of its own. `not_required` and `granted`
 * render nothing.
 *
 * THE TOKEN NEVER TOUCHES THIS FILE. `public.request_parental_consent()` returns the raw token
 * once, into the server route, which hands it to the mail transport and drops it; Postgres only
 * ever stored `digest(token,'sha256')`. The route answers with a request id, a MASKED guardian
 * address and an expiry, and that is all there is to render. A consent link on this screen would
 * be a consent link the child can click themselves.
 *
 * Resending asks for the guardian's name and address again rather than resending to the stored
 * one silently. Re-typing it is a second signal that the person holding the phone knows who the
 * guardian is, and it is also the only way to correct a typo in the address that never arrived.
 * So the address field starts EMPTY and shows only a masked version of what is on file. Prefilling
 * it would turn "resend" into one tap with nothing typed and defeat the whole point, and it would
 * also read a parent's full address back out of the UI to whoever is holding an unlocked phone.
 * The web client does the same — see apps/web/components/account/consent-status.tsx.
 */

import * as React from 'react'
import { View, type StyleProp, type ViewStyle } from 'react-native'

import type { Enums } from '@halisaha/shared/database'
import { z } from 'zod'

import { Button, Field, Notice, Text } from '@/components/ui'
import { apiFetch, isApiError } from '@/lib/api'
import { CONSENT_TOKEN_TTL_DAYS, DIGITAL_CONSENT_AGE } from '@/lib/gdpr'
import { formatKickoff } from '@/lib/format'
import { useTheme } from '@/lib/theme'

/** What `POST /api/auth/parental-consent/request` answers with. Parsed, never assumed. */
const consentResultSchema = z.object({
  requestId: z.string().nullable().optional(),
  guardianEmailMasked: z.string().min(1),
  expiresAt: z.string().min(1),
  delivered: z.boolean(),
})

type ConsentResult = z.infer<typeof consentResultSchema>

export interface ConsentBannerProps {
  status: Enums<'consent_status'>
  /** `profiles.guardian_name`, used to prefill the resend form. */
  guardianName?: string | null
  /**
   * `profiles.guardian_email`. Shown MASKED as a placeholder so the reader can recognise it; it
   * never prefills the input, and it is never rendered in full.
   */
  guardianEmail?: string | null
  /**
   * Names the thing the reader was about to do, so the banner explains this blockage rather than
   * blockages in general.
   */
  blocking?: 'booking' | 'ranked-match' | null
  style?: StyleProp<ViewStyle>
}

const MIN_GUARDIAN_NAME = 2
const MAX_GUARDIAN_NAME = 120
const MAX_EMAIL = 254

/** Mirrors `parentalConsentRequestSchema`, which the route enforces. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * `a***z@example.com` — enough to recognise your own address, useless to anyone else.
 *
 * Same rule as `maskEmail` in apps/web/lib/gdpr.ts, which is what the consent route applies before
 * it puts an address in a response body.
 */
function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@')
  if (!domain) return '***'
  if (local.length <= 2) return `${local[0] ?? '*'}***@${domain}`
  return `${local[0]}***${local[local.length - 1]}@${domain}`
}

export function ConsentBanner({
  status,
  guardianName = null,
  guardianEmail = null,
  blocking = null,
  style,
}: ConsentBannerProps): React.ReactElement | null {
  const theme = useTheme()

  const [open, setOpen] = React.useState(false)
  const [name, setName] = React.useState(guardianName ?? '')
  // Deliberately empty. See the header: the address has to be typed in full to resend.
  const [email, setEmail] = React.useState('')
  const [touched, setTouched] = React.useState(false)
  const [sending, setSending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [result, setResult] = React.useState<ConsentResult | null>(null)

  // A profile read can land after this mounted (the settings screen refreshes on focus), and the
  // form should adopt the stored guardian NAME until the user has typed over it. The address is
  // never adopted — it is the thing being re-confirmed.
  React.useEffect(() => {
    if (touched) return
    setName(guardianName ?? '')
  }, [guardianName, touched])

  if (status !== 'pending' && status !== 'revoked') return null

  const maskedOnFile = guardianEmail?.trim() ? maskEmail(guardianEmail.trim()) : null

  const trimmedName = name.trim()
  const trimmedEmail = email.trim()
  const nameValid = trimmedName.length >= MIN_GUARDIAN_NAME && trimmedName.length <= MAX_GUARDIAN_NAME
  const emailValid = EMAIL_PATTERN.test(trimmedEmail) && trimmedEmail.length <= MAX_EMAIL
  const canSend = !sending && nameValid && emailValid

  const blockedLine =
    blocking === 'booking'
      ? 'Booking this pitch is paused until they approve.'
      : blocking === 'ranked-match'
        ? 'Joining this match is paused until they approve.'
        : 'Booking a pitch and joining a ranked match are paused until they approve.'

  async function send(): Promise<void> {
    if (!canSend) return
    setError(null)
    setSending(true)

    try {
      const raw = await apiFetch<unknown>('/api/auth/parental-consent/request', {
        method: 'POST',
        json: { guardianName: trimmedName, guardianEmail: trimmedEmail.toLowerCase() },
      })

      const parsed = consentResultSchema.safeParse(raw)
      if (!parsed.success) {
        setError('The approval request was created, but the server sent back a reply we could not read.')
        return
      }

      setResult(parsed.data)
      setOpen(false)
    } catch (caught) {
      if (isApiError(caught)) {
        setError(caught.message)
        return
      }
      setError(
        caught instanceof Error && caught.message
          ? caught.message
          : 'Onay e-postası gönderilemedi. Hiçbir şey değişmedi.',
      )
    } finally {
      setSending(false)
    }
  }

  return (
    <Notice
      tone={status === 'revoked' ? 'destructive' : 'warning'}
      title={
        status === 'revoked'
          ? 'Your guardian has withdrawn their approval'
          : 'Waiting for a guardian to approve'
      }
      live
      style={style}
    >
      <Text variant="body" tone="muted">
        {status === 'revoked'
          ? `A parent or guardian withdrew their approval for this account. ${blockedLine} Everything else — your profile, your rating, browsing venues — still works.`
          : `Accounts under ${DIGITAL_CONSENT_AGE} need a parent or guardian to approve them (GDPR Art. 8). ${blockedLine} Everything else works as normal.`}
      </Text>

      {result ? (
        <Notice
          tone={result.delivered ? 'success' : 'warning'}
          title={result.delivered ? 'Approval email sent' : 'Approval link created'}
          live
        >
          <Text variant="body" tone="muted">
            {result.delivered
              ? `We emailed ${result.guardianEmailMasked}. The link works once and expires ${formatKickoff(result.expiresAt)}.`
              : `The link is live for ${result.guardianEmailMasked} until ${formatKickoff(result.expiresAt)}, but our mail provider would not take it just now. Try again in a few minutes if nothing arrives.`}
          </Text>
        </Notice>
      ) : null}

      {open ? (
        <View style={{ gap: theme.spacing.md }}>
          <Field
            label="Velinin adı"
            value={name}
            onChangeText={(next) => {
              setTouched(true)
              setName(next)
            }}
            autoCapitalize="words"
            autoComplete="name"
            textContentType="name"
            maxLength={MAX_GUARDIAN_NAME}
            disabled={sending}
            error={name.length > 0 && !nameValid ? 'Enter their full name.' : null}
          />

          <Field
            label="E-posta adresi"
            value={email}
            onChangeText={(next) => {
              setTouched(true)
              setEmail(next)
            }}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            // `off`, not `email`: the address wanted here is the guardian's, and offering the
            // phone owner's own saved address is both wrong and one tap from being submitted.
            autoComplete="off"
            textContentType="emailAddress"
            maxLength={MAX_EMAIL}
            disabled={sending}
            placeholder={maskedOnFile ?? 'guardian@example.com'}
            hint={
              maskedOnFile
                ? `On file: ${maskedOnFile}. Type it in full to confirm. The link expires after ${CONSENT_TOKEN_TTL_DAYS} days and can only be used once.`
                : `The link expires after ${CONSENT_TOKEN_TTL_DAYS} days and can only be used once.`
            }
            error={email.length > 0 && !emailValid ? 'That email address does not look right.' : null}
          />

          {error ? (
            <Text variant="caption" tone="destructive" accessibilityLiveRegion="polite">
              {error}
            </Text>
          ) : null}

          <View style={{ flexDirection: 'row', gap: theme.spacing.md }}>
            <Button
              title="E-postayı gönder"
              size="sm"
              loading={sending}
              disabled={!canSend}
              onPress={() => void send()}
            />
            <Button
              title="Vazgeç"
              size="sm"
              variant="ghost"
              disabled={sending}
              onPress={() => {
                setOpen(false)
                setError(null)
              }}
            />
          </View>
        </View>
      ) : (
        <View style={{ gap: theme.spacing.sm }}>
          {error ? (
            <Text variant="caption" tone="destructive" accessibilityLiveRegion="polite">
              {error}
            </Text>
          ) : null}
          <Button
            title={result ? 'Send it again' : 'Send another approval email'}
            size="sm"
            variant="outline"
            onPress={() => {
              setError(null)
              setOpen(true)
            }}
          />
        </View>
      )}
    </Notice>
  )
}
