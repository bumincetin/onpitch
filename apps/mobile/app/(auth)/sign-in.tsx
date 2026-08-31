/**
 * app/(auth)/sign-in.tsx
 *
 * Email and password. There is no social provider yet, so there is no provider picker.
 *
 * On success the screen navigates itself rather than waiting for a layout to notice the session:
 * `onAuthStateChange` and the navigator would otherwise race, and the loser is a frame of the
 * sign-in form sliding out from under a tab bar.
 */

import { Link, useRouter } from 'expo-router'
import * as React from 'react'
import { Pressable, View } from 'react-native'

import { Button, Field, Notice, Screen, Text } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { useTheme } from '@/lib/theme'

export default function SignInScreen(): React.ReactElement {
  const router = useRouter()
  const theme = useTheme()

  const [email, setEmail] = React.useState('')
  const [password, setPassword] = React.useState('')
  const [revealed, setRevealed] = React.useState(false)
  const [submitting, setSubmitting] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const canSubmit = !submitting && email.trim().length > 3 && password.length > 0

  async function handleSubmit(): Promise<void> {
    if (!canSubmit) return
    setError(null)
    setSubmitting(true)

    try {
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: email.trim().toLowerCase(),
        password,
      })

      if (signInError) {
        setError(humaniseSignInError(signInError.message))
        return
      }

      router.replace('/(tabs)')
    } catch (caught) {
      setError(
        caught instanceof Error && caught.message
          ? caught.message
          : 'Sunucuya ulaşamadık. Bağlantını kontrol edip tekrar dene.',
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Screen scroll edges={['top', 'left', 'right', 'bottom']}>
      <View style={{ gap: theme.spacing.sm, marginTop: theme.spacing.xxl }}>
        <Text variant="display" tone="primary">
          Halısaha
        </Text>
        <Text variant="body" tone="muted">
          Saha tut, kadroyu doldur, skoru karara bağla.
        </Text>
      </View>

      {error ? <Notice tone="destructive" title="Girişini yapamadık" description={error} live /> : null}

      <View style={{ gap: theme.spacing.lg, marginTop: theme.spacing.lg }}>
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
          returnKeyType="next"
          maxLength={254}
        />

        <Field
          label="Şifre"
          value={password}
          onChangeText={setPassword}
          placeholder="Şifren"
          autoCapitalize="none"
          autoComplete="current-password"
          autoCorrect={false}
          secureTextEntry={!revealed}
          textContentType="password"
          returnKeyType="go"
          onSubmitEditing={() => void handleSubmit()}
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

        <Button
          title="Giriş yap"
          size="lg"
          fullWidth
          loading={submitting}
          disabled={!canSubmit}
          onPress={() => void handleSubmit()}
        />
      </View>

      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: theme.spacing.xs,
          marginTop: theme.spacing.md,
        }}
      >
        <Text variant="body" tone="muted">
          Yeni misin?
        </Text>
        <Link href="/(auth)/age-gate" asChild>
          <Pressable accessibilityRole="link" hitSlop={8}>
            <Text variant="body" tone="primary" weight="600">
              Hesap oluştur
            </Text>
          </Pressable>
        </Link>
      </View>

      <Text variant="caption" tone="muted" align="center" style={{ marginTop: theme.spacing.xl }}>
        Şifreni mi unuttun? Şimdilik web uygulamasından sıfırla.
      </Text>
    </Screen>
  )
}

/**
 * gotrue's messages are accurate and unhelpful. These are the three a real user actually hits.
 *
 * "Invalid login credentials" stays deliberately vague about WHICH half was wrong — telling an
 * attacker that the email exists turns the login form into an account enumeration oracle.
 */
function humaniseSignInError(message: string): string {
  const lower = message.toLowerCase()

  if (lower.includes('invalid login credentials')) {
    return 'That email and password do not match an account.'
  }
  if (lower.includes('email not confirmed')) {
    return 'Confirm your email address first — check your inbox for the link we sent.'
  }
  if (lower.includes('too many requests') || lower.includes('rate limit')) {
    return 'Too many attempts. Wait a minute and try again.'
  }
  return message
}
