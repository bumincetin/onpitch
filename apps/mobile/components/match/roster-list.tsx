/**
 * components/match/roster-list.tsx
 *
 * Who is playing, split by side.
 *
 * A name can be missing here even when the participant row is visible. `player_ratings` is
 * readable by any signed-in user, but the NAME attached to a rating is what the `profiles`
 * policies protect — so a player whose profile the viewer may not see renders as "Player" with
 * their rating intact. That is the privacy model working, not a failed read, and the component
 * says nothing about it rather than drawing attention to who is hidden.
 */

import * as React from 'react'
import { Pressable, View } from 'react-native'

import { Avatar, Badge, Separator, Text } from '@/components/ui'
import { useTheme } from '@/lib/theme'

export interface RosterPlayer {
  playerId: string
  /** `profiles.display_name ?? full_name`, or null when the viewer may not read the profile. */
  displayName: string | null
  avatarUrl: string | null
  teamSide: 'home' | 'away' | null
  /** `match_participants.is_confirmed` — whether they have checked in. */
  isConfirmed: boolean
  /** `player_ratings.conservative_rating`, i.e. mu − 3σ. Null for a player with no rating row. */
  conservativeRating: number | null
  isSelf: boolean
}

export interface RosterListProps {
  players: readonly RosterPlayer[]
  /** Players per side for the format. Drives the "5 of 7" counts. */
  teamSize: number
  homeLabel?: string
  awayLabel?: string
  /** Profile ids currently on the live channel, if a scoreboard is attached. */
  presentIds?: ReadonlySet<string>
  /**
   * Opens a player. Omit and the rows are inert.
   *
   * The component does not reach for the router itself: it is rendered inside a match screen that
   * already owns navigation, and a shared list that pushed routes of its own would be one more
   * place a route name could go stale.
   */
  onSelectPlayer?: (playerId: string) => void
}

export function RosterList({
  players,
  teamSize,
  homeLabel = 'Home',
  awayLabel = 'Away',
  presentIds,
  onSelectPlayer,
}: RosterListProps): React.ReactElement {
  const theme = useTheme()

  const home: RosterPlayer[] = []
  const away: RosterPlayer[] = []
  for (const player of players) {
    if (player.teamSide === 'away') away.push(player)
    else home.push(player)
  }

  return (
    <View style={{ gap: theme.spacing.xl }}>
      <RosterSide
        label={homeLabel}
        players={home}
        teamSize={teamSize}
        presentIds={presentIds}
        onSelectPlayer={onSelectPlayer}
      />
      <RosterSide
        label={awayLabel}
        players={away}
        teamSize={teamSize}
        presentIds={presentIds}
        onSelectPlayer={onSelectPlayer}
      />
    </View>
  )
}

function RosterSide({
  label,
  players,
  teamSize,
  presentIds,
  onSelectPlayer,
}: {
  label: string
  players: readonly RosterPlayer[]
  teamSize: number
  presentIds?: ReadonlySet<string>
  onSelectPlayer?: (playerId: string) => void
}): React.ReactElement {
  const theme = useTheme()

  // Checked-in players first, then by rating, then by name. A captain reading this wants to know
  // who is definitely coming before who is merely listed.
  const ordered = [...players].sort((a, b) => {
    if (a.isConfirmed !== b.isConfirmed) return a.isConfirmed ? -1 : 1
    const ratingGap = (b.conservativeRating ?? -Infinity) - (a.conservativeRating ?? -Infinity)
    if (ratingGap !== 0 && Number.isFinite(ratingGap)) return ratingGap
    return (a.displayName ?? '').localeCompare(b.displayName ?? '')
  })

  return (
    <View style={{ gap: theme.spacing.md }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: theme.spacing.sm,
        }}
      >
        <Text variant="heading" accessibilityRole="header">
          {label}
        </Text>
        <Text variant="label" tone="muted">
          {players.length} of {teamSize}
        </Text>
      </View>

      {ordered.length === 0 ? (
        <Text variant="body" tone="muted">
          Bu tarafta henüz kimse yok.
        </Text>
      ) : (
        <View
          style={{
            borderRadius: theme.radius.lg,
            borderWidth: 1,
            borderColor: theme.colors.border,
            backgroundColor: theme.colors.card,
            overflow: 'hidden',
          }}
        >
          {ordered.map((player, index) => (
            <React.Fragment key={player.playerId}>
              {index > 0 ? <Separator inset={theme.spacing.lg} /> : null}
              <RosterRow
                player={player}
                present={presentIds?.has(player.playerId) ?? false}
                onSelect={onSelectPlayer}
              />
            </React.Fragment>
          ))}
        </View>
      )}
    </View>
  )
}

function RosterRow({
  player,
  present,
  onSelect,
}: {
  player: RosterPlayer
  present: boolean
  onSelect?: (playerId: string) => void
}): React.ReactElement {
  const theme = useTheme()
  const name = player.displayName?.trim() || 'Player'

  const label = [
    name,
    player.isSelf ? 'you' : null,
    player.isConfirmed ? 'checked in' : 'not checked in',
    present ? 'at the pitch' : null,
    typeof player.conservativeRating === 'number'
      ? `rating ${player.conservativeRating.toFixed(1)}`
      : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join(', ')

  const rowStyle = {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.md,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.md,
  } as const

  // A row is a link to that player when the screen supplied a handler, and an inert block of text
  // when it did not. `accessible` collapses either into one element, so the label carries the
  // whole row rather than the reader stepping through five fragments.
  const body = (
    <>
      <Avatar uri={player.avatarUrl} name={player.displayName} size="md" />

      <View style={{ flex: 1, gap: theme.spacing.xs }}>
        <Text variant="body" weight={player.isSelf ? '600' : '400'} numberOfLines={1}>
          {name}
          {player.isSelf ? ' (you)' : ''}
        </Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.xs }}>
          <Badge tone={player.isConfirmed ? 'success' : 'outline'} size="sm">
            {player.isConfirmed ? 'Checked in' : 'Not checked in'}
          </Badge>
          {present ? (
            <Badge tone="primary" size="sm">
              Şu an burada
            </Badge>
          ) : null}
        </View>
      </View>

      <Text variant="label" tone="muted" style={{ fontVariant: ['tabular-nums'] }}>
        {typeof player.conservativeRating === 'number'
          ? player.conservativeRating.toFixed(1)
          : '—'}
      </Text>
    </>
  )

  if (!onSelect) {
    return (
      <View accessible accessibilityLabel={label} style={rowStyle}>
        {body}
      </View>
    )
  }

  return (
    <Pressable
      accessible
      accessibilityRole="button"
      accessibilityLabel={`${label}. Opens their profile.`}
      onPress={() => onSelect(player.playerId)}
      style={({ pressed }) => [rowStyle, pressed ? { opacity: 0.6 } : null]}
    >
      {body}
    </Pressable>
  )
}
