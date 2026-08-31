/**
 * components/team/team-card.tsx
 *
 * A team in a list: crest, name, where they play, how many are on the squad.
 *
 * Presentational and server-renderable — every field is handed in, nothing is fetched here.
 *
 * The crest is origin-checked before it reaches `next/image` for the same reason
 * `components/booking/venue-card.tsx` checks a venue photo: `teams.crest_url` is text a captain
 * types, `next/image` refuses any origin outside `images.remotePatterns`, and it refuses it by
 * throwing during render. One pasted link from the wrong host would otherwise take down the whole
 * discovery page. Anything unrecognised falls back to the monogram tile.
 */

import Image from "next/image"
import Link from "next/link"

import { TeamRatingInline, type TeamRatingSummary } from "@/components/team/team-rating"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import type { Enums } from "@halisaha/shared/database"

export interface TeamCardTeam {
  id: string
  name: string
  slug: string
  city: string | null
  crestUrl: string | null
  description: string | null
  isPublic: boolean
  /** Active members only. */
  memberCount: number
  /** The viewer's rank on this team, or `null` if they are not on it. */
  viewerRole: Enums<"team_member_role"> | null
  viewerIsOwner: boolean
}

export interface TeamCardProps {
  team: TeamCardTeam
  /** Optional; omitted on discovery lists where the ratings have not been loaded. */
  rating?: TeamRatingSummary | null
  className?: string
}

export const TEAM_ROLE_LABEL: Readonly<Record<Enums<"team_member_role">, string>> = {
  captain: "Captain",
  vice_captain: "Vice-captain",
  member: "Kadro",
}

export function TeamCard({ team, rating, className }: TeamCardProps) {
  const crest = isRenderableCrest(team.crestUrl) ? team.crestUrl : null

  return (
    <Card className={cn("flex h-full flex-col transition-colors hover:border-foreground/20", className)}>
      <CardHeader className="flex-row items-start gap-3 space-y-0 pb-3">
        <TeamCrest name={team.name} url={crest} />

        <div className="min-w-0 flex-1 space-y-1">
          <CardTitle className="text-base leading-snug">
            <Link
              href={`/teams/${team.slug}`}
              className="rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {team.name}
            </Link>
          </CardTitle>

          <p className="truncate text-xs text-muted-foreground">
            {team.city ?? "No city set"} · {team.memberCount}{" "}
            {team.memberCount === 1 ? "player" : "players"}
          </p>
        </div>
      </CardHeader>

      <CardContent className="flex flex-1 flex-col justify-between gap-3">
        {team.description ? (
          <p className="line-clamp-2 text-sm text-muted-foreground">{team.description}</p>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          {team.viewerIsOwner ? (
            <Badge variant="default">Senin takımın</Badge>
          ) : team.viewerRole ? (
            <Badge variant="secondary">{TEAM_ROLE_LABEL[team.viewerRole]}</Badge>
          ) : null}

          <Badge variant={team.isPublic ? "outline" : "secondary"}>
            {team.isPublic ? "Open to join" : "Invite only"}
          </Badge>

          {rating !== undefined ? <TeamRatingInline summary={rating} className="ml-auto" /> : null}
        </div>
      </CardContent>
    </Card>
  )
}

/* -------------------------------------------------------------------------- */
/*  Crest                                                                      */
/* -------------------------------------------------------------------------- */

export function TeamCrest({
  name,
  url,
  size = 44,
  className,
}: {
  name: string
  url: string | null
  size?: number
  className?: string
}) {
  if (url) {
    return (
      <Image
        src={url}
        alt=""
        width={size}
        height={size}
        className={cn("shrink-0 rounded-md border object-cover", className)}
      />
    )
  }

  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size }}
      className={cn(
        "grid shrink-0 place-items-center rounded-md border bg-muted text-sm font-semibold uppercase text-muted-foreground",
        className,
      )}
    >
      {monogram(name)}
    </span>
  )
}

/** First letters of the first two words, e.g. "Kartal Spor" becomes "KS". */
function monogram(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  const first = words[0]?.slice(0, 1) ?? "?"
  const second = words.length > 1 ? (words[1]?.slice(0, 1) ?? "") : (words[0]?.slice(1, 2) ?? "")
  return `${first}${second}`
}

/**
 * Mirrors `images.remotePatterns` in next.config.mjs. Keep the two in step — this function
 * existing at all is what stops an unlisted origin from throwing inside `next/image`.
 *
 * The wildcard depth matters. The config entry is `*.supabase.in`, and a single `*` in a
 * remotePattern hostname matches exactly ONE label (`**` is the multi-label form). So the test
 * below has to be a single-label one: `endsWith(".supabase.in")` would also accept
 * `a.b.supabase.in`, which next/image is not configured for and would throw on during render —
 * precisely the failure this guard exists to prevent, and on a page rendered for every viewer.
 */
export function isRenderableCrest(rawUrl: string | null | undefined): rawUrl is string {
  if (!rawUrl) return false

  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return false
  }

  if (url.protocol !== "https:") return false
  if (!url.pathname.startsWith("/storage/v1/object/public/")) return false

  const configured = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (configured) {
    try {
      if (url.hostname === new URL(configured).hostname) return true
    } catch {
      // A malformed env var is not this component's problem; fall through to the wildcard rule.
    }
  }
  return /^[^.]+\.supabase\.in$/.test(url.hostname)
}

/* -------------------------------------------------------------------------- */
/*  Skeleton                                                                   */
/* -------------------------------------------------------------------------- */

export function TeamCardSkeleton() {
  return (
    <Card aria-hidden="true" className="h-full">
      <CardHeader className="flex-row items-start gap-3 space-y-0 pb-3">
        <span className="size-11 shrink-0 animate-pulse rounded-md bg-muted" />
        <div className="flex-1 space-y-2">
          <span className="block h-4 w-2/3 animate-pulse rounded bg-muted" />
          <span className="block h-3 w-1/2 animate-pulse rounded bg-muted" />
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <span className="block h-3 w-full animate-pulse rounded bg-muted" />
        <span className="block h-3 w-4/5 animate-pulse rounded bg-muted" />
      </CardContent>
    </Card>
  )
}
