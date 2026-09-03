"use client"

/**
 * components/team/roster-table.tsx
 *
 * The squad list, and — for whoever is allowed — the controls that change it.
 *
 * ---------------------------------------------------------------------------------------------
 * THE CONTROLS ARE RENDERED FROM THE SAME MODEL THE ROUTES ENFORCE
 * ---------------------------------------------------------------------------------------------
 *   rank            owner or 'captain'
 *   squad number    the player themselves, or owner / 'captain' / 'vice_captain'
 *   remove          owner / 'captain' / 'vice_captain'; anyone may remove themselves
 *
 * Hiding a control the viewer cannot use is honesty, not security: `PATCH` and `DELETE` under
 * `/api/teams/[id]/members` re-derive all of this server-side, and `team_members_update_*` in
 * `0002_rls.sql` sits underneath both. A viewer who forges a request gets a 403 from the route or
 * an empty result set from Postgres.
 *
 * Two rules show up as a disabled control with a reason rather than a missing one, because the
 * absence would look like a bug to the person it applies to:
 *
 *   * the owner's rank cannot be changed — `private.is_team_captain()` is true for them however
 *     the row reads, so a demoted owner would be a display that lies;
 *   * the last captain cannot step down.
 *
 * ---------------------------------------------------------------------------------------------
 * FORMER PLAYERS
 * ---------------------------------------------------------------------------------------------
 * Leaving sets `left_at`; the row survives so historical line-ups keep resolving. Those rows are
 * shown in their own muted section instead of being filtered away, because "who used to play for
 * this club" is a question a squad list should answer.
 */

import { useCallback, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { z } from "zod"

import { JerseyPicker } from "@/components/team/jersey-picker"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { toast } from "@/lib/use-toast"
import { cn } from "@/lib/utils"
import { Constants, type Enums } from "@onpitch/shared/database"

type TeamRole = Enums<"team_member_role">

export interface RosterMember {
  playerId: string
  /** `null` when the viewer may not see this profile — a private account on a public team. */
  displayName: string | null
  role: TeamRole
  jerseyNumber: number | null
  joinedAt: string
  leftAt: string | null
  isOwner: boolean
  preferredPosition: string | null
  /** `player_ratings.conservative_rating`, i.e. mu minus 3 sigma. `null` before a first match. */
  conservativeRating: number | null
}

export interface RosterViewer {
  id: string
  /** Owner or 'captain'. May change ranks. */
  isCaptain: boolean
  /** Owner, 'captain' or 'vice_captain'. May add, remove and re-number. */
  canManageRoster: boolean
}

export interface RosterTableProps {
  teamId: string
  members: readonly RosterMember[]
  viewer: RosterViewer
  className?: string
}

export const ROLE_LABEL: Readonly<Record<TeamRole, string>> = {
  captain: "Captain",
  vice_captain: "Vice-captain",
  member: "Player",
}

const ROLE_VARIANT: Readonly<Record<TeamRole, "default" | "secondary" | "outline">> = {
  captain: "default",
  vice_captain: "secondary",
  member: "outline",
}

/**
 * Both formatters are pinned, locale AND zone.
 *
 * This is a client component rendered by two Server Components, so every cell below is produced
 * once on the server and again in the browser and the two strings are compared. `undefined` here
 * would mean "whatever the host resolves": a UTC/en-US server writes "24.5" and 3 Feb, a tr-TR
 * browser in Europe/Istanbul hydrates "24,5" and 4 Feb, and React throws the markup away. Same
 * hazard `components/admin/role-editor.tsx` documents. Turkey is one zone and the product is
 * Turkish, so these match `lib/notifications/format.ts`.
 */
const DATE_FORMAT = new Intl.DateTimeFormat("tr-TR", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "Europe/Istanbul",
})

const RATING_1DP = new Intl.NumberFormat("tr-TR", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
})

/* ========================================================================== */

export function RosterTable({ teamId, members, viewer, className }: RosterTableProps) {
  const router = useRouter()
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [confirmRemoval, setConfirmRemoval] = useState<RosterMember | null>(null)

  const active = useMemo(() => members.filter((member) => member.leftAt === null), [members])
  const former = useMemo(() => members.filter((member) => member.leftAt !== null), [members])

  const takenNumbers = useMemo(
    () =>
      active
        .map((member) => member.jerseyNumber)
        .filter((number): number is number => number !== null),
    [active],
  )

  /** The owner plus every active captain — the set the "last captain" rule protects. */
  const captainCount = useMemo(
    () => active.filter((member) => member.isOwner || member.role === "captain").length,
    [active],
  )

  const patchMember = useCallback(
    async (member: RosterMember, body: { role?: TeamRole; jerseyNumber?: number | null }) => {
      setPendingId(member.playerId)
      const result = await callApi(`/api/teams/${teamId}/members/${member.playerId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      setPendingId(null)

      if (!result.ok) {
        toast({ variant: "destructive", title: "Kaydedilemedi", description: result.message })
        return
      }

      toast({
        variant: "success",
        title: "Kadro güncellendi",
        description:
          body.role !== undefined
            ? `${nameOf(member)} is now a ${ROLE_LABEL[body.role].toLowerCase()}.`
            : body.jerseyNumber === null
              ? `${nameOf(member)} is playing without a number.`
              : `${nameOf(member)} now wears ${body.jerseyNumber}.`,
      })
      router.refresh()
    },
    [router, teamId],
  )

  const removeMember = useCallback(
    async (member: RosterMember) => {
      setPendingId(member.playerId)
      const result = await callApi(
        `/api/teams/${teamId}/members?playerId=${encodeURIComponent(member.playerId)}`,
        { method: "DELETE" },
      )
      setPendingId(null)
      setConfirmRemoval(null)

      if (!result.ok) {
        toast({ variant: "destructive", title: "Güncellenemedi", description: result.message })
        return
      }

      const isSelf = member.playerId === viewer.id
      toast({
        variant: "success",
        title: isSelf ? "You left the team" : "Player removed",
        description: isSelf
          ? "Your past matches for this team stay on your record."
          : `${nameOf(member)} is no longer on the active squad.`,
      })
      router.refresh()
    },
    [router, teamId, viewer.id],
  )

  if (active.length === 0 && former.length === 0) {
    return (
      <p className={cn("rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground", className)}>
        Kadroda henüz oyuncu yok.
      </p>
    )
  }

  const showActions = viewer.canManageRoster || active.some((m) => m.playerId === viewer.id)

  return (
    <div className={cn("space-y-6", className)}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-16">No.</TableHead>
            <TableHead>Oyuncu</TableHead>
            <TableHead className="w-40">Rütbe</TableHead>
            <TableHead className="hidden sm:table-cell">Mevki</TableHead>
            <TableHead className="hidden text-right md:table-cell">Reyting</TableHead>
            <TableHead className="hidden text-right lg:table-cell">Katıldı</TableHead>
            {showActions ? (
              <TableHead className="w-24 text-right">
                <span className="sr-only">İşlemler</span>
              </TableHead>
            ) : null}
          </TableRow>
        </TableHeader>

        <TableBody>
          {active.map((member) => {
            const isSelf = member.playerId === viewer.id
            const busy = pendingId === member.playerId

            // Rank: captains only, never on the owner, never emptying the captain set.
            const rankLocked =
              member.isOwner || (member.role === "captain" && captainCount <= 1)
            const canEditRank = viewer.isCaptain && !rankLocked

            const canEditNumber = viewer.canManageRoster || isSelf
            const canRemove = (viewer.canManageRoster || isSelf) && !member.isOwner

            return (
              <TableRow key={member.playerId} className={busy ? "opacity-60" : undefined}>
                <TableCell>
                  {canEditNumber ? (
                    <JerseyPicker
                      value={member.jerseyNumber}
                      taken={takenNumbers}
                      disabled={busy}
                      playerName={nameOf(member)}
                      onChange={(next) => void patchMember(member, { jerseyNumber: next })}
                    />
                  ) : (
                    <span className="tabular-nums text-muted-foreground">
                      {member.jerseyNumber ?? "—"}
                    </span>
                  )}
                </TableCell>

                <TableCell className="font-medium">
                  <PlayerName member={member} isSelf={isSelf} />
                </TableCell>

                <TableCell>
                  {canEditRank ? (
                    <Select
                      value={member.role}
                      disabled={busy}
                      onValueChange={(value) =>
                        void patchMember(member, { role: value as TeamRole })
                      }
                    >
                      <SelectTrigger
                        className="h-9"
                        aria-label={`Rank for ${nameOf(member)}`}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Constants.public.Enums.team_member_role.map((role) => (
                          <SelectItem key={role} value={role}>
                            {ROLE_LABEL[role]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <span className="inline-flex items-center gap-2">
                      <Badge variant={ROLE_VARIANT[member.role]}>
                        {member.isOwner ? "Kurucu" : ROLE_LABEL[member.role]}
                      </Badge>
                      {viewer.isCaptain && rankLocked ? (
                        <span className="text-[11px] text-muted-foreground">
                          {member.isOwner ? "always a captain" : "last captain"}
                        </span>
                      ) : null}
                    </span>
                  )}
                </TableCell>

                <TableCell className="hidden text-muted-foreground sm:table-cell">
                  {member.preferredPosition ?? "—"}
                </TableCell>

                <TableCell className="hidden text-right tabular-nums md:table-cell">
                  {member.conservativeRating === null ? (
                    <span className="text-muted-foreground">Reytingsiz</span>
                  ) : (
                    RATING_1DP.format(member.conservativeRating)
                  )}
                </TableCell>

                <TableCell className="hidden text-right text-muted-foreground lg:table-cell">
                  {formatDate(member.joinedAt)}
                </TableCell>

                {showActions ? (
                  <TableCell className="text-right">
                    {canRemove ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => setConfirmRemoval(member)}
                      >
                        {isSelf ? "Leave" : "Remove"}
                      </Button>
                    ) : null}
                  </TableCell>
                ) : null}
              </TableRow>
            )
          })}
        </TableBody>
      </Table>

      {former.length > 0 ? (
        <section aria-labelledby="former-players" className="space-y-2">
          <h3 id="former-players" className="text-sm font-medium text-muted-foreground">
            Eski oyuncular
          </h3>
          <ul className="divide-y rounded-lg border text-sm">
            {former.map((member) => (
              <li
                key={member.playerId}
                className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-muted-foreground"
              >
                <PlayerName member={member} isSelf={member.playerId === viewer.id} />
                <span className="text-xs">
                  {member.jerseyNumber !== null ? `No. ${member.jerseyNumber} · ` : ""}
                  left {formatDate(member.leftAt)}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">
            Geçmiş kadrolar ve maç kayıtları doğru tarafı adıyla göstersin diye saklanır.
          </p>
        </section>
      ) : null}

      <Dialog
        open={confirmRemoval !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmRemoval(null)
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {confirmRemoval?.playerId === viewer.id ? "Leave this team?" : "Remove this player?"}
            </DialogTitle>
            <DialogDescription>
              {confirmRemoval?.playerId === viewer.id
                ? "You come off the active squad. Matches you already played for this team stay on your record, and a captain can add you back."
                : `${confirmRemoval ? nameOf(confirmRemoval) : "This player"} comes off the active squad. Their past matches for the team are untouched, and a captain can add them back.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={() => setConfirmRemoval(null)}>
              Vazgeç
            </Button>
            <Button
              variant="destructive"
              disabled={pendingId !== null}
              onClick={() => {
                if (confirmRemoval) void removeMember(confirmRemoval)
              }}
            >
              {confirmRemoval?.playerId === viewer.id ? "Leave team" : "Remove player"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Bits                                                                       */
/* -------------------------------------------------------------------------- */

function PlayerName({ member, isSelf }: { member: RosterMember; isSelf: boolean }) {
  if (member.displayName === null) {
    return (
      <span className="text-muted-foreground">
        Gizli profil
        <span className="sr-only"> — this player has not made their profile visible to you</span>
      </span>
    )
  }

  return (
    <span className="inline-flex items-center gap-2">
      <Link
        href={`/players/${member.playerId}`}
        className="rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {member.displayName}
      </Link>
      {isSelf ? <span className="text-xs text-muted-foreground">(you)</span> : null}
    </span>
  )
}

function nameOf(member: RosterMember): string {
  return member.displayName ?? "That player"
}

function formatDate(value: string | null): string {
  if (!value) return "—"
  const instant = new Date(value)
  return Number.isNaN(instant.getTime()) ? "—" : DATE_FORMAT.format(instant)
}

/* -------------------------------------------------------------------------- */
/*  Transport                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * `ApiResponse` is a discriminated union, so a failure is parsed rather than inferred from the
 * status code — the route's `message` is already written for a person to read, and showing it
 * beats a generic "request failed".
 */
const failureSchema = z.object({
  ok: z.literal(false),
  error: z.object({ code: z.string(), message: z.string() }),
})

async function callApi(
  url: string,
  init: RequestInit,
): Promise<{ ok: true } | { ok: false; message: string }> {
  let response: Response
  try {
    response = await fetch(url, { credentials: "same-origin", ...init })
  } catch {
    return { ok: false, message: "Sunucuya ulaşılamadı. Bağlantını kontrol et." }
  }

  const payload: unknown = await response.json().catch(() => null)
  const failure = failureSchema.safeParse(payload)
  if (failure.success) return { ok: false, message: failure.data.error.message }
  if (!response.ok) return { ok: false, message: "Bir şeyler ters gitti. Lütfen tekrar dene." }
  return { ok: true }
}
