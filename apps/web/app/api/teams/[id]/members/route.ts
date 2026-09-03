/**
 * /api/teams/[id]/members — add somebody to a roster, or take them off it.
 *
 *   POST                    add by playerId, email, or display name
 *   DELETE ?playerId=…      leave, or remove
 *
 * ---------------------------------------------------------------------------------------------
 * WHO MAY DO WHAT
 * ---------------------------------------------------------------------------------------------
 * `private.is_team_captain()` — the RLS write predicate — is true for the owner, a 'captain' and
 * a 'vice_captain'. This route matches it for roster edits and tightens it for rank changes,
 * which live in `members/[playerId]/route.ts`:
 *
 *   add / remove someone else   owner, captain, vice_captain     (this file)
 *   change a rank               owner, captain                   (the sibling route)
 *   leave                       anyone, for their own row
 *
 * The check in this file is a fast, specific 403 with a sentence the user can act on. It is NOT
 * the boundary: `team_members_insert_captain_or_self_join` and
 * `team_members_update_captain_or_self` still run underneath, and a bug here fails closed at the
 * database rather than leaking a write.
 *
 * ---------------------------------------------------------------------------------------------
 * NOBODY IS EVER DELETED
 * ---------------------------------------------------------------------------------------------
 * Leaving sets `left_at`. The row stays, because `private.is_match_participant()` resolves a
 * historical line-up through `team_members`, and `player_stats` rows carry a `team_id` that has to
 * keep meaning something. Deleting the row would quietly rewrite who played in matches that have
 * already been rated. So DELETE here is a verb, not a statement: it performs an UPDATE.
 *
 * Re-joining reuses the same row (the primary key is `(team_id, player_id)`, so a second INSERT
 * would be a 23505 rather than a new membership) and resets the rank to 'member'. A captain who
 * left and was later re-added does not silently walk back in with their old authority.
 *
 * ---------------------------------------------------------------------------------------------
 * INVITING BY EMAIL
 * ---------------------------------------------------------------------------------------------
 * `profiles.email` is absent from the column-level SELECT grant in `0002_rls.sql`, and a column
 * privilege covers a WHERE clause as well as a projection — so the caller's own client cannot
 * filter on it at all. The lookup therefore runs through the service-role client, under four
 * self-imposed limits that keep it from becoming an address-book oracle:
 *
 *   1. Only after the caller has been confirmed a captain of this team.
 *   2. EXACT match only. There is no prefix or partial search, so an attacker can confirm an
 *      address they already guessed and cannot enumerate.
 *   3. It returns the id and display name and nothing else. The email is never echoed, and the
 *      membership INSERT that follows runs on the caller's RLS-bound client.
 *   4. The id it finds is re-read through the CALLER'S client, and a miss is reported as "not
 *      found". The elevated read therefore only ever answers "is this address the person I can
 *      already see?" and never "who owns this address?".
 *
 * Limit 4 is what keeps this from being a privilege escalation rather than a convenience.
 * `team_members_insert_captain_or_self_join` admits a roster INSERT on `private.is_team_captain()`
 * alone — the target never consents — and that row then makes `private.shares_team_with()` true,
 * which `private.can_view_profile()` honours ahead of its `profile_visibility` check. Without the
 * re-read, anybody could create a team (which makes them its captain in one request), post a
 * stranger's address, and buy themselves permanent read access to a private — or minor — profile.
 *
 * Display-name lookup needs none of that: `display_name` is in the SELECT grant, so it runs on the
 * caller's client and `profiles_select_self_or_visible` scopes it — a private profile is not
 * findable by name, which is the entire point of setting it private.
 *
 * No shadow profiles. If nothing matches, the answer is "we have nobody by that address; send
 * them a signup link" and not a single row is written.
 */

import { z } from "zod"

import { fail, handleRoute, ok } from "@/lib/api-response"
import { requireRole } from "@/lib/rbac"
import { createAdminClient } from "@/lib/supabase/admin"
import { createClient } from "@/lib/supabase/server"
import { isUniqueViolation, mentionsConstraint, type PostgresErrorLike } from "@/lib/teams/slug"
import { enforceRateLimit } from "@/lib/rate-limit"
import { isUuid } from "@onpitch/shared/channels"
import type { Enums, Tables } from "@onpitch/shared/database"
import { API_ERROR_CODES } from "@onpitch/shared/domain"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** The partial unique index in `0001_schema.sql`: (team_id, jersey_number) where active. */
const JERSEY_INDEX = "uq_team_members_jersey"
/** `(team_id, player_id)`. A 23505 on this means "already has a row", left or not. */
const MEMBERSHIP_PK = "team_members_pkey"

/* ========================================================================== */
/*  Schemas                                                                   */
/* ========================================================================== */

const jerseySchema = z
  .number()
  .int("A squad number is a whole number.")
  .min(1, "Kadro numbers run from 1 to 99.")
  .max(99, "Kadro numbers run from 1 to 99.")
  .nullable()
  .optional()

const addMemberSchema = z
  .object({
    playerId: z.string().uuid().optional(),
    email: z.string().trim().email("That does not look like an email address.").optional(),
    displayName: z.string().trim().min(2).max(80).optional(),
    jerseyNumber: jerseySchema,
  })
  .refine(
    (body) =>
      body.playerId !== undefined || body.email !== undefined || body.displayName !== undefined,
    { message: "Bir oyuncu kimliği, e-posta adresi ya da görünen ad ver.", path: ["email"] },
  )

/* ========================================================================== */
/*  Wire shape                                                                */
/* ========================================================================== */

interface MemberPayload {
  playerId: string
  role: Enums<"team_member_role">
  jerseyNumber: number | null
  joinedAt: string
  displayName: string | null
  /** True when the person already had a row and this call brought them back. */
  rejoined: boolean
}

/* ========================================================================== */
/*  POST — add                                                                */
/* ========================================================================== */

export async function POST(
  request: Request,
  context: { params: { id: string } },
): Promise<Response> {
  return handleRoute<{ member: MemberPayload }>(async () => {
    const { user } = await requireRole()
    const teamId = context.params.id

    // Budgets are counted in Postgres, not in this process — see lib/rate-limit.ts.
    const limited = await enforceRateLimit("team_invite")
    if (limited) return limited

    if (!isUuid(teamId)) {
      return fail(API_ERROR_CODES.NOT_FOUND, "Takım bulunamadı.", 404)
    }

    const raw: unknown = await request.json().catch(() => null)
    if (raw === null) {
      return fail(API_ERROR_CODES.VALIDATION_FAILED, "JSON gövdesi gerekli.", 422)
    }

    const parsed = addMemberSchema.safeParse(raw)
    if (!parsed.success) {
      return fail(API_ERROR_CODES.VALIDATION_FAILED, "Davet geçersizdi.", 422, {
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
    if (!authority.canManageRoster) {
      return fail(
        API_ERROR_CODES.FORBIDDEN,
        "Bu takıma yalnızca kaptan veya kaptan yardımcısı oyuncu ekleyebilir.",
        403,
      )
    }

    /* ---- resolve the person ------------------------------------------- */

    const resolution = await resolvePlayer(supabase, input)
    if (resolution.status === "not_found") {
      return fail(
        API_ERROR_CODES.NOT_FOUND,
        "Ekleyebileceğin kimse bununla eşleşmiyor. Kayıtlı değilse ona bir kayıt bağlantısı gönder " +
          "ve hesabı olunca ekle — yer tutucu profil oluşturmuyoruz. Profili gizliyse, bir " +
          "kaptanın onu ekleyebilmesi için önce profilini görünür yapması gerekir.",
        404,
      )
    }
    if (resolution.status === "ambiguous") {
      return fail(
        API_ERROR_CODES.VALIDATION_FAILED,
        "Bu görünen adı birden fazla oyuncu kullanıyor. Onun yerine e-posta ile ekle.",
        409,
      )
    }

    const target = resolution.profile

    /* ---- already on the roster? ---------------------------------------- */

    const existing = authority.members.find((row) => row.player_id === target.id)

    if (existing && existing.left_at === null) {
      return fail(API_ERROR_CODES.VALIDATION_FAILED, "Bu oyuncu zaten kadroda.", 409)
    }

    const jerseyNumber = input.jerseyNumber ?? null

    if (existing) {
      // Re-join: reuse the row so the historical membership stays intact, and reset the rank.
      const { data, error } = await supabase
        .from("team_members")
        .update({ left_at: null, role: "member", jersey_number: jerseyNumber })
        .eq("team_id", teamId)
        .eq("player_id", target.id)
        .select("*")
        .maybeSingle()

      const conflict = jerseyConflict(error, jerseyNumber)
      if (conflict) return conflict
      if (error) {
        console.error("[team-members] rejoin failed", { code: error.code })
        return fail(API_ERROR_CODES.INTERNAL, "Oyuncu takıma eklenemedi.", 500)
      }
      if (!data) {
        return fail(API_ERROR_CODES.FORBIDDEN, "Bu kadroyu düzenleyemezsin.", 403)
      }

      await notifyAdded(target.id, authority.team, true)
      return ok({ member: toPayload(data, target.display_name, true) })
    }

    const { data, error } = await supabase
      .from("team_members")
      // `role` is not in the INSERT grant, so the row lands as 'member' by column default. That
      // is the schema refusing to let anyone mint a captain in one statement, not an omission.
      .insert({ team_id: teamId, player_id: target.id, jersey_number: jerseyNumber })
      .select("*")
      .maybeSingle()

    const conflict = jerseyConflict(error, jerseyNumber)
    if (conflict) return conflict

    if (error) {
      if (isUniqueViolation(error) && mentionsConstraint(error, MEMBERSHIP_PK)) {
        // Another captain added them between our read and this insert.
        return fail(API_ERROR_CODES.VALIDATION_FAILED, "Bu oyuncu zaten kadroda.", 409)
      }
      if (error.code === "42501" || error.code === "PGRST301") {
        return fail(API_ERROR_CODES.FORBIDDEN, "Bu kadroyu düzenleyemezsin.", 403)
      }
      console.error("[team-members] insert failed", { code: error.code })
      return fail(API_ERROR_CODES.INTERNAL, "Oyuncu takıma eklenemedi.", 500)
    }

    if (!data) {
      return fail(API_ERROR_CODES.FORBIDDEN, "Bu kadroyu düzenleyemezsin.", 403)
    }

    await notifyAdded(target.id, authority.team, false)
    return ok({ member: toPayload(data, target.display_name, false) }, { status: 201 })
  })
}

/* ========================================================================== */
/*  DELETE — leave or remove                                                  */
/* ========================================================================== */

export async function DELETE(
  request: Request,
  context: { params: { id: string } },
): Promise<Response> {
  return handleRoute<{ playerId: string; leftAt: string }>(async () => {
    const { user } = await requireRole()
    const teamId = context.params.id

    if (!isUuid(teamId)) {
      return fail(API_ERROR_CODES.NOT_FOUND, "Takım bulunamadı.", 404)
    }

    const playerId = new URL(request.url).searchParams.get("playerId")
    if (!isUuid(playerId)) {
      return fail(API_ERROR_CODES.VALIDATION_FAILED, "Geçerli bir playerId gerekli.", 422)
    }

    const supabase = await createClient()

    const authority = await loadAuthority(supabase, teamId, user.id)
    if (!authority) {
      return fail(API_ERROR_CODES.NOT_FOUND, "Takım bulunamadı.", 404)
    }

    const isSelf = playerId === user.id

    if (!isSelf && !authority.canManageRoster) {
      return fail(
        API_ERROR_CODES.FORBIDDEN,
        "Bir oyuncuyu yalnızca kaptan veya kaptan yardımcısı çıkarabilir.",
        403,
      )
    }

    // The owner's authority comes from `teams.owner_id`, which no roster edit can touch — the
    // column is absent from the UPDATE grant because transferring a team is a server-side
    // operation. Letting them "leave" would produce a team run by somebody who is not on it,
    // while RLS carried on treating them as its captain.
    if (playerId === authority.team.owner_id) {
      return fail(
        API_ERROR_CODES.VALIDATION_FAILED,
        isSelf
          ? "You founded this team, so you cannot leave it. A team keeps its founder on the roster."
          : "The team owner cannot be removed from their own team.",
        409,
      )
    }

    const target = authority.members.find((row) => row.player_id === playerId)
    if (!target || target.left_at !== null) {
      return fail(API_ERROR_CODES.NOT_FOUND, "Bu oyuncu kadroda değil.", 404)
    }

    // The same invariant the rank route enforces: the set of people who can run the team must
    // never be emptied. The owner check above normally gets there first, since `owner_id` is
    // always in `captainIds`; this stays as the general statement of the rule so a future change
    // to who counts as a captain cannot quietly strand a team.
    if (authority.captainIds.has(playerId) && authority.captainIds.size <= 1) {
      return fail(
        API_ERROR_CODES.VALIDATION_FAILED,
        "Bu takımın son kaptanı. Önce başka birini kaptan yap.",
        409,
      )
    }

    const leftAt = new Date().toISOString()
    const { data, error } = await supabase
      .from("team_members")
      .update({ left_at: leftAt })
      .eq("team_id", teamId)
      .eq("player_id", playerId)
      .is("left_at", null)
      .select("player_id, left_at")
      .maybeSingle()

    if (error) {
      console.error("[team-members] leave failed", { code: error.code })
      return fail(API_ERROR_CODES.INTERNAL, "Kadro güncellenemedi.", 500)
    }
    if (!data || data.left_at === null) {
      return fail(API_ERROR_CODES.NOT_FOUND, "Bu oyuncu kadroda değil.", 404)
    }

    return ok({ playerId: data.player_id, leftAt: data.left_at })
  })
}

/* ========================================================================== */
/*  Authority                                                                 */
/* ========================================================================== */

type ServerClient = Awaited<ReturnType<typeof createClient>>

/**
 * Who the caller is on this team, and who else holds authority.
 *
 * Duplicated in `members/[playerId]/route.ts` on purpose: the two files own different verbs and
 * a Next.js `route.ts` may only export HTTP handlers and route segment config, so there is no
 * legal way to share a helper between them from inside either one.
 *
 * `members` deliberately includes rows with `left_at` set, because "have they been here before?"
 * is the question that decides between an INSERT and a re-join UPDATE.
 */
interface TeamAuthority {
  team: Tables<"teams">
  members: Tables<"team_members">[]
  caller: Tables<"team_members"> | null
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

  // An invisible team and a missing team are the same answer. Confirming that a private team
  // exists is a small leak with no upside.
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
    caller,
    isOwner,
    isCaptain: isOwner || (callerActive && caller?.role === "captain"),
    canManageRoster:
      isOwner || (callerActive && (caller?.role === "captain" || caller?.role === "vice_captain")),
    captainIds,
  }
}

/* ========================================================================== */
/*  Player resolution                                                         */
/* ========================================================================== */

interface ResolvedProfile {
  id: string
  display_name: string | null
}

type Resolution =
  | { status: "found"; profile: ResolvedProfile }
  | { status: "not_found" }
  | { status: "ambiguous" }

async function resolvePlayer(
  supabase: ServerClient,
  input: { playerId?: string; email?: string; displayName?: string },
): Promise<Resolution> {
  if (input.playerId) {
    // Read through the caller's client: if they cannot see the profile they should not be able
    // to bulk-add ids they scraped from somewhere else.
    const { data } = await supabase
      .from("profiles")
      .select("id, display_name")
      .eq("id", input.playerId)
      .maybeSingle()

    return data ? { status: "found", profile: data } : { status: "not_found" }
  }

  if (input.email) {
    return resolveByEmail(supabase, input.email)
  }

  if (input.displayName) {
    // `ilike` with every wildcard escaped is a case-insensitive EXACT match, which is what a
    // person typing a name expects. RLS scopes the result to profiles they may see.
    //
    // There is no `deleted_at is null` filter, and there must not be: that column is outside the
    // caller's SELECT grant, and a column privilege covers a WHERE clause too, so naming it here
    // would make the whole statement a 42501. It is also unnecessary — every branch of
    // `profiles_select_self_or_visible` except self and admin already requires `deleted_at is
    // null`, and a policy qual runs in the executor rather than under the caller's privileges.
    const { data, error } = await supabase
      .from("profiles")
      .select("id, display_name")
      .ilike("display_name", escapeLike(input.displayName))
      .limit(2)

    if (error) {
      console.error("[team-members] name lookup failed", { code: error.code })
      return { status: "not_found" }
    }

    const rows = data ?? []
    if (rows.length > 1) return { status: "ambiguous" }
    const first = rows[0]
    return first ? { status: "found", profile: first } : { status: "not_found" }
  }

  return { status: "not_found" }
}

/**
 * Exact-address lookup through the service-role client. See the file header for why that client
 * is involved and the four limits that keep it from becoming an enumeration oracle. Nothing but
 * the id and display name leaves this function, and the caller has already been proven a captain.
 *
 * The row the admin client finds is deliberately thrown away: only its id is used, to re-read the
 * profile through the caller's own client so `profiles_select_self_or_visible` gets the last word.
 * An address that belongs to somebody the caller cannot already see resolves to "not found", the
 * same answer an unregistered address gets — the email path can never name a profile the caller
 * could not have named directly, so it cannot be used to farm an unwilling stranger's row into
 * `team_members` and buy `can_view_profile()` over them.
 */
async function resolveByEmail(supabase: ServerClient, email: string): Promise<Resolution> {
  let admin: ReturnType<typeof createAdminClient>
  try {
    admin = createAdminClient()
  } catch (error) {
    console.error("[team-members] admin client unavailable", error)
    return { status: "not_found" }
  }

  // `profiles.email` is citext, so equality is already case-insensitive in the database.
  const { data, error } = await admin
    .from("profiles")
    .select("id, display_name")
    .eq("email", email)
    .is("deleted_at", null)
    .limit(2)

  if (error) {
    console.error("[team-members] email lookup failed", { code: error.code })
    return { status: "not_found" }
  }

  const rows = data ?? []
  // `uq_profiles_email_active` makes two live rows impossible, but answering "ambiguous" rather
  // than picking one is the right behaviour if that ever stops being true.
  if (rows.length > 1) return { status: "ambiguous" }
  const first = rows[0]
  if (!first) return { status: "not_found" }

  // The visibility gate. Everything above ran without an RLS predicate, so nothing it read may be
  // trusted or echoed until the caller's own client confirms it can see this profile by id.
  const { data: visible, error: visibleError } = await supabase
    .from("profiles")
    .select("id, display_name")
    .eq("id", first.id)
    .maybeSingle()

  if (visibleError) {
    console.error("[team-members] email visibility check failed", { code: visibleError.code })
    return { status: "not_found" }
  }

  return visible ? { status: "found", profile: visible } : { status: "not_found" }
}

/* ========================================================================== */
/*  Helpers                                                                   */
/* ========================================================================== */

/**
 * Turn a 23505 on the jersey index into "that number is taken" rather than a 500.
 *
 * PostgREST does not always carry the constraint name through, so when a jersey number was part
 * of the statement and the message is unhelpful, this still answers the jersey error — it is the
 * only unique index a roster write can hit apart from the primary key, which is checked first.
 */
function jerseyConflict(
  error: PostgresErrorLike | null,
  jerseyNumber: number | null,
): Response | null {
  if (!isUniqueViolation(error)) return null
  if (mentionsConstraint(error, MEMBERSHIP_PK)) return null
  if (!mentionsConstraint(error, JERSEY_INDEX) && jerseyNumber === null) return null

  return fail(
    API_ERROR_CODES.VALIDATION_FAILED,
    jerseyNumber === null
      ? "That squad number is taken. Pick another."
      : `Kadro number ${jerseyNumber} is taken. Pick another.`,
    409,
  )
}

function toPayload(
  row: Tables<"team_members">,
  displayName: string | null,
  rejoined: boolean,
): MemberPayload {
  return {
    playerId: row.player_id,
    role: row.role,
    jerseyNumber: row.jersey_number,
    joinedAt: row.joined_at,
    displayName,
    rejoined,
  }
}

/**
 * Tell the player they were added. `notifications` has no INSERT grant for `authenticated` — the
 * server writes the feed and the owner only reads and dismisses it — so this goes through the
 * service-role client with values derived from rows we just read, never from the request body.
 *
 * A failed notification never fails the request: the membership is already committed, and an
 * error here would tell the captain their perfectly successful edit did not work.
 */
async function notifyAdded(
  playerId: string,
  team: Tables<"teams">,
  rejoined: boolean,
): Promise<void> {
  try {
    const admin = createAdminClient()
    const { error } = await admin.from("notifications").insert({
      user_id: playerId,
      type: "team.member_added",
      title: rejoined ? `You are back in ${team.name}` : `You were added to ${team.name}`,
      body: rejoined
        ? `A captain has brought you back into ${team.name}.`
        : `A captain has added you to ${team.name}. You can leave from the team page at any time.`,
      data: { team_id: team.id, team_slug: team.slug },
    })
    if (error) console.error("[team-members] notification insert failed", error.message)
  } catch (error) {
    console.error("[team-members] notification skipped", error)
  }
}

/**
 * Neutralise every wildcard on the way to `ilike`, which is what makes the display-name lookup an
 * EXACT match rather than a pattern.
 *
 * PostgREST rewrites `*` into `%` before the pattern reaches SQL, and SQL treats `%` and `_` as
 * wildcards with backslash as the escape. Leaving any of the three alone would let "a_a" resolve
 * to a player called "ada" and add the wrong person to the squad.
 */
function escapeLike(value: string): string {
  return value.replace(/\*/g, "").replace(/[\\%_]/g, (character) => `\\${character}`)
}
