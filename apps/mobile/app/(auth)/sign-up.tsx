/**
 * app/(auth)/sign-up.tsx
 *
 * Step two of signup. The age gate has already run; this screen collects the account itself.
 *
 * `options.data` is read by `public.handle_new_user()` (0003_auth_rbac_gdpr.sql), which provisions
 * the `profiles` row from it. Two things about that are worth knowing before editing this file:
 *
 *   * The role is a REQUEST, not an assignment. The trigger allow-lists it down to
 *     `player | venue_owner`, and the `profiles_insert_role_not_admin` policy is the second lock.
 *     The picker below is honest UI, not a privilege.
 *   * `date_of_birth` drives `profiles.is_minor`, which drives the privacy lock and the consent
 *     gate. Arriving here without one is not an adult account, it is an ungateable one — hence
 *     the redirect back to the gate when the param is missing or fails to parse.
 *
 * For a minor the guardian email is kicked off over the API route rather than from here, because
 * the raw consent token must never touch a client: `request_parental_consent()` returns it once,
 * the route puts it straight into an email, and answers with nothing but a masked address.
 */

import { Redirect, useLocalSearchParams, useRouter } from 'expo-router'
import * as React from 'react'
import { Pressable, View } from 'react-native'
import { z } from 'zod'

import { Button, Card, Field, Notice, Screen, Text, Toggle } from '@/components/ui'
import { apiFetch } from '@/lib/api'
import {
  assessAge,
  CONSENT_TOKEN_TTL_DAYS,
  MINIMUM_PASSWORD_LENGTH,
  MINOR_PRIVACY_EXPLANATIONS,
} from '@/lib/gdpr'
import { env } from '@/lib/env'
import { supabase } from '@/lib/supabase'
import { useTheme } from '@/lib/theme'

type RequestedRole = 'player' | 'venue_owner'

const ROLE_OPTIONS: ReadonlyArray<{ value: RequestedRole; label: string; blurb: string }> = [
  { value: 'player', label: 'Oynamak istiyorum', blurb: 'Book pitches, join matches, build a rating.' },
  { value: 'venue_owner', label: 'Saha işletiyorum', blurb: 'List your facility and take bookings.' },
]

/** Route params are strings from another screen — parsed, not trusted, like any other input. */
const paramsSchema = z.object({
  dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  guardianName: z.string().min(2).max(120).optional(),
  guardianEmail: z.string().email().max(254).optional(),
})

/** What `POST /api/auth/parental-consent/request` answers with. */
const consentResultSchema = z.object({
  guardianEmailMasked: z.string(),
  expiresAt: z.string(),
  delivered: z.boolean(),
})

type Phase =
  | { kind: 'form' }
  /** Account created, email confirmation pending — no session exists yet. */
  | { kind: 'confirm_email'; email: string; guardianPending: boolean }
  /** Account created AND signed in, because the project has email confirmation switched off. */
  | { kind: 'signed_in'; guardianEmailMasked: string | null; guardianDelivered: boolean | null }

export default function SignUpScreen(): React.ReactElement {
  const router = useRouter()
  const theme = useTheme()
  const rawParams = useLocalSearchParams()

  const parsedParams = React.useMemo(() => paramsSchema.safeParse(normaliseParams(rawParams)), [rawParams])

  const [fullName, setFullName] = React.useState('')
  const [email, setEmail] = React.useState('')
  const [password, setPassword] = React.useState('')
  const [revealed, setRevealed] = React.useState(false)
  const [role, setRole] = React.useState<RequestedRole>('player')
  const [marketingOptIn, setMarketingOptIn] = React.useState(false)
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [phase, setPhase] = React.useState<Phase>({ kind: 'form' })

  const dob = parsedParams.success ? parsedParams.data.dob : null
  const assessment = React.useMemo(() => assessAge(dob), [dob])
  const isMinorSignup = assessment.requiresGuardianConsent

  // The opt-in is disabled for minors, not hidden. Force it off the moment the band is known so a
  // value set before this screen mounted cannot survive into `options.data`.
  React.useEffect(() => {
    if (isMinorSignup && marketingOptIn) setMarketingOptIn(false)
  }, [isMinorSignup, marketingOptIn])

  // Missing or nonsensical params mean the gate was skipped. Send them back through it rather than
  // creating an account with no birth date, which the consent gate could never act on.
  if (!parsedParams.success || assessment.band === 'unknown' || assessment.blocked) {
    return <Redirect href="/(auth)/age-gate" />
  }

  const guardianName = parsedParams.data.guardianName ?? null
  const guardianEmail = parsedParams.data.guardianEmail ?? null

  const canSubmit =
    !submitting &&
    fullName.trim().length >= 2 &&
    email.trim().length > 3 &&
    password.length >= MINIMUM_PASSWORD_LENGTH &&
    (!isMinorSignup || (guardianName !== null && guardianEmail !== null))

  async function handleSubmit(): Promise<void> {
    if (!canSubmit || dob === null) return
    setError(null)
    setSubmitting(true)

    try {
      const { data, error: signUpError } = await supabase.auth.signUp({
        email: email.trim().toLowerCase(),
        password,
        options: {
          // Read by public.handle_new_user(). Anything outside its allow-list is ignored.
          data: {
            full_name: fullName.trim(),
            display_name: fullName.trim(),
            role,
            date_of_birth: dob,
            marketing_opt_in: isMinorSignup ? false : marketingOptIn,
            // Carried so the web `/auth/callback` can start the consent email once the address is
            // confirmed, since no session exists at that point for this app to do it from.
            guardian_name: isMinorSignup ? guardianName : null,
            guardian_email: isMinorSignup ? guardianEmail : null,
          },
          // Confirmation finishes on the web app, which already owns the callback that mints the
          // guardian token. The user comes back here and signs in normally afterwards.
          emailRedirectTo: `${env.apiUrl}/auth/callback`,
        },
      })

      if (signUpError) {
        setError(humaniseSignUpError(signUpError.message))
        return
      }

      if (!data.session) {
        setPhase({ kind: 'confirm_email', email: email.trim(), guardianPending: isMinorSignup })
        return
      }

      let guardianEmailMasked: string | null = null
      let guardianDelivered: boolean | null = null

      if (isMinorSignup && guardianName && guardianEmail) {
        const consent = await requestGuardianConsent(guardianName, guardianEmail)
        guardianEmailMasked = consent.guardianEmailMasked
        guardianDelivered = consent.delivered
      }

      setPhase({ kind: 'signed_in', guardianEmailMasked, guardianDelivered })
    } catch (caught) {
      setError(
        caught instanceof Error && caught.message
          ? caught.message
          : 'Bir şeyler ters gitti. Lütfen tekrar dene.',
      )
    } finally {
      setSubmitting(false)
    }
  }

  if (phase.kind === 'confirm_email') {
    return (
      <Screen scroll>
        <Notice tone="success" title="E-postanı kontrol et" live>
          <Text variant="body" tone="muted">
            We sent a confirmation link to {phase.email}. Open it to finish creating your account,
            then come back here and sign in.
          </Text>
        </Notice>

        {phase.guardianPending ? (
          <Notice tone="warning" title="Sonrası velinde">
            <Text variant="body" tone="muted">
              As soon as you confirm your address we will email {guardianEmail ?? 'them'} the
              approval link. You can look around in the meantime — booking and joining matches
              unlock once they click it.
            </Text>
          </Notice>
        ) : null}

        <Button
          title="Girişe dön"
          size="lg"
          fullWidth
          onPress={() => router.replace('/(auth)/sign-in')}
        />
      </Screen>
    )
  }

  if (phase.kind === 'signed_in') {
    return (
      <Screen scroll>
        <Notice tone="success" title="İçeridesin" description="Hesabın hazır." live />

        {phase.guardianEmailMasked ? (
          <Notice
            tone={phase.guardianDelivered === false ? 'destructive' : 'info'}
            title={
              phase.guardianDelivered === false
                ? 'We could not send the approval email'
                : 'We have emailed your guardian'
            }
          >
            <Text variant="body" tone="muted">
              {phase.guardianDelivered === false
                ? `Your account exists and the approval link is still valid for ${CONSENT_TOKEN_TTL_DAYS} days, but the email to ${phase.guardianEmailMasked} did not go out. You can resend it from your profile.`
                : `${phase.guardianEmailMasked} has a link to approve your account. It expires in ${CONSENT_TOKEN_TTL_DAYS} days. Until they use it you can look around, but you cannot book a pitch or join a match.`}
            </Text>
          </Notice>
        ) : null}

        <Button title="Devam" size="lg" fullWidth onPress={() => router.replace('/(tabs)')} />
      </Screen>
    )
  }

  return (
    <Screen scroll>
      {error ? (
        <Notice tone="destructive" title="Hesabını oluşturamadık" description={error} live />
      ) : null}

      {isMinorSignup && guardianEmail ? (
        <Notice
          tone="warning"
          title="Velin bekleniyor"
          description={`Once you finish here we will email ${guardianEmail} a link to approve your account. Your location stays off and your profile stays private either way.`}
        />
      ) : null}

      <Field
        label="Adın"
        value={fullName}
        onChangeText={setFullName}
        placeholder="Mehmet Demir"
        autoCapitalize="words"
        autoComplete="name"
        textContentType="name"
        maxLength={120}
        required
      />

      <Field
        label="E-posta"
        value={email}
        onChangeText={setEmail}
        placeholder="you@example.com"
        autoCapitalize="none"
        autoComplete="email"
        autoCorrect={false}
        inputMode="email"
        keyboardType="email-address"
        textContentType="emailAddress"
        maxLength={254}
        required
      />

      <Field
        label="Şifre"
        value={password}
        onChangeText={setPassword}
        placeholder={`At least ${MINIMUM_PASSWORD_LENGTH} characters`}
        autoCapitalize="none"
        autoComplete="new-password"
        autoCorrect={false}
        secureTextEntry={!revealed}
        textContentType="newPassword"
        required
        hint={`${MINIMUM_PASSWORD_LENGTH} characters or more. A short phrase beats a short password.`}
        error={
          password.length > 0 && password.length < MINIMUM_PASSWORD_LENGTH
            ? `${MINIMUM_PASSWORD_LENGTH - password.length} more to go.`
            : null
        }
        right={
          <Pressable
            onPress={() => setRevealed((current) => !current)}
            accessibilityRole="button"
            accessibilityLabel={revealed ? 'Hide password' : 'Show password'}
            hitSlop={12}
          >
            <Text variant="label" tone="primary">
              {revealed ? 'Hide' : 'Show'}
            </Text>
          </Pressable>
        }
      />

      <View style={{ gap: theme.spacing.md }}>
        <Text variant="label">Buraya niye geldin?</Text>
        {ROLE_OPTIONS.map((option) => {
          const selected = role === option.value
          return (
            <Card
              key={option.value}
              onPress={() => setRole(option.value)}
              accessibilityLabel={`${option.label}. ${option.blurb}`}
              style={{
                borderColor: selected ? theme.colors.primary : theme.colors.border,
                borderWidth: selected ? 2 : 1,
              }}
            >
              <View style={{ gap: theme.spacing.xs }}>
                <Text variant="heading" tone={selected ? 'primary' : 'default'}>
                  {option.label}
                </Text>
                <Text variant="label" tone="muted">
                  {option.blurb}
                </Text>
              </View>
            </Card>
          )
        })}
      </View>

      <Toggle
        label="Yeni sahalar ve özellikler hakkında ara sıra e-posta gönderin"
        value={marketingOptIn}
        onValueChange={setMarketingOptIn}
        hint="Varsayılan olarak kapalı. İstediğin an profilinden değiştirebilirsin."
        lockedReason={isMinorSignup ? MINOR_PRIVACY_EXPLANATIONS.marketing_opt_in : null}
      />

      <Button
        title="Hesabı oluştur"
        size="lg"
        fullWidth
        loading={submitting}
        disabled={!canSubmit}
        onPress={() => void handleSubmit()}
      />

      <Notice title="Neyi neden topluyoruz">
        <Text variant="body" tone="muted">
          Adın ve e-postan hesabını tanımlar. Doğum tarihin hangi kuralların sana uygulanacağını belirler. Bir oyuncunun konumunu asla saklamayız ve hiçbir şeyi kimseye satmayız. Hakkında tuttuğumuz her şeyi profilinden indirebilir ya da silinmesini isteyebilirsin.
        </Text>
      </Notice>
    </Screen>
  )
}

/**
 * Starts the Art. 8 consent email.
 *
 * A failure here must not fail the signup: the account already exists and the consent request row
 * is valid for its full window whether or not the mail provider answered. The screen reports it
 * and offers a resend rather than rolling anything back.
 */
async function requestGuardianConsent(
  guardianName: string,
  guardianEmail: string,
): Promise<{ guardianEmailMasked: string | null; delivered: boolean }> {
  try {
    const result = await apiFetch<unknown>('/api/auth/parental-consent/request', {
      method: 'POST',
      json: { guardianName, guardianEmail },
    })

    const parsed = consentResultSchema.safeParse(result)
    if (!parsed.success) return { guardianEmailMasked: maskEmail(guardianEmail), delivered: false }

    return { guardianEmailMasked: parsed.data.guardianEmailMasked, delivered: parsed.data.delivered }
  } catch {
    // Every failure mode lands here the same way — the route refused it, the network dropped, the
    // response was unreadable. The account is created either way, so the screen falls back to a
    // locally masked address and tells the user the email did not go out.
    return { guardianEmailMasked: maskEmail(guardianEmail), delivered: false }
  }
}

/** `parent@example.com` -> `p****t@example.com`. Only used for the local fallback. */
function maskEmail(email: string): string {
  const at = email.indexOf('@')
  if (at <= 0) return '•••'
  const local = email.slice(0, at)
  const domain = email.slice(at)
  if (local.length <= 2) return `${local.charAt(0)}•••${domain}`
  return `${local.charAt(0)}${'•'.repeat(Math.min(local.length - 2, 5))}${local.charAt(local.length - 1)}${domain}`
}

/** expo-router hands params back as `string | string[]`; take the first value of a repeat. */
function normaliseParams(params: Record<string, unknown>): Record<string, string> {
  const flat: Record<string, string> = {}
  for (const [key, value] of Object.entries(params)) {
    // `noUncheckedIndexedAccess` makes `value[0]` `unknown | undefined`, so the typeof below is
    // the narrowing, not a formality.
    const first = Array.isArray(value) ? value[0] : value
    if (typeof first === 'string') flat[key] = first
  }
  return flat
}

/** The two gotrue signup failures a real person hits, in words they can act on. */
function humaniseSignUpError(message: string): string {
  const lower = message.toLowerCase()

  if (lower.includes('already registered') || lower.includes('already been registered')) {
    return 'There is already an account with that email. Sign in instead, or use a different address.'
  }
  if (lower.includes('password')) {
    return `That password was rejected: ${message}`
  }
  if (lower.includes('rate limit') || lower.includes('too many')) {
    return 'Too many attempts from this device. Wait a minute and try again.'
  }
  return message
}
