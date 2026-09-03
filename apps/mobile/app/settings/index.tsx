/**
 * app/settings/index.tsx
 *
 * Account settings: the parts of your profile you are allowed to change, and the parts you are not.
 *
 * WHAT IS EDITABLE HERE IS DECIDED BY A GRANT, NOT BY THIS FORM
 * -------------------------------------------------------------
 * `0002_rls.sql` §4.1 grants `authenticated` UPDATE on exactly: full_name, display_name,
 * avatar_url, guardian_email, guardian_name, location_sharing_enabled, profile_visibility,
 * marketing_opt_in, phone, city, preferred_position, bio, last_seen_at, onboarding_completed_at.
 * The six fields below are that list minus the ones that belong to another screen — the privacy
 * trio lives in `settings/privacy`, and the guardian pair belongs to the consent flow, which mints
 * a token as part of the same gesture.
 *
 * `email`, `role`, `date_of_birth`, `is_minor`, `parental_consent_status` and the Stripe ids are
 * outside the grant on purpose, so they are shown read-only with the reason rather than hidden.
 * `date_of_birth` in particular is insertable but not updatable: `is_minor` is GENERATED STORED and
 * recomputed on every UPDATE, so a minor who could PATCH an adult birth date would clear the whole
 * Art. 8 gate in one request.
 *
 * Empty input means "clear this field", so it is written as NULL rather than as an empty string.
 * Every one of these columns is nullable, and `city is null` filters would be quietly wrong
 * otherwise.
 */

import { useRouter } from 'expo-router'
import * as React from 'react'
import { RefreshControl, View } from 'react-native'

import type { TablesUpdate } from '@onpitch/shared/database'

import { Badge, Button, Card, Field, Notice, Screen, Separator, Text } from '@/components/ui'
import { ScreenHeader, displayNameOf, useMyProfile, type MyProfile } from '@/components/profile'
import { formatDayLabel } from '@/lib/format'
import { supabase, useSession } from '@/lib/supabase'
import { useTheme } from '@/lib/theme'

interface FormState {
  displayName: string
  fullName: string
  phone: string
  city: string
  preferredPosition: string
  bio: string
}

const EMPTY_FORM: FormState = {
  displayName: '',
  fullName: '',
  phone: '',
  city: '',
  preferredPosition: '',
  bio: '',
}

const LIMITS = {
  displayName: 60,
  fullName: 120,
  phone: 24,
  city: 80,
  preferredPosition: 40,
  bio: 500,
} as const

/**
 * Permissive on shape, strict on characters — the same rule the web route applies. Turkish numbers
 * are written half a dozen ways and none of them is wrong; what must not get through is a field
 * being used to smuggle text.
 */
const PHONE_PATTERN = /^\+?[\d\s()./-]{7,24}$/

function fromProfile(profile: MyProfile): FormState {
  return {
    displayName: profile.display_name ?? '',
    fullName: profile.full_name ?? '',
    phone: profile.phone ?? '',
    city: profile.city ?? '',
    preferredPosition: profile.preferred_position ?? '',
    bio: profile.bio ?? '',
  }
}

/** Trim, then treat "" as "clear this column". */
function normalise(value: string): string | null {
  const trimmed = value.trim()
  return trimmed.length === 0 ? null : trimmed
}

type FieldErrors = Partial<Record<keyof FormState, string>>

function validate(form: FormState): FieldErrors {
  const errors: FieldErrors = {}

  const fullName = form.fullName.trim()
  if (fullName.length > 0 && fullName.length < 2) {
    errors.fullName = 'Use at least two characters, or leave it empty.'
  }
  if (fullName.length > LIMITS.fullName) {
    errors.fullName = `Keep this under ${LIMITS.fullName} characters.`
  }

  const displayName = form.displayName.trim()
  if (displayName.length > LIMITS.displayName) {
    errors.displayName = `Keep this under ${LIMITS.displayName} characters.`
  }

  const phone = form.phone.trim()
  if (phone.length > 0 && !PHONE_PATTERN.test(phone)) {
    errors.phone = 'Use digits, spaces and + ( ) - only.'
  }

  if (form.city.trim().length > LIMITS.city) {
    errors.city = `Keep this under ${LIMITS.city} characters.`
  }
  if (form.preferredPosition.trim().length > LIMITS.preferredPosition) {
    errors.preferredPosition = `Keep this under ${LIMITS.preferredPosition} characters.`
  }
  if (form.bio.trim().length > LIMITS.bio) {
    errors.bio = `Keep this under ${LIMITS.bio} characters.`
  }

  return errors
}

export default function SettingsScreen(): React.ReactElement {
  const theme = useTheme()
  const router = useRouter()
  const { user, signOut } = useSession()
  const { profile, loading, error, refresh, patch } = useMyProfile()

  const [form, setForm] = React.useState<FormState>(EMPTY_FORM)
  const [dirty, setDirty] = React.useState(false)
  const [errors, setErrors] = React.useState<FieldErrors>({})
  const [saving, setSaving] = React.useState(false)
  const [saveError, setSaveError] = React.useState<string | null>(null)
  const [saved, setSaved] = React.useState(false)
  const [refreshing, setRefreshing] = React.useState(false)

  // Adopt the loaded row, but never overwrite something the user is in the middle of typing.
  React.useEffect(() => {
    if (profile === null || dirty) return
    setForm(fromProfile(profile))
  }, [dirty, profile])

  const update = React.useCallback((key: keyof FormState, value: string): void => {
    setDirty(true)
    setSaved(false)
    setForm((current) => ({ ...current, [key]: value }))
  }, [])

  const save = React.useCallback(async (): Promise<void> => {
    if (profile === null) return

    const nextErrors = validate(form)
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) {
      setSaveError('Fix the highlighted fields and try again.')
      return
    }

    const changes: TablesUpdate<'profiles'> = {}
    const proposed = {
      display_name: normalise(form.displayName),
      full_name: normalise(form.fullName),
      phone: normalise(form.phone),
      city: normalise(form.city),
      preferred_position: normalise(form.preferredPosition),
      bio: normalise(form.bio),
    }

    if (proposed.display_name !== profile.display_name) changes.display_name = proposed.display_name
    if (proposed.full_name !== profile.full_name) changes.full_name = proposed.full_name
    if (proposed.phone !== profile.phone) changes.phone = proposed.phone
    if (proposed.city !== profile.city) changes.city = proposed.city
    if (proposed.preferred_position !== profile.preferred_position) {
      changes.preferred_position = proposed.preferred_position
    }
    if (proposed.bio !== profile.bio) changes.bio = proposed.bio

    if (Object.keys(changes).length === 0) {
      setDirty(false)
      setSaveError(null)
      setSaved(true)
      return
    }

    setSaving(true)
    setSaveError(null)
    try {
      // `profiles_update_self` is the authorisation; `.eq('id', …)` is the row filter PostgREST
      // needs before it will accept an UPDATE at all.
      const { error: writeError } = await supabase
        .from('profiles')
        .update(changes)
        .eq('id', profile.id)

      if (writeError) {
        setSaveError(
          writeError.code === '42501'
            ? 'The database refused that change. Sign out and back in, and if it keeps happening let us know.'
            : writeError.message || 'Could not save your details. Nothing was changed.',
        )
        return
      }

      patch(proposed)
      setDirty(false)
      setSaved(true)
    } finally {
      setSaving(false)
    }
  }, [form, patch, profile])

  const refreshAll = React.useCallback(async (): Promise<void> => {
    setRefreshing(true)
    await refresh()
    setRefreshing(false)
  }, [refresh])

  const header = <ScreenHeader title="Hesap" subtitle="Bilgilerin ve nasıl göründükleri" />

  if (loading && profile === null) {
    return (
      <Screen
        edges={['top', 'left', 'right', 'bottom']}
        header={header}
        loading
        loadingLabel="Loading your account"
      />
    )
  }

  if (profile === null) {
    return (
      <Screen
        edges={['top', 'left', 'right', 'bottom']}
        header={header}
        error={error ?? 'We could not load your account.'}
        onRetry={() => void refresh()}
      />
    )
  }

  return (
    <Screen
      edges={['top', 'left', 'right', 'bottom']}
      scroll
      header={header}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => void refreshAll()}
          tintColor={theme.colors.mutedForeground}
          colors={[theme.colors.primary]}
        />
      }
      footer={
        <Button
          title="Değişiklikleri kaydet"
          size="lg"
          fullWidth
          loading={saving}
          disabled={!dirty || saving}
          onPress={() => void save()}
        />
      }
    >
      {saved && !dirty ? (
        <Notice tone="success" title="Kaydedildi" description="Profilin güncel." live />
      ) : null}

      {saveError ? (
        <Notice tone="destructive" title="Kaydedilemedi" description={saveError} live />
      ) : null}

      {/* -------------------------------------------------------- editable -- */}
      <Card title="Nasıl görünüyorsun" subtitle="Takım arkadaşlarının ve işletme sahiplerinin gördüğü">
        <Field
          label="Görünen ad"
          value={form.displayName}
          onChangeText={(next) => update('displayName', next)}
          maxLength={LIMITS.displayName}
          autoCapitalize="words"
          disabled={saving}
          hint="Kadro listelerinde ve maç kartlarında görünür. Ad soyadını kullanmak için boş bırak."
          error={errors.displayName ?? null}
        />

        <Field
          label="Ad soyad"
          value={form.fullName}
          onChangeText={(next) => update('fullName', next)}
          maxLength={LIMITS.fullName}
          autoCapitalize="words"
          autoComplete="name"
          textContentType="name"
          disabled={saving}
          error={errors.fullName ?? null}
        />

        <Field
          label="Şehir"
          value={form.city}
          onChangeText={(next) => update('city', next)}
          maxLength={LIMITS.city}
          autoCapitalize="words"
          disabled={saving}
          hint="Yakınındaki maçları bulmak için kullanılır. Hiçbir zaman şehirden daha hassas değildir."
          error={errors.city ?? null}
        />

        <Field
          label="Tercih ettiğin mevki"
          value={form.preferredPosition}
          onChangeText={(next) => update('preferredPosition', next)}
          maxLength={LIMITS.preferredPosition}
          disabled={saving}
          hint="Serbest metin. Eşleştirici bunu kural olarak değil, tercih olarak okur."
          placeholder="Kaleci, sol bek, fark etmez"
          error={errors.preferredPosition ?? null}
        />

        <Field
          label="Hakkında"
          value={form.bio}
          onChangeText={(next) => update('bio', next)}
          maxLength={LIMITS.bio}
          multiline
          numberOfLines={4}
          disabled={saving}
          hint={`${form.bio.trim().length} of ${LIMITS.bio} characters`}
          error={errors.bio ?? null}
        />
      </Card>

      <Card title="İletişim" subtitle="Telefonunu yalnızca rezervasyon yaptığın işletme sahipleri görebilir">
        <Field
          label="Telefon"
          value={form.phone}
          onChangeText={(next) => update('phone', next)}
          maxLength={LIMITS.phone}
          keyboardType="phone-pad"
          autoComplete="tel"
          textContentType="telephoneNumber"
          disabled={saving}
          placeholder="+90 532 123 45 67"
          error={errors.phone ?? null}
        />
      </Card>

      {/* ------------------------------------------------------- read-only -- */}
      <Card title="Bu hesapta değiştirilemez" subtitle="Uygulamadan değil, destek üzerinden değiştirilir">
        <ReadOnlyRow label="E-posta" value={profile.email ?? user?.email ?? '—'} />
        <Separator />
        <ReadOnlyRow label="Rol" value={roleLabel(profile.role)} />
        <Separator />
        <ReadOnlyRow
          label="Doğum tarihi"
          value={profile.date_of_birth ? formatDayLabel(profile.date_of_birth) : 'Not recorded'}
          note="Doğum tarihin 16 yaş altı korumalarının uygulanıp uygulanmayacağını belirler; bu yüzden uygulamadan değiştirilemez."
        />
        {profile.is_minor === true ? (
          <>
            <Separator />
            <View style={{ gap: theme.spacing.xs }}>
              <Text variant="label">Hesap türü</Text>
              <Badge tone="neutral" size="sm">
                16 yaş altı
              </Badge>
              <Text variant="caption" tone="muted">
                Üç gizlilik ayarı senin için sabitlenmiş. Hangileri ve neden olduğunu görmek için Gizlilik ve veri sayfasını aç.
              </Text>
            </View>
          </>
        ) : null}
      </Card>

      {/* ----------------------------------------------------------- links -- */}
      <Card>
        <Button
          title="Kartın: renk, kare, numara"
          variant="outline"
          fullWidth
          onPress={() => router.push('/settings/style')}
        />
        <Button
          title="Gizlilik ve veri"
          variant="outline"
          fullWidth
          onPress={() => router.push('/settings/privacy')}
        />
        <Button
          title="Bildirimler"
          variant="outline"
          fullWidth
          onPress={() => router.push('/settings/notifications')}
        />
        <Button
          title="Takımlarım"
          variant="outline"
          fullWidth
          onPress={() => router.push('/teams')}
        />
      </Card>

      <Button
        title="Çıkış yap"
        variant="ghost"
        fullWidth
        onPress={() => {
          void signOut()
        }}
      />

      <Text variant="caption" tone="muted">
        Signed in as {displayNameOf(profile, user?.email ?? 'this account')}.
      </Text>
    </Screen>
  )
}

function roleLabel(role: string): string {
  if (role === 'admin') return 'Admin'
  if (role === 'venue_owner') return 'Venue owner'
  return 'Player'
}

interface ReadOnlyRowProps {
  label: string
  value: string
  note?: string
}

function ReadOnlyRow({ label, value, note }: ReadOnlyRowProps): React.ReactElement {
  const theme = useTheme()

  return (
    <View style={{ gap: theme.spacing.xs }}>
      <Text variant="label" tone="muted">
        {label}
      </Text>
      <Text variant="body">{value}</Text>
      {note ? (
        <Text variant="caption" tone="muted">
          {note}
        </Text>
      ) : null}
    </View>
  )
}
