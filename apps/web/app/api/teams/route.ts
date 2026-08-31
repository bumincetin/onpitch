/**
 * /api/teams — create a team, and list the ones a player can see.
 *
 *   GET   ?scope=mine|discover&q=&city=&limit=   list
 *   POST                                         create
 *   PATCH                                        edit (the target is `id` in the body)
 *
 * PATCH sits on the collection rather than on `/api/teams/[id]` for the same reason it does in
 * `/api/pitches`: this module is the only team-write route, and keeping the update here puts
 * every column change behind one validated server handler instead of a `supabase.from('teams')
 * .update(...)` in the browser. The client never names a column — it sends the camelCase fields of
 * the schema below and this file maps them.
 *
 * `slug` is deliberately not editable. It is in the UPDATE grant, so the database would allow it,
 * but a team's URL is pasted into group chats and changing it breaks every one of them. The handle
 * is minted once from the name at creation and then left alone.
 *
 * ---------------------------------------------------------------------------------------------
 * AUTHORISATION
 * ---------------------------------------------------------------------------------------------
 * All three verbs use the caller's cookie-bound client, so `teams_select_public_or_member`,
 * `teams_insert_own` and `teams_update_captain` in `0002_rls.sql` are the boundary — never the
 * service role, which this module does not touch. `scope=mine` narrows to teams the caller
 * belongs to, and `scope=discover` narrows to `is_public` — but neither filter is what stops a
 * stranger reading a private team. The policy does. Removing the filters would change what this
 * endpoint returns, not who is allowed to read it.
 *
 * ---------------------------------------------------------------------------------------------
 * CREATING A TEAM IS THREE STATEMENTS, AND THE ORDER MATTERS
 * ---------------------------------------------------------------------------------------------
 *   1. INSERT the team.       `teams_insert_own` requires `owner_id = auth.uid()`.
 *   2. INSERT the owner's roster row. `role` is deliberately absent from the column-level INSERT
 *      grant, so the row lands as 'member' whatever we ask for.
 *   3. UPDATE that row to 'captain'. This is the only path to a captain row, and it is safe here
 *      because `private.is_team_captain()` already returns true for the owner, so the restrictive
 *      `team_members_update_no_self_promotion` policy admits it. Nobody is gaining authority they
 *      did not already have — the row is being made to agree with the ownership.
 *
 * Steps 2 and 3 are best-effort. Ownership alone confers captaincy in every RLS predicate, so a
 * team whose owner has no roster row is still fully administrable; the roster UI renders the owner
 * from `teams.owner_id` regardless. Failing the whole creation over a cosmetic row would be the
 * worse trade, so the failure is logged and the team is returned.
 */

import { z } from "zod"

import { fail, handleRoute, ok } from "@/lib/api-response"
import { requireRole } from "@/lib/rbac"
import { createClient } from "@/lib/supabase/server"
import { insertWithUniqueSlug } from "@/lib/teams/slug"
import { enforceRateLimit } from "@/lib/rate-limit"
import type { Enums, Tables, TablesInsert, TablesUpdate } from "@halisaha/shared/database"
import { API_ERROR_CODES } from "@halisaha/shared/domain"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/* ========================================================================== */
/*  Schemas                                                                   */
/* ========================================================================== */

/**
 * Mirrors the CHECK on `teams.name`: `char_length(btrim(name)) between 2 and 80`. Trimming here
 * rather than after the length test means "  a  " is rejected for being one character, which is
 * what Postgres would say too.
 */
const nameSchema = z
  .string()
  .trim()
  .min(2, "A team name needs at least two characters.")
  .max(80, "Keep the team name under 80 characters.")

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value.length === 0 ? null : value))
    .nullable()
    .optional()

const createTeamSchema = z.object({
  name: nameSchema,
  city: optionalText(80),
  description: optionalText(1000),
  /**
   * Storage or CDN URL for the crest. `https` only: a rendered `http` image on an https page is
   * blocked as mixed content, and a `javascript:` or `data:` URL in an <img src> is an injection
   * surface the database does not police.
   */
  crestUrl: z
    .string()
    .trim()
    .url()
    .max(2048)
    .refine((value) => value.startsWith("https://"), "The crest URL must be https.")
    .nullable()
    .optional(),
  isPublic: z.boolean().default(true),
})

const updateTeamSchema = createTeamSchema.partial().extend({ id: z.string().uuid() })

const listQuerySchema = z.object({
  scope: z.enum(["mine", "discover"]).default("mine"),
  q: z.string().trim().max(80).optional(),
  city: z.string().trim().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(24),
})

/* ========================================================================== */
/*  Wire shape                                                                */
/* ========================================================================== */

interface TeamSummary {
  id: string
  name: string
  slug: string
  city: string | null
  crestUrl: string | null
  description: string | null
  isPublic: boolean
  ownerId: string
  createdAt: string
  /** Active members only — a row with `left_at` set is history, not a squad member. */
  memberCount: number
  /** The caller's rank on this team, or `null` when they are not on the roster. */
  viewerRole: Enums<"team_member_role"> | null
  viewerIsOwner: boolean
}

/* ========================================================================== */
/*  GET — list                                                                */
/* ========================================================================== */

export async function GET(request: Request): Promise<Response> {
  return handleRoute<{ teams: TeamSummary[] }>(async () => {
    const { user } = await requireRole()

    const url = new URL(request.url)
    const parsed = listQuerySchema.safeParse({
      scope: url.searchParams.get("scope") ?? undefined,
      q: url.searchParams.get("q") ?? undefined,
      city: url.searchParams.get("city") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined,
    })
    if (!parsed.success) {
      return fail(API_ERROR_CODES.VALIDATION_FAILED, "Liste filtreleri geçersizdi.", 422)
    }

    const { scope, q, city, limit } = parsed.data
    const supabase = await createClient()

    // The caller's own memberships, used both to scope `mine` and to label `discover` rows with
    // "you are already in this one". One read, reused twice.
    const { data: myMemberships, error: membershipError } = await supabase
      .from("team_members")
      .select("team_id, role")
      .eq("player_id", user.id)
      .is("left_at", null)

    if (membershipError) {
      console.error("[teams] membership read failed", { code: membershipError.code })
      return fail(API_ERROR_CODES.INTERNAL, "Takımların yüklenemedi.", 500)
    }

    const myRoles = new Map((myMemberships ?? []).map((row) => [row.team_id, row.role]))

    let query = supabase.from("teams").select("*").limit(limit)

    if (scope === "mine") {
      const ids = [...myRoles.keys()]
      // `.or()` builds one statement instead of two round trips. With no memberships the `in.()`
      // half would be empty and PostgREST rejects that, so drop to the owner filter alone.
      query =
        ids.length > 0
          ? query.or(`owner_id.eq.${user.id},id.in.(${ids.join(",")})`)
          : query.eq("owner_id", user.id)
      query = query.order("created_at", { ascending: false })
    } else {
      query = query.eq("is_public", true)
      if (q) query = query.ilike("name", `%${escapeLike(q)}%`)
      if (city) query = query.ilike("city", `${escapeLike(city)}%`)
      query = query.order("created_at", { ascending: false })
    }

    const { data: teamRows, error } = await query
    if (error) {
      console.error("[teams] list failed", { code: error.code })
      return fail(API_ERROR_CODES.INTERNAL, "Takımlar yüklenemedi.", 500)
    }

    const teams = teamRows ?? []
    const counts = await countActiveMembers(supabase, teams.map((team) => team.id))

    return ok({
      teams: teams.map((team) =>
        toSummary(team, {
          memberCount: counts.get(team.id) ?? 0,
          viewerRole: myRoles.get(team.id) ?? null,
          viewerId: user.id,
        }),
      ),
    })
  })
}

/* ========================================================================== */
/*  POST — create                                                             */
/* ========================================================================== */

export async function POST(request: Request): Promise<Response> {
  return handleRoute<{ team: TeamSummary }>(async () => {
    const { user } = await requireRole()

    // Budgets are counted in Postgres, not in this process — see lib/rate-limit.ts.
    const limited = await enforceRateLimit("create_team")
    if (limited) return limited

    const raw: unknown = await request.json().catch(() => null)
    if (raw === null) {
      return fail(API_ERROR_CODES.VALIDATION_FAILED, "JSON gövdesi gerekli.", 422)
    }

    const parsed = createTeamSchema.safeParse(raw)
    if (!parsed.success) {
      return fail(API_ERROR_CODES.VALIDATION_FAILED, "Takım bilgileri geçersizdi.", 422, {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      })
    }

    const input = parsed.data
    const supabase = await createClient()

    // The slug is derived, never sent by the client, and the uniqueness race is settled by the
    // database rather than by a look-before-you-leap SELECT. See lib/teams/slug.ts.
    const outcome = await insertWithUniqueSlug<Tables<"teams">>(input.name, async (slug) => {
      const insert: TablesInsert<"teams"> = {
        name: input.name,
        slug,
        owner_id: user.id,
        city: input.city ?? null,
        description: input.description ?? null,
        crest_url: input.crestUrl ?? null,
        is_public: input.isPublic,
      }
      return supabase.from("teams").insert(insert).select("*").single()
    })

    if (outcome.status === "exhausted") {
      return fail(
        API_ERROR_CODES.VALIDATION_FAILED,
        "Bu ismi kullanan çok fazla takım var. Daha ayırt edici bir isim seç.",
        409,
      )
    }

    if (outcome.status === "failed") {
      const code = outcome.error?.code
      if (code === "42501" || code === "PGRST301") {
        return fail(API_ERROR_CODES.FORBIDDEN, "Bu hesapla takım kuramazsın.", 403)
      }
      console.error("[teams] insert failed", { code })
      return fail(API_ERROR_CODES.INTERNAL, "Takım oluşturulamadı.", 500)
    }

    const team = outcome.row

    // Steps 2 and 3 from the header. Best-effort: the owner is a captain by ownership either way.
    const { error: memberError } = await supabase
      .from("team_members")
      .insert({ team_id: team.id, player_id: user.id })

    if (memberError) {
      console.error("[teams] owner roster row failed", { code: memberError.code })
    } else {
      const { error: promoteError } = await supabase
        .from("team_members")
        .update({ role: "captain" })
        .eq("team_id", team.id)
        .eq("player_id", user.id)

      if (promoteError) {
        console.error("[teams] owner promotion failed", { code: promoteError.code })
      }
    }

    return ok(
      {
        team: toSummary(team, {
          memberCount: memberError ? 0 : 1,
          viewerRole: memberError ? null : "captain",
          viewerId: user.id,
        }),
      },
      { status: 201 },
    )
  })
}

/* ========================================================================== */
/*  PATCH — edit                                                              */
/* ========================================================================== */

export async function PATCH(request: Request): Promise<Response> {
  return handleRoute<{ team: TeamSummary }>(async () => {
    const { user } = await requireRole()

    const raw: unknown = await request.json().catch(() => null)
    if (raw === null) {
      return fail(API_ERROR_CODES.VALIDATION_FAILED, "JSON gövdesi gerekli.", 422)
    }

    const parsed = updateTeamSchema.safeParse(raw)
    if (!parsed.success) {
      return fail(API_ERROR_CODES.VALIDATION_FAILED, "Takım bilgileri geçersizdi.", 422, {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      })
    }

    const { id, ...changes } = parsed.data

    const patch: TablesUpdate<"teams"> = {}
    if (changes.name !== undefined) patch.name = changes.name
    if (changes.city !== undefined) patch.city = changes.city
    if (changes.description !== undefined) patch.description = changes.description
    if (changes.crestUrl !== undefined) patch.crest_url = changes.crestUrl
    if (changes.isPublic !== undefined) patch.is_public = changes.isPublic

    if (Object.keys(patch).length === 0) {
      return fail(API_ERROR_CODES.VALIDATION_FAILED, "Güncellenecek bir şey yok.", 422)
    }

    const supabase = await createClient()

    // `teams_update_captain` is the boundary and it admits a vice-captain as well, since
    // `private.is_team_captain()` covers all three. That is the intended reading: a vice-captain
    // running the club's page while the captain is away is normal, and nothing here changes who
    // owns the team — `owner_id` is not in the UPDATE grant at all.
    const { data, error } = await supabase
      .from("teams")
      .update(patch)
      .eq("id", id)
      .select("*")
      .maybeSingle()

    if (error) {
      if (error.code === "42501" || error.code === "PGRST301") {
        return fail(API_ERROR_CODES.FORBIDDEN, "Bu takımı düzenleyemezsin.", 403)
      }
      console.error("[teams] update failed", { code: error.code })
      return fail(API_ERROR_CODES.INTERNAL, "Takım kaydedilemedi.", 500)
    }

    if (!data) {
      // Filtered out by RLS, or no such team. Same answer either way.
      return fail(API_ERROR_CODES.NOT_FOUND, "Takım bulunamadı.", 404)
    }

    const { data: myRow } = await supabase
      .from("team_members")
      .select("role")
      .eq("team_id", id)
      .eq("player_id", user.id)
      .is("left_at", null)
      .maybeSingle()

    const counts = await countActiveMembers(supabase, [data.id])

    return ok({
      team: toSummary(data, {
        memberCount: counts.get(data.id) ?? 0,
        viewerRole: myRow?.role ?? null,
        viewerId: user.id,
      }),
    })
  })
}

/* ========================================================================== */
/*  Helpers                                                                   */
/* ========================================================================== */

function toSummary(
  team: Tables<"teams">,
  context: {
    memberCount: number
    viewerRole: Enums<"team_member_role"> | null
    viewerId: string
  },
): TeamSummary {
  return {
    id: team.id,
    name: team.name,
    slug: team.slug,
    city: team.city,
    crestUrl: team.crest_url,
    description: team.description,
    isPublic: team.is_public,
    ownerId: team.owner_id,
    createdAt: team.created_at,
    memberCount: context.memberCount,
    viewerRole: context.viewerRole,
    viewerIsOwner: team.owner_id === context.viewerId,
  }
}

/**
 * Active roster sizes for a batch of teams, in one round trip.
 *
 * `team_members_select_visible` lets anyone read the roster of a PUBLIC team, so the count is
 * accurate on the discovery list too. For a private team the caller is not on, the team row is
 * invisible anyway and never reaches this function.
 */
async function countActiveMembers(
  supabase: Awaited<ReturnType<typeof createClient>>,
  teamIds: readonly string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>()
  if (teamIds.length === 0) return counts

  const { data, error } = await supabase
    .from("team_members")
    .select("team_id")
    .in("team_id", [...teamIds])
    .is("left_at", null)

  if (error) {
    // A missing count is a cosmetic loss; the list is still worth rendering.
    console.error("[teams] member count failed", { code: error.code })
    return counts
  }

  for (const row of data ?? []) {
    counts.set(row.team_id, (counts.get(row.team_id) ?? 0) + 1)
  }
  return counts
}

/**
 * Neutralise every wildcard in a user-supplied `ilike` pattern.
 *
 * Two layers bite here. PostgREST rewrites `*` into `%` before the pattern reaches SQL, and SQL
 * itself treats `%` and `_` as wildcards with backslash as the escape. Without this a search for
 * "%" matches every team — not a security hole, since RLS still applies, but a confusing result —
 * and `_` silently matching any character makes searches look broken.
 */
function escapeLike(value: string): string {
  return value.replace(/\*/g, "").replace(/[\\%_]/g, (character) => `\\${character}`)
}
