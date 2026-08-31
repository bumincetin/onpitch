/**
 * app/match/[id]/report.tsx
 *
 * Filing the score.
 *
 * ---------------------------------------------------------------------------------------------
 * THIS SCREEN ADJUDICATES NOTHING
 * ---------------------------------------------------------------------------------------------
 *
 * `public.validate_score_report()` — the BEFORE INSERT trigger from `0005_integrity_consensus.sql`
 * — decides whether a report is allowed: are you in the line-up, has the match kicked off, is the
 * 48-hour window still open, is the scoreline physically possible, is your device clock plausible,
 * have you filed too many reports lately. Every one of those checks runs inside the writing
 * transaction and none of them can be bypassed.
 *
 * So the form mirrors a couple of them to avoid dangling a button that can only be refused, and
 * otherwise gets out of the way. When the trigger does refuse, its message is written to be read by
 * a player ("That scoreline is not possible in a 60 minute match (at most 30 goals in total).") and
 * `describeError` forwards it verbatim rather than replacing it with something vaguer.
 *
 * ---------------------------------------------------------------------------------------------
 * THE PREVIEW IS A FORECAST, NOT A PROMISE
 * ---------------------------------------------------------------------------------------------
 *
 * `rateScoreline()` from @halisaha/shared/trueskill is a mirror of `public.trueskill2_update`, so
 * the number under the steppers is the update the server would run for THIS scoreline with the
 * line-up as it stands. It is computed on the device and stored nowhere. Ratings only move once the
 * result is confirmed — which may be after a consensus round, and may be a different scoreline.
 */

import { Redirect, Stack, useLocalSearchParams, useRouter } from 'expo-router'
import * as React from 'react'
import { View } from 'react-native'
import { z } from 'zod'

import { isUuid } from '@halisaha/shared/channels'
import type { Enums } from '@halisaha/shared/database'
import { SCORE_VERDICTS } from '@halisaha/shared/domain'
import { defaultRating, rateScoreline, type RatedTeamMember } from '@halisaha/shared/trueskill'

import {
  ErrorNotice,
  RatingDelta,
  ScoreStepper,
  describeErrorText,
} from '@/components/match'
import { Button, EmptyState, Notice, Screen, Text } from '@/components/ui'
import { apiFetch } from '@/lib/api'
import { DataError, dataError } from '@/lib/data-error'
import { formatKickoff, formatRelative } from '@/lib/format'
import { supabase, useSession } from '@/lib/supabase'
import { useTheme } from '@/lib/theme'

/** `report_window_hours` in 0005. Mirrored so the form can say when it closes. */
const REPORT_WINDOW_HOURS = 48
/** `max_goals_per_team` in 0005. The trigger is the real limit; this caps the stepper. */
const MAX_GOALS_PER_TEAM = 30

/** The `ReportScoreResult` the route answers with. Parsed, because the envelope is all `apiFetch` checks. */
const reportResultSchema = z.object({
  verdict: z.enum(SCORE_VERDICTS),
  variance: z.number(),
  reportsCount: z.number().int(),
  requiresConsensus: z.boolean(),
})

type ReportResult = z.infer<typeof reportResultSchema>

interface ReportContext {
  id: string
  kickoffAt: string
  /** `venues.timezone`. Kick-off is quoted in the venue's zone, never the device's. */
  timezone: string | null
  durationMinutes: number
  status: Enums<'match_status'>
  isRanked: boolean
  scoreConfirmedAt: string | null
  homeLabel: string
  awayLabel: string
  viewerSide: 'home' | 'away' | null
  viewerIsParticipant: boolean
  /** An existing report by this viewer. Reports cannot be edited, so this closes the form. */
  existingReport: { homeScore: number; awayScore: number; reportedAt: string } | null
  homeSquad: RatedTeamMember[]
  awaySquad: RatedTeamMember[]
}

/* ========================================================================== */
/*  Screen                                                                    */
/* ========================================================================== */

export default function ReportScoreScreen(): React.ReactElement {
  const params = useLocalSearchParams<{ id?: string }>()
  const router = useRouter()
  const theme = useTheme()
  const { user } = useSession()

  const matchId = typeof params.id === 'string' ? params.id : null
  const viewerId = user?.id ?? null

  const [context, setContext] = React.useState<ReportContext | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [loadError, setLoadError] = React.useState<string | null>(null)

  const [homeScore, setHomeScore] = React.useState(0)
  const [awayScore, setAwayScore] = React.useState(0)
  const [submitting, setSubmitting] = React.useState(false)
  const [failure, setFailure] = React.useState<unknown>(null)
  const [result, setResult] = React.useState<ReportResult | null>(null)

  const load = React.useCallback(async (): Promise<void> => {
    if (!matchId || !isUuid(matchId) || !viewerId) {
      setLoading(false)
      return
    }

    setLoading(true)
    setLoadError(null)
    try {
      setContext(await loadReportContext(matchId, viewerId))
    } catch (caught) {
      setLoadError(describeErrorText(caught, 'This match could not be loaded.'))
    } finally {
      setLoading(false)
    }
  }, [matchId, viewerId])

  React.useEffect(() => {
    void load()
  }, [load])

  if (!viewerId) return <Redirect href="/(auth)/sign-in" />

  const header = (
    <Stack.Screen
      options={{
        headerShown: true,
        title: 'Skoru bildir',
        headerBackTitle: 'Match',
        headerShadowVisible: false,
        headerStyle: { backgroundColor: theme.colors.background },
        headerTintColor: theme.colors.foreground,
      }}
    />
  )

  if (!matchId || !isUuid(matchId)) {
    return (
      <>
        {header}
        <Screen>
          <EmptyState
            tone="destructive"
            title="Bu maç bağlantısı geçerli değil"
            description="Maç kimliği olmadan bildirilecek bir şey yok."
          />
        </Screen>
      </>
    )
  }

  if (loading && !context) {
    return (
      <>
        {header}
        <Screen loading loadingLabel="Loading the match" />
      </>
    )
  }

  if (!context) {
    return (
      <>
        {header}
        <Screen>
          <EmptyState
            tone={loadError ? 'destructive' : 'default'}
            title={loadError ? 'That did not load' : 'Match not found'}
            description={loadError ?? 'It has been removed, or it is not one you can see.'}
            action={{ label: 'Tekrar dene', onPress: () => void load() }}
          />
        </Screen>
      </>
    )
  }

  const kickoffMs = Date.parse(context.kickoffAt)
  const closesAtMs = kickoffMs + REPORT_WINDOW_HOURS * 3_600_000
  const now = Date.now()

  /*
   * The trigger's total-goals rule, mirrored: greatest(10, ceil(duration_minutes / 2)). Shown as a
   * warning and used to hold the button, so an impossible scoreline is caught before it costs a
   * round trip — and the server still gets the last word.
   */
  const maxTotal = Math.max(10, Math.ceil(context.durationMinutes / 2))
  const total = homeScore + awayScore
  const overTotal = total > maxTotal

  const blocked = blockingReason(context, now, kickoffMs, closesAtMs)
  const preview = blocked ? null : previewFor(context, viewerId, homeScore, awayScore)

  async function submit(): Promise<void> {
    if (!context || submitting) return
    setSubmitting(true)
    setFailure(null)

    try {
      const raw = await apiFetch<unknown>(`/api/matches/${context.id}/report-score`, {
        method: 'POST',
        json: {
          homeScore,
          awayScore,
          // The timestamp this device asserts. Stored next to the server's own `reported_at`; the
          // gap between them is an anomaly feature, and a clock more than five minutes out gets
          // the report refused with a message saying so.
          clientReportedAt: new Date().toISOString(),
          ...(context.viewerSide ? { teamSide: context.viewerSide } : {}),
        },
      })

      const parsed = reportResultSchema.safeParse(raw)
      if (!parsed.success) {
        throw new DataError(
          'The report was filed, but the answer could not be read. Reload the match.',
        )
      }
      setResult(parsed.data)
    } catch (caught) {
      setFailure(caught)
    } finally {
      setSubmitting(false)
    }
  }

  /* ---- already done ---------------------------------------------------- */

  if (result) {
    const verdict = VERDICT_COPY[result.verdict]
    return (
      <>
        {header}
        <Screen scroll>
          <Notice tone={verdict.tone} title={verdict.title} description={verdict.body} live />

          <Text variant="body">
            You reported {homeScore}–{awayScore}. {result.reportsCount}{' '}
            {result.reportsCount === 1 ? 'report has' : 'reports have'} been filed for this match.
          </Text>

          {result.requiresConsensus ? (
            <Button
              title="Oylamaya git"
              size="lg"
              fullWidth
              onPress={() => router.replace(`/match/${context.id}/consensus`)}
            />
          ) : null}

          <Button
            title="Maça dön"
            variant="outline"
            size="lg"
            fullWidth
            onPress={() => router.replace(`/match/${context.id}`)}
          />
        </Screen>
      </>
    )
  }

  if (context.existingReport) {
    return (
      <>
        {header}
        <Screen scroll>
          <Notice
            tone="info"
            title="Bu maçı zaten bildirdin"
            description={`You filed ${context.existingReport.homeScore}–${context.existingReport.awayScore} ${formatRelative(context.existingReport.reportedAt)}. Reports cannot be edited, because a disagreement is judged on what each side filed.`}
          />
          <Button
            title="Maça dön"
            variant="outline"
            size="lg"
            fullWidth
            onPress={() => router.replace(`/match/${context.id}`)}
          />
        </Screen>
      </>
    )
  }

  if (blocked) {
    return (
      <>
        {header}
        <Screen scroll>
          <Notice tone="info" title={blocked.title} description={blocked.body} />
          <Button
            title="Maça dön"
            variant="outline"
            size="lg"
            fullWidth
            onPress={() => router.replace(`/match/${context.id}`)}
          />
        </Screen>
      </>
    )
  }

  /* ---- the form -------------------------------------------------------- */

  return (
    <>
      {header}
      <Screen
        scroll
        footer={
          <Button
            title="Bu skoru gönder"
            size="lg"
            fullWidth
            loading={submitting}
            disabled={overTotal}
            onPress={() => void submit()}
          />
        }
      >
        <View style={{ gap: theme.spacing.xs }}>
          <Text variant="title">
            {context.homeLabel} against {context.awayLabel}
          </Text>
          <Text variant="label" tone="muted">
            {formatKickoff(context.kickoffAt, context.timezone ?? undefined)}
            {context.timezone ? ` · venue time (${context.timezone})` : " · your device's time"}
            {/* `new Date(NaN).toISOString()` throws, and an unparseable kickoff must not take the
                form down — it would be the one screen a player needs at that moment. */}
            {Number.isFinite(closesAtMs)
              ? ` · report closes ${formatRelative(new Date(closesAtMs).toISOString())}`
              : ''}
          </Text>
        </View>

        <ErrorNotice error={failure} fallback="The score could not be filed." />

        <View style={{ flexDirection: 'row', gap: theme.spacing.lg }}>
          <ScoreStepper
            label={context.homeLabel}
            value={homeScore}
            onChange={setHomeScore}
            max={MAX_GOALS_PER_TEAM}
            disabled={submitting}
          />
          <ScoreStepper
            label={context.awayLabel}
            value={awayScore}
            onChange={setAwayScore}
            max={MAX_GOALS_PER_TEAM}
            disabled={submitting}
          />
        </View>

        {overTotal ? (
          <Notice
            tone="warning"
            live
            title="Bu, maçın süresine sığmayacak kadar çok gol"
            description={`A ${context.durationMinutes} minute match takes at most ${maxTotal} goals in total. The database refuses anything above that, so check the numbers before filing.`}
          />
        ) : null}

        <Text variant="caption" tone="muted">
          Gerçekte ne oynandıysa onu bildir. Kadrodaki herkes bildirim yapabilir, bildirimler birbiriyle karşılaştırılır ve anlaşmazlık ilk bildirene değil oylamaya gider.
        </Text>

        {context.isRanked && preview ? (
          <RatingDelta
            before={preview.before}
            after={preview.after}
            variant="preview"
            title={`If ${homeScore}–${awayScore} stands`}
          />
        ) : null}

        {context.isRanked && !preview ? (
          <Text variant="caption" tone="muted">
            Reyting önizlemesi için her iki tarafta en az bir oyuncu ve kendi reyting satırın gerekir.
          </Text>
        ) : null}

        {!context.isRanked ? (
          <Text variant="caption" tone="muted">
            Bu bir hazırlık maçı; sonuç ne olursa olsun hiçbir reyting değişmez.
          </Text>
        ) : null}
      </Screen>
    </>
  )
}

/* ========================================================================== */
/*  Verdicts                                                                  */
/* ========================================================================== */

const VERDICT_COPY: Record<
  (typeof SCORE_VERDICTS)[number],
  { title: string; body: string; tone: 'success' | 'info' | 'warning' }
> = {
  finalized: {
    title: 'Sonuç onaylandı',
    body: 'Bildirimler uyuşuyor; skor kesinleşti ve reytingler işlendi.',
    tone: 'success',
  },
  awaiting_opponent: {
    title: 'Gönderildi. Karşı taraf bekleniyor',
    body: 'Bildirimin kaydedildi. Karşı taraftan biri aynı skoru bildirdiğinde ya da kimse itiraz etmezse 24 saat sonra kesinleşir.',
    tone: 'info',
  },
  requires_consensus: {
    title: 'Bildirimler çelişiyor',
    body: 'Bir oylama açık; hangi skorun geçerli olacağına kadro karar veriyor. Sahaya gelen oyuncuların üçte ikisi ve her iki taraftan en az birer kişi gerekir.',
    tone: 'warning',
  },
}

/* ========================================================================== */
/*  Gates and preview                                                         */
/* ========================================================================== */

/**
 * Why the form should not be shown at all.
 *
 * Each of these is also enforced by the trigger. Rendering the reason instead of the form is the
 * difference between "you cannot do this, and here is why" and a button that fails on tap.
 */
function blockingReason(
  context: ReportContext,
  now: number,
  kickoffMs: number,
  closesAtMs: number,
): { title: string; body: string } | null {
  if (!context.viewerIsParticipant) {
    return {
      title: 'Yalnızca kadro bildirim yapabilir',
      body: 'Skorlar oynayanlardan gelir. Bu maçta oynadığın hâlde listede yoksan seni eklemesi için maçı kurana söyle.',
    }
  }
  if (context.scoreConfirmedAt !== null || context.status === 'finalized') {
    return {
      title: 'Bu sonuç zaten karara bağlandı',
      body: 'Skor onaylandı, artık yeni bildirim alınmıyor.',
    }
  }
  if (context.status === 'cancelled') {
    return { title: 'Bu maç iptal edildi', body: 'Bildirilecek bir sonuç yok.' }
  }
  if (now < kickoffMs) {
    return {
      title: 'Maç henüz başlamadı',
      body: `Reporting opens at kick-off, ${formatKickoff(
        context.kickoffAt,
        context.timezone ?? undefined,
      )}${context.timezone ? ` (${context.timezone})` : ''}.`,
    }
  }
  if (now > closesAtMs) {
    return {
      title: 'Bildirim süresi kapandı',
      body: `Reports are taken for ${REPORT_WINDOW_HOURS} hours after kick-off. After that an administrator has to settle the result.`,
    }
  }
  return null
}

/**
 * What this scoreline would do to the viewer's own rating.
 *
 * Runs the same TrueSkill 2 update the server runs, on the device, over the line-up as it stands.
 * Returns null when the maths would be degenerate — an empty side, or a viewer with no rating in
 * the squad arrays — rather than inventing a plausible-looking number.
 */
function previewFor(
  context: ReportContext,
  viewerId: string,
  homeScore: number,
  awayScore: number,
): { before: { mu: number; sigma: number }; after: { mu: number; sigma: number } } | null {
  if (context.homeSquad.length === 0 || context.awaySquad.length === 0) return null

  try {
    const result = rateScoreline(context.homeSquad, context.awaySquad, homeScore, awayScore)
    const own = result.deltas.find((delta) => delta.playerId === viewerId)
    if (!own) return null
    return {
      before: { mu: own.muBefore, sigma: own.sigmaBefore },
      after: { mu: own.muAfter, sigma: own.sigmaAfter },
    }
  } catch {
    // `rate()` throws a RangeError on degenerate input (a player on both sides, zero weights). A
    // missing preview is a missing paragraph; it must never take the form down with it.
    return null
  }
}

/* ========================================================================== */
/*  Loader                                                                    */
/* ========================================================================== */

async function loadReportContext(
  matchId: string,
  viewerId: string,
): Promise<ReportContext | null> {
  const { data: match, error } = await supabase
    .from('matches')
    .select(
      'id, kickoff_at, duration_minutes, status, is_ranked, score_confirmed_at, home_team_id, away_team_id, venue_id',
    )
    .eq('id', matchId)
    .maybeSingle()

  if (error) throw dataError('Could not load this match.', error)
  if (!match) return null

  const teamIds = [match.home_team_id, match.away_team_id].filter(
    (id): id is string => typeof id === 'string',
  )

  const [teamsResult, participantsResult, reportResult, venueResult] = await Promise.all([
    teamIds.length > 0
      ? supabase.from('teams').select('id, name').in('id', teamIds)
      : Promise.resolve({ data: null, error: null }),
    supabase.from('match_participants').select('player_id, team_side').eq('match_id', matchId),
    supabase
      .from('score_reports')
      .select('home_score, away_score, reported_at')
      .eq('match_id', matchId)
      .eq('reported_by', viewerId)
      .maybeSingle(),
    // A venue the viewer cannot read costs a zone label, not the screen.
    match.venue_id
      ? supabase.from('venues').select('timezone').eq('id', match.venue_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ])

  if (participantsResult.error) throw dataError('Could not load the line-up.', participantsResult.error)

  const participants = participantsResult.data ?? []
  const playerIds = participants.map((row) => row.player_id)

  const { data: ratingRows } = playerIds.length
    ? await supabase.from('player_ratings').select('player_id, mu, sigma').in('player_id', playerIds)
    : { data: null }

  const ratings = new Map<string, { mu: number; sigma: number }>()
  for (const row of ratingRows ?? []) {
    ratings.set(row.player_id, { mu: row.mu, sigma: row.sigma })
  }

  const homeSquad: RatedTeamMember[] = []
  const awaySquad: RatedTeamMember[] = []
  for (const row of participants) {
    // A newcomer with no `player_ratings` row is rated at the PRIOR, not skipped.
    // `apply_match_rating` collects every `match_participants` row and `trueskill2_update` calls
    // `private.ensure_rating_row(pid, cfg.mu0, cfg.sigma0)` for each of them, so the server rates
    // the whole line-up over a roster that includes the unrated player. `defaultRating()` is
    // (mu0, sigma0) from the same shared config, so seeding here is what makes this preview agree
    // with the update it is previewing; dropping the player is what made it disagree.
    const rating = ratings.get(row.player_id) ?? defaultRating()
    const member: RatedTeamMember = { playerId: row.player_id, mu: rating.mu, sigma: rating.sigma }
    if (row.team_side === 'away') awaySquad.push(member)
    else homeSquad.push(member)
  }

  const teams = new Map<string, string>()
  for (const row of teamsResult.data ?? []) {
    teams.set(row.id, row.name)
  }

  const own = participants.find((row) => row.player_id === viewerId)
  const existing = reportResult.data

  return {
    id: match.id,
    kickoffAt: match.kickoff_at,
    timezone: venueResult.data?.timezone ?? null,
    durationMinutes: match.duration_minutes,
    status: match.status,
    isRanked: match.is_ranked,
    scoreConfirmedAt: match.score_confirmed_at,
    homeLabel: match.home_team_id ? (teams.get(match.home_team_id) ?? 'Home') : 'Home',
    awayLabel: match.away_team_id ? (teams.get(match.away_team_id) ?? 'Away') : 'Away',
    viewerSide: own ? (own.team_side === 'away' ? 'away' : 'home') : null,
    viewerIsParticipant: Boolean(own),
    existingReport: existing
      ? {
          homeScore: existing.home_score,
          awayScore: existing.away_score,
          reportedAt: existing.reported_at,
        }
      : null,
    homeSquad,
    awaySquad,
  }
}
