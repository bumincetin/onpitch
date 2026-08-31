/**
 * /api/pitches/[id]/availability — the venue calendar's read and write endpoint.
 *
 *   GET    ?from=&to=        bookings + blackout blocks overlapping a window
 *   POST                     create a blackout window (`availabilityBlockSchema`)
 *   DELETE ?blockId=…        remove a blackout window
 *
 * ---------------------------------------------------------------------------
 * OVERLAP IS DECIDED BY POSTGRES, NOT BY THIS FILE
 * ---------------------------------------------------------------------------
 * There is no "select … where block_range && …" check before the insert, and that omission is
 * the whole design. Such a check is a textbook TOCTOU: two owners (or one owner with two tabs)
 * both read "free", both insert, both succeed. The `pitch_blocks_no_overlap` EXCLUDE constraint
 * IS the serialisation point — it is evaluated inside the same transaction as the insert, so the
 * loser gets SQLSTATE 23P01 and we translate that into `BLOCK_OVERLAP`. The same reasoning is
 * why `bookings_no_double_booking` exists rather than a pre-flight availability query.
 *
 * A blackout also cannot evict a live booking: `bookings_no_double_booking` and
 * `pitch_blocks_no_overlap` are separate constraints over separate tables, so blocking a slot
 * somebody has already paid for succeeds at the database level. This handler therefore checks
 * for occupying bookings itself and refuses — advisory rather than atomic (a booking landing in
 * the same millisecond still wins), but it turns the common case into a clear error instead of a
 * double-sold pitch.
 *
 * ---------------------------------------------------------------------------
 * AUTHORISATION
 * ---------------------------------------------------------------------------
 * The caller's COOKIE-BOUND client is used throughout, so RLS is the boundary:
 * `pitch_blocks_insert_owner` / `pitch_blocks_delete_owner` gate writes on
 * `private.owns_pitch()`, and `bookings_select_stakeholders` gates the booking read. The column
 * grant means `created_by` may only ever be the caller's own id.
 */

import { z } from "zod"

import { fail, handleRoute, ok } from "@/lib/api-response"
import { requireRole } from "@/lib/rbac"
import { createClient } from "@/lib/supabase/server"
import { isExclusionViolation } from "@/lib/payments"
import { OCCUPYING_BOOKING_STATUSES, toRangeLiteral } from "@/lib/venue/metrics"
import type { Enums, Tables, TablesInsert } from "@halisaha/shared/database"
import { API_ERROR_CODES, availabilityBlockSchema } from "@halisaha/shared/domain"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const MAX_WINDOW_DAYS = 92
const DAY_MS = 86_400_000

const BOOKING_COLUMNS =
  "id, pitch_id, booked_by, team_id, time_range, status, payment_status, subtotal_minor, " +
  "platform_fee_minor, total_minor, refunded_amount_minor, currency, notes, created_at"

const BLOCK_COLUMNS = "id, pitch_id, block_range, reason, created_by, created_at"

export type AvailabilityBooking = Pick<
  Tables<"bookings">,
  | "id"
  | "pitch_id"
  | "booked_by"
  | "team_id"
  | "time_range"
  | "status"
  | "payment_status"
  | "subtotal_minor"
  | "platform_fee_minor"
  | "total_minor"
  | "refunded_amount_minor"
  | "currency"
  | "notes"
  | "created_at"
>

export type AvailabilityBlock = Tables<"pitch_availability_blocks">

export interface AvailabilityWindowResponse {
  pitchId: string
  from: string
  to: string
  bookings: AvailabilityBooking[]
  blocks: AvailabilityBlock[]
}

const windowQuerySchema = z.object({
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
})

const uuidSchema = z.string().uuid()

/* ========================================================================== */
/*  GET — the window the calendar is showing                                  */
/* ========================================================================== */

export async function GET(
  request: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  return handleRoute<AvailabilityWindowResponse>(async () => {
    await requireRole("venue_owner", "admin")

    const pitchId = uuidSchema.safeParse(params.id)
    if (!pitchId.success) {
      return fail(API_ERROR_CODES.VALIDATION_FAILED, "Geçersiz saha referansı.", 422)
    }

    const url = new URL(request.url)
    const parsed = windowQuerySchema.safeParse({
      from: url.searchParams.get("from") ?? undefined,
      to: url.searchParams.get("to") ?? undefined,
    })
    if (!parsed.success) {
      return fail(
        API_ERROR_CODES.VALIDATION_FAILED,
        "from ve to ISO-8601 zaman damgası olmalı.",
        422,
      )
    }

    const window = resolveWindow(parsed.data.from, parsed.data.to)
    if ("error" in window) return window.error

    const supabase = await createClient()
    const literal = toRangeLiteral(window.from, window.to)

    // Both reads are authorised by RLS; `.eq('pitch_id', …)` + `.overlaps()` ride
    // idx_bookings_pitch_range and idx_pitch_blocks_range (both GiST).
    const [bookingsResponse, blocksResponse] = await Promise.all([
      supabase
        .from("bookings")
        .select(BOOKING_COLUMNS)
        .eq("pitch_id", pitchId.data)
        .overlaps("time_range", literal),
      supabase
        .from("pitch_availability_blocks")
        .select(BLOCK_COLUMNS)
        .eq("pitch_id", pitchId.data)
        .overlaps("block_range", literal),
    ])

    if (bookingsResponse.error) {
      console.error("[availability] booking read failed", { code: bookingsResponse.error.code })
      return fail(API_ERROR_CODES.INTERNAL, "Takvim yüklenemedi.", 500)
    }
    if (blocksResponse.error) {
      console.error("[availability] block read failed", { code: blocksResponse.error.code })
      return fail(API_ERROR_CODES.INTERNAL, "Takvim yüklenemedi.", 500)
    }

    return ok({
      pitchId: pitchId.data,
      from: window.from.toISOString(),
      to: window.to.toISOString(),
      // `as unknown as`: the column lists are shared consts rather than string literals, so
      // postgrest-js infers an opaque result type. The projections above are what make these
      // assertions true.
      bookings: (bookingsResponse.data ?? []) as unknown as AvailabilityBooking[],
      blocks: (blocksResponse.data ?? []) as unknown as AvailabilityBlock[],
    })
  })
}

/* ========================================================================== */
/*  POST — create a blackout window                                           */
/* ========================================================================== */

export async function POST(
  request: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  return handleRoute<{ block: AvailabilityBlock }>(async () => {
    const { user } = await requireRole("venue_owner", "admin")

    const pitchId = uuidSchema.safeParse(params.id)
    if (!pitchId.success) {
      return fail(API_ERROR_CODES.VALIDATION_FAILED, "Geçersiz saha referansı.", 422)
    }

    const raw: unknown = await request.json().catch(() => null)
    if (raw === null) {
      return fail(API_ERROR_CODES.VALIDATION_FAILED, "JSON gövdesi gerekli.", 422)
    }

    const parsed = availabilityBlockSchema.safeParse(raw)
    if (!parsed.success) {
      return fail(API_ERROR_CODES.VALIDATION_FAILED, "Kapalı zaman aralığı geçersizdi.", 422, {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      })
    }

    const startsAt = new Date(parsed.data.startsAt)
    const endsAt = new Date(parsed.data.endsAt)
    if (endsAt.getTime() - startsAt.getTime() > MAX_WINDOW_DAYS * DAY_MS) {
      return fail(
        API_ERROR_CODES.VALIDATION_FAILED,
        `A single blackout window may not exceed ${MAX_WINDOW_DAYS} days.`,
        422,
      )
    }

    const supabase = await createClient()
    const literal = toRangeLiteral(startsAt, endsAt)

    /* --- Advisory guard: never black out a slot somebody already holds ----- */
    const { data: clashes, error: clashError } = await supabase
      .from("bookings")
      .select("id, status")
      .eq("pitch_id", pitchId.data)
      .in("status", OCCUPYING_BOOKING_STATUSES as unknown as Enums<"booking_status">[])
      .overlaps("time_range", literal)
      .limit(1)

    if (clashError) {
      console.error("[availability] clash check failed", { code: clashError.code })
      return fail(API_ERROR_CODES.INTERNAL, "Takvim kontrol edilemedi.", 500)
    }
    if ((clashes?.length ?? 0) > 0) {
      return fail(
        API_ERROR_CODES.SLOT_TAKEN,
        "Bu aralıkta zaten bir rezervasyon var. Önce onu iptal et, sonra saati kapat.",
        409,
      )
    }

    /* --- Insert. The EXCLUDE constraint is the real overlap check. --------- */
    const insert: TablesInsert<"pitch_availability_blocks"> = {
      pitch_id: pitchId.data,
      block_range: literal,
      reason: parsed.data.reason?.trim() || null,
      // The insert grant allows only `created_by = auth.uid()`; sending it explicitly makes the
      // audit trail useful rather than leaving it null.
      created_by: user.id,
    }

    const { data, error } = await supabase
      .from("pitch_availability_blocks")
      .insert(insert)
      .select(BLOCK_COLUMNS)
      .single()

    if (error) {
      if (isExclusionViolation(error, "pitch_blocks_no_overlap") || error.code === "23P01") {
        return fail(
          API_ERROR_CODES.BLOCK_OVERLAP,
          "Bu kapalı zaman aralığı mevcut bir aralıkla çakışıyor.",
          409,
        )
      }
      if (error.code === "42501" || error.code === "PGRST301") {
        return fail(API_ERROR_CODES.FORBIDDEN, "Bu sahayı sen yönetmiyorsun.", 403)
      }
      console.error("[availability] block insert failed", { code: error.code })
      return fail(API_ERROR_CODES.INTERNAL, "Kapalı zaman aralığı oluşturulamadı.", 500)
    }

    return ok({ block: data as unknown as AvailabilityBlock }, { status: 201 })
  })
}

/* ========================================================================== */
/*  DELETE — lift a blackout window                                           */
/* ========================================================================== */

export async function DELETE(
  request: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  return handleRoute<{ blockId: string }>(async () => {
    await requireRole("venue_owner", "admin")

    const pitchId = uuidSchema.safeParse(params.id)
    if (!pitchId.success) {
      return fail(API_ERROR_CODES.VALIDATION_FAILED, "Geçersiz saha referansı.", 422)
    }

    const url = new URL(request.url)
    const blockId = uuidSchema.safeParse(url.searchParams.get("blockId") ?? "")
    if (!blockId.success) {
      return fail(API_ERROR_CODES.VALIDATION_FAILED, "Geçerli bir blockId gerekli.", 422)
    }

    const supabase = await createClient()

    // `pitch_blocks_delete_owner` is the boundary; the `pitch_id` predicate additionally stops a
    // mistyped URL from deleting a block that belongs to a different pitch of the same owner.
    const { data, error } = await supabase
      .from("pitch_availability_blocks")
      .delete()
      .eq("id", blockId.data)
      .eq("pitch_id", pitchId.data)
      .select("id")
      .maybeSingle()

    if (error) {
      console.error("[availability] block delete failed", { code: error.code })
      return fail(API_ERROR_CODES.INTERNAL, "Kapalı zaman aralığı kaldırılamadı.", 500)
    }
    if (!data) {
      return fail(API_ERROR_CODES.NOT_FOUND, "Kapalı zaman aralığı bulunamadı.", 404)
    }

    return ok({ blockId: data.id })
  })
}

/* ========================================================================== */
/*  Helpers                                                                   */
/* ========================================================================== */

function resolveWindow(
  from: string | undefined,
  to: string | undefined,
): { from: Date; to: Date } | { error: Response } {
  const now = Date.now()
  const start = from ? new Date(from) : new Date(now)
  const end = to ? new Date(to) : new Date(start.getTime() + 7 * DAY_MS)

  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
    return { error: fail(API_ERROR_CODES.VALIDATION_FAILED, "Geçersiz tarih aralığı.", 422) }
  }
  if (end.getTime() <= start.getTime()) {
    return { error: fail(API_ERROR_CODES.VALIDATION_FAILED, "to, from değerinden sonra olmalı.", 422) }
  }
  if (end.getTime() - start.getTime() > MAX_WINDOW_DAYS * DAY_MS) {
    return {
      error: fail(
        API_ERROR_CODES.VALIDATION_FAILED,
        `The window may not exceed ${MAX_WINDOW_DAYS} days.`,
        422,
      ),
    }
  }
  return { from: start, to: end }
}
