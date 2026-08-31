/**
 * lib/env.ts
 *
 * The four build-time values the app cannot discover on its own, read once and validated once.
 *
 * Babel replaces `process.env.EXPO_PUBLIC_FOO` with a string literal at bundle time, but only
 * when it is written out as a literal member expression. `process.env[name]` compiles to a lookup
 * against an object that is empty on device, so every read below is spelled out longhand and the
 * variable name is passed separately for the error message.
 *
 * Missing configuration throws on import, so a misconfigured build stops at startup instead of
 * surfacing later as "Network request failed" from somewhere inside gotrue.
 */

export interface MobileEnv {
  /** Supabase project URL. */
  supabaseUrl: string
  /** Anon key. Public by design; RLS is the security boundary. */
  supabaseAnonKey: string
  /** Origin of the Next.js app serving /api/**, with any trailing slash removed. */
  apiUrl: string
  /**
   * Stripe publishable key, or null when it is not configured.
   *
   * Nullable on purpose. `POST /api/bookings/checkout` returns `publishableKey` in its
   * `CheckoutResult`, so a payment can always mount Stripe with the key the server just handed
   * it. Setting this variable only buys an earlier mount, which is what the Apple Pay and Google
   * Pay availability checks need before the user reaches checkout.
   */
  stripePublishableKey: string | null
}

function required(name: string, raw: string | undefined): string {
  const value = raw?.trim()
  if (!value) {
    throw new Error(
      `[env] ${name} is not set. Copy apps/mobile/.env.example to apps/mobile/.env, fill it in, ` +
        'then restart with `npx expo start --clear`. Env values are baked into the bundle, so a ' +
        'warm Metro cache keeps serving the old ones.',
    )
  }
  return value
}

function optional(raw: string | undefined): string | null {
  const value = raw?.trim()
  return value ? value : null
}

export const env: MobileEnv = {
  supabaseUrl: required('EXPO_PUBLIC_SUPABASE_URL', process.env.EXPO_PUBLIC_SUPABASE_URL),
  supabaseAnonKey: required(
    'EXPO_PUBLIC_SUPABASE_ANON_KEY',
    process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
  ),
  apiUrl: required('EXPO_PUBLIC_API_URL', process.env.EXPO_PUBLIC_API_URL).replace(/\/+$/, ''),
  stripePublishableKey: optional(process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY),
}
