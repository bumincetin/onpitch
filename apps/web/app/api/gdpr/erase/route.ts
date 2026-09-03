/**
 * POST /api/gdpr/erase
 *
 * GDPR Art. 17 (erasure), with the limit written into the migration rather than into a policy
 * document nobody reads.
 *
 * `public.request_account_erasure()` pseudonymises the profile in place, clears free text the
 * subject wrote, de-identifies consent evidence, deletes notifications, kills the auth sessions —
 * and RETAINS bookings and payment references. That retention is Art. 17(3)(b): compliance with
 * a legal obligation, specifically Turkish accounting retention (VUK art. 253, TTK art. 82). It
 * is a deliberate, defensible position, and the receipt returned to the user says so in plain
 * language rather than pretending the deletion was total.
 *
 * The confirmation string is required by `types/domain.ts`'s `gdprErasureSchema` as a literal:
 * the user must type "DELETE MY ACCOUNT". A checkbox is too easy to click through for an action
 * that cannot be undone.
 */

import { NextResponse } from "next/server"

import { createRouteClient } from "@/lib/supabase/server"
import { API_ERROR_CODES, gdprErasureSchema } from "@onpitch/shared/domain"
import type { ApiResponse } from "@onpitch/shared/domain"
import type { Database, Json } from "@onpitch/shared/database"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type ErasureArgs = Database["public"]["Functions"]["request_account_erasure"]["Args"]

interface ErasureData {
  /** `'erased'` or `'already_erased'`, straight from the RPC receipt. */
  status: string
  erasedAt: string | null
  retainedBookingCount: number
  retentionNote: string
  /** The full receipt, for the user to keep. */
  receipt: Json
}

function json<T>(body: ApiResponse<T>, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } })
}

export async function POST(request: Request): Promise<NextResponse> {
  // `createRouteClient` — not `createClient` — because the Expo app has no cookie jar and
  // authenticates with `Authorization: Bearer <access token>`. A cookie-only client would reject
  // every mobile caller with a 401 and make Art. 17 unreachable from the phone.
  const supabase = await createRouteClient(request)

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return json(
      {
        ok: false,
        error: {
          code: API_ERROR_CODES.UNAUTHENTICATED,
          message: "Hesabını silmek için giriş yap.",
        },
      },
      401,
    )
  }

  let rawBody: unknown
  try {
    rawBody = await request.json()
  } catch {
    return json(
      {
        ok: false,
        error: { code: API_ERROR_CODES.VALIDATION_FAILED, message: "JSON gövdesi bekleniyordu." },
      },
      400,
    )
  }

  const parsed = gdprErasureSchema.safeParse(rawBody)
  if (!parsed.success) {
    return json(
      {
        ok: false,
        error: {
          code: API_ERROR_CODES.VALIDATION_FAILED,
          message:
            'To confirm, send { "confirmation": "DELETE MY ACCOUNT" } exactly. This cannot be undone.',
        },
      },
      422,
    )
  }

  const callErasure = (args: Record<string, unknown>) =>
    supabase.rpc("request_account_erasure", args as unknown as ErasureArgs)

  // The migration declares `request_account_erasure()` with no parameters; `types/database.ts`
  // models it as taking `p_confirmation`. Call the migration's signature and fall back on
  // PGRST202 so the route works against either. The confirmation has already been verified
  // above either way — it is a UX guard, not an authorisation check.
  let { data, error } = await callErasure({})

  if (error?.code === "PGRST202") {
    ;({ data, error } = await callErasure({ p_confirmation: parsed.data.confirmation }))
  }

  if (error) {
    // eslint-disable-next-line no-console
    console.error("[gdpr/erase] request_account_erasure failed:", error.code, error.message)
    return json(
      {
        ok: false,
        error: {
          code: API_ERROR_CODES.INTERNAL,
          message: "Silme işlemini tamamlayamadık. Hiçbir şey değişmedi — lütfen tekrar dene.",
        },
      },
      500,
    )
  }

  const receipt = (data ?? {}) as Record<string, unknown>

  // The RPC has already deleted this user's rows from `auth.sessions`. Clear the cookies too, so
  // the browser is not left holding an access token that is still inside its TTL. `scope: 'local'`
  // avoids a network call that would now fail against a revoked session.
  try {
    await supabase.auth.signOut({ scope: "local" })
  } catch {
    // Cookie clearing is best effort; the erasure itself has already committed.
  }

  const payload: ErasureData = {
    status: typeof receipt["status"] === "string" ? (receipt["status"] as string) : "erased",
    erasedAt: typeof receipt["erased_at"] === "string" ? (receipt["erased_at"] as string) : null,
    retainedBookingCount:
      typeof receipt["retained_booking_count"] === "number"
        ? (receipt["retained_booking_count"] as number)
        : 0,
    retentionNote:
      typeof receipt["retention_note"] === "string"
        ? (receipt["retention_note"] as string)
        : "Booking and payment records are kept in pseudonymised form for the statutory " +
          "accounting retention period under GDPR Art. 17(3)(b).",
    receipt: (data ?? {}) as Json,
  }

  return json({ ok: true, data: payload }, 200)
}
