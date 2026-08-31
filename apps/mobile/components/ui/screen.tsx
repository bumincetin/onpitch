/**
 * components/ui/screen.tsx
 *
 * The outer frame every screen renders into: themed background, safe-area insets, and the
 * loading / error / content switch that otherwise gets reimplemented per screen.
 *
 * `edges` defaults to the sides plus the bottom, not the top. Screens inside a Stack or Tabs
 * navigator already sit below the header, so claiming the top inset here adds a second gap. A
 * headerless screen should pass `edges={['top', 'left', 'right', 'bottom']}` explicitly.
 */

import * as React from 'react'
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  View,
  type StyleProp,
  type ViewStyle,
  type RefreshControlProps,
} from 'react-native'
import { SafeAreaView, type Edge } from 'react-native-safe-area-context'

import { useTheme } from '@/lib/theme'

import { EmptyState } from './empty-state'
import { Spinner } from './spinner'

const DEFAULT_EDGES: readonly Edge[] = ['left', 'right', 'bottom']

export interface ScreenProps {
  children?: React.ReactNode
  /** Wraps the content in a ScrollView. Off by default — a FlatList must not be nested in one. */
  scroll?: boolean
  /** Applies the standard screen gutter. */
  padded?: boolean
  edges?: readonly Edge[]
  /** Lifts the content clear of the keyboard. On by default when `scroll` is on. */
  keyboardAvoiding?: boolean
  /** Pull-to-refresh. Only has an effect together with `scroll`. */
  refreshControl?: React.ReactElement<RefreshControlProps>
  /** Pinned above the scrolling content. */
  header?: React.ReactNode
  /** Pinned below it, inside the safe area — the place for a primary action. */
  footer?: React.ReactNode
  /** Replaces the content with a centred spinner. */
  loading?: boolean
  loadingLabel?: string
  /** Replaces the content with an error state. Takes precedence over `loading`. */
  error?: string | null
  onRetry?: () => void
  style?: StyleProp<ViewStyle>
  contentContainerStyle?: StyleProp<ViewStyle>
  testID?: string
}

export function Screen({
  children,
  scroll = false,
  padded = true,
  edges = DEFAULT_EDGES,
  keyboardAvoiding,
  refreshControl,
  header,
  footer,
  loading = false,
  loadingLabel = 'Loading',
  error = null,
  onRetry,
  style,
  contentContainerStyle,
  testID,
}: ScreenProps): React.ReactElement {
  const theme = useTheme()
  const avoidKeyboard = keyboardAvoiding ?? scroll

  const gutter: ViewStyle = padded
    ? { paddingHorizontal: theme.spacing.lg, paddingVertical: theme.spacing.lg }
    : {}

  let body: React.ReactNode

  if (error) {
    body = (
      <EmptyState
        tone="destructive"
        title="Bu yüklenemedi"
        description={error}
        action={onRetry ? { label: 'Tekrar dene', onPress: onRetry } : undefined}
      />
    )
  } else if (loading) {
    body = <Spinner centred label={loadingLabel} />
  } else if (scroll) {
    body = (
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={[{ flexGrow: 1, gap: theme.spacing.lg }, gutter, contentContainerStyle]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
        refreshControl={refreshControl}
        showsVerticalScrollIndicator={false}
      >
        {children}
      </ScrollView>
    )
  } else {
    body = <View style={[{ flex: 1, gap: theme.spacing.lg }, gutter, contentContainerStyle]}>{children}</View>
  }

  const inner = (
    <>
      {header ? <View style={{ paddingHorizontal: padded ? theme.spacing.lg : 0 }}>{header}</View> : null}
      {body}
      {footer ? (
        <View
          style={{
            paddingHorizontal: padded ? theme.spacing.lg : 0,
            paddingTop: theme.spacing.md,
            paddingBottom: theme.spacing.md,
            borderTopWidth: 1,
            borderTopColor: theme.colors.border,
            backgroundColor: theme.colors.background,
            gap: theme.spacing.md,
          }}
        >
          {footer}
        </View>
      ) : null}
    </>
  )

  return (
    <SafeAreaView
      testID={testID}
      edges={edges}
      style={[{ flex: 1, backgroundColor: theme.colors.background }, style]}
    >
      {avoidKeyboard ? (
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          // iOS pushes the whole view up; Android's windowSoftInputMode already resizes it, and
          // adding padding on top of that leaves a gap the height of the keyboard.
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          {inner}
        </KeyboardAvoidingView>
      ) : (
        inner
      )}
    </SafeAreaView>
  )
}
