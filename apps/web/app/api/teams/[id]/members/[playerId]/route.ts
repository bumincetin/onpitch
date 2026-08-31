/**
 * PATCH /api/teams/[id]/members/[playerId] — change somebody's rank or squad number.
 *
 * ---------------------------------------------------------------------------------------------
 * TWO DIFFERENT PERMISSIONS IN ONE HANDLER
 * ---------------------------------------------------------------------------------------------
 *   role           owner or 'captain'.        A rank is authority; handing it out is a captain's
 *                                             job and a vice-captain does not get to promote.
 *   jerseyNumber   the player themselves, or anyone who can manage the roster
 *                  (owner, 'captain', 'vice_captain').
 *
 * A body carrying both fields must clear both bars. The narrower right does not inherit from the
 * wider one, so a vice-captain editing their own number is fine and a vice-captain promoting a
 * friend is a 403.
 *
 * Underneath, `team_members_update_captain_or_self` gates the row and the RESTRICTIVE
 * `team_members_update_no_self_promotion` stops a rank-and-file member writing anything but
 * 'member' into `role`. Note what that restrictive policy does NOT do: it admits a 'vice_captain'
 * writing 'captain', because `private.is_team_captain()` is true for them. The tighter rule above
 * is this route's, so it is enforced here and documented as a deliberate narrowing rather than a
 * duplicate of the policy.
 *
 * ---------------------------------------------------------------------------------------------
 * THE TEAM ALWAYS HAS A CAPTAIN
 * ---------------------------------------------------------------------------------------------
 * `captainIds` is the owner plus every active 'captain' row — the people who can actually run the
 * team — and two guards keep it from being emptied or misreported:
 *
 *   * A rank change may not leave that set empty. Since `owner_id` is always in it, this fires
 *     exactly when a founder who is the only captain tries to step down, and the message tells
 *     them what to do about it: promote somebody first.
 *   * The owner's rank is otherwise fixed at captain. `private.is_team_captain()` returns true
 *     for `teams.owner_id` whatever their roster row says, so a demoted owner would render as a
 *     plain member while still holding every write right — a display that lies about who is in
 *     charge.
 *
 * They are checked in that order, because "promote somebody first" is actionable and "ownership
 * carries the rank" is only an explanation.
 *
 * ---------------------------------------------------------------------------------------------
 * SQUAD NUMBERS
 * ---------------------------------------------------------------------------------------------
 * `uq_team_members_jersey` is UNIQUE on `(team_id, jersey_number)` WHERE the member is active and
 * the number is set. Two players reaching for 10 at the same moment is a race no SELECT can win,
 * so the write goes ahead and SQLSTATE 23505 comes back as "that number is taken" with a 409 —
 * never as a 500. `null` clears the number and is always allowed, since the partial index ignores
 * nulls entirely.
 */

import { z } from "zod"

import { fail, handleRoute, ok } from "@/lib/api-response"
import { requireRole } from "@/lib/rbac"
import { createAdminClient } from "@/lib/supabase/admin"
import { createClient } from "@/lib/supabase/server"
import { isUniqueViolation, mentionsConstraint } from "@/lib/teams/slug"
import { isUuid } from "@halisaha/shared/channels"
import { Constants, type Enums, type Tables } from "@halisaha/shared/database"
import { API_ERROR_CODES } from "@halisaha/shared/domain"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const MEMBERSHIP_PK = "team_members_pkey"

/* ========================================================================== */
/*  Schema                                                                    */
/* ========================================================================== */

const patchSchema = z
  .object({
    role: z.enum(Constants.public.Enums.team_member_role).optional(),
    jerseyNumber: z
      .number()
      .int("A squad number is a whole number.")
      .min(1, "Kadro numbers run from 1 to 99.")
      .max(99, "Kadro numbers run from 1 to 99.")
      .nullable()
      .optional(),
  })
  .refine((body) => body.role !== undefined || body.jerseyNumber !== undefined, {
    message: "Değiştirilecek bir şey yok.",
    path: ["role"],
  })

interface MemberPayload {
  playerId: string
  role: Enums<"team_member_role">
  jerseyNumber: number | null
}

/* ========================================================================== */
/*  PATCH                                                                     */
/* ========================================================================== */

export async function PATCH(
  request: Request,
  context: { params: { id: string; playerId: string } },
): Promise<Response> {
  return handleRoute<{ member: MemberPayload }>(async () => {
    const { user } = await requireRole()
    const { id: teamId, playerId } = context.params

    if (!isUuid(teamId)) {
      return fail(API_ERROR_CODES.NOT_FOUND, "Takım bulunamadı.", 404)
    }
    if (!isUuid(playerId)) {
      return fail(API_ERROR_CODES.NOT_FOUND, "Bu oyuncu kadroda değil.", 404)
    }

    const raw: unknown = await request.json().catch(() => null)
    if (raw === null) {
      return fail(API_ERROR_CODES.VALIDATION_FAILED, "JSON gövdesi gerekli.", 422)
    }

    const parsed = patchSchema.safeParse(raw)
    if (!parsed.success) {
      return fail(API_ERROR_CODES.VALIDATION_FAILED, "Değişiklik geçersizdi.", 422, {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      })
    }

    const input = parsed.data
    const supabase = await createClient()

    const authority = await loadAuthority(supabase, teamId, user.id)
    if (!authority) {
      return fail(API_ERROR_CODES.NOT_FOUND, "Takım bulunamadı.", 404)
    }

    const target = authority.members.find((row) => row.player_id === playerId)
    if (!target || target.left_at !== null) {
      return fail(API_ERROR_CODES.NOT_FOUND, "Bu oyuncu kadroda değil.", 404)
    }

    /* ---- permission ---------------------------------------------------- */

    if (input.role !== undefined && !authority.isCaptain) {
      return fail(API_ERROR_CODES.FORBIDDEN, "Bir oyuncunun rütbesini yalnızca kaptan değiştirebilir.", 403)
    }

    if (input.jerseyNumber !== undefined && playerId !== user.id && !authority.canManageRoster) {
      return fail(
        API_ERROR_CODES.FORBIDDEN,
        "Başka bir oyuncunun forma numarasını yalnızca kaptan veya kaptan yardımcısı belirleyebilir.",
        403,
      )
    }

    /* ---- rank rules ---------------------------------------------------- */

    if (input.role !== undefined && input.role !== target.role) {
      const losesCaptaincy = authority.captainIds.has(playerId) && input.role !== "captain"

      // Who would still hold captain authority afterwards. Checked BEFORE the owner rule below,
      // because the actionable message for a founder who is the only captain is "promote somebody
      // first", not an explanation of how ownership works.
      const remainingCaptains = new Set(authority.captainIds)
      if (losesCaptaincy) remainingCaptains.delete(playerId)

      if (remainingCaptains.size === 0) {
        return fail(
          API_ERROR_CODES.VALIDATION_FAILED,
          playerId === user.id
            ? "You are this team's last captain. Promote somebody else before stepping down."
            : "That is the team's last captain. Promote somebody else first.",
          409,
        )
      }

      if (playerId === authority.team.owner_id && input.role !== "captain") {
        return fail(
          API_ERROR_CODES.VALIDATION_FAILED,
          "Takım sahibi her zaman kaptandır — rütbesi takımı kurmuş olmasından gelir, " +
            "bu satırdan değil.",
          409,
        )
      }
    }

    /* ---- write --------------------------------------------------------- */

    const patch: { role?: Enums<"team_member_role">; jersey_number?: number | null } = {}
    if (input.role !== undefined) patch.role = input.role
    if (input.jerseyNumber !== undefined) patch.jersey_number = input.jerseyNumber

    const { data, error } = await supabase
      .from("team_members")
      .update(patch)
      .eq("team_id", teamId)
      .eq("player_id", playerId)
      // Belt and braces against a concurrent removal: an UPDATE that would resurrect a departed
      // member by writing their rank is not what this endpoint is for.
      .is("left_at", null)
      .select("player_id, role, jersey_number")
      .maybeSingle()

    if (error) {
      if (isUniqueViolation(error) && !mentionsConstraint(error, MEMBERSHIP_PK)) {
        return fail(
          API_ERROR_CODES.VALIDATION_FAILED,
          input.jerseyNumber === null || input.jerseyNumber === undefined
            ? "That squad number is taken. Pick another."
            : `Kadro number ${input.jerseyNumber} is taken. Pick another.`,
          409,
        )
      }
      if (error.code === "42501" || error.code === "PGRST301") {
        return fail(API_ERROR_CODES.FORBIDDEN, "Bu değişikliği yapamazsın.", 403)
      }
      console.error("[team-members] patch failed", { code: error.code })
      return fail(API_ERROR_CODES.INTERNAL, "Değişiklik kaydedilemedi.", 500)
    }

    if (!data) {
      // RLS refused the row, or the member left between the read and the write.
      return fail(API_ERROR_CODES.NOT_FOUND, "Bu oyuncu kadroda değil.", 404)
    }

    if (input.role !== undefined && input.role !== target.role) {
      await notifyRoleChange(playerId, authority.team, input.role)
    }

    return ok({
      member: {
        playerId: data.player_id,
        role: data.role,
        jerseyNumber: data.jersey_number,
      },
    })
  })
}

/* ========================================================================== */
/*  Authority                                                                 */
/* ========================================================================== */

type ServerClient = Awaited<ReturnType<typeof createClient>>

/**
 * Who the caller is on this team, and who else holds authority.
 *
 * Deliberately duplicated from `members/route.ts`: a Next.js `route.ts` may only export HTTP
 * handlers and route segment config, so neither file can legally export a shared helper to the
 * other. Keep the two copies in step — they encode the same permission model.
 */
interface TeamAuthority {
  team: Tables<"teams">
  members: Tables<"team_members">[]
  isOwner: boolean
  /** Owner or 'captain'. May change ranks. */
  isCaptain: boolean
  /** Owner, 'captain' or 'vice_captain' — mirrors `private.is_team_captain()`. */
  canManageRoster: boolean
  /** Everyone holding captain authority right now: the owner plus active 'captain' rows. */
  captainIds: Set<string>
}

async function loadAuthority(
  supabase: ServerClient,
  teamId: string,
  userId: string,
): Promise<TeamAuthority | null> {
  const { data: team, error: teamError } = await supabase
    .from("teams")
    .select("*")
    .eq("id", teamId)
    .maybeSingle()

  if (teamError || !team) return null

  const { data: memberRows, error: memberError } = await supabase
    .from("team_members")
    .select("*")
    .eq("team_id", teamId)

  if (memberError) {
    console.error("[team-members] roster read failed", { code: memberError.code })
    return null
  }

  const members = memberRows ?? []
  const caller = members.find((row) => row.player_id === userId) ?? null
  const isOwner = team.owner_id === userId
  const callerActive = caller !== null && caller.left_at === null

  const captainIds = new Set<string>([team.owner_id])
  for (const row of members) {
    if (row.left_at === null && row.role === "captain") captainIds.add(row.player_id)
  }

  return {
    team,
    members,
    isOwner,
    isCaptain: isOwner || (callerActive && caller?.role === "captain"),
    canManageRoster:
      isOwner || (callerActive && (caller?.role === "captain" || caller?.role === "vice_captain")),
    captainIds,
  }
}

/* ========================================================================== */
/*  Notification                                                              */
/* ========================================================================== */

const ROLE_LABEL: Readonly<Record<Enums<"team_member_role">, string>> = {
  captain: "captain",
  vice_captain: "vice-captain",
  member: "squad member",
}

/**
 * `notifications` has no INSERT grant for `authenticated`, so the feed is written server-side.
 * Every value comes from rows already read under RLS, never from the request body, and a failure
 * is logged rather than surfaced: the rank change is committed and telling the captain otherwise
 * would be wrong.
 */
async function notifyRoleChange(
  playerId: string,
  team: Tables<"teams">,
  role: Enums<"team_member_role">,
): Promise<void> {
  try {
    const admin = createAdminClient()
    const { error } = await admin.from("notifications").insert({
      user_id: playerId,
      type: "team.role_changed",
      title: `Your role at ${team.name} changed`,
      body: `You are now a ${ROLE_LABEL[role]} of ${team.name}.`,
      data: { team_id: team.id, team_slug: team.slug, role },
    })
    if (error) console.error("[team-members] role notification failed", error.message)
  } catch (error) {
    console.error("[team-members] role notification skipped", error)
  }
}
