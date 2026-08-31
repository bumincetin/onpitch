/**
 * app/leagues.tsx
 *
 * City leagues: five divisions, thirteen-week seasons, promotion and relegation.
 *
 * The screen opens on the reader's own team's division rather than on bronze, because a captain
 * checking the league wants their own table, not the bottom one. City and division are local
 * state here — the web version puts them in the URL so a table can be pasted into a group chat,
 * and a phone has no URL bar to paste from.
 *
 * `zoneFor()` is shared with the web AND mirrors `close_season()` in 0009, including the rule
 * that nobody moves out of a division with fewer than six teams. A small table is therefore drawn
 * with no zones at all rather than with zones that will not fire.
 */

import { useRouter } from 'expo-router'
import * as React from 'react'
import { Pressable, RefreshControl, ScrollView, View } from 'react-native'

import { Eyebrow, Measure, SectionHead } from '@/components/progress'
import { ScreenHeader } from '@/components/profile'
import { EmptyState, Screen, Spinner, Text } from '@/components/ui'
import { describeErrorText } from '@/components/match'
import { loadLeagueTable, loadMyLeagues, type LeagueCity } from '@/lib/leagues'
import { useTheme } from '@/lib/theme'
import {
  DIVISIONS,
  DIVISION_COLORS,
  DIVISION_LABELS,
  LEAGUE_RULES,
  daysLeft,
  zoneFor,
  type Division,
  type LeagueStanding,
  type MyLeagueEntry,
} from '@halisaha/shared/leagues'

export default function LeaguesScreen(): React.ReactElement {
  const theme = useTheme()
  const router = useRouter()

  const [mine, setMine] = React.useState<MyLeagueEntry[]>([])
  const [cities, setCities] = React.useState<LeagueCity[]>([])
  const [city, setCity] = React.useState<string | null>(null)
  const [division, setDivision] = React.useState<Division>('bronze')
  const [standings, setStandings] = React.useState<LeagueStanding[]>([])
  const [loading, setLoading] = React.useState(true)
  const [refreshing, setRefreshing] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const load = React.useCallback(async (mode: 'initial' | 'refresh') => {
    if (mode === 'initial') setLoading(true)
    else setRefreshing(true)
    setError(null)

    try {
      const payload = await loadMyLeagues()
      setMine(payload.mine)
      setCities(payload.cities)

      // Open on the reader's own table. Falling back to the first city with a season beats
      // showing an empty bronze table for a city nobody plays in.
      const first = payload.mine[0]
      const nextCity = first?.city ?? payload.cities[0]?.city ?? null
      const nextDivision = first?.division ?? 'bronze'
      setCity(nextCity)
      setDivision(nextDivision)

      setStandings(nextCity ? await loadLeagueTable(nextCity, nextDivision) : [])
    } catch (caught) {
      setError(describeErrorText(caught, 'Ligler yüklenemedi.'))
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  React.useEffect(() => {
    void load('initial')
  }, [load])

  const pick = React.useCallback(
    async (nextCity: string, nextDivision: Division) => {
      setCity(nextCity)
      setDivision(nextDivision)
      try {
        setStandings(await loadLeagueTable(nextCity, nextDivision))
      } catch (caught) {
        setError(describeErrorText(caught, 'Puan durumu yüklenemedi.'))
      }
    },
    [],
  )

  const header = (
    <ScreenHeader
      title="Ligler"
      subtitle={city ? `${city} · ${DIVISION_LABELS[division]}` : 'Şehir ligleri'}
      fallbackHref="/(tabs)/progress"
    />
  )

  if (loading) {
    return (
      <Screen header={header}>
        <Spinner centred label="Ligler yükleniyor" />
      </Screen>
    )
  }

  if (cities.length === 0 && mine.length === 0) {
    return (
      <Screen header={header}>
        <EmptyState
          title="Henüz lig yok"
          description="Aynı şehirden iki takım maç yapıp sonucu kesinleştirdiğinde şehrin ligi açılır."
          action={{ label: 'Tekrar dene', onPress: () => void load('initial') }}
        />
      </Screen>
    )
  }

  const season = cities.find((entry) => entry.city === city) ?? null

  return (
    <Screen padded={false} header={header}>
      <ScrollView
        contentContainerStyle={{
          padding: theme.spacing.lg,
          paddingBottom: theme.spacing.xxxl,
          gap: theme.spacing.xxl,
        }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void load('refresh')}
            tintColor={theme.colors.mutedForeground}
            colors={[theme.colors.primary]}
            progressBackgroundColor={theme.colors.card}
          />
        }
        showsVerticalScrollIndicator={false}
      >
        {error ? (
          <Text variant="caption" tone="destructive" accessibilityLiveRegion="polite">
            {error}
          </Text>
        ) : null}

        {season ? (
          <Eyebrow>
            {season.seasonName} · bitmesine {daysLeft(season.endsOn)} gün
          </Eyebrow>
        ) : null}

        {/* ------------------------------------------------------------- mine */}
        {mine.length > 0 ? (
          <View style={{ gap: theme.spacing.md }}>
            <SectionHead n="01" title="Takımların" />
            {mine.map((entry) => (
              <MyLeagueRow
                key={`${entry.seasonId}-${entry.teamId}`}
                entry={entry}
                onPress={() => void pick(entry.city, entry.division)}
              />
            ))}
          </View>
        ) : null}

        {/* ------------------------------------------------------------ picker */}
        {cities.length > 1 ? (
          <View style={{ gap: theme.spacing.sm }}>
            <Eyebrow>Şehir</Eyebrow>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm }}>
              {cities.map((entry) => (
                <Chip
                  key={entry.city}
                  label={`${entry.city} · ${entry.teams}`}
                  selected={entry.city === city}
                  onPress={() => void pick(entry.city, division)}
                />
              ))}
            </View>
          </View>
        ) : null}

        <View style={{ gap: theme.spacing.sm }}>
          <Eyebrow>Lig seviyesi</Eyebrow>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm }}>
            {[...DIVISIONS].reverse().map((option) => (
              <Chip
                key={option}
                label={DIVISION_LABELS[option]}
                tint={DIVISION_COLORS[option]}
                selected={option === division}
                onPress={() => city && void pick(city, option)}
              />
            ))}
          </View>
        </View>

        {/* ----------------------------------------------------------- table */}
        <View style={{ gap: theme.spacing.sm }}>
          <SectionHead
            n={mine.length > 0 ? '02' : '01'}
            title="Puan durumu"
            aside={<Eyebrow>{standings.length} takım</Eyebrow>}
          />

          {standings.length === 0 ? (
            <Text variant="caption" tone="muted">
              Bu ligde henüz maç oynanmamış. Aynı şehirden iki takım karşılaşıp sonucu
              kesinleştirdiğinde tablo dolmaya başlar.
            </Text>
          ) : (
            standings.map((row) => (
              <StandingRow
                key={row.teamId}
                row={row}
                division={division}
                teams={standings.length}
                mine={mine.some((entry) => entry.teamId === row.teamId)}
                onPress={() => router.push(`/teams`)}
              />
            ))
          )}

          <Text variant="caption" tone="muted" style={{ marginTop: theme.spacing.md }}>
            {standings.length >= LEAGUE_RULES.minimumForMovement
              ? `İlk ${LEAGUE_RULES.promote} takım bir üst lige çıkar, son ${LEAGUE_RULES.relegate} takım bir alt lige düşer. Hiç maç yapmamış takım düşmez.`
              : `Bu ligde ${LEAGUE_RULES.minimumForMovement} takımdan az var; sezon sonunda kimse çıkmaz ya da düşmez.`}
          </Text>
        </View>
      </ScrollView>
    </Screen>
  )
}

/* ========================================================================== */

function Chip({
  label,
  selected,
  tint,
  onPress,
}: {
  label: string
  selected: boolean
  tint?: string
  onPress: () => void
}): React.ReactElement {
  const theme = useTheme()
  const color = tint ?? theme.colors.gold

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={{
        paddingVertical: theme.spacing.sm,
        paddingHorizontal: theme.spacing.md,
        borderBottomWidth: 2,
        borderBottomColor: selected ? color : 'transparent',
      }}
    >
      <Text
        variant="caption"
        weight="600"
        tone={selected ? 'default' : 'muted'}
        style={{ letterSpacing: 1.2, textTransform: 'uppercase' }}
      >
        {label}
      </Text>
    </Pressable>
  )
}

function MyLeagueRow({
  entry,
  onPress,
}: {
  entry: MyLeagueEntry
  onPress: () => void
}): React.ReactElement {
  const theme = useTheme()
  const tint = DIVISION_COLORS[entry.division]
  const zone = zoneFor(entry.position, entry.teamsInDivision, entry.division)

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={{
        borderTopWidth: 1,
        borderTopColor: theme.colors.border,
        paddingVertical: theme.spacing.lg,
        gap: theme.spacing.md,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}>
        <View
          style={{
            width: 10,
            height: 10,
            borderWidth: 1,
            borderColor: tint,
            backgroundColor: tint,
            transform: [{ rotate: '45deg' }],
          }}
        />
        <Text variant="body" weight="500" style={{ flex: 1 }} numberOfLines={1}>
          {entry.teamName}
        </Text>
        <Text
          variant="caption"
          weight="600"
          style={{ color: tint, letterSpacing: 1.2, textTransform: 'uppercase', fontSize: 10 }}
        >
          {DIVISION_LABELS[entry.division]}
        </Text>
      </View>

      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: theme.spacing.md }}>
        <Text variant="display" weight="300" style={{ fontVariant: ['tabular-nums'] }}>
          {entry.position}
        </Text>
        <Text variant="caption" tone="muted">
          / {entry.teamsInDivision} takım
        </Text>
        <Text
          variant="caption"
          style={{
            marginLeft: 'auto',
            color:
              zone === 'promotion'
                ? theme.colors.teal
                : zone === 'relegation'
                  ? theme.colors.vermilion
                  : theme.colors.mutedForeground,
          }}
        >
          {zone === 'promotion' ? 'Çıkma hattında' : zone === 'relegation' ? 'Düşme hattında' : 'Güvende'}
        </Text>
      </View>

      <View style={{ flexDirection: 'row', gap: theme.spacing.lg }}>
        <Measure label="O" value={entry.played} style={{ flex: 1 }} />
        <Measure label="G" value={entry.won} tone="teal" style={{ flex: 1 }} />
        <Measure label="B" value={entry.drawn} style={{ flex: 1 }} />
        <Measure label="M" value={entry.lost} style={{ flex: 1 }} />
        <Measure label="P" value={entry.points} tone="gold" style={{ flex: 1 }} />
      </View>
    </Pressable>
  )
}

function StandingRow({
  row,
  division,
  teams,
  mine,
  onPress,
}: {
  row: LeagueStanding
  division: Division
  teams: number
  mine: boolean
  onPress: () => void
}): React.ReactElement {
  const theme = useTheme()
  const zone = zoneFor(row.place, teams, division)
  const edge =
    zone === 'promotion'
      ? theme.colors.teal
      : zone === 'relegation'
        ? theme.colors.vermilion
        : 'transparent'

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${row.place}. ${row.teamName}, ${row.points} puan`}
      onPress={onPress}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.sm,
        paddingVertical: theme.spacing.md,
        paddingHorizontal: mine ? theme.spacing.sm : 0,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
        backgroundColor: mine ? `${theme.colors.gold}1A` : 'transparent',
      }}
    >
      <View style={{ width: 3, height: 18, backgroundColor: edge }} />
      <Text variant="caption" tone="muted" style={{ width: 22, fontVariant: ['tabular-nums'] }}>
        {String(row.place).padStart(2, '0')}
      </Text>
      <Text variant="body" style={{ flex: 1 }} numberOfLines={1}>
        {row.teamName}
      </Text>
      <Text variant="caption" tone="muted" style={{ width: 26, textAlign: 'right', fontVariant: ['tabular-nums'] }}>
        {row.played}
      </Text>
      <Text variant="caption" tone="muted" style={{ width: 32, textAlign: 'right', fontVariant: ['tabular-nums'] }}>
        {row.goalDifference > 0 ? `+${row.goalDifference}` : row.goalDifference}
      </Text>
      <Text
        variant="body"
        weight="600"
        style={{
          width: 30,
          textAlign: 'right',
          fontVariant: ['tabular-nums'],
          color: DIVISION_COLORS[division],
        }}
      >
        {row.points}
      </Text>
    </Pressable>
  )
}
