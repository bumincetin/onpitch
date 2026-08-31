/**
 * app/match/[id]/consensus.tsx
 *
 * Voting on a contested result.
 *
 * ---------------------------------------------------------------------------------------------
 * THE DEVICE COMPUTES ITS OWN DIGEST
 * ---------------------------------------------------------------------------------------------
 *
 * The screen reads the canonical payload twice, from two places, and hashes it here:
 *
 *   1. `supabase.rpc('consensus_payload')` — the source. Runs as the signed-in user, so `auth.uid()`
 *      is the voter and the function's own PT403 keeps non-participants out. The raw jsonb comes
 *      back, is canonicalised with `canonicalizeJsonb` (a byte-for-byte mirror of Postgres's
 *      `jsonb::text`) and hashed with expo-crypto ON THIS DEVICE.
 *
 *   2. `GET /api/matches/[id]/consensus` — the round state: quorum, votes so far, deadline, and the
 *      server's own digest for cross-checking.
 *
 * The vote carries the digest computed in (1). If (1) and (2) disagree, the screen refuses to vote
 * and says so: either the scoreline moved while this screen was open, or something rewrote the
 * payload between the two reads. Both are reasons not to sign.
 *
 * That is what makes an approval mean anything. A bare "yes" does not say what was approved — bind
 * it to `sha256(canonical payload)` and it commits to one scoreline, one line-up and one round
 * nonce, and a client showing a stale score cannot have that assent counted.
 *
 * `submit_consensus_approval` recomputes the digest a third time inside the writing transaction.
 * That is the copy that actually secures this; the two on the way there exist so an honest client
 * gets a clear error instead of a Postgres exception.
 */

import type { PostgrestError } from '@supabase/supabase-js'
import { Redirect, Stack, useLocalSearchParams, useRouter } from 'expo-router'
import * as React from 'react'
import { z } from 'zod'

import { isUuid } from '@halisaha/shared/channels'
import { API_ERROR_CODES } from '@halisaha/shared/domain'

import {
  CanonicalizationError,
  ConsensusCard,
  ErrorNotice,
  computeLocalDigest,
  parseConsensusPayload,
  type ConsensusPayloadShape,
  type ConsensusRoundState,
  type LocalDigest,
} from '@/components/match'
import { Button, EmptyState, Notice, Screen, Text } from '@/components/ui'
import { ApiError, apiFetch, isApiError } from '@/lib/api'
import { DataError } from '@/lib/data-error'
import { supabase, useSession } from '@/lib/supabase'
import { useTheme } from '@/lib/theme'

/**
 * The parts of `ConsensusRound` this screen uses.
 *
 * `payload` is deliberately not read from here. The API's `payload` is a friendly decoding with
 * camelCase keys and joined-in match fields; re-serialising THAT would produce a different digest
 * and every vote would be rejected. The bytes come from the RPC.
 */
const roundSchema = z.object({
  canonical: z.string(),
  digest: z.string(),
  deadline: z.string().nullable(),
  quorumRequired: z.number().int(),
  approvals: z.number().int(),
  rejections: z.number().int(),
  hasHomeApproval: z.boolean(),
  hasAwayApproval: z.boolean(),
  callerHasVoted: z.boolean(),
})

interface Loaded {
  payload: ConsensusPayloadShape
  local: LocalDigest
  serverDigest: string
  /** True when the server's canonical bytes differ from ours, character for character. */
  bytesDiffer: boolean
  round: ConsensusRoundState
  homeLabel: string
  awayLabel: string
  viewerIsParticipant: boolean
}

/* ========================================================================== */
/*  Screen                                                                    */
/* ========================================================================== */

export default function ConsensusScreen(): React.ReactElement {
  const params = useLocalSearchParams<{ id?: string }>()
  const router = useRouter()
  const theme = useTheme()
  const { user } = useSession()

  const matchId = typeof params.id === 'string' ? params.id : null
  const viewerId = user?.id ?? null

  const [loaded, setLoaded] = React.useState<Loaded | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [failure, setFailure] = React.useState<unknown>(null)
  const [submitting, setSubmitting] = React.useState<'approve' | 'reject' | null>(null)

  const load = React.useCallback(async (): Promise<void> => {
    if (!matchId || !isUuid(matchId) || !viewerId) {
      setLoading(false)
      return
    }

    setLoading(true)
    setFailure(null)
    try {
      setLoaded(await loadRound(matchId, viewerId))
    } catch (caught) {
      setFailure(caught)
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
        title: 'Sonucu onayla',
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
            description="Maç kimliği olmadan oy verilecek bir tur yok."
          />
        </Screen>
      </>
    )
  }

  if (loading && !loaded) {
    return (
      <>
        {header}
        <Screen loading loadingLabel="Reading the payload" />
      </>
    )
  }

  async function vote(decision: 'approve' | 'reject'): Promise<void> {
    if (!loaded || !matchId || submitting) return

    setSubmitting(decision)
    setFailure(null)
    try {
      await apiFetch<unknown>(`/api/matches/${matchId}/consensus`, {
        method: 'POST',
        json: {
          decision,
          // The digest THIS DEVICE computed over the bytes it rendered. The handler recomputes it
          // and refuses a mismatch before spending a transaction.
          clientDigest: loaded.local.digest,
        },
      })
      // Re-read rather than patch the counts: the vote may have closed the round, finalised the
      // match and applied ratings on its way out, and the screen should show what actually happened.
      await load()
    } catch (caught) {
      setFailure(caught)
      if (isApiError(caught, API_ERROR_CODES.DIGEST_MISMATCH)) {
        // The result on the table moved. Pull the new payload so the next vote is cast against
        // whatever is now being counted.
        await load()
      }
    } finally {
      setSubmitting(null)
    }
  }

  if (!loaded) {
    const noRound = isApiError(failure, API_ERROR_CODES.REPORT_REJECTED)
    return (
      <>
        {header}
        <Screen scroll>
          <ErrorNotice error={failure} fallback="This round could not be opened." />
          <EmptyState
            title={noRound ? 'Nothing to vote on' : 'No round to show'}
            description={
              noRound
                ? 'There is no open consensus round for this match. One opens when the reports disagree or the integrity checks flag something.'
                : 'The payload for this round could not be read.'
            }
            action={{ label: 'Tekrar dene', onPress: () => void load() }}
            secondaryAction={{
              label: 'Maça dön',
              onPress: () => router.replace(`/match/${matchId}`),
            }}
          />
        </Screen>
      </>
    )
  }

  return (
    <>
      {header}
      <Screen scroll>
        <ErrorNotice error={failure} fallback="Your vote could not be recorded." />

        {loaded.bytesDiffer && loaded.local.digest === loaded.serverDigest ? (
          // Same digest from different bytes is not possible in practice; if it ever happens the
          // canonicalisation is wrong in a way that is about to bite, and it must not pass quietly.
          <Notice
            tone="warning"
            title="Veri kontrolü tutarsız"
            description="Bu cihaz ve sunucu farklı baytlardan aynı özeti üretti. Bunu bildir — aşağıdaki oy yine de gördüğün şeye bağlı."
          />
        ) : null}

        <ConsensusCard
          payload={loaded.payload}
          local={loaded.local}
          serverDigest={loaded.serverDigest}
          round={loaded.round}
          homeLabel={loaded.homeLabel}
          awayLabel={loaded.awayLabel}
          submitting={submitting}
          onVote={(decision) => void vote(decision)}
          disabledReason={
            loaded.viewerIsParticipant
              ? null
              : 'Only the players in this match can vote on its result.'
          }
        />

        <Text variant="caption" tone="muted">
          Onaylar yalnızca skor ve kadro aynı kaldığı sürece geçerlidir. Geç gelen bir bildirim bunlardan birini değiştirirse tur yeniden başlar ve herkese yeniden sorulur.
        </Text>

        <Button
          title="Maça dön"
          variant="outline"
          size="lg"
          fullWidth
          onPress={() => router.replace(`/match/${matchId}`)}
        />
      </Screen>
    </>
  )
}

/* ========================================================================== */
/*  Loader                                                                    */
/* ========================================================================== */

async function loadRound(matchId: string, viewerId: string): Promise<Loaded> {
  /*
   * The payload comes from the RPC, on the user's own client. `consensus_payload` reads
   * `auth.uid()` to decide who is asking — calling it any other way would make that null and either
   * skip the authorisation branch or fail outright. The voter's identity IS the session.
   */
  const { data: rawPayload, error: payloadError } = await supabase.rpc('consensus_payload', {
    p_match_id: matchId,
  })

  if (payloadError) throw new ApiError(codeFor(payloadError), messageFor(payloadError), 409)

  const payload = parseConsensusPayload(rawPayload)
  if (!payload) {
    throw new DataError('The payload for this round is not in a shape this app can verify.')
  }

  let local: LocalDigest
  try {
    // Hashes the RAW value, not the parsed one — see the note on computeLocalDigest.
    local = await computeLocalDigest(rawPayload)
  } catch (caught) {
    if (caught instanceof CanonicalizationError) {
      throw new DataError(
        'This round contains a value this app cannot hash the way the database does, so a vote from here could not be verified. Vote from the web app.',
      )
    }
    throw caught
  }

  const rawRound = await apiFetch<unknown>(`/api/matches/${matchId}/consensus`)
  const parsedRound = roundSchema.safeParse(rawRound)
  if (!parsedRound.success) {
    throw new DataError('The round state came back in a shape this version of the app cannot read.')
  }

  const [matchResult, participantsResult] = await Promise.all([
    supabase
      .from('matches')
      .select('home_team_id, away_team_id')
      .eq('id', matchId)
      .maybeSingle(),
    supabase.from('match_participants').select('player_id').eq('match_id', matchId),
  ])

  const teamIds = [matchResult.data?.home_team_id, matchResult.data?.away_team_id].filter(
    (id): id is string => typeof id === 'string',
  )

  const teams = new Map<string, string>()
  if (teamIds.length > 0) {
    const { data: teamRows } = await supabase.from('teams').select('id, name').in('id', teamIds)
    for (const row of teamRows ?? []) {
      teams.set(row.id, row.name)
    }
  }

  const homeTeamId = matchResult.data?.home_team_id ?? null
  const awayTeamId = matchResult.data?.away_team_id ?? null

  return {
    payload,
    local,
    serverDigest: parsedRound.data.digest.toLowerCase(),
    bytesDiffer: parsedRound.data.canonical !== local.canonical,
    round: {
      deadline: parsedRound.data.deadline,
      quorumRequired: parsedRound.data.quorumRequired,
      approvals: parsedRound.data.approvals,
      rejections: parsedRound.data.rejections,
      hasHomeApproval: parsedRound.data.hasHomeApproval,
      hasAwayApproval: parsedRound.data.hasAwayApproval,
      callerHasVoted: parsedRound.data.callerHasVoted,
    },
    homeLabel: homeTeamId ? (teams.get(homeTeamId) ?? 'Home') : 'Home',
    awayLabel: awayTeamId ? (teams.get(awayTeamId) ?? 'Away') : 'Away',
    viewerIsParticipant: (participantsResult.data ?? []).some((row) => row.player_id === viewerId),
  }
}

/**
 * A `PT*` SQLSTATE carries a message written for a player, so it is forwarded verbatim; anything
 * else gets a neutral sentence, because raw Postgres text leaks constraint names to no one's
 * benefit.
 */
function messageFor(error: PostgrestError): string {
  const code = error.code ?? ''
  if (code.startsWith('PT') && error.message) return error.message
  return 'The payload for this round could not be read.'
}

/** Maps the SQLSTATE onto the same `ApiError` codes the route handlers use. */
function codeFor(error: PostgrestError): string {
  switch (error.code) {
    case 'PT403':
      return API_ERROR_CODES.FORBIDDEN
    case 'PT404':
      return API_ERROR_CODES.NOT_FOUND
    case 'PT409':
      return API_ERROR_CODES.REPORT_REJECTED
    default:
      return API_ERROR_CODES.INTERNAL
  }
}
