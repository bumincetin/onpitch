/**
 * app/settings/privacy.tsx
 *
 * What other people can see, the guardian-consent record, and both GDPR rights, in one place.
 *
 * THE THREE SWITCHES
 * ------------------
 * `location_sharing_enabled`, `profile_visibility` and `marketing_opt_in` are pinned for an
 * under-16 account by `enforce_minor_privacy` (a BEFORE trigger) and by
 * `profiles_minor_privacy_locked_check` (a CHECK constraint). For a minor they render OFF and
 * DISABLED with one plain sentence each — never hidden. Hiding a control teaches a young user that
 * the platform is opaque and leaves them unable to tell a policy from a bug; a greyed switch with a
 * reason next to it is the Art. 12 answer, and it is also how they learn the setting is waiting for
 * them at 16. No disabled switch can reach a write: the database would refuse the statement, and a
 * form that knowingly sends a doomed write is a form that eventually shows a constraint violation
 * to a fifteen-year-old.
 *
 * `profile_visibility` has three values and this is one switch, so turning "public" off has to
 * choose between `members` and `private`. It restores whichever the account was last on rather than
 * picking one — a private profile toggled public and back must not quietly land on `members`, which
 * is strictly more open than where it started.
 *
 * THE TWO RIGHTS
 * --------------
 * Export (Art. 15 and 20) is a plain JSON document, built entirely by `public.export_my_data()`.
 * Erasure (Art. 17) is `public.request_account_erasure()`, which pseudonymises the profile, clears
 * everything the person wrote, de-identifies the consent evidence, deletes their notifications, and
 * KEEPS the booking rows and payment references under Art. 17(3)(b). The copy below states that
 * split before the button is enabled, because claiming a total deletion and then keeping those rows
 * would be the lie.
 */

import { File, Paths } from 'expo-file-system'
import * as Sharing from 'expo-sharing'
import * as React from 'react'
import { RefreshControl, View } from 'react-native'

import type { TablesUpdate } from '@onpitch/shared/database'
import { gdprErasureSchema, type ProfileVisibility } from '@onpitch/shared/domain'
import { z } from 'zod'

import {
  Badge,
  Button,
  Card,
  Field,
  Notice,
  NoticeBullet,
  Screen,
  Separator,
  Text,
} from '@/components/ui'
import { ConsentBanner, PrivacyToggle, ScreenHeader, useMyProfile } from '@/components/profile'
import { Avatar } from '@/components/ui'
import { readBlockedUsers, unblockUser } from '@/lib/messaging'
import { MESSAGING_POLICIES, MESSAGING_POLICY_LABEL, type MessagingPolicy } from '@onpitch/shared/profile'
import type { BlockedUser } from '@onpitch/shared/messaging'
import { Pressable } from 'react-native'
import { apiFetch, isApiError } from '@/lib/api'
import { env } from '@/lib/env'
import { DIGITAL_CONSENT_AGE, MINOR_PRIVACY_EXPLANATIONS, isMinor } from '@/lib/gdpr'
import { formatKickoff } from '@/lib/format'
import { supabase, useSession } from '@/lib/supabase'
import { useTheme } from '@/lib/theme'

/** Must match `gdprErasureSchema`'s literal exactly, including the case. */
const ERASURE_CONFIRMATION = 'DELETE MY ACCOUNT'

/** What `POST /api/gdpr/erase` answers with. Parsed, never assumed. */
const erasureResultSchema = z.object({
  status: z.string(),
  erasedAt: z.string().nullable(),
  retainedBookingCount: z.number(),
  retentionNote: z.string(),
})

type ErasureResult = z.infer<typeof erasureResultSchema>

const CONSENT_LABEL: Readonly<Record<string, string>> = {
  not_required: 'Not required',
  pending: 'Waiting on a guardian',
  granted: 'Approved',
  revoked: 'Withdrawn',
}

function exportFilename(): string {
  return `onpitch-data-export-${new Date().toISOString().slice(0, 10)}.json`
}

export default function PrivacyScreen(): React.ReactElement {
  const theme = useTheme()
  const { user, signOut } = useSession()
  const { profile, loading, error, refresh, patch } = useMyProfile()

  const [refreshing, setRefreshing] = React.useState(false)

  const minor = isMinor(profile)

  /* ------------------------------------------------------------- switches -- */

  // The value a "public profile" switch returns to when it is turned off.
  const [lastNonPublic, setLastNonPublic] = React.useState<ProfileVisibility>('private')

  React.useEffect(() => {
    if (profile && profile.profile_visibility !== 'public') {
      setLastNonPublic(profile.profile_visibility)
    }
  }, [profile])

  const locationValue = minor ? false : (profile?.location_sharing_enabled ?? false)
  const publicValue = minor ? false : profile?.profile_visibility === 'public'
  const marketingValue = minor ? false : (profile?.marketing_opt_in ?? false)

  const locationPatch = React.useCallback(
    (next: boolean): TablesUpdate<'profiles'> => ({ location_sharing_enabled: next }),
    [],
  )
  const visibilityPatch = React.useCallback(
    (next: boolean): TablesUpdate<'profiles'> => ({
      profile_visibility: next ? 'public' : lastNonPublic,
    }),
    [lastNonPublic],
  )
  const marketingPatch = React.useCallback(
    (next: boolean): TablesUpdate<'profiles'> => ({ marketing_opt_in: next }),
    [],
  )

  /* ------------------------------------------------------------ messaging -- */

  const policy: MessagingPolicy = (MESSAGING_POLICIES as readonly string[]).includes(profile?.messaging_policy ?? '')
    ? (profile?.messaging_policy as MessagingPolicy)
    : 'teammates'
  const [policyBusy, setPolicyBusy] = React.useState(false)
  const [policyError, setPolicyError] = React.useState<string | null>(null)
  const [blocked, setBlocked] = React.useState<BlockedUser[]>([])
  const [unblocking, setUnblocking] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!profile) return
    void readBlockedUsers().then(setBlocked)
  }, [profile])

  const choosePolicy = React.useCallback(
    async (next: MessagingPolicy): Promise<void> => {
      if (!profile || next === policy || policyBusy) return
      setPolicyBusy(true)
      setPolicyError(null)
      const { error: writeError } = await supabase.from('profiles').update({ messaging_policy: next }).eq('id', profile.id)
      setPolicyBusy(false)
      if (writeError) {
        setPolicyError(writeError.code === '42501' ? '16 yaşın altındaki hesaplarda mesajlaşma herkese açılamaz.' : writeError.message || 'Ayar kaydedilemedi.')
        return
      }
      patch({ messaging_policy: next })
    },
    [patch, policy, policyBusy, profile],
  )

  const unblock = React.useCallback(async (userEntry: BlockedUser): Promise<void> => {
    setUnblocking(userEntry.id)
    try {
      await unblockUser(userEntry.id)
      setBlocked((current) => current.filter((entry) => entry.id !== userEntry.id))
    } finally {
      setUnblocking(null)
    }
  }, [])

  /* --------------------------------------------------------------- export -- */

  const [exporting, setExporting] = React.useState(false)
  const [exportError, setExportError] = React.useState<string | null>(null)
  const [exportedAs, setExportedAs] = React.useState<string | null>(null)

  const runExport = React.useCallback(async (): Promise<void> => {
    setExporting(true)
    setExportError(null)

    try {
      // This is the one endpoint that does NOT return the `ApiResponse` envelope on success —
      // Art. 20 asks for a portable document, and wrapping it would make every consumer unwrap our
      // envelope to read their own data. So it is fetched directly rather than through `apiFetch`,
      // with the same bearer token that helper attaches. Errors DO keep the envelope.
      const { data: sessionData } = await supabase.auth.getSession()
      const token = sessionData.session?.access_token
      if (!token) {
        setExportError('Your session has expired. Sign in again and retry the export.')
        return
      }

      const response = await fetch(`${env.apiUrl}/api/gdpr/export`, {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      })

      const body = await response.text()

      if (!response.ok) {
        const message = errorMessageFrom(body)
        setExportError(message ?? 'We could not build your export right now. Please try again.')
        return
      }

      const filename = exportFilename()
      const file = new File(Paths.cache, filename)

      // Delete any previous copy before writing, so today's export never lands on top of an older
      // one and the cache holds at most a single document. It is left in place afterwards: the
      // cache directory is inside the app sandbox — the same boundary that holds the session token
      // — and removing it while the receiving app may still be copying would break the share.
      if (file.exists) file.delete()
      file.create()
      file.write(body)

      setExportedAs(filename)

      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(file.uri, {
          mimeType: 'application/json',
          UTI: 'public.json',
          dialogTitle: 'Your OnPitch data export',
        })
      } else {
        setExportError(
          `Your device has no share sheet, so we could not hand the file on. It is saved on this device as ${filename}.`,
        )
      }
    } catch (caught) {
      setExportError(
        caught instanceof Error && caught.message
          ? caught.message
          : 'Dışa aktarman oluşturulamadı. Bağlantını kontrol edip tekrar dene.',
      )
    } finally {
      setExporting(false)
    }
  }, [])

  /* -------------------------------------------------------------- erasure -- */

  const [confirmation, setConfirmation] = React.useState('')
  const [erasing, setErasing] = React.useState(false)
  const [eraseError, setEraseError] = React.useState<string | null>(null)
  const [receipt, setReceipt] = React.useState<ErasureResult | null>(null)

  const confirmed = gdprErasureSchema.safeParse({ confirmation }).success

  const erase = React.useCallback(async (): Promise<void> => {
    if (!confirmed) return

    setErasing(true)
    setEraseError(null)
    try {
      const raw = await apiFetch<unknown>('/api/gdpr/erase', {
        method: 'POST',
        json: { confirmation: ERASURE_CONFIRMATION },
      })

      const parsed = erasureResultSchema.safeParse(raw)
      if (!parsed.success) {
        setEraseError(
          'The erasure was accepted, but the receipt came back in a shape we could not read. Sign out and check your email.',
        )
        return
      }

      setReceipt(parsed.data)
    } catch (caught) {
      setEraseError(
        isApiError(caught)
          ? caught.message
          : caught instanceof Error && caught.message
            ? caught.message
            : 'Sunucuya ulaşılamadı. Hiçbir şey silinmedi.',
      )
    } finally {
      setErasing(false)
    }
  }, [confirmed])

  /* --------------------------------------------------------------- render -- */

  const refreshAll = React.useCallback(async (): Promise<void> => {
    setRefreshing(true)
    await refresh()
    setRefreshing(false)
  }, [refresh])

  const header = (
    <ScreenHeader title="Gizlilik ve veri" subtitle="Başkaları ne görüyor ve GDPR hakların" />
  )

  if (loading && profile === null) {
    return (
      <Screen
        edges={['top', 'left', 'right', 'bottom']}
        header={header}
        loading
        loadingLabel="Loading your settings"
      />
    )
  }

  if (profile === null) {
    return (
      <Screen
        edges={['top', 'left', 'right', 'bottom']}
        header={header}
        error={error ?? 'We could not load your privacy settings.'}
        onRetry={() => void refresh()}
      />
    )
  }

  // The erasure has committed: there is no account behind this screen any more, so nothing but the
  // receipt and the way out is rendered.
  if (receipt) {
    return (
      <Screen edges={['top', 'left', 'right', 'bottom']} scroll header={header}>
        <Notice
          tone="success"
          title={receipt.status === 'already_erased' ? 'Already erased' : 'Your account is erased'}
          live
        >
          <Text variant="body" tone="muted">
            {receipt.erasedAt
              ? `Completed ${formatKickoff(receipt.erasedAt)}. Your name, email, phone and everything you wrote have been removed or replaced with placeholders, and every session has been ended.`
              : 'Your name, email, phone and everything you wrote have been removed or replaced with placeholders, and every session has been ended.'}
          </Text>
          <Text variant="body" tone="muted">
            {receipt.retainedBookingCount === 1
              ? '1 booking record was kept.'
              : `${receipt.retainedBookingCount} booking records were kept.`}{' '}
            {receipt.retentionNote}
          </Text>
        </Notice>

        <Button title="Uygulama oturumunu kapat" size="lg" fullWidth onPress={() => void signOut()} />
      </Screen>
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
    >
      <ConsentBanner
        status={profile.parental_consent_status}
        guardianName={profile.guardian_name}
        guardianEmail={profile.guardian_email}
      />

      {/* ---------------------------------------------------------- switches -- */}
      <Card
        title="Başkaları ne görüyor"
        subtitle="Üç ayar; her biri değiştirdiğin anda kaydedilir"
      >
        {minor ? (
          <Notice tone="info" title="Bu üçü kilitli">
            <Text variant="body" tone="muted">
              {`This account is registered as under ${DIGITAL_CONSENT_AGE}, so location sharing, a public profile and marketing email stay off until then. They are shown here so you know they exist and where to find them.`}
            </Text>
          </Notice>
        ) : null}

        <PrivacyToggle
          label="Konumumu paylaş"
          hint="Yakındaki maçların seni şehir yerine mesafeye göre bulmasını sağlar."
          value={locationValue}
          userId={profile.id}
          patchFor={locationPatch}
          lockedReason={minor ? MINOR_PRIVACY_EXPLANATIONS.location_sharing_enabled : null}
          onChanged={(next) => patch({ location_sharing_enabled: next })}
        />

        <Separator />

        <PrivacyToggle
          label="Herkese açık profil"
          hint={
            publicValue
              ? 'Anyone signed in can see your name, city and rating.'
              : lastNonPublic === 'members'
                ? 'Off: only players you have shared a team with can see your profile.'
                : 'Off: only you and your teammates can see your profile.'
          }
          value={publicValue}
          userId={profile.id}
          patchFor={visibilityPatch}
          lockedReason={minor ? MINOR_PRIVACY_EXPLANATIONS.profile_visibility : null}
          onChanged={(next) =>
            patch({ profile_visibility: next ? 'public' : lastNonPublic })
          }
        />

        <Separator />

        <PrivacyToggle
          label="Pazarlama e-postası"
          hint="Yeni sahalar ve özellikler hakkında ara sıra e-posta. Rezervasyon onayları ayrıdır ve her zaman gönderilir."
          value={marketingValue}
          userId={profile.id}
          patchFor={marketingPatch}
          lockedReason={minor ? MINOR_PRIVACY_EXPLANATIONS.marketing_opt_in : null}
          onChanged={(next) => patch({ marketing_opt_in: next })}
        />
      </Card>

      {/* -------------------------------------------------------- messaging -- */}
      <Card
        title="Kim sana mesaj gönderebilir"
        subtitle="Sohbetler yalnızca iki tarafın hesabında durur; bir yıl sonra silinir. Engellediğin biri sana ulaşamaz ve bundan haberi olmaz."
      >
        {policyError ? <Notice tone="destructive" title="Kaydedilemedi" description={policyError} live /> : null}
        <View accessibilityRole="radiogroup" style={{ gap: theme.spacing.xs }}>
          {MESSAGING_POLICIES.map((option) => {
            const locked = minor && option === 'everyone'
            const on = policy === option
            return (
              <Pressable
                key={option}
                accessibilityRole="radio"
                accessibilityState={{ checked: on, disabled: locked }}
                disabled={locked || policyBusy}
                onPress={() => void choosePolicy(option)}
                style={{
                  flexDirection: 'row',
                  gap: theme.spacing.md,
                  alignItems: 'flex-start',
                  minHeight: 44,
                  padding: theme.spacing.md,
                  borderRadius: theme.radius.lg,
                  borderWidth: 1,
                  borderColor: on ? theme.colors.user : theme.colors.border,
                  backgroundColor: on ? `${theme.colors.user}22` : 'transparent',
                  opacity: locked ? 0.55 : 1,
                }}
              >
                <View style={{ width: 12, height: 12, borderRadius: 6, marginTop: 4, borderWidth: 1, borderColor: on ? theme.colors.user : theme.colors.mutedForeground, backgroundColor: on ? theme.colors.user : 'transparent' }} />
                <View style={{ flex: 1, gap: 2 }}>
                  <Text variant="body" weight="600">
                    {MESSAGING_POLICY_LABEL[option].title}
                  </Text>
                  <Text variant="caption" tone="muted">
                    {locked
                      ? '16 yaşından küçük hesaplarda kapalı. O yaşa kadar yalnızca takım arkadaşların ve rezervasyon yaptığın işletmeler yazabilir.'
                      : MESSAGING_POLICY_LABEL[option].hint}
                  </Text>
                </View>
              </Pressable>
            )
          })}
        </View>

        <Separator />

        <Text variant="label">{`Engellediklerin · ${blocked.length}`}</Text>
        {blocked.length === 0 ? (
          <Text variant="caption" tone="muted">
            Kimseyi engellemedin. Bir sohbetin menüsünden ya da bir oyuncunun profilinden engelleyebilirsin.
          </Text>
        ) : (
          blocked.map((entry) => (
            <View key={entry.id} style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md }}>
              <Avatar uri={entry.avatarUrl} name={entry.displayName} size="sm" accent={entry.accentColor} />
              <Text variant="body" numberOfLines={1} style={{ flex: 1 }}>
                {entry.displayName ?? 'Oyuncu'}
              </Text>
              <Button title="Engeli kaldır" size="sm" variant="outline" loading={unblocking === entry.id} onPress={() => void unblock(entry)} />
            </View>
          ))
        )}
      </Card>

      {/* ---------------------------------------------------------- consent -- */}
      <Card
        title="Veli onayı"
        subtitle={
          minor
            ? `Accounts under ${DIGITAL_CONSENT_AGE} need a guardian to approve booking and match features (GDPR Art. 8).`
            : 'Where a guardian approval would appear if this account needed one.'
        }
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md }}>
          <Badge
            tone={
              profile.parental_consent_status === 'granted'
                ? 'success'
                : profile.parental_consent_status === 'pending'
                  ? 'warning'
                  : profile.parental_consent_status === 'revoked'
                    ? 'destructive'
                    : 'outline'
            }
            size="sm"
          >
            {CONSENT_LABEL[profile.parental_consent_status] ?? profile.parental_consent_status}
          </Badge>
          {profile.parental_consent_at ? (
            <Text variant="caption" tone="muted">
              {`Recorded ${formatKickoff(profile.parental_consent_at)}`}
            </Text>
          ) : null}
        </View>

        <Text variant="body" tone="muted">
          {profile.parental_consent_status === 'granted'
            ? 'A guardian has approved this account. Booking and ranked matches are open.'
            : profile.parental_consent_status === 'not_required'
              ? `This account is ${DIGITAL_CONSENT_AGE} or over, so nothing is waiting on a parent or guardian.`
              : 'Use the banner above to send the approval email again. The link we send works once and never appears on this screen.'}
        </Text>
      </Card>

      {/* ----------------------------------------------------------- export -- */}
      <Card
        title="Verilerini indir"
        subtitle="GDPR md. 15 ve md. 20 — tuttuğumuz her şey, tek bir JSON dosyası olarak"
      >
        <Text variant="body" tone="muted">
          Profilin, rezervasyonların, maçların, reytinglerin, istatistiklerin, bildirimlerin ve adına verilmiş her onayın kaydı. Dosya her istediğinde yeniden oluşturulur.
        </Text>

        {exportError ? (
          <Notice tone="destructive" title="Dışa aktarma tamamlanmadı" description={exportError} live />
        ) : null}

        {exportedAs && !exportError ? (
          <Notice tone="success" title="Dışa aktarma hazır" description={exportedAs} live />
        ) : null}

        <Button
          title="Dışa aktar ve paylaş"
          fullWidth
          loading={exporting}
          onPress={() => void runExport()}
        />
      </Card>

      {/* ---------------------------------------------------------- erasure -- */}
      <Card title="Hesabını sil" subtitle="GDPR md. 17 ve kaldıramadıkları">
        <Notice tone="warning" title="Tam olarak ne oluyor">
          <NoticeBullet>
            Adın, e-postan, telefonun, biyografin ve avatarın kaldırılır ya da yer tutucuyla değiştirilir.
          </NoticeBullet>
          <NoticeBullet>
            Bildirimlerin silinir ve açık bütün oturumlar sonlandırılır.
          </NoticeBullet>
          <NoticeBullet>
            Rezervasyon ve ödeme kayıtları takma adlaştırılmış hâlde kalır. Türk mevzuatı (VUK md. 253, TTK md. 82) işlem kayıtlarının yıllarca saklanmasını gerektirir ve GDPR md. 17(3)(b) buna izin veren istisnadır. İçlerinde artık adın geçmez.
          </NoticeBullet>
          <NoticeBullet>
            Maç sonuçları ve reytingler de kalır; çünkü diğer oyuncuların reytingleri bunlardan hesaplandı. Artık adınla ilişkili değiller.
          </NoticeBullet>
        </Notice>

        <Field
          label={`Type ${ERASURE_CONFIRMATION} to confirm`}
          value={confirmation}
          onChangeText={setConfirmation}
          autoCapitalize="characters"
          autoCorrect={false}
          disabled={erasing}
          placeholder={ERASURE_CONFIRMATION}
          hint="Bu geri alınamaz ve bekleme süresi yoktur."
          error={
            confirmation.length > 0 && !confirmed
              ? `It has to match ${ERASURE_CONFIRMATION} exactly, including the capitals.`
              : null
          }
        />

        {eraseError ? (
          <Notice tone="destructive" title="Hiçbir şey silinmedi" description={eraseError} live />
        ) : null}

        <Button
          title="Hesabımı sil"
          variant="destructive"
          fullWidth
          loading={erasing}
          disabled={!confirmed || erasing}
          onPress={() => void erase()}
        />
      </Card>

      <Text variant="caption" tone="muted">
        {`Signed in as ${profile.email ?? user?.email ?? 'this account'}.`}
      </Text>
    </Screen>
  )
}

/** Pulls the message out of an `ApiResponse` error body; null when the body is not one. */
function errorMessageFrom(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body)
    const shape = z.object({ ok: z.literal(false), error: z.object({ message: z.string() }) })
    const result = shape.safeParse(parsed)
    return result.success ? result.data.error.message : null
  } catch {
    return null
  }
}
