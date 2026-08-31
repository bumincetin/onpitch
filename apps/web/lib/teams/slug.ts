/**
 * lib/teams/slug.ts
 *
 * Turning a team name into the URL handle `teams.slug` will actually accept, and settling the
 * race when two people pick the same name at the same time.
 *
 * ---------------------------------------------------------------------------------------------
 * THE CONSTRAINT IS THE SPEC
 * ---------------------------------------------------------------------------------------------
 * `0001_schema.sql` declares:
 *
 *     slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
 *
 * Lowercase alphanumerics in hyphen-separated runs. No leading hyphen, no trailing hyphen, no
 * double hyphen, no empty string. {@link slugify} is written to satisfy exactly that regex for
 * every input, including inputs made entirely of characters it has to throw away — a team called
 * "***" still needs a URL.
 *
 * ---------------------------------------------------------------------------------------------
 * TURKISH
 * ---------------------------------------------------------------------------------------------
 * The product is Turkish-first, and two characters need the transliteration table specifically,
 * because Unicode case folding gets both wrong for this purpose:
 *
 *   * U+0131 (dotless i) has no diacritic to strip, so NFD leaves it intact and the `[^a-z0-9]`
 *     filter would delete it outright. "Kizilay" spelled properly would become "kzlay".
 *   * U+0130 (capital dotted I) lowercases under the default locale to `i` + U+0307 COMBINING DOT
 *     ABOVE — two code points. Stripping combining marks recovers `i`, but only if the strip runs
 *     after the lowercase, which is fragile ordering to depend on.
 *
 * So the table is applied to the raw string BEFORE any case folding, and the generic NFD pass
 * afterwards catches everything else (e-acute, n-tilde, a-ring) for free.
 *
 * ---------------------------------------------------------------------------------------------
 * COLLISIONS
 * ---------------------------------------------------------------------------------------------
 * `slug` is UNIQUE, and two captains naming their team "Kartallar" three seconds apart is an
 * ordinary occurrence rather than an exceptional one. A SELECT-then-INSERT would still lose that
 * race — the gap between the two statements is exactly where the other transaction commits — so
 * {@link insertWithUniqueSlug} INSERTs and treats SQLSTATE 23505 as "try the next candidate". The database arbitrates, and the loser
 * retries. `kartallar`, then `kartallar-2`, `kartallar-3`, and after the numbered run a random
 * suffix, which converges immediately even when a hundred teams share a name.
 *
 * No I/O of its own: the caller supplies the insert closure, so this module stays testable and
 * says nothing about which Supabase client (or which RLS context) the write happens under.
 */

/** The CHECK constraint on `teams.slug`, mirrored exactly. */
export const TEAM_SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/

/**
 * How much of the name survives into the slug.
 *
 * The column is unbounded `text`; this cap exists so the numbered and random suffixes stay
 * readable and so a URL made from an 80-character team name (the `name` CHECK's ceiling) does not
 * wrap in a chat window.
 */
export const MAX_SLUG_BASE_LENGTH = 48

/** Used when a name contributes no `[a-z0-9]` at all. Rarely surfaces alone — a suffix follows. */
export const SLUG_FALLBACK = "team"

/** How many `-2`, `-3`, ... candidates to try before switching to random suffixes. */
const NUMBERED_ATTEMPTS = 8

/** Total INSERT attempts before giving up and asking the captain for a different name. */
const DEFAULT_MAX_ATTEMPTS = 12

/* ========================================================================== */
/*  Transliteration                                                           */
/* ========================================================================== */

/**
 * Applied before case folding, for the reasons in the header. Both cases are listed explicitly
 * rather than relying on `toLowerCase()` first, because U+0130's lowercase is locale-dependent.
 */
const TRANSLITERATION: Readonly<Record<string, string>> = {
  "ı": "i", // dotless i
  "İ": "i", // capital I with dot
  "ğ": "g", // g with breve
  "Ğ": "g",
  "ü": "u", // u with diaeresis
  "Ü": "u",
  "ş": "s", // s with cedilla
  "Ş": "s",
  "ö": "o", // o with diaeresis
  "Ö": "o",
  "ç": "c", // c with cedilla
  "Ç": "c",
  // Not Turkish, but common enough in team names to be worth spelling out rather than deleting.
  "ß": "ss",
  "æ": "ae",
  "Æ": "ae",
  "ø": "o",
  "Ø": "o",
  "đ": "d",
  "Đ": "d",
  "ł": "l",
  "Ł": "l",
  "&": " and ",
}

function transliterate(input: string): string {
  let out = ""
  // Iterating the string yields whole code points, so an astral character is handled as one unit
  // instead of two lone surrogates that the filter would drop separately anyway.
  for (const character of input) {
    out += TRANSLITERATION[character] ?? character
  }
  return out
}

/* ========================================================================== */
/*  slugify                                                                   */
/* ========================================================================== */

/**
 * A team name becomes a handle: "Besiktas Genclik  Kulubu!" -> "besiktas-genclik-kulubu",
 * with the Turkish spellings transliterated on the way through.
 *
 * The return value always matches {@link TEAM_SLUG_PATTERN}. When the input contributes nothing
 * usable the result is {@link SLUG_FALLBACK}, which is a real slug rather than an empty string —
 * the caller can hand it straight to Postgres and let the uniqueness retry give it a suffix.
 */
export function slugify(input: string, maxLength: number = MAX_SLUG_BASE_LENGTH): string {
  const collapsed = transliterate(input)
    // Decompose, then drop combining marks. Runs after the table so the two Turkish characters
    // that decomposition cannot help have already been dealt with.
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    // Everything the CHECK will not accept becomes a separator, and runs collapse.
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")

  if (collapsed.length === 0) return SLUG_FALLBACK

  // Truncation can leave a trailing hyphen ("kartal-" from "kartal-spor"), which the CHECK
  // rejects, so trim again after cutting. A cut that removes everything falls back too.
  const truncated = collapsed.slice(0, Math.max(1, maxLength)).replace(/-+$/g, "")
  return truncated.length === 0 ? SLUG_FALLBACK : truncated
}

/** Does this string satisfy the `teams.slug` CHECK? */
export function isTeamSlug(value: unknown): value is string {
  return typeof value === "string" && TEAM_SLUG_PATTERN.test(value)
}

/* ========================================================================== */
/*  Candidates                                                                */
/* ========================================================================== */

const SUFFIX_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"

/**
 * A short random tail for the candidates after the numbered run.
 *
 * `crypto.getRandomValues` when the runtime has it (Node 18+ and every browser), `Math.random`
 * otherwise. This picks a URL suffix, not a token — the fallback costs nothing security-wise, and
 * the modulo bias across a 36-character alphabet is irrelevant to collision behaviour here.
 */
function randomSuffix(length = 5): string {
  const webCrypto = globalThis.crypto
  let out = ""

  if (webCrypto && typeof webCrypto.getRandomValues === "function") {
    const bytes = webCrypto.getRandomValues(new Uint8Array(length))
    for (const byte of bytes) {
      // The modulo is always in range; the `??` is what narrows `string | undefined` under
      // noUncheckedIndexedAccess without asserting.
      out += SUFFIX_ALPHABET[byte % SUFFIX_ALPHABET.length] ?? "x"
    }
    return out
  }

  for (let index = 0; index < length; index += 1) {
    const position = Math.floor(Math.random() * SUFFIX_ALPHABET.length)
    out += SUFFIX_ALPHABET[position] ?? "x"
  }
  return out
}

/**
 * The nth candidate for a base slug. Attempt 0 is the bare base.
 *
 * The base is re-trimmed before a suffix is appended so `base` + `-2` cannot produce a double
 * hyphen, and it is shortened to leave room for the suffix rather than letting the slug grow.
 */
export function slugCandidate(base: string, attempt: number): string {
  if (attempt <= 0) return base

  const suffix = attempt < NUMBERED_ATTEMPTS ? String(attempt + 1) : randomSuffix()
  const room = Math.max(1, MAX_SLUG_BASE_LENGTH - suffix.length - 1)
  const trimmed = base.slice(0, room).replace(/-+$/g, "") || SLUG_FALLBACK

  return `${trimmed}-${suffix}`
}

/**
 * The candidate sequence a name would be tried under, in order. Exported for tests and for a
 * "this handle is taken, here is what you would get" preview; {@link insertWithUniqueSlug} does
 * not call it, because it must generate a FRESH random suffix per attempt rather than replay a
 * pre-computed list.
 */
export function slugCandidates(name: string, count = DEFAULT_MAX_ATTEMPTS): string[] {
  const base = slugify(name)
  const out: string[] = []
  for (let attempt = 0; attempt < Math.max(1, count); attempt += 1) {
    out.push(slugCandidate(base, attempt))
  }
  return out
}

/* ========================================================================== */
/*  Insert with retry                                                         */
/* ========================================================================== */

/**
 * The shape postgrest-js reports a database failure in. Structural rather than an import of
 * `PostgrestError`, so this module has no dependency on the Supabase client at all.
 */
export interface PostgresErrorLike {
  code: string
  message: string
  details?: string | null
  hint?: string | null
}

/** SQLSTATE 23505 — unique_violation. */
export const UNIQUE_VIOLATION = "23505"

export function isUniqueViolation(error: PostgresErrorLike | null | undefined): boolean {
  return error?.code === UNIQUE_VIOLATION
}

/**
 * Does this 23505 name the given constraint or column?
 *
 * Postgres phrases the message as `duplicate key value violates unique constraint "<name>"`, so
 * matching on the constraint name is reliable when the message survives the transport. It does
 * not always — PostgREST can return a 23505 with an unhelpful message — so callers must have a
 * sensible answer for `false` rather than reading it as "some other constraint".
 */
export function mentionsConstraint(
  error: PostgresErrorLike | null | undefined,
  constraint: string,
): boolean {
  if (!error) return false
  const haystack = `${error.message} ${error.details ?? ""}`.toLowerCase()
  return haystack.includes(constraint.toLowerCase())
}

/** What {@link insertWithUniqueSlug} ended up doing. */
export type UniqueSlugOutcome<TRow> =
  | { status: "created"; slug: string; row: TRow; attempts: number }
  /** Every candidate collided. Vanishingly unlikely; surfaced rather than looped forever. */
  | { status: "exhausted"; attempts: number }
  /** The insert failed for a reason that is not a slug collision — RLS, a CHECK, a dead link. */
  | { status: "failed"; error: PostgresErrorLike | null; attempts: number }

export interface InsertWithUniqueSlugOptions {
  /** Total INSERT attempts. Defaults to 12: one bare, seven numbered, four random. */
  maxAttempts?: number
}

/**
 * INSERT a row under a generated slug, retrying the collision.
 *
 * @param name the team name the captain typed; slugified internally.
 * @param insert a closure that performs one INSERT with the given slug and returns postgrest's
 *   `{ data, error }`. It must not swallow the error — the 23505 is the retry signal.
 *
 * `teams` has exactly one unique constraint besides its primary key (`slug`), and the primary key
 * defaults to `gen_random_uuid()`, so a 23505 here is a slug collision with certainty. That is
 * why this function does not need {@link mentionsConstraint} to decide whether to retry — a table
 * with two unique constraints would.
 */
export async function insertWithUniqueSlug<TRow>(
  name: string,
  insert: (slug: string) => Promise<{ data: TRow | null; error: PostgresErrorLike | null }>,
  options: InsertWithUniqueSlugOptions = {},
): Promise<UniqueSlugOutcome<TRow>> {
  const base = slugify(name)
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const slug = slugCandidate(base, attempt)
    const { data, error } = await insert(slug)

    if (!error && data) {
      return { status: "created", slug, row: data, attempts: attempt + 1 }
    }

    if (isUniqueViolation(error)) continue

    return { status: "failed", error: error ?? null, attempts: attempt + 1 }
  }

  return { status: "exhausted", attempts: maxAttempts }
}
