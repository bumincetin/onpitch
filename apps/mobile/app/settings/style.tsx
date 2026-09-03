/**
 * app/settings/style.tsx
 *
 * How you look: accent, the pitch shot behind your card, tagline, number, foot. The card at the
 * top is the live preview — the same `ProfileCard` a teammate sees — and the accent is applied to
 * the tab bar the moment it is saved.
 *
 * Written straight to `profiles` under `profiles_update_self`, like the rest of settings; the
 * six columns are in the 0011 UPDATE grant.
 */

import * as React from 'react'
import { Pressable, View } from 'react-native'

import {
  ACCENT_COLOR_LABEL,
  BANNER_SHOT_LABEL,
  DOMINANT_FEET,
  DOMINANT_FOOT_LABEL,
  JERSEY_NUMBER_MAX,
  PROFILE_BANNER_SHOTS,
  TAGLINE_MAX,
  profileStyleOf,
  type DominantFoot,
  type ProfileStyle,
} from '@onpitch/shared/profile'

import { PitchMarkings, ProfileCard } from '@/components/profile/profile-card'
import { ScreenHeader, displayNameOf, useMyProfile } from '@/components/profile'
import { Button, Card, Field, Notice, Screen, Text } from '@/components/ui'
import { ACCENT_CHOICES, useAccent } from '@/lib/accent'
import { supabase } from '@/lib/supabase'
import { useTheme } from '@/lib/theme'

export default function StyleScreen(): React.ReactElement {
  const theme = useTheme()
  const { setAccent } = useAccent()
  const { profile, loading, error, refresh, patch } = useMyProfile()

  const [style, setStyle] = React.useState<ProfileStyle | null>(null)
  const [saving, setSaving] = React.useState(false)
  const [saveError, setSaveError] = React.useState<string | null>(null)
  const [saved, setSaved] = React.useState(false)

  React.useEffect(() => {
    if (profile && style === null) setStyle(profileStyleOf(profile))
  }, [profile, style])

  const set = <K extends keyof ProfileStyle>(key: K, value: ProfileStyle[K]): void => {
    setSaved(false)
    setStyle((current) => (current ? { ...current, [key]: value } : current))
  }

  const dirty = React.useMemo(() => {
    if (!profile || !style) return false
    const stored = profileStyleOf(profile)
    return (Object.keys(style) as (keyof ProfileStyle)[]).some((key) => style[key] !== stored[key])
  }, [profile, style])

  const save = async (): Promise<void> => {
    if (!profile || !style || !dirty) return
    setSaving(true)
    setSaveError(null)
    try {
      const { error: writeError } = await supabase
        .from('profiles')
        .update({
          accent_color: style.accentColor,
          banner_shot: style.bannerShot,
          tagline: style.tagline?.trim() || null,
          jersey_number: style.jerseyNumber,
          dominant_foot: style.dominantFoot,
        })
        .eq('id', profile.id)
      if (writeError) {
        setSaveError(writeError.message || 'Görünüm kaydedilemedi.')
        return
      }
      patch({ accent_color: style.accentColor, banner_shot: style.bannerShot, tagline: style.tagline, jersey_number: style.jerseyNumber, dominant_foot: style.dominantFoot })
      setAccent(style.accentColor)
      setSaved(true)
    } finally {
      setSaving(false)
    }
  }

  const header = <ScreenHeader title="Kartın" subtitle="Rengin, karen, numaran ve sloganın" />

  if (loading && profile === null) return <Screen edges={['top', 'left', 'right', 'bottom']} header={header} loading loadingLabel="Yükleniyor" />
  if (profile === null || style === null) return <Screen edges={['top', 'left', 'right', 'bottom']} header={header} error={error ?? 'Profilin yüklenemedi.'} onRetry={() => void refresh()} />

  return (
    <Screen
      edges={['top', 'left', 'right', 'bottom']}
      scroll
      keyboardAvoiding
      header={header}
      footer={<Button title="Görünümü kaydet" size="lg" fullWidth loading={saving} disabled={!dirty || saving} onPress={() => void save()} />}
    >
      <ProfileCard
        name={displayNameOf(profile, 'Sen')}
        avatarUrl={profile.avatar_url}
        style={style}
        city={profile.city}
        position={profile.preferred_position}
        role={profile.role}
        size="preview"
      />

      {saved && !dirty ? <Notice tone="success" title="Kaydedildi" description="Rengin ve kartın her yerde güncellendi." live /> : null}
      {saveError ? <Notice tone="destructive" title="Kaydedilemedi" description={saveError} live /> : null}

      {/* ---- accent ---- */}
      <Card title="Rengin" subtitle="Sekme çubuğu, seviye plakan, avatarın ve mesaj baloncukların bu renkte olur">
        <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm }}>
          {ACCENT_CHOICES.map((choice) => {
            const on = style.accentColor === choice.name
            return (
              <Pressable
                key={choice.name}
                accessibilityRole="radio"
                accessibilityState={{ checked: on }}
                accessibilityLabel={ACCENT_COLOR_LABEL[choice.name]}
                onPress={() => set('accentColor', choice.name)}
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 22,
                  backgroundColor: choice.swatch,
                  borderWidth: 3,
                  borderColor: on ? theme.colors.foreground : 'transparent',
                  transform: [{ scale: on ? 1.1 : 1 }],
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {on ? <View style={{ width: 10, height: 6, borderLeftWidth: 2.5, borderBottomWidth: 2.5, borderColor: '#05070C', transform: [{ rotate: '-45deg' }], marginTop: -3 }} /> : null}
              </Pressable>
            )
          })}
        </View>
      </Card>

      {/* ---- shot ---- */}
      <Card title="Profilinin açıldığı kare" subtitle="Kartının arkasındaki saha hangi açıdan">
        <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm }}>
          {PROFILE_BANNER_SHOTS.map((shot) => {
            const on = style.bannerShot === shot
            return (
              <Pressable
                key={shot}
                accessibilityRole="radio"
                accessibilityState={{ checked: on }}
                accessibilityLabel={`${BANNER_SHOT_LABEL[shot].title}. ${BANNER_SHOT_LABEL[shot].hint}`}
                onPress={() => set('bannerShot', shot)}
                style={{
                  width: '30.5%',
                  aspectRatio: 1.35,
                  borderRadius: theme.radius.lg,
                  borderWidth: on ? 2 : 1,
                  borderColor: on ? theme.colors.user : theme.colors.border,
                  backgroundColor: '#05070C',
                  overflow: 'hidden',
                  justifyContent: 'flex-end',
                  padding: 6,
                }}
              >
                <PitchMarkings shot={shot} accent={theme.colors.user} compact />
                <Text variant="caption" weight="600" style={{ color: '#F6F1E7', fontSize: 10, letterSpacing: 1, textTransform: 'uppercase' }}>
                  {BANNER_SHOT_LABEL[shot].title}
                </Text>
              </Pressable>
            )
          })}
        </View>
      </Card>

      {/* ---- words and numbers ---- */}
      <Card title="Kartında yazanlar">
        <Field
          label="Sloganın"
          value={style.tagline ?? ''}
          onChangeText={(next) => set('tagline', next.length ? next.slice(0, TAGLINE_MAX) : null)}
          maxLength={TAGLINE_MAX}
          placeholder="Sol kanat, sağ ayak, geç kalmam."
          hint={`${(style.tagline ?? '').length} / ${TAGLINE_MAX}`}
          disabled={saving}
        />
        <Field
          label="Numaran"
          value={style.jerseyNumber === null ? '' : String(style.jerseyNumber)}
          onChangeText={(next) => {
            const digits = next.replace(/\D/g, '').slice(0, 2)
            set('jerseyNumber', digits === '' ? null : Math.min(JERSEY_NUMBER_MAX, Number.parseInt(digits, 10)))
          }}
          keyboardType="number-pad"
          placeholder="—"
          hint="0–99. Kartında büyük, kendi renginde."
          disabled={saving}
        />
        <View style={{ gap: theme.spacing.xs }}>
          <Text variant="label">Ayağın</Text>
          <View accessibilityRole="radiogroup" style={{ flexDirection: 'row', gap: theme.spacing.xs }}>
            {[null, ...DOMINANT_FEET].map((foot) => {
              const on = style.dominantFoot === foot
              return (
                <Pressable
                  key={foot ?? 'none'}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: on }}
                  onPress={() => set('dominantFoot', foot as DominantFoot | null)}
                  style={{
                    flex: 1,
                    minHeight: 44,
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: theme.radius.lg,
                    borderWidth: 1,
                    borderColor: on ? theme.colors.user : theme.colors.border,
                    backgroundColor: on ? `${theme.colors.user}22` : 'transparent',
                  }}
                >
                  <Text variant="label" tone={on ? 'default' : 'muted'}>
                    {foot ? DOMINANT_FOOT_LABEL[foot] : 'Söylemem'}
                  </Text>
                </Pressable>
              )
            })}
          </View>
        </View>
      </Card>
    </Screen>
  )
}
