/**
 * app/(auth)/age-gate.tsx
 *
 * GDPR Article 8. The first screen of signup, before any account details are collected.
 *
 * Three outcomes, decided here so nobody spends a round trip to find out:
 *
 *   under 13   refuse, say why, and point at the alternative.
 *   13 to 15   collect a guardian's name and email. The account gets created, but it cannot book
 *              or join a match until the guardian clicks the link we email them.
 *   16 and up  nothing extra.
 *
 * It runs first on purpose. Asking for a birth date after someone has typed a name, an email and
 * a password, and then refusing them, is a worse experience and collects more personal data than
 * the answer required.
 *
 * Nothing here is a security control — `private.is_minor_dob()` and `enforce_minor_privacy` make
 * the same decisions in Postgres, and they are the ones that count.
 *
 * The date of birth and the guardian details travel to the next screen as route params. No
 * credential ever does: the password is typed on `sign-up.tsx` and never leaves its state.
 */

import { useRouter } from 'expo-router'
import * as React from 'react'
import { View } from 'react-native'

import { Button, Field, Notice, NoticeBullet, Screen, Text } from '@/components/ui'
import { assessAge, DIGITAL_CONSENT_AGE, MINIMUM_SIGNUP_AGE } from '@/lib/gdpr'
import { useTheme } from '@/lib/theme'

/** Same shape the web signup form validates guardian addresses with. */
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/

/** `profiles_dob_sane_check` rejects anything on or before 1900-01-01. */
const EARLIEST_BIRTH_YEAR = 1901

export default function AgeGateScreen(): React.ReactElement {
  const router = useRouter()
  const theme = useTheme()

  const [day, setDay] = React.useState('')
  const [month, setMonth] = React.useState('')
  const [year, setYear] = React.useState('')
  const [guardianName, setGuardianName] = React.useState('')
  const [guardianEmail, setGuardianEmail] = React.useState('')
  const [touched, setTouched] = React.useState(false)

  const dateOfBirth = React.useMemo(() => composeDateOfBirth(day, month, year), [day, month, year])
  const assessment = React.useMemo(() => assessAge(dateOfBirth), [dateOfBirth])
  const needsGuardian = assessment.requiresGuardianConsent

  const dateEntered = day.length > 0 && month.length > 0 && year.length === 4
  const dateError = touched && dateEntered && dateOfBirth === null ? 'That is not a real date.' : null

  const guardianNameError =
    touched && needsGuardian && guardianName.trim().length < 2
      ? 'We need their name for the email.'
      : null
  const guardianEmailError =
    touched && needsGuardian && !EMAIL_PATTERN.test(guardianEmail.trim())
      ? 'That does not look like an email address.'
      : null

  const canContinue =
    dateOfBirth !== null &&
    !assessment.blocked &&
    (!needsGuardian ||
      (guardianName.trim().length >= 2 && EMAIL_PATTERN.test(guardianEmail.trim())))

  function handleContinue(): void {
    setTouched(true)
    if (!canContinue || dateOfBirth === null) return

    router.push({
      pathname: '/(auth)/sign-up',
      params: needsGuardian
        ? {
            dob: dateOfBirth,
            guardianName: guardianName.trim(),
            guardianEmail: guardianEmail.trim().toLowerCase(),
          }
        : { dob: dateOfBirth },
    })
  }

  return (
    <Screen scroll>
      <View style={{ gap: theme.spacing.sm }}>
        <Text variant="title">Ne zaman doğdun?</Text>
        <Text variant="body" tone="muted">
          The law sets different rules for players under {DIGITAL_CONSENT_AGE}. We store the date,
          use it for nothing else, and never show it to anyone.
        </Text>
      </View>

      <View style={{ flexDirection: 'row', gap: theme.spacing.md }}>
        <Field
          label="Gün"
          containerStyle={{ flex: 1 }}
          value={day}
          onChangeText={(next) => setDay(digitsOnly(next, 2))}
          placeholder="14"
          keyboardType="number-pad"
          inputMode="numeric"
          maxLength={2}
          autoComplete="birthdate-day"
        />
        <Field
          label="Ay"
          containerStyle={{ flex: 1 }}
          value={month}
          onChangeText={(next) => setMonth(digitsOnly(next, 2))}
          placeholder="03"
          keyboardType="number-pad"
          inputMode="numeric"
          maxLength={2}
          autoComplete="birthdate-month"
        />
        <Field
          label="Yıl"
          containerStyle={{ flex: 1.4 }}
          value={year}
          onChangeText={(next) => setYear(digitsOnly(next, 4))}
          placeholder="2005"
          keyboardType="number-pad"
          inputMode="numeric"
          maxLength={4}
          autoComplete="birthdate-year"
          error={dateError}
        />
      </View>

      {assessment.band === 'under_minimum' && assessment.message ? (
        <Notice tone="destructive" title="Sana henüz hesap oluşturamıyoruz" live>
          <Text variant="body" tone="muted">
            {assessment.message}
          </Text>
          <Button
            title="Girişe dön"
            variant="outline"
            onPress={() => router.replace('/(auth)/sign-in')}
            style={{ marginTop: theme.spacing.sm }}
          />
        </Notice>
      ) : null}

      {needsGuardian && assessment.message ? (
        <View style={{ gap: theme.spacing.lg }}>
          <Notice tone="warning" title="Bu hesabı bir velinin onaylaması gerekiyor" live>
            <Text variant="body" tone="muted">
              {assessment.message}
            </Text>
            <View style={{ gap: theme.spacing.xs, marginTop: theme.spacing.sm }}>
              <NoticeBullet>
                Konumun kapalı kalır. Yakınındaki maçlar şehrinden bulunur; kimse nerede olduğunu görmez.
              </NoticeBullet>
              <NoticeBullet>
                Profilin asla herkese açık olmaz — yalnızca birlikte oynadığın kişiler görebilir.
              </NoticeBullet>
              <NoticeBullet>Sana asla pazarlama e-postası göndermeyiz.</NoticeBullet>
              <NoticeBullet>
                Onaylayana kadar etrafa bakabilirsin ama saha tutamaz, maça katılamazsın.
              </NoticeBullet>
            </View>
            <Text variant="body" tone="muted" style={{ marginTop: theme.spacing.sm }}>
              These stay in place until you turn {DIGITAL_CONSENT_AGE}. Approval does not unlock
              them.
            </Text>
          </Notice>

          <View style={{ gap: theme.spacing.lg }}>
            <Text variant="heading">Annen, baban ya da velin</Text>

            <Field
              label="Ad soyadı"
              value={guardianName}
              onChangeText={setGuardianName}
              placeholder="Ayşe Yılmaz"
              autoCapitalize="words"
              autoComplete="off"
              maxLength={120}
              required
              error={guardianNameError}
            />

            <Field
              label="E-posta adresi"
              value={guardianEmail}
              onChangeText={setGuardianEmail}
              placeholder="parent@example.com"
              autoCapitalize="none"
              autoComplete="off"
              autoCorrect={false}
              inputMode="email"
              keyboardType="email-address"
              maxLength={254}
              required
              error={guardianEmailError}
              hint="Tek e-posta, tek bağlantı, yedi gün geçerli. Adresini başka hiçbir şey için kullanmayız."
            />
          </View>
        </View>
      ) : null}

      <Button
        title="Devam"
        size="lg"
        fullWidth
        disabled={assessment.blocked || !dateEntered}
        onPress={handleContinue}
      />

      <Text variant="caption" tone="muted">
        You need to be at least {MINIMUM_SIGNUP_AGE} to have an account of your own.
      </Text>
    </Screen>
  )
}

/** Strips everything that is not a digit and caps the length, so paste cannot smuggle text in. */
function digitsOnly(value: string, maxLength: number): string {
  return value.replace(/\D/g, '').slice(0, maxLength)
}

/**
 * Builds `YYYY-MM-DD` from three fields, or null when they do not describe a real past date.
 *
 * The round-trip check at the end is what rejects 31 February: `new Date('2011-02-31')` does not
 * throw, it silently becomes 3 March, and a date that quietly changes itself is worse than one
 * that is refused.
 */
function composeDateOfBirth(day: string, month: string, year: string): string | null {
  if (!/^\d{1,2}$/.test(day) || !/^\d{1,2}$/.test(month) || !/^\d{4}$/.test(year)) return null

  const d = Number(day)
  const m = Number(month)
  const y = Number(year)

  if (m < 1 || m > 12 || d < 1 || d > 31) return null
  if (y < EARLIEST_BIRTH_YEAR) return null

  const iso = `${y.toString().padStart(4, '0')}-${pad2(m)}-${pad2(d)}`
  const parsed = new Date(`${iso}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime())) return null

  if (
    parsed.getUTCFullYear() !== y ||
    parsed.getUTCMonth() + 1 !== m ||
    parsed.getUTCDate() !== d
  ) {
    return null
  }

  if (parsed.getTime() > Date.now()) return null

  return iso
}

function pad2(value: number): string {
  return value.toString().padStart(2, '0')
}
