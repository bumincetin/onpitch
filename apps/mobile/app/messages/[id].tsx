/**
 * app/messages/[id].tsx
 *
 * One thread: the bubbles, the composer, and — behind the title — mute, block, leave.
 *
 * The list is inverted so it opens at the bottom and stays there while the keyboard comes up;
 * the data is reversed once to match. Long-press a bubble for unsend (yours) or report
 * (theirs). A thread the viewer is not in reads as empty under RLS and is not in their inbox,
 * so it renders the "no such thread" state rather than a blank screen.
 */

import { useLocalSearchParams, useRouter } from 'expo-router'
import * as React from 'react'
import { Alert, FlatList, Pressable, TextInput, View } from 'react-native'

import { isUuid } from '@onpitch/shared/channels'
import {
  MESSAGE_BODY_MAX,
  REPORT_REASONS,
  REPORT_REASON_LABEL,
  type ConversationSummary,
  type MessageView,
  type ReportReason,
} from '@onpitch/shared/messaging'

import { MessageBubble } from '@/components/messaging'
import { ScreenHeader } from '@/components/profile'
import { Avatar, Button, EmptyState, Screen, Sheet, Text } from '@/components/ui'
import { formatDayLabel } from '@/lib/format'
import {
  MessagingError,
  blockUser,
  isBlocked,
  leaveConversation,
  readConversations,
  reportMessage,
  setConversationMuted,
  unblockUser,
  useThread,
} from '@/lib/messaging'
import { useSession } from '@/lib/supabase'
import { useTheme } from '@/lib/theme'

const RUN_WINDOW_MS = 5 * 60_000

export default function ThreadScreen(): React.ReactElement {
  const theme = useTheme()
  const router = useRouter()
  const { user } = useSession()
  const viewerId = user?.id ?? ''

  const params = useLocalSearchParams()
  const raw = Array.isArray(params.id) ? params.id[0] : params.id
  const conversationId = typeof raw === 'string' && isUuid(raw) ? raw : null

  const thread = useThread(conversationId)
  const [summary, setSummary] = React.useState<ConversationSummary | null | undefined>(undefined)
  const [blocked, setBlocked] = React.useState(false)
  const [draft, setDraft] = React.useState('')
  const [menu, setMenu] = React.useState(false)
  const [reporting, setReporting] = React.useState<MessageView | null>(null)
  const [reason, setReason] = React.useState<ReportReason>('harassment')

  // The counterpart comes from the inbox RPC (visibility policy is not in the way there).
  React.useEffect(() => {
    let cancelled = false
    if (conversationId === null) return
    void readConversations()
      .then(async (list) => {
        const found = list.find((c) => c.id === conversationId) ?? null
        if (cancelled) return
        setSummary(found)
        if (found?.counterpart && viewerId) setBlocked(await isBlocked(viewerId, found.counterpart.id))
      })
      .catch(() => !cancelled && setSummary(null))
    return () => {
      cancelled = true
    }
  }, [conversationId, viewerId])

  const counterpart = summary?.counterpart ?? null
  const name = counterpart?.erased ? 'Silinmiş hesap' : (counterpart?.displayName ?? 'Oyuncu')
  const canWrite = !counterpart?.erased && !blocked

  const send = async (): Promise<void> => {
    const body = draft.trim()
    if (!body || thread.sending) return
    setDraft('')
    try {
      await thread.send(body)
    } catch (caught) {
      setDraft(body)
      Alert.alert('Gönderilemedi', caught instanceof MessagingError ? caught.message : 'Sunucuya ulaşılamadı.')
    }
  }

  const act = async (label: string, run: () => Promise<void>): Promise<void> => {
    setMenu(false)
    try {
      await run()
    } catch (caught) {
      Alert.alert(label, caught instanceof MessagingError ? caught.message : 'Bu işlem tamamlanamadı.')
    }
  }

  const onLongPress = (message: MessageView): void => {
    if (message.senderId === viewerId) {
      Alert.alert('Mesajı geri al', 'Bu mesaj karşı tarafta “Mesaj geri alındı” olarak görünür.', [
        { text: 'Vazgeç', style: 'cancel' },
        { text: 'Geri al', style: 'destructive', onPress: () => void act('Geri alınamadı', () => thread.unsend(message)) },
      ])
    } else {
      setReporting(message)
    }
  }

  /* -------------------------------------------------------------- states -- */

  if (conversationId === null || summary === null) {
    return (
      <Screen edges={['top', 'left', 'right', 'bottom']} header={<ScreenHeader title="Sohbet" fallbackHref="/(tabs)/messages" />}>
        <EmptyState title="Böyle bir sohbet yok" description="Bağlantı eskimiş olabilir ya da bu sohbet sende değil." action={{ label: 'Mesajlara dön', onPress: () => router.replace('/(tabs)/messages') }} />
      </Screen>
    )
  }

  // Inverted list: newest first in data, drawn bottom-up. Time shows on the last bubble of a
  // run (the FIRST in inverted order), day labels on the first message of a day (the LAST).
  const inverted = [...thread.messages].reverse()

  return (
    <Screen
      edges={['top', 'left', 'right', 'bottom']}
      padded={false}
      keyboardAvoiding
      header={
        <View style={{ paddingHorizontal: theme.spacing.lg }}>
          <ScreenHeader
            title={name}
            subtitle={counterpart ? `${counterpart.role === 'venue_owner' ? 'İşletme' : 'Oyuncu'}${summary?.mutedAt ? ' · sessiz' : ''}${blocked ? ' · engelli' : ''}` : undefined}
            fallbackHref="/(tabs)/messages"
            right={
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Sohbet seçenekleri"
                onPress={() => setMenu(true)}
                hitSlop={8}
                style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
              >
                <Avatar uri={counterpart?.avatarUrl ?? null} name={name} size="sm" accent={counterpart?.accentColor ?? null} />
              </Pressable>
            }
          />
        </View>
      }
      footer={
        <View style={{ paddingHorizontal: theme.spacing.lg, paddingTop: theme.spacing.sm, borderTopWidth: 1, borderTopColor: theme.colors.border }}>
          {canWrite ? (
            <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: theme.spacing.sm }}>
              <TextInput
                value={draft}
                onChangeText={setDraft}
                placeholder="Mesaj yaz…"
                placeholderTextColor={theme.colors.mutedForeground}
                multiline
                maxLength={MESSAGE_BODY_MAX}
                accessibilityLabel="Mesaj"
                style={{
                  flex: 1,
                  minHeight: 44,
                  maxHeight: 140,
                  paddingHorizontal: theme.spacing.md,
                  paddingVertical: 10,
                  borderRadius: theme.radius.lg,
                  borderWidth: 1,
                  borderColor: theme.colors.input,
                  backgroundColor: theme.colors.background,
                  color: theme.colors.foreground,
                  fontSize: theme.type.body.fontSize,
                }}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Gönder"
                disabled={!draft.trim() || thread.sending}
                onPress={() => void send()}
                style={({ pressed }) => ({
                  width: 44,
                  height: 44,
                  borderRadius: theme.radius.lg,
                  backgroundColor: theme.colors.user,
                  opacity: !draft.trim() || thread.sending ? 0.4 : pressed ? 0.8 : 1,
                  alignItems: 'center',
                  justifyContent: 'center',
                })}
              >
                <View style={{ width: 0, height: 0, borderTopWidth: 7, borderBottomWidth: 7, borderLeftWidth: 12, borderTopColor: 'transparent', borderBottomColor: 'transparent', borderLeftColor: '#05070C', marginLeft: 3 }} />
              </Pressable>
            </View>
          ) : (
            <Text variant="caption" tone="muted" align="center">
              {blocked ? 'Bu kişiyi engelledin. Yazmak için engeli kaldır.' : 'Bu hesap silinmiş; sohbet yalnızca okunabilir.'}
            </Text>
          )}
          <Text variant="caption" tone="muted" style={{ marginTop: 6, fontSize: 10 }}>
            Mesajlar bir yıl sonra silinir; hesabını silersen yazdıkların anında kaldırılır.
          </Text>
        </View>
      }
    >
      <FlatList
        inverted
        data={inverted}
        keyExtractor={(item) => item.id}
        renderItem={({ item, index }) => {
          const mine = item.senderId === viewerId
          const newer = inverted[index - 1]
          const older = inverted[index + 1]
          const showTime = !newer || newer.senderId !== item.senderId || Date.parse(newer.createdAt) - Date.parse(item.createdAt) > RUN_WINDOW_MS
          const dayStarts = !older || formatDayLabel(older.createdAt, 'Europe/Istanbul') !== formatDayLabel(item.createdAt, 'Europe/Istanbul')
          return (
            <View style={{ paddingHorizontal: theme.spacing.lg, paddingTop: 4, paddingBottom: showTime ? 8 : 2 }}>
              {dayStarts ? (
                <Text variant="caption" tone="muted" align="center" style={{ marginBottom: theme.spacing.md, marginTop: theme.spacing.sm, letterSpacing: 1.2, textTransform: 'uppercase', fontSize: 10 }}>
                  {formatDayLabel(item.createdAt, 'Europe/Istanbul')}
                </Text>
              ) : null}
              <MessageBubble message={item} mine={mine} showTime={showTime} onLongPress={onLongPress} />
            </View>
          )
        }}
        ListEmptyComponent={
          thread.loading ? null : (
            <View style={{ padding: theme.spacing.xl, transform: [{ scaleY: -1 }] }}>
              <Text variant="body" tone="muted" align="center">
                İlk mesajı sen yaz. {counterpart?.role === 'venue_owner' ? 'Saha, saat, fiyat — burada konuşun.' : 'Maç günü, saat, kadro — burada konuşun.'}
              </Text>
            </View>
          )
        }
        ListFooterComponent={
          thread.nextBefore ? (
            <View style={{ padding: theme.spacing.md }}>
              <Button title="Daha eski mesajlar" variant="ghost" size="sm" onPress={() => void thread.loadOlder()} />
            </View>
          ) : null
        }
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingVertical: theme.spacing.md }}
      />

      {/* ---- options ---- */}
      <Sheet visible={menu} onClose={() => setMenu(false)} title={name} description="Bu sohbet için">
        <Button
          title={summary?.mutedAt ? 'Bildirimleri aç' : 'Sessize al'}
          variant="outline"
          fullWidth
          onPress={() =>
            void act('Ayar kaydedilemedi', async () => {
              const muted = await setConversationMuted(conversationId, !summary?.mutedAt)
              setSummary((current) => (current ? { ...current, mutedAt: muted ? new Date().toISOString() : null } : current))
            })
          }
        />
        {counterpart && !counterpart.erased ? (
          <Button
            title={blocked ? 'Engeli kaldır' : `${name} kişisini engelle`}
            variant={blocked ? 'outline' : 'destructive'}
            fullWidth
            onPress={() =>
              void act('Engel', async () => {
                if (blocked) await unblockUser(counterpart.id)
                else await blockUser(counterpart.id)
                setBlocked(!blocked)
              })
            }
          />
        ) : null}
        <Button
          title="Sohbeti listeden kaldır"
          variant="ghost"
          fullWidth
          onPress={() =>
            void act('Çıkılamadı', async () => {
              await leaveConversation(conversationId)
              router.replace('/(tabs)/messages')
            })
          }
        />
        {counterpart && !counterpart.erased ? (
          <Button title="Profilini aç" variant="ghost" fullWidth onPress={() => { setMenu(false); router.push(`/player/${counterpart.id}`) }} />
        ) : null}
      </Sheet>

      {/* ---- report ---- */}
      <Sheet
        visible={reporting !== null}
        onClose={() => setReporting(null)}
        title="Mesajı bildir"
        description="Yalnızca bu mesajın alıntısı yöneticilere gider. Gönderen kişiye bildirim yapılmaz."
        footer={
          <Button
            title="Bildir"
            fullWidth
            onPress={() =>
              void act('Bildirilemedi', async () => {
                if (!reporting) return
                await reportMessage(reporting.id, reason)
                setReporting(null)
                Alert.alert('Bildirim alındı', 'Bir yönetici mesajın alıntısını inceleyecek; sohbetin kendisi açılmaz.')
              })
            }
          />
        }
      >
        <View style={{ gap: theme.spacing.xs }}>
          {REPORT_REASONS.map((option) => (
            <Pressable
              key={option}
              accessibilityRole="radio"
              accessibilityState={{ checked: reason === option }}
              onPress={() => setReason(option)}
              style={{
                minHeight: 44,
                paddingHorizontal: theme.spacing.md,
                justifyContent: 'center',
                borderRadius: theme.radius.lg,
                borderWidth: 1,
                borderColor: reason === option ? theme.colors.user : theme.colors.border,
                backgroundColor: reason === option ? `${theme.colors.user}22` : 'transparent',
              }}
            >
              <Text variant="body">{REPORT_REASON_LABEL[option]}</Text>
            </Pressable>
          ))}
        </View>
      </Sheet>
    </Screen>
  )
}
