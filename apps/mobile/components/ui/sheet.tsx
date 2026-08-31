/**
 * components/ui/sheet.tsx
 *
 * A bottom sheet for a short, focused decision: pick a side, confirm a cancellation, choose a
 * slot. Built on the platform Modal rather than a gesture library, because a sheet that can be
 * dismissed by swiping also gets dismissed by the swipe that was meant to scroll its content.
 *
 * Dismissal is explicit: tap the scrim, tap Close, or press the Android back button. All three
 * route through `onClose`, so a caller never has to keep two paths in sync.
 */

import * as React from 'react'
import { Modal, Pressable, ScrollView, View, type StyleProp, type ViewStyle } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

import { useTheme } from '@/lib/theme'

import { Separator } from './separator'
import { Text } from './text'

export interface SheetProps {
  visible: boolean
  onClose: () => void
  /** Announced when the sheet opens. Give every sheet one. */
  title: string
  /** One line under the title. */
  description?: string
  children?: React.ReactNode
  /** Pinned under the scrolling content — the sheet's actions. */
  footer?: React.ReactNode
  /** Blocks the scrim tap while a submit is in flight. */
  dismissible?: boolean
  style?: StyleProp<ViewStyle>
}

export function Sheet({
  visible,
  onClose,
  title,
  description,
  children,
  footer,
  dismissible = true,
  style,
}: SheetProps): React.ReactElement {
  const theme = useTheme()
  const insets = useSafeAreaInsets()

  const requestClose = React.useCallback(() => {
    if (dismissible) onClose()
  }, [dismissible, onClose])

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      // Fires for the Android hardware back button and the iOS swipe-down on a pageSheet.
      onRequestClose={requestClose}
      statusBarTranslucent
    >
      <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: theme.colors.overlay }}>
        {/* The scrim is the dismiss target, so it stays in the reading order — but it is labelled,
            so it announces as "Close" rather than as an unnamed region above the sheet. */}
        <Pressable
          style={{ flex: 1 }}
          onPress={requestClose}
          accessibilityRole="button"
          accessibilityLabel="Kapat"
        />

        <View
          accessibilityViewIsModal
          style={[
            {
              backgroundColor: theme.colors.popover,
              borderTopLeftRadius: theme.radius.xl * 1.5,
              borderTopRightRadius: theme.radius.xl * 1.5,
              borderTopWidth: 1,
              borderColor: theme.colors.border,
              paddingBottom: Math.max(insets.bottom, theme.spacing.lg),
              maxHeight: '85%',
            },
            style,
          ]}
        >
          <View style={{ alignItems: 'center', paddingTop: theme.spacing.md }}>
            <View
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              style={{
                width: 36,
                height: 4,
                borderRadius: theme.radius.full,
                backgroundColor: theme.colors.border,
              }}
            />
          </View>

          <View style={{ padding: theme.spacing.lg, gap: theme.spacing.xs }}>
            <Text variant="title" accessibilityRole="header">
              {title}
            </Text>
            {description ? (
              <Text variant="label" tone="muted">
                {description}
              </Text>
            ) : null}
          </View>

          <Separator />

          <ScrollView
            contentContainerStyle={{ padding: theme.spacing.lg, gap: theme.spacing.lg }}
            keyboardShouldPersistTaps="handled"
          >
            {children}
          </ScrollView>

          {footer ? (
            <>
              <Separator />
              <View style={{ padding: theme.spacing.lg, gap: theme.spacing.md }}>{footer}</View>
            </>
          ) : null}
        </View>
      </View>
    </Modal>
  )
}
