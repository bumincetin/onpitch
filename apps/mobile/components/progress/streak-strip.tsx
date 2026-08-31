import * as React from 'react'
import { View } from 'react-native'

import { Text } from '@/components/ui'
import { useTheme } from '@/lib/theme'
import type { FormResult } from '@/lib/progress'

import { Eyebrow } from './primitives'

/**
 * Streak and form: the two numbers a player checks without meaning to.
 *
 * The streak is drawn as marks rather than printed as a number, because a run of six is a shape
 * you take in at a glance. The marks grow toward the present, so the run reads as a direction
 * rather than as a fence.
 *
 * Form uses the notation a Turkish football page already uses — G/B/M — which saves a legend,
 * and the screen reader gets the words spelled out instead.
 */

/** Marks drawn per week, capped so a long run stays on one line on a phone. */
const MAX_MARKS = 8

export function StreakStrip({
  weeks,
  longest,
  lastPlayedOn,
}: {
  weeks: number
  longest: number
  lastPlayedOn: string | null
}): React.ReactElement {
  const theme = useTheme()
  const marks = Math.min(weeks, MAX_MARKS)

  return (
    <View style={{ borderTopWidth: 1, borderTopColor: theme.colors.border, paddingTop: 10 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Eyebrow>Seri</Eyebrow>
        <Eyebrow>en uzun {longest}</Eyebrow>
      </View>

      {weeks === 0 ? (
        <Text variant="caption" tone="muted" style={{ marginTop: 10 }}>
          {lastPlayedOn
            ? 'Serin bitti. Bu hafta bir maç yaparsan yeniden başlar.'
            : 'İlk maçını oynadığında serin başlar.'}
        </Text>
      ) : (
        <View
          style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 10, marginTop: 12 }}
          accessible
          accessibilityLabel={`${weeks} haftalık seri, en uzunu ${longest} hafta.`}
        >
          <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 3 }}>
            {Array.from({ length: marks }, (_, i) => (
              <View
                key={i}
                style={{
                  width: 5,
                  height: 10 + (i / Math.max(1, marks - 1)) * 14,
                  backgroundColor: theme.colors.gold,
                }}
              />
            ))}
          </View>
          <Text variant="title" weight="300" style={{ fontVariant: ['tabular-nums'] }}>
            {weeks}
            <Text variant="caption" tone="muted">
              {'  '}hafta
            </Text>
          </Text>
        </View>
      )}
    </View>
  )
}

const FORM_LETTER: Record<FormResult, string> = { win: 'G', draw: 'B', loss: 'M' }
const FORM_WORD: Record<FormResult, string> = {
  win: 'galibiyet',
  draw: 'beraberlik',
  loss: 'mağlubiyet',
}

export function FormRow({ results }: { results: readonly FormResult[] }): React.ReactElement {
  const theme = useTheme()
  const shown = results.slice(-5)

  const colorFor = (result: FormResult): string =>
    result === 'win'
      ? theme.colors.teal
      : result === 'loss'
        ? theme.colors.vermilion
        : theme.colors.mutedForeground

  return (
    <View style={{ borderTopWidth: 1, borderTopColor: theme.colors.border, paddingTop: 10 }}>
      <Eyebrow>Form</Eyebrow>

      {shown.length === 0 ? (
        <Text variant="caption" tone="muted" style={{ marginTop: 10 }}>
          Henüz sonuçlanmış maçın yok.
        </Text>
      ) : (
        <View
          style={{ flexDirection: 'row', gap: 6, marginTop: 12 }}
          accessible
          accessibilityLabel={`Son ${shown.length} maç, eskiden yeniye: ${shown
            .map((r) => FORM_WORD[r])
            .join(', ')}.`}
        >
          {shown.map((result, i) => (
            <View
              key={`${result}-${i}`}
              style={{
                width: 28,
                height: 28,
                alignItems: 'center',
                justifyContent: 'center',
                borderWidth: 1,
                borderColor: colorFor(result),
              }}
            >
              <Text variant="caption" weight="600" style={{ color: colorFor(result) }}>
                {FORM_LETTER[result]}
              </Text>
            </View>
          ))}
        </View>
      )}
    </View>
  )
}
