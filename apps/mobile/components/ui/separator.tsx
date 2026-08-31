/**
 * components/ui/separator.tsx
 *
 * A hairline rule. `StyleSheet.hairlineWidth` rather than 1 — on a 3x screen a 1pt border is
 * three physical pixels and reads as a heavy line next to native list separators.
 */

import * as React from 'react'
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'

import { useTheme } from '@/lib/theme'

export interface SeparatorProps {
  orientation?: 'horizontal' | 'vertical'
  /** Insets the line from the leading edge, the way a native list does under an avatar. */
  inset?: number
  style?: StyleProp<ViewStyle>
}

export function Separator({
  orientation = 'horizontal',
  inset = 0,
  style,
}: SeparatorProps): React.ReactElement {
  const theme = useTheme()

  return (
    <View
      // Decorative: it carries no information a screen reader needs to announce.
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        orientation === 'horizontal'
          ? { height: StyleSheet.hairlineWidth, width: '100%', marginLeft: inset }
          : { width: StyleSheet.hairlineWidth, alignSelf: 'stretch', marginTop: inset },
        { backgroundColor: theme.colors.border },
        style,
      ]}
    />
  )
}
