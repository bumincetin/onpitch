/**
 * /api/pitches — the venue owner's pitch CRUD surface.
 *
 *   GET    ?venueId=…   list the pitches of one venue
 *   POST                create a pitch
 *   PATCH               update a pitch (the target is `id` in the body)
 *
 * ---------------------------------------------------------------------------
 * WHY PATCH LIVES ON THE COLLECTION
 * ---------------------------------------------------------------------------
 * Not REST orthodoxy, and deliberate: this module owns `app/api/pitches/route.ts` only, so
 * putting the update here keeps every pitch write behind one validated server route instead of
 * pushing `supabase.from('pitches').update(...)` into the browser. The client never gets to name
 * a column — it sends the camelCase fields of `updatePitchSchema` and this file maps them.
 *
 * ---------------------------------------------------------------------------
 * AUTHORISATION
 * ---------------------------------------------------------------------------
 * All three verbs use the caller's COOKIE-BOUND client, never the service role, so the real
 * boundary is RLS + the column grants in 0002_rls.sql:
 *
 *   • `pitches_insert_venue_owner` / `pitches_update_venue_owner` gate the ROW on
 *     `private.owns_venue()` / `private.owns_pitch()`.
 *   • The column-level `grant insert (…)` / `grant update (…)` gate the COLUMNS. Every field
 *     accepted below is inside that grant, which is not a coincidence: `venue_id` is insertable
 *     but NOT updatable, so a pitch can never be moved to a venue the caller does not own, and
 *     that invariant is enforced by Postgres rather than by this file remembering to omit it.
 *
 * `requireRole('venue_owner','admin')` on top is the cheap capability gate — it turns a player's
 * request into a 403 without a database round trip.
 *
 * An update that matches no row is indistinguishable (by design) from "you do not own it", so
 * both surface as 404. Confirming the existence of another owner's pitch is a small leak with no
 * upside.
 */

import { z } from "zod"

import { fail, handleRoute, ok } from "@/lib/api-response"
import { requireRole } from "@/lib/rbac"
import { createClient } from "@/lib/supabase/server"
import type { Tables, TablesInsert, TablesUpdate } from "@halisaha/shared/database"
import {
  API_ERROR_CODES,
  createPitchSchema,
  updatePitchSchema,
  type CreatePitchInput,
  type UpdatePitchInput,
} from "@halisaha/shared/domain"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Every column the UI needs; deliberately the whole row, since none of it is sensitive. */
const PITCH_COLUMNS =
  "id, venue_id, name, format, surface, is_indoor, capacity, hourly_rate_minor, currency, " +
  "opening_time, closing_time, slot_minutes, is_active, created_at, updated_at"

const listQuerySchema = z.object({
  venueId: z.string().uuid(),
  includeInactive: z
    .enum(["true", "false", "1", "0"])
    .optional()
    .transform((value) => value === "true" || value === "1"),
})

const patchSchema = updatePitchSchema.extend({ id: z.string().uuid() })

type PatchInput = z.infer<typeof patchSchema>

/* ========================================================================== */
/*  GET — list                                                                */
/* ========================================================================== */

export async function GET(request: Request): Promise<Response> {
  return handleRoute<{ pitches: Tables<"pitches">[] }>(async () => {
    await requireRole("venue_owner", "admin")

    const url = new URL(request.url)
    const parsed = listQuerySchema.safeParse({
      venueId: url.searchParams.get("venueId") ?? undefined,
      includeInactive: url.searchParams.get("includeInactive") ?? undefined,
    })
    if (!parsed.success) {
      return fail(API_ERROR_CODES.VALIDATION_FAILED, "Geçerli bir venueId gerekli.", 422)
    }

    const supabase = await createClient()

    // RLS (`pitches_select_visible`) is the boundary. `.eq('venue_id', …)` rides
    // idx_pitches_venue_id and is a query optimisation, not the access check.
    // Filters first, ordering last, so every predicate is unambiguously part of the WHERE clause.
    let query = supabase
      .from("pitches")
      .select(PITCH_COLUMNS)
      .eq("venue_id", parsed.data.venueId)

    if (!parsed.data.includeInactive) query = query.eq("is_active", true)

    const { data, error } = await query.order("name", { ascending: true })
    if (error) {
      console.error("[pitches] list failed", { code: error.code })
      return fail(API_ERROR_CODES.INTERNAL, "Sahalar yüklenemedi.", 500)
    }

    // `as unknown as`: PITCH_COLUMNS is a shared const rather than a string literal, so
    // postgrest-js cannot parse it into a result type. The projection above is what makes this
    // assertion true.
    return ok({ pitches: (data ?? []) as unknown as Tables<"pitches">[] })
  })
}

/* ========================================================================== */
/*  POST — create                                                             */
/* ========================================================================== */

export async function POST(request: Request): Promise<Response> {
  return handleRoute<{ pitch: Tables<"pitches"> }>(async () => {
    await requireRole("venue_owner", "admin")

    const raw: unknown = await request.json().catch(() => null)
    if (raw === null) {
      return fail(API_ERROR_CODES.VALIDATION_FAILED, "JSON gövdesi gerekli.", 422)
    }

    const parsed = createPitchSchema.safeParse(raw)
    if (!parsed.success) {
      return validationFailure(parsed.error.issues)
    }

    const input: CreatePitchInput = parsed.data
    // There is deliberately no "closing must be later than opening" check. 0001_schema.sql
    // documents closing_time as one that "may sort before opening_time for venues open past
    // midnight", and `assertWithinOpeningHours` in lib/payments.ts prices such a pitch by
    // projecting the window onto a continuous [open, close + 24h) axis. Rejecting it here made a
    // halisaha open past midnight impossible to model at all.

    const supabase = await createClient()

    const insert: TablesInsert<"pitches"> = {
      venue_id: input.venueId,
      name: input.name.trim(),
      format: input.format,
      surface: input.surface,
      is_indoor: input.isIndoor,
      capacity: input.capacity ?? null,
      hourly_rate_minor: input.hourlyRateMinor,
      currency: input.currency.toLowerCase(),
      opening_time: normaliseTime(input.openingTime),
      closing_time: normaliseTime(input.closingTime),
      slot_minutes: input.slotMinutes,
      is_active: input.isActive,
    }

    const { data, error } = await supabase
      .from("pitches")
      .insert(insert)
      .select(PITCH_COLUMNS)
      .single()

    if (error) {
      // 23505 on pitches_venue_name_unique — two pitches on one venue may not share a name.
      if (error.code === "23505") {
        return fail(
          API_ERROR_CODES.VALIDATION_FAILED,
          "Bu tesiste aynı isimde bir saha zaten var.",
          409,
        )
      }
      // 42501 (insufficient_privilege) / an RLS refusal both mean "not your venue".
      if (error.code === "42501" || error.code === "PGRST301") {
        return fail(API_ERROR_CODES.FORBIDDEN, "Bu tesisin sahibi değilsin.", 403)
      }
      console.error("[pitches] insert failed", { code: error.code })
      return fail(API_ERROR_CODES.INTERNAL, "Saha oluşturulamadı.", 500)
    }

    return ok({ pitch: data as unknown as Tables<"pitches"> }, { status: 201 })
  })
}

/* ========================================================================== */
/*  PATCH — update                                                            */
/* ========================================================================== */

export async function PATCH(request: Request): Promise<Response> {
  return handleRoute<{ pitch: Tables<"pitches"> }>(async () => {
    await requireRole("venue_owner", "admin")

    const raw: unknown = await request.json().catch(() => null)
    if (raw === null) {
      return fail(API_ERROR_CODES.VALIDATION_FAILED, "JSON gövdesi gerekli.", 422)
    }

    const parsed = patchSchema.safeParse(raw)
    if (!parsed.success) {
      return validationFailure(parsed.error.issues)
    }

    const { id, ...changes }: PatchInput = parsed.data
    const patch = toPitchUpdate(changes)

    if (Object.keys(patch).length === 0) {
      return fail(API_ERROR_CODES.VALIDATION_FAILED, "Güncellenecek bir şey yok.", 422)
    }

    const supabase = await createClient()

    // Opening hours are NOT compared against the merged row: an overnight session stores a
    // closing_time that sorts before its opening_time on purpose (see the POST above), so there
    // is no ordering left to enforce. The `!data` branch below still answers 404 for a pitch the
    // caller cannot see.

    const { data, error } = await supabase
      .from("pitches")
      .update(patch)
      .eq("id", id)
      .select(PITCH_COLUMNS)
      .maybeSingle()

    if (error) {
      if (error.code === "23505") {
        return fail(
          API_ERROR_CODES.VALIDATION_FAILED,
          "Bu tesiste aynı isimde bir saha zaten var.",
          409,
        )
      }
      console.error("[pitches] update failed", { code: error.code })
      return fail(API_ERROR_CODES.INTERNAL, "Saha güncellenemedi.", 500)
    }

    if (!data) {
      // RLS filtered the row out, or it does not exist. Same answer either way — see the header.
      return fail(API_ERROR_CODES.NOT_FOUND, "Saha bulunamadı.", 404)
    }

    return ok({ pitch: data as unknown as Tables<"pitches"> })
  })
}

/* ========================================================================== */
/*  Helpers                                                                   */
/* ========================================================================== */

/**
 * camelCase input → snake_case column patch, dropping every key the caller omitted.
 *
 * `venue_id` is intentionally absent: it is not in the UPDATE grant, so including it would make
 * Postgres reject the whole statement — the schema, not this function, is what stops a pitch
 * being relocated to somebody else's venue.
 */
function toPitchUpdate(changes: UpdatePitchInput): TablesUpdate<"pitches"> {
  const patch: TablesUpdate<"pitches"> = {}
  if (changes.name !== undefined) patch.name = changes.name.trim()
  if (changes.format !== undefined) patch.format = changes.format
  if (changes.surface !== undefined) patch.surface = changes.surface
  if (changes.isIndoor !== undefined) patch.is_indoor = changes.isIndoor
  if (changes.capacity !== undefined) patch.capacity = changes.capacity ?? null
  if (changes.hourlyRateMinor !== undefined) patch.hourly_rate_minor = changes.hourlyRateMinor
  if (changes.currency !== undefined) patch.currency = changes.currency.toLowerCase()
  if (changes.openingTime !== undefined) patch.opening_time = normaliseTime(changes.openingTime)
  if (changes.closingTime !== undefined) patch.closing_time = normaliseTime(changes.closingTime)
  if (changes.slotMinutes !== undefined) patch.slot_minutes = changes.slotMinutes
  if (changes.isActive !== undefined) patch.is_active = changes.isActive
  return patch
}

/** `"08:00"` → `"08:00:00"`. Postgres accepts both; storing one shape keeps diffs readable. */
function normaliseTime(value: string): string {
  return value.length === 5 ? `${value}:00` : value
}

function validationFailure(issues: readonly z.ZodIssue[]): Response {
  return fail(API_ERROR_CODES.VALIDATION_FAILED, "Saha bilgileri geçersizdi.", 422, {
    issues: issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
  })
}
