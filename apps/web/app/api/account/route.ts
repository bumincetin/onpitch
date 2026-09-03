/**
 * PATCH /api/account — the one write path for a person's own profile row.
 *
 * ---------------------------------------------------------------------------
 * WHAT MAY BE CHANGED, AND WHY THE LIST IS SHORT
 * ---------------------------------------------------------------------------
 * `0002_rls.sql` §4.1 grants `authenticated` an UPDATE on exactly these columns:
 *
 *     full_name, display_name, avatar_url, guardian_email, guardian_name,
 *     location_sharing_enabled, profile_visibility, marketing_opt_in,
 *     phone, city, preferred_position, bio, last_seen_at, onboarding_completed_at
 *
 * Anything else — `role`, `is_minor`, `stripe_account_id`, `stripe_customer_id`,
 * `parental_consent_status`, `date_of_birth`, `email`, `deleted_at` — is outside the grant, so
 * Postgres would reject the whole statement. The request schema is therefore `.strict()`: a
 * body naming one of those fields gets a 422 that says which field, instead of a 500 from a
 * refused UPDATE. The guardian columns are deliberately absent too; they belong to
 * `POST /api/auth/parental-consent/request`, which mints a token as part of the same gesture.
 *
 * ---------------------------------------------------------------------------
 * MINORS
 * ---------------------------------------------------------------------------
 * `enforce_minor_privacy` (a BEFORE trigger) and `profiles_minor_privacy_locked_check` pin
 * `location_sharing_enabled = false`, `profile_visibility <> 'public'` and
 * `marketing_opt_in = false` for an under-16 account. This route mirrors that with
 * `enforcePrivacyDefaults()` and refuses the write up front rather than sending a statement the
 * database will bounce. The UI renders those controls disabled, so a well-behaved client never
 * gets here; a hand-rolled request gets a sentence instead of a constraint violation.
 *
 * ---------------------------------------------------------------------------
 * AVATARS
 * ---------------------------------------------------------------------------
 * `avatar_url` is the only free-text column that a browser renders as a resource, so it is the
 * only one with a real validator. It must be a public object in OUR Supabase Storage project,
 * in the `avatars` bucket, under a folder named for the caller's own user id — which is checked
 * against the session, never against anything in the body. The object is then fetched with HEAD
 * and its content type and length re-checked, because the client-side file-picker validation in
 * `components/account/avatar-upload.tsx` is a courtesy, not a boundary.
 */

import { z } from "zod"

import { fail, handleRoute, ok } from "@/lib/api-response"
import { getSessionUser } from "@/lib/rbac"
import { createRouteClient } from "@/lib/supabase/server"
import { enforcePrivacyDefaults, type LockedPrivacyField } from "@/lib/gdpr"
import type { TablesUpdate } from "@onpitch/shared/database"
import {
  API_ERROR_CODES,
  profileVisibilitySchema,
  type ProfileVisibility,
} from "@onpitch/shared/domain"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/* ========================================================================== */
/*  Request schema                                                            */
/* ========================================================================== */

/**
 * Trim, then treat "" as "clear this field". Every one of these columns is nullable, and a user
 * who empties an input means "I do not want a city on my profile" — storing an empty string
 * would make `city is null` filters quietly wrong.
 */
function optionalText(max: number) {
  return z
    .string()
    .max(max, `Keep this under ${max} characters.`)
    .transform((value) => value.trim())
    .transform((value) => (value.length === 0 ? null : value))
    .nullable()
    .optional()
}

/**
 * Permissive on shape, strict on characters. Turkish numbers are written half a dozen ways
 * ("0532 123 45 67", "+90 532 123 45 67") and none of them is wrong; what must not get through
 * is a field being used to smuggle text.
 */
const phoneSchema = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => value.length === 0 || /^\+?[\d\s()./-]{7,24}$/.test(value), {
    message: "Use digits, spaces and + ( ) - only.",
  })
  .transform((value) => (value.length === 0 ? null : value))
  .nullable()
  .optional()

const accountPatchSchema = z
  .object({
    fullName: optionalText(120),
    displayName: optionalText(60),
    phone: phoneSchema,
    city: optionalText(80),
    preferredPosition: optionalText(40),
    bio: optionalText(500),
    avatarUrl: z.string().url("That is not a valid URL.").max(2048).nullable().optional(),
    locationSharingEnabled: z.boolean().optional(),
    profileVisibility: profileVisibilitySchema.optional(),
    marketingOptIn: z.boolean().optional(),
  })
  .strict()

type AccountPatch = z.infer<typeof accountPatchSchema>

/** Every column in the SELECT grant that this route echoes back. */
const RETURNING = "id, full_name, display_name, avatar_url, city, preferred_position, bio"

interface AccountUpdateData {
  /** snake_case column names actually written, so the client can say what it saved. */
  updated: string[]
  profile: {
    id: string
    fullName: string | null
    displayName: string | null
    avatarUrl: string | null
    city: string | null
    preferredPosition: string | null
    bio: string | null
  }
  /**
   * The three locked-for-minors switches AFTER the write. They are outside the column-level
   * SELECT grant, so they cannot be read back — these are the values the statement set, run
   * through the same enforcement the trigger applies.
   */
  privacy: {
    locationSharingEnabled: boolean
    profileVisibility: ProfileVisibility
    marketingOptIn: boolean
  }
  /** Fields the UI must render disabled. Empty for an adult. */
  lockedFields: LockedPrivacyField[]
}

/* ========================================================================== */
/*  Avatar validation                                                         */
/* ========================================================================== */

const AVATAR_BUCKET = "avatars"
/**
 * Mirrored by `MAX_AVATAR_BYTES` in `components/account/avatar-upload.tsx`. Not exported from
 * here: a route module may only export HTTP verbs and Next's own route config, and anything
 * else is a build error.
 */
const MAX_AVATAR_BYTES = 2 * 1024 * 1024
const AVATAR_CONTENT_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
])
/** No slashes, no traversal, one of four extensions. */
const AVATAR_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(?:jpe?g|png|webp)$/

type AvatarCheck = { ok: true } | { ok: false; message: string }

function parseUrl(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

function decodePathSegment(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

async function validateAvatarUrl(rawUrl: string, userId: string): Promise<AvatarCheck> {
  const projectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!projectUrl) {
    return { ok: false, message: "Bu kurulumda fotoğraf yükleme yapılandırılmamış." }
  }

  const candidate = parseUrl(rawUrl)
  const project = parseUrl(projectUrl)
  if (!candidate || !project) {
    return { ok: false, message: "Bu fotoğraf adresi okunamadı." }
  }

  // Origin, not hostname: an attacker-supplied http:// on our own host would still be a
  // different origin and must not pass.
  if (candidate.origin !== project.origin) {
    return {
      ok: false,
      message: "Profil fotoğrafları başka yerden bağlanamaz, buradan yüklenmelidir.",
    }
  }

  const prefix = `/storage/v1/object/public/${AVATAR_BUCKET}/${userId}/`
  if (!candidate.pathname.startsWith(prefix)) {
    return { ok: false, message: "Bu fotoğraf senin yükleme klasöründe değil." }
  }

  const filename = decodePathSegment(candidate.pathname.slice(prefix.length))
  if (filename === null || !AVATAR_FILENAME.test(filename)) {
    return { ok: false, message: "Profil fotoğrafı JPEG, PNG ya da WebP olmalıdır." }
  }

  // Re-check what was actually uploaded. The bucket is public, so a HEAD needs no credentials
  // and costs one round trip on a gesture that happens roughly never.
  const head = await fetch(candidate.toString(), { method: "HEAD", cache: "no-store" }).catch(
    () => null,
  )
  if (!head) {
    return { ok: false, message: "Bu fotoğrafa ulaşamadık. Yeniden yüklemeyi dene." }
  }

  if (!head.ok) {
    return { ok: false, message: "Bu fotoğraf artık mevcut değil. Yeniden yüklemeyi dene." }
  }

  const contentType = (head.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase()
  if (!contentType || !AVATAR_CONTENT_TYPES.has(contentType)) {
    return { ok: false, message: "Profil fotoğrafı JPEG, PNG ya da WebP olmalıdır." }
  }

  // A missing Content-Length is inconclusive rather than suspicious; the type check above is the
  // one that matters for what a browser will do with the file.
  const length = Number(head.headers.get("content-length"))
  if (Number.isFinite(length) && length > MAX_AVATAR_BYTES) {
    return { ok: false, message: "Bu fotoğraf 2 MB'tan büyük." }
  }

  return { ok: true }
}

/* ========================================================================== */
/*  PATCH                                                                     */
/* ========================================================================== */

export async function PATCH(request: Request): Promise<Response> {
  return handleRoute<AccountUpdateData>(async () => {
    const session = await getSessionUser()
    if (!session) {
      return fail(API_ERROR_CODES.UNAUTHENTICATED, "Profilini değiştirmek için giriş yap.", 401)
    }

    const raw: unknown = await request.json().catch(() => null)
    if (raw === null) {
      return fail(API_ERROR_CODES.VALIDATION_FAILED, "JSON gövdesi gerekli.", 422)
    }

    const parsed = accountPatchSchema.safeParse(raw)
    if (!parsed.success) {
      const unrecognised = parsed.error.issues.flatMap((issue) =>
        issue.code === "unrecognized_keys" ? issue.keys : [],
      )
      if (unrecognised.length > 0) {
        return fail(
          API_ERROR_CODES.VALIDATION_FAILED,
          `${unrecognised.join(", ")} cannot be changed from this screen.`,
          422,
          { fields: unrecognised },
        )
      }
      return fail(API_ERROR_CODES.VALIDATION_FAILED, "Girdiğin bilgilerin bir kısmı geçersiz.", 422, {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      })
    }

    const input: AccountPatch = parsed.data
    const { profile } = session

    /* ---- minors: refuse rather than let Postgres refuse -------------------- */

    const enforcement = enforcePrivacyDefaults(profile)
    const lockedFields = [...enforcement.lockedFields]

    const rejected: LockedPrivacyField[] = []
    if (
      lockedFields.includes("location_sharing_enabled") &&
      input.locationSharingEnabled !== undefined &&
      input.locationSharingEnabled !== enforcement.values.location_sharing_enabled
    ) {
      rejected.push("location_sharing_enabled")
    }
    if (
      lockedFields.includes("marketing_opt_in") &&
      input.marketingOptIn !== undefined &&
      input.marketingOptIn !== enforcement.values.marketing_opt_in
    ) {
      rejected.push("marketing_opt_in")
    }
    if (
      lockedFields.includes("profile_visibility") &&
      input.profileVisibility !== undefined &&
      input.profileVisibility === "public"
    ) {
      rejected.push("profile_visibility")
    }

    if (rejected.length > 0) {
      return fail(
        API_ERROR_CODES.FORBIDDEN,
        "Hesap 16 yaşın altındayken bu ayarlar kilitli ve o zamana kadar kapalı kalır.",
        403,
        { fields: rejected },
      )
    }

    /* ---- avatar ----------------------------------------------------------- */

    if (typeof input.avatarUrl === "string") {
      const check = await validateAvatarUrl(input.avatarUrl, profile.id)
      if (!check.ok) {
        return fail(API_ERROR_CODES.VALIDATION_FAILED, check.message, 422, {
          fields: ["avatarUrl"],
        })
      }
    }

    /* ---- build the patch --------------------------------------------------- */

    const patch: TablesUpdate<"profiles"> = {}
    if (input.fullName !== undefined) patch.full_name = input.fullName
    if (input.displayName !== undefined) patch.display_name = input.displayName
    if (input.phone !== undefined) patch.phone = input.phone
    if (input.city !== undefined) patch.city = input.city
    if (input.preferredPosition !== undefined) patch.preferred_position = input.preferredPosition
    if (input.bio !== undefined) patch.bio = input.bio
    if (input.avatarUrl !== undefined) patch.avatar_url = input.avatarUrl
    if (input.locationSharingEnabled !== undefined) {
      patch.location_sharing_enabled = input.locationSharingEnabled
    }
    if (input.profileVisibility !== undefined) patch.profile_visibility = input.profileVisibility
    if (input.marketingOptIn !== undefined) patch.marketing_opt_in = input.marketingOptIn

    const updated = Object.keys(patch)
    if (updated.length === 0) {
      return fail(API_ERROR_CODES.VALIDATION_FAILED, "Güncellenecek bir şey yok.", 422)
    }

    // `createRouteClient` — not `createClient` — because `getSessionUser()` above resolves the
    // caller through the bearer-aware client. A cookie-only client here would authorise the Expo
    // app as itself and then run the UPDATE as `anon`, which RLS refuses; the two identities have
    // to come off the same transport.
    const supabase = await createRouteClient(request)

    // `.eq('id', …)` is load-bearing here rather than an optimisation: `profiles_update_self`
    // admits `private.is_admin()`, so an admin calling this without the filter would rewrite
    // every profile in the table. RLS still decides whether the row is writable at all.
    const { data, error } = await supabase
      .from("profiles")
      .update(patch)
      .eq("id", profile.id)
      .select(RETURNING)
      .maybeSingle()

    if (error) {
      // 23514 is the CHECK constraint (`profiles_minor_privacy_locked_check`); 42501 is the
      // column grant. Both mean the same thing to a user: this field is not theirs to change.
      if (error.code === "23514" || error.code === "42501") {
        return fail(
          API_ERROR_CODES.FORBIDDEN,
          "Veritabanı bu değişikliği reddetti. Bazı alanlar hesap türüne göre kilitli.",
          403,
        )
      }
      console.error("[account] profile update failed", { code: error.code })
      return fail(API_ERROR_CODES.INTERNAL, "Bu değişiklikler kaydedilemedi.", 500)
    }

    if (!data) {
      return fail(API_ERROR_CODES.NOT_FOUND, "Profilin bulunamadı.", 404)
    }

    /* ---- effective privacy, after the trigger has had its say -------------- */

    const after = enforcePrivacyDefaults({
      date_of_birth: profile.date_of_birth,
      is_minor: profile.is_minor,
      parental_consent_status: profile.parental_consent_status,
      location_sharing_enabled:
        input.locationSharingEnabled ?? profile.location_sharing_enabled,
      profile_visibility: input.profileVisibility ?? profile.profile_visibility,
      marketing_opt_in: input.marketingOptIn ?? profile.marketing_opt_in,
    })

    return ok<AccountUpdateData>({
      updated,
      profile: {
        id: data.id,
        fullName: data.full_name,
        displayName: data.display_name,
        avatarUrl: data.avatar_url,
        city: data.city,
        preferredPosition: data.preferred_position,
        bio: data.bio,
      },
      privacy: {
        locationSharingEnabled: after.values.location_sharing_enabled,
        profileVisibility: after.values.profile_visibility,
        marketingOptIn: after.values.marketing_opt_in,
      },
      lockedFields,
    })
  })
}
