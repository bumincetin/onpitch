import * as React from 'react'
import { View } from 'react-native'

import { Button, Text } from '@/components/ui'
import { useTheme } from '@/lib/theme'
import { formatXp, type ChallengeState } from '@onpitch/shared/gamification'

import { Eyebrow, HairlineBar } from './primitives'

/**
 * One weekly objective, with its claim button.
 *
 * The claim is a deliberate tap rather than an automatic payout, for the same reason as on the
 * web: XP that lands silently is a number that changed while nobody was looking. Collecting it
 * is the mechanic.
 *
 * The button is disabled while the request is in flight and the row only shows as collected
 * once the server has said so, because the server is the only thing that knows whether this tap
 * or the one on the other device won.
 */

export interface ChallengeRowProps {
  challenge: ChallengeState
  index: number
  claimed: boolean
  pending: boolean
  onClaim: (challenge: ChallengeState) => void
}

export function ChallengeRow({
  challenge,
  index,
  claimed,
  pending,
  onClaim,
}: ChallengeRowProps): React.ReactElement {
  const theme = useTheme()
  const isClaimed = claimed || challenge.claimedAt !== null
  const isComplete = challenge.completedAt !== null
  const ratio = challenge.target > 0 ? challenge.progress / challenge.target : 0

  return (
    <View
      style={{
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
        paddingVertical: theme.spacing.lg,
        flexDirection: 'row',
        gap: theme.spacing.md,
      }}
    >
      <Text
        variant="caption"
        weight="600"
        style={{ color: theme.colors.gold, letterSpacing: 1.4, width: 22, marginTop: 2 }}
      >
        {String(index + 1).padStart(2, '0')}
      </Text>

      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: theme.spacing.md }}>
          <Text variant="body" weight="500" style={{ flex: 1 }}>
            {challenge.title}
          </Text>
          <Eyebrow tone="gold">+{formatXp(challenge.xpReward)} XP</Eyebrow>
        </View>

        <Text variant="caption" tone="muted" style={{ marginTop: 4 }}>
          {challenge.description}
        </Text>

        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.spacing.md,
            marginTop: theme.spacing.md,
          }}
        >
          <HairlineBar
            ratio={ratio}
            color={isComplete ? theme.colors.teal : theme.colors.gold}
            style={{ flex: 1 }}
          />
          <Text variant="caption" tone="muted" style={{ fontVariant: ['tabular-nums'] }}>
            {challenge.progress} / {challenge.target}
          </Text>
        </View>

        {isClaimed ? (
          <Text variant="caption" style={{ color: theme.colors.teal, marginTop: theme.spacing.md }}>
            Ödül alındı
          </Text>
        ) : isComplete ? (
          <View style={{ marginTop: theme.spacing.md, alignSelf: 'flex-start' }}>
            <Button
              size="sm"
              variant="primary"
              disabled={pending}
              onPress={() => onClaim(challenge)}
              title={pending ? 'Alınıyor…' : 'Ödülü al'}
            />
          </View>
        ) : null}
      </View>
    </View>
  )
}
