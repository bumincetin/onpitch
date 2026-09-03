/**
 * POST /api/admin/users/[id]/role
 *
 * Changes one account's `app_role`. The most dangerous write in the product, so it is also the
 * most explicit one.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS NEEDS THE SERVICE ROLE
 * ---------------------------------------------------------------------------
 * `0002_rls.sql` §4.1 grants `authenticated` UPDATE on thirteen columns of `profiles`, and
 * `role` is deliberately not among them. The `profiles_update_self` policy would admit an
 * admin — it has an `is_admin()` disjunct — but a policy cannot hand back a column privilege
 * the role does not hold. That is the migration's stated intent: privilege escalation is
 * structurally impossible through PostgREST for everybody, admins included, and the only way
 * in is a server route holding the service-role key. So this handler bypasses RLS, and every
 * guard RLS would have applied is re-stated here in TypeScript.
 *
 * ---------------------------------------------------------------------------
 * THE STALE-CLAIM PROBLEM, WHICH IS NOT A BUG
 * ---------------------------------------------------------------------------
 * `private."current_role"()` reads the `user_role` JWT claim first and only falls back to
 * `profiles.role` when the claim is absent. The claim is minted by
 * `public.custom_access_token_hook` when an access token is issued. A user holding a valid
 * token therefore keeps their OLD role — in RLS, in the middleware, everywhere — until that
 * token is refreshed or they sign in again.
 *
 * Both directions of that matter and the response says so in words the operator can repeat:
 * a promotion does not take effect immediately, and a demotion does not revoke access
 * immediately. Removing an active abuser needs a session revocation, not a role change.
 *
 * ---------------------------------------------------------------------------
 * THE LAST-ADMIN GUARD
 * ---------------------------------------------------------------------------
 * `role` is unreachable from PostgREST, so if the final admin demotes themselves nobody can
 * put it back without database access. The count that guards this excludes soft-deleted
 * profiles, which is why it runs on the service-role client too (`deleted_at` is not in the
 * SELECT grant either).
 */

import { z } from "zod"

import { fail, handleRoute, ok } from "@/lib/api-response"
import { requireRole, type AppRole } from "@/lib/rbac"
import { createClient } from "@/lib/supabase/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { countLiveAdmins, recordAdminAudit } from "@/lib/admin/metrics"
import { API_ERROR_CODES, appRoleSchema } from "@onpitch/shared/domain"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * A reason is mandatory and has a floor, because "test" in an accountability trail is the same
 * as no entry at all when somebody reads it back two years later during an investigation.
 */
const roleChangeSchema = z.object({
  role: appRoleSchema,
  reason: z
    .string()
    .trim()
    .min(10, "Give a reason of at least 10 characters — it goes into the audit trail.")
    .max(500, "Keep the reason under 500 characters."),
})

export interface RoleChangeResponse {
  userId: string
  previousRole: AppRole
  role: AppRole
  /** False when `log_audit` refused; the DB trigger's own row still exists. */
  auditRecorded: boolean
  /** Always true. The claim is minted at sign-in, never patched into a live token. */
  reauthRequired: boolean
  message: string
}

export async function POST(
  request: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  return handleRoute<RoleChangeResponse>(async () => {
    const { user } = await requireRole("admin")

    const targetId = params.id
    if (!UUID_PATTERN.test(targetId)) {
      return fail(API_ERROR_CODES.VALIDATION_FAILED, "Geçersiz kullanıcı referansı.", 422)
    }

    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      return fail(API_ERROR_CODES.VALIDATION_FAILED, "JSON gövdesi gönder.", 422)
    }

    const parsed = roleChangeSchema.safeParse(rawBody)
    if (!parsed.success) {
      return fail(API_ERROR_CODES.VALIDATION_FAILED, "Rol değişikliği geçersizdi.", 422, {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      })
    }

    const nextRole: AppRole = parsed.data.role
    const reason = parsed.data.reason

    /* --- 1. Read the target through the CALLER'S client -------------------- */
    // RLS decides whether this admin may see the row at all. Reading the target with the
    // service-role client instead would turn a stale-claim demotion into a silent success.
    // Only granted columns are projected: `email` and `deleted_at` are outside the §4.1
    // SELECT grant and asking for them raises 42501.
    const supabase = await createClient()
    const { data: target, error: targetError } = await supabase
      .from("profiles")
      .select("id, role, display_name, full_name")
      .eq("id", targetId)
      .maybeSingle()

    if (targetError) {
      console.error("[admin/role] target lookup failed", { code: targetError.code })
      return fail(API_ERROR_CODES.INTERNAL, "Bu hesap yüklenemedi.", 500)
    }
    if (!target) {
      return fail(API_ERROR_CODES.NOT_FOUND, "Böyle bir hesap yok.", 404)
    }

    const previousRole = target.role as AppRole
    if (previousRole === nextRole) {
      return fail(
        API_ERROR_CODES.VALIDATION_FAILED,
        `That account is already a ${nextRole.replace("_", " ")}.`,
        409,
      )
    }

    /* --- 2. The last-admin guard ------------------------------------------ */
    if (previousRole === "admin" && nextRole !== "admin") {
      const liveAdmins = await countLiveAdmins()
      if (liveAdmins <= 1) {
        return fail(
          API_ERROR_CODES.FORBIDDEN,
          targetId === user.id
            ? "You are the only administrator left. Promote someone else before stepping down — " +
                "the role column is not writable from the app, so nobody could restore it for you."
            : "That is the last administrator. Promote a replacement first.",
          409,
        )
      }
    }

    /* --- 3. The write ------------------------------------------------------ */
    const admin = createAdminClient()
    const { data: updated, error: updateError } = await admin
      .from("profiles")
      .update({ role: nextRole })
      .eq("id", targetId)
      // Re-stating what RLS cannot: an erased account is not eligible for a role. The service
      // role bypasses `profiles_select_self_or_visible`, so this predicate has to be explicit.
      .is("deleted_at", null)
      .select("id, role")
      .maybeSingle()

    if (updateError) {
      console.error("[admin/role] update failed", { code: updateError.code })
      return fail(API_ERROR_CODES.INTERNAL, "Rol değişikliği gerçekleşmedi.", 500)
    }
    if (!updated) {
      return fail(
        API_ERROR_CODES.NOT_FOUND,
        "Bu hesap silinmiş, rol verilemez.",
        404,
      )
    }

    /* --- 4. Accountability -------------------------------------------------- */
    // `trg_profiles_audit_role_change` already committed a `profile.role_changed` row inside
    // the UPDATE's transaction, so the fact of the change cannot be lost. This entry is the
    // one that names the operator and carries their reason.
    const auditRecorded = await recordAdminAudit({
      action: "admin.role_changed",
      actorId: user.id,
      entityType: "profiles",
      entityId: targetId,
      reason,
      metadata: {
        from: previousRole,
        to: nextRole,
        self_change: targetId === user.id,
        subject_label: target.display_name ?? target.full_name ?? null,
      },
    })

    return ok<RoleChangeResponse>({
      userId: targetId,
      previousRole,
      role: nextRole,
      auditRecorded,
      reauthRequired: true,
      message:
        `Role changed from ${previousRole} to ${nextRole}. It reaches their JWT only when they ` +
        "sign in again or their token refreshes, so until then both the middleware and RLS " +
        "still see the old role. To cut off access now, revoke their sessions as well.",
    })
  })
}
