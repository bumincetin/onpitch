/**
 * next.config.mjs
 *
 * Three things live here that are easy to get wrong elsewhere:
 *
 *  1. `images.remotePatterns` — Supabase Storage is the only remote image origin we trust.
 *     The public object path is always `/storage/v1/object/public/**`, so we scope the
 *     pattern to it rather than allowing the whole host.
 *
 *  2. `headers()` — defence-in-depth headers applied to every response. The
 *     Permissions-Policy line is not boilerplate: geolocation is denied platform-wide by
 *     default, which reinforces the minors' privacy default enforced in the database
 *     (`profiles_minor_privacy_locked_check` pins `location_sharing_enabled = false` for
 *     under-16 accounts). A UI bug can therefore never prompt a minor for their position:
 *     the browser refuses the API before our code runs.
 *
 *  3. CORS for `/api/*`, so the Expo app can reach the same route handlers the web app uses.
 *     Native React Native sends no `Origin` and is not subject to CORS at all; this exists for
 *     Expo Web (`expo start --web`) and for a browser-hosted build of the mobile app. Every rule
 *     names ONE exact origin — `Access-Control-Allow-Origin: *` on routes that accept an
 *     `Authorization` header would let any page on the internet read a signed-in user's data.
 */

/** Host of the Supabase project, e.g. `abcdefgh.supabase.co`. Absent at lint time in CI. */
const supabaseHostname = (() => {
  const raw = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!raw) return null
  try {
    return new URL(raw).hostname
  } catch {
    return null
  }
})()

/* -------------------------------------------------------------------------- */
/*  Content-Security-Policy                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Origin of the Supabase project, e.g. `https://abcdefgh.supabase.co`, plus its websocket
 * scheme. PostgREST is reached over https and Realtime over wss, and `connect-src` must name
 * both or the live scoreboard silently stops updating with a console error nobody sees in
 * production.
 */
const supabaseOrigins = (() => {
  const raw = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!raw) return []
  try {
    const url = new URL(raw)
    return [url.origin, `wss://${url.host}`]
  } catch {
    return []
  }
})()

/**
 * The policy, as a directive map.
 *
 * ---------------------------------------------------------------------------
 * WHY `'unsafe-inline'` IS IN `script-src`, AND WHAT IT COSTS
 * ---------------------------------------------------------------------------
 * The App Router serves hydration data and the flight stream through inline `<script>` tags it
 * generates itself. There are exactly two ways to allow those:
 *
 *   1. A per-request nonce, set in `middleware.ts` and read by Next. This is the strict option,
 *      and it forces EVERY page to render dynamically — a nonce is per-response, so nothing can
 *      be statically generated or cached at the edge. This build statically prerenders most of
 *      its 35 routes, and the marketing page and the venue pages are the ones that most need it.
 *   2. `'unsafe-inline'`, which allows those tags and, with them, any injected inline script.
 *
 * We take (2) deliberately, and it is honest to say what that means: this CSP does NOT stop XSS.
 * It is worth having anyway for what it *does* stop — every directive below is a real control:
 *
 *   • `object-src 'none'` kills Flash/PDF plugin-based script execution outright.
 *   • `base-uri 'self'` stops an injected `<base>` from re-pointing every relative script URL.
 *   • `form-action 'self'` stops an injected form from POSTing a session to an attacker.
 *   • `frame-ancestors 'none'` is the clickjacking control that actually works (X-Frame-Options
 *      is legacy and ignored by newer browsers when this is present).
 *   • the src allowlists mean an injected `<script src>` can only load from Stripe or ourselves,
 *     so the common "inject a tag pointing at attacker.com" exfiltration path is closed.
 *
 * XSS defence proper is upstream of this: React escapes by default, there is no
 * `dangerouslySetInnerHTML` anywhere in the app, and every user-supplied string reaches the DOM
 * as a text node. Moving to a nonce is a real improvement and is written up in docs/PRODUCTION.md
 * as the next step, with its rendering cost stated.
 *
 * Everything else is as tight as the app allows:
 *   script-src   — 'self' plus Stripe.js. `'unsafe-eval'` ONLY in development, where Next's
 *                  fast-refresh runtime needs it; a production build has no eval at all.
 *   style-src    — 'unsafe-inline' is unavoidable: next/font injects a `<style>` for the font
 *                  face and Next inlines critical CSS. No external stylesheet origin is allowed.
 *   img-src      — 'self', data:, blob: (canvas textures in the 3D scene) and Supabase Storage.
 *   font-src     — 'self' only. next/font/google downloads the files at BUILD time and serves
 *                  them from /_next/static, so no Google origin is needed at runtime.
 *   connect-src  — Supabase https + wss, Stripe's API, and 'self'.
 *   frame-src    — Stripe only; that is 3-D Secure and the Express onboarding return.
 *   worker-src   — 'self' blob:, which is what Three.js uses if it spawns a loader worker.
 */
const buildContentSecurityPolicy = (isDevelopment) => {
  const directives = {
    'default-src': ["'self'"],
    'script-src': [
      "'self'",
      "'unsafe-inline'",
      ...(isDevelopment ? ["'unsafe-eval'"] : []),
      'https://js.stripe.com'
    ],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:', 'https://*.supabase.co', 'https://*.supabase.in'],
    'font-src': ["'self'", 'data:'],
    'connect-src': [
      "'self'",
      ...supabaseOrigins,
      'https://api.stripe.com',
      // Metro's dev websocket, and nothing in a production build.
      ...(isDevelopment ? ['ws:', 'http://localhost:*'] : [])
    ],
    'frame-src': ["'self'", 'https://js.stripe.com', 'https://hooks.stripe.com'],
    'worker-src': ["'self'", 'blob:'],
    'media-src': ["'self'", 'blob:', 'data:'],
    'manifest-src': ["'self'"],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'none'"]
  }

  const serialised = Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(' ')}`)
    .join('; ')

  // Only in production: over http:// it would try to upgrade localhost and break dev entirely.
  return isDevelopment ? serialised : `${serialised}; upgrade-insecure-requests`
}

/* -------------------------------------------------------------------------- */
/*  CORS for the mobile client                                                */
/* -------------------------------------------------------------------------- */

/**
 * Origins Expo serves from during development. Used only when MOBILE_ALLOWED_ORIGINS is unset
 * AND the build is not a production one, so a deploy that forgets the variable ships with no
 * cross-origin access rather than with localhost quietly allowed.
 *
 *   8081  — Metro / `expo start --web` on SDK 50+
 *   19006 — the older `expo start:web` port, still what some tooling defaults to
 */
const EXPO_DEV_ORIGINS = [
  'http://localhost:8081',
  'http://127.0.0.1:8081',
  'http://localhost:19006',
  'http://127.0.0.1:19006'
]

/**
 * An entry has to be a bare origin: scheme, host, optional port, nothing else. That is exactly
 * what a browser puts in the `Origin` header, so an entry with a trailing slash, a path or
 * credentials would match nothing at runtime. Comparing against `url.origin` rejects those at
 * config load instead of leaving dead config that looks alive.
 */
function isBareHttpOrigin(candidate) {
  try {
    const url = new URL(candidate)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    return url.origin === candidate
  } catch {
    return false
  }
}

/**
 * MOBILE_ALLOWED_ORIGINS — comma separated, e.g.
 *   MOBILE_ALLOWED_ORIGINS="http://localhost:8081,https://app.halisaha.example"
 *
 * Custom schemes (`halisaha://`) are not origins a browser will ever send and are rejected here;
 * a native build needs no entry at all.
 */
function readMobileAllowedOrigins() {
  const configured = (process.env.MOBILE_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)

  const accepted = []
  for (const entry of configured) {
    if (!isBareHttpOrigin(entry)) {
      console.warn(
        `[next.config] MOBILE_ALLOWED_ORIGINS: ignoring "${entry}". Expected a bare origin ` +
          'such as https://app.example.com — no trailing slash, path or credentials.'
      )
      continue
    }
    if (!accepted.includes(entry)) accepted.push(entry)
  }

  if (accepted.length > 0) return accepted
  return process.env.NODE_ENV === 'production' ? [] : EXPO_DEV_ORIGINS
}

const mobileAllowedOrigins = readMobileAllowedOrigins()

/**
 * Next compiles a `has` value into `^<value>$` and matches the header against it, so the origin
 * has to be escaped: an unescaped `.` matches any character, and `https://app.example.com` would
 * then also match a request from `https://appxexample.com`. Nothing leaks even in that case —
 * the rule echoes the CONFIGURED origin, and the browser rejects a value that is not its own —
 * but a matcher that is only approximately right is not a matcher.
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Everything under `/api` EXCEPT the Stripe webhook. That route is called by Stripe's servers,
 * never by a browser: it has no origin to allow, its authentication is the HMAC signature over
 * the raw body, and `middleware.ts` already excludes it for the same reason. Advertising CORS on
 * it would be noise at best and an invitation to probe it at worst.
 */
const CORS_API_SOURCE = '/api/:path((?!stripe/webhook).*)'

/**
 * One rule per allowed origin. `Access-Control-Allow-Origin` must echo a single origin — a list
 * is not valid in that header — so the `has` condition picks the matching rule per request.
 *
 * No `Access-Control-Allow-Credentials`: the mobile transport is a bearer token, not a cookie,
 * and switching it on would invite cross-origin cookie-authenticated calls, which is CSRF.
 *
 * OPTIONS needs no route code. Next answers preflight for any route handler that exists, and
 * these headers are attached to that response because they are matched on the path, not the
 * method.
 */
const mobileCorsHeaderRules = mobileAllowedOrigins.map((origin) => ({
  source: CORS_API_SOURCE,
  has: [{ type: 'header', key: 'origin', value: escapeRegExp(origin) }],
  headers: [
    { key: 'Access-Control-Allow-Origin', value: origin },
    { key: 'Access-Control-Allow-Methods', value: 'GET, POST, PATCH, DELETE, OPTIONS' },
    { key: 'Access-Control-Allow-Headers', value: 'Authorization, Content-Type' },
    { key: 'Access-Control-Max-Age', value: '600' },
    // The response body differs per origin AND per transport. `Cookie` is repeated from
    // lib/api-response.ts so the header stays complete whether Next replaces or appends.
    { key: 'Vary', value: 'Origin, Cookie, Authorization' }
  ]
}))

/** @type {import('next').NextConfig} */
const nextConfig = {
  // @halisaha/shared ships TypeScript source, so Next has to compile it rather than
  // consume a prebuilt bundle. This is what keeps the TrueSkill engine and the realtime
  // topic strings identical between web and mobile instead of forked per app.
  transpilePackages: ["@halisaha/shared"],
  reactStrictMode: true,
  poweredByHeader: false,
  experimental: {
    // Typed routes are off on purpose: half the app's hrefs are built from database ids at
    // runtime, and the generated Route union rejects those without a cast on every call site.
    typedRoutes: false,
    // Required in Next 14 for `instrumentation.ts` to run at all. Without it the file is dead
    // code and the environment is never validated, which is the whole reason it exists.
    instrumentationHook: true
  },
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: supabaseHostname ?? '*.supabase.co',
        pathname: '/storage/v1/object/public/**'
      },
      {
        protocol: 'https',
        hostname: '*.supabase.in',
        pathname: '/storage/v1/object/public/**'
      }
    ]
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: buildContentSecurityPolicy(process.env.NODE_ENV !== 'production')
          },
          {
            // Only meaningful over HTTPS; browsers ignore it on http://localhost.
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload'
          },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          {
            // DENY, not SAMEORIGIN, to agree with `frame-ancestors 'none'` above. Nothing in
            // this app is meant to be framed, including by itself; a policy that disagrees with
            // its own legacy fallback is the kind of thing that gets read as intentional later.
            key: 'X-Frame-Options',
            value: 'DENY'
          },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            // geolocation=() denies it to this document AND every embedded frame.
            // See the file header: this is the browser-side half of the minors' privacy default.
            key: 'Permissions-Policy',
            value: 'geolocation=(), camera=(), microphone=(), payment=(self), interest-cohort=()'
          },
          { key: 'X-DNS-Prefetch-Control', value: 'on' },
          {
            // Isolates this origin's browsing-context group, which is what makes a cross-origin
            // popup (Stripe's onboarding window) unable to reach back into `window.opener`.
            key: 'Cross-Origin-Opener-Policy',
            value: 'same-origin-allow-popups'
          },
          {
            // Opts every response out of Google's FLoC/Topics inference. The Permissions-Policy
            // line covers the older name; this covers the current one.
            key: 'X-Permitted-Cross-Domain-Policies',
            value: 'none'
          }
        ]
      },
      ...mobileCorsHeaderRules
    ]
  }
}

export default nextConfig
