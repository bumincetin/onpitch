/**
 * app/(app)/matches/page.tsx
 *
 * The player's match list.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT THIS PAGE CAN AND CANNOT SHOW
 * ---------------------------------------------------------------------------------------------
 *
 * It reads through the cookie-bound client, so `matches_select_involved` in `0002_rls.sql` is what
 * decides the contents:
 *
 *     created_by = auth.uid()  OR  private.can_view_match(id)
 *     can_view_match  =  is_match_participant  OR  can_manage_match
 *     can_manage_match =  is_admin  OR  organiser  OR  owns the venue  OR  owns the pitch
 *
 * There is no "public match" disjunct. A signed-in stranger cannot read a fixture they are not
 * part of — which is a deliberate privacy posture (a match row names the people in it), and it
 * means this page is honestly titled "your matches" rather than a public directory. Open-match
 * DISCOVERY is a different capability with a different threat model: it belongs to
 * `GET /api/matchmaking/suggest`, which ranks candidates server-side and can redact, rather than
 * to a widened SELECT policy that would retroactively open every existing fixture to everyone.
 *
 * Everything below is one round trip per entity kind — never a query inside a loop. Six small
 * `in (...)` reads beat sixty correlated ones, and each of them is an index seek: the id lists
 * come straight from `idx_matches_status_kickoff_at` and land on primary keys.
 */

import type { Metadata } from "next"
import Link from "next/link"

import { getSessionUser } from "@/lib/rbac"
import { createClient } from "@/lib/supabase/server"
import { MatchCard, type MatchCardMatch } from "@/components/match/match-card"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import type { Enums } from "@onpitch/shared/database"

export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "Maçlar",
  description: "Maçların, canlı oyunlar ve seni bekleyen sonuçlar.",
}

/* -------------------------------------------------------------------------- */
/*  Views                                                                      */
/* -------------------------------------------------------------------------- */

interface ViewConfig {
  label: string
  /** Fed straight to `.in('status', …)`, so `idx_matches_status_kickoff_at` covers the read. */
  statuses: Enums<"match_status">[]
  ascending: boolean
  empty: string
}

type ViewKey = "upcoming" | "attention" | "results" | "cancelled"

const VIEWS: Record<ViewKey, ViewConfig> = {
  upcoming: {
    label: "Yaklaşan",
    statuses: ["scheduled", "live"],
    ascending: true,
    empty: "Ajanda boş. Bir saha tut ya da açık bir maça katılarak başla.",
  },
  attention: {
    label: "Seni bekliyor",
    statuses: ["awaiting_report", "requires_consensus", "disputed"],
    ascending: false,
    empty: "Seni bekleyen bir şey yok. Dahil olduğun her sonuç karara bağlandı.",
  },
  results: {
    label: "Sonuçlar",
    statuses: ["finalized"],
    ascending: false,
    empty: "Henüz biten maç yok. İlk onaylanmış sonucun burada görünecek.",
  },
  cancelled: {
    label: "İptal edildi",
    statuses: ["cancelled"],
    ascending: false,
    empty: "Dahil olduğun hiçbir maç iptal edilmedi.",
  },
}

function resolveView(raw: string | undefined): ViewKey {
  return raw && raw in VIEWS ? (raw as ViewKey) : "upcoming"
}

const PAGE_SIZE = 60

/* -------------------------------------------------------------------------- */

export default async function MatchesPage({
  searchParams,
}: {
  searchParams?: { view?: string }
}) {
  const session = await getSessionUser()
  if (!session) {
    // The layout's requireRole() already redirected; this is belt and braces for a direct render.
    return null
  }

  const view = resolveView(searchParams?.view)
  const config = VIEWS[view]
  const supabase = await createClient()

  const { data: matchRows, error } = await supabase
    .from("matches")
    .select(
      "id, kickoff_at, duration_minutes, format, status, home_score, away_score, is_ranked, requires_consensus, venue_id, pitch_id, home_team_id, away_team_id",
    )
    .in("status", config.statuses)
    .order("kickoff_at", { ascending: config.ascending })
    .limit(PAGE_SIZE)

  if (error) {
    return (
      <PageFrame view={view}>
        <Alert variant="destructive">
          <AlertTitle>Maçların yüklenemedi</AlertTitle>
          <AlertDescription>
            Maçların okunurken bir şeyler ters gitti. Sayfayı yenile; devam ederse bize haber ver.
          </AlertDescription>
        </Alert>
      </PageFrame>
    )
  }

  const matches = matchRows ?? []

  if (matches.length === 0) {
    return (
      <PageFrame view={view}>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{VIEWS[view].label.toLowerCase()} — nothing here</CardTitle>
            <CardDescription>{config.empty}</CardDescription>
          </CardHeader>
          <CardContent>
            <Link href="/dashboard" className="text-sm underline underline-offset-4">
              Panele dön
            </Link>
          </CardContent>
        </Card>
      </PageFrame>
    )
  }

  /* ---- one round trip per entity kind ---------------------------------- */

  const matchIds = matches.map((match) => match.id)
  const venueIds = unique(matches.map((match) => match.venue_id))
  const pitchIds = unique(matches.map((match) => match.pitch_id))
  const teamIds = unique([
    ...matches.map((match) => match.home_team_id),
    ...matches.map((match) => match.away_team_id),
  ])

  const [venuesResult, pitchesResult, teamsResult, participantsResult, reportsResult, votesResult] =
    await Promise.all([
      supabase.from("venues").select("id, name, city, timezone").in("id", orSentinel(venueIds)),
      supabase.from("pitches").select("id, name").in("id", orSentinel(pitchIds)),
      supabase.from("teams").select("id, name").in("id", orSentinel(teamIds)),
      supabase.from("match_participants").select("match_id, player_id").in("match_id", matchIds),
      supabase
        .from("score_reports")
        .select("match_id")
        .in("match_id", matchIds)
        .eq("reported_by", session.user.id),
      supabase
        .from("consensus_approvals")
        .select("match_id")
        .in("match_id", matchIds)
        .eq("approver_id", session.user.id),
    ])

  const venues = indexBy(venuesResult.data ?? [], (row) => row.id)
  const pitches = indexBy(pitchesResult.data ?? [], (row) => row.id)
  const teams = indexBy(teamsResult.data ?? [], (row) => row.id)

  const participantCounts = new Map<string, number>()
  const viewerIsIn = new Set<string>()
  for (const row of participantsResult.data ?? []) {
    participantCounts.set(row.match_id, (participantCounts.get(row.match_id) ?? 0) + 1)
    if (row.player_id === session.user.id) viewerIsIn.add(row.match_id)
  }

  const alreadyReported = new Set((reportsResult.data ?? []).map((row) => row.match_id))
  const alreadyVoted = new Set((votesResult.data ?? []).map((row) => row.match_id))

  return (
    <PageFrame view={view}>
      <ul className="grid gap-3 sm:grid-cols-2">
        {matches.map((match) => {
          const venue = match.venue_id ? venues.get(match.venue_id) : undefined
          const pitch = match.pitch_id ? pitches.get(match.pitch_id) : undefined
          const isParticipant = viewerIsIn.has(match.id)

          return (
            <li key={match.id}>
              <MatchCard
                match={match satisfies MatchCardMatch}
                homeTeamName={match.home_team_id ? (teams.get(match.home_team_id)?.name ?? null) : null}
                awayTeamName={match.away_team_id ? (teams.get(match.away_team_id)?.name ?? null) : null}
                venueName={venue?.name ?? null}
                pitchName={pitch?.name ?? null}
                city={venue?.city ?? null}
                timeZone={venue?.timezone}
                participantCount={participantCounts.get(match.id) ?? 0}
                isParticipant={isParticipant}
                actionRequired={actionFor(match, isParticipant, alreadyReported, alreadyVoted)}
              />
            </li>
          )
        })}
      </ul>

      {matches.length === PAGE_SIZE ? (
        <p className="mt-4 text-xs text-muted-foreground">
          Showing the first {PAGE_SIZE} matches in this view.
        </p>
      ) : null}
    </PageFrame>
  )
}

/* -------------------------------------------------------------------------- */
/*  Frame                                                                      */
/* -------------------------------------------------------------------------- */

function PageFrame({ view, children }: { view: ViewKey; children: React.ReactNode }) {
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Maçların</h1>
        <p className="text-sm text-muted-foreground">
          Kurduğun, eklendiğin ya da ev sahipliği yaptığın maçlar.
        </p>
      </div>

      {/*
        Links rather than a client-side tab control: the filter is server-side, each view is a real
        URL you can share or bookmark, and the whole page stays a Server Component.
      */}
      <nav aria-label="Maçları filtrele">
        <ul className="flex flex-wrap gap-1 border-b">
          {(Object.keys(VIEWS) as ViewKey[]).map((key) => {
            const active = key === view
            return (
              <li key={key}>
                <Link
                  href={key === "upcoming" ? "/matches" : `/matches?view=${key}`}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "inline-flex h-9 items-center whitespace-nowrap border-b-2 px-3 text-sm transition-colors",
                    active
                      ? "border-foreground font-medium text-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  {VIEWS[key].label}
                </Link>
              </li>
            )
          })}
        </ul>
      </nav>

      {children}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function actionFor(
  match: { id: string; status: Enums<"match_status">; requires_consensus: boolean },
  isParticipant: boolean,
  reported: Set<string>,
  voted: Set<string>,
): string | null {
  if (!isParticipant) return null
  if (match.requires_consensus && !voted.has(match.id)) return "Vote on the result"
  if (match.status === "awaiting_report" && !reported.has(match.id)) return "Report the score"
  return null
}

function unique(values: (string | null)[]): string[] {
  return Array.from(new Set(values.filter((value): value is string => typeof value === "string")))
}

function indexBy<T>(rows: T[], key: (row: T) => string): Map<string, T> {
  const map = new Map<string, T>()
  for (const row of rows) map.set(key(row), row)
  return map
}

/**
 * The nil UUID, used to keep an `in (...)` lookup well-typed when the id list is empty.
 *
 * Branching on `ids.length` and substituting a resolved promise would make `Promise.all` infer a
 * union of two unrelated response shapes for every lookup. One extra primary-key probe that
 * matches nothing is cheaper than that, in both machine and human terms.
 */
const NIL_UUID = "00000000-0000-0000-0000-000000000000"

function orSentinel(ids: string[]): string[] {
  return ids.length > 0 ? ids : [NIL_UUID]
}
