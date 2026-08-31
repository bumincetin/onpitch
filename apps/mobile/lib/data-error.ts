/**
 * lib/data-error.ts
 *
 * A failure from a direct Supabase read, carrying a sentence written for a player.
 *
 * WHY THIS EXISTS
 * ---------------
 * `PostgrestError.message` is never empty, so `new Error(error.message || 'Could not load X.')`
 * always takes the first branch and the curated fallback is dead code. What reaches the screen is
 * then the database's own diagnostic — a policy name, a column name, `JWT expired`, `permission
 * denied for table profiles`. None of that helps somebody holding a phone, and the RLS and schema
 * detail in it is not something to volunteer.
 *
 * `DataError` inverts that. The message is the curated sentence; the raw failure goes to the
 * console, where a developer reading a device log can still see it. `describeError` in
 * components/match/error-notice.tsx treats a `DataError` message as safe to render and anything
 * else as generic, so a loader that forgets to wrap cannot leak by accident.
 *
 * Errors coming back from the app's OWN routes are `ApiError` (lib/api.ts) and are unaffected:
 * those messages are written by `validate_score_report()` and the consensus functions to be read
 * by a player, and are forwarded verbatim on purpose.
 */

/** A read failed. `message` is safe to show; `cause` is the raw failure, for the log only. */
export class DataError extends Error {
  /** The `PostgrestError`, `Error` or unknown value this was built from. Never rendered. */
  readonly cause: unknown

  constructor(message: string, cause: unknown = null) {
    super(message)
    this.name = 'DataError'
    this.cause = cause
    // Hermes runs the class down-level in some release configurations; without this,
    // `err instanceof DataError` returns false in exactly the build that is hardest to debug.
    Object.setPrototypeOf(this, DataError.prototype)
  }
}

/** True when `error` is a `DataError`. Narrows in a catch block. */
export function isDataError(error: unknown): error is DataError {
  return error instanceof DataError
}

/**
 * Wraps a Supabase failure in a message a player can read, and logs the original.
 *
 * @example
 * if (error) throw dataError('Could not load your teams.', error)
 */
export function dataError(message: string, cause: unknown = null): DataError {
  if (cause !== null && cause !== undefined) {
    console.warn('[data]', message, cause)
  }
  return new DataError(message, cause)
}
