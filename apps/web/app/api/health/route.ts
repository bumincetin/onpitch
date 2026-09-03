/**
 * GET /api/health
 *
 * Liveness probe. Unauthenticated by design, and the only route in `app/api/**` that is.
 *
 * What it answers: "is this deployment up and serving route handlers?". The mobile app pings it
 * on cold start and after a network error to tell "the API is unreachable" apart from "your
 * session expired", which are the same silent failure to a user otherwise.
 *
 * What it deliberately does NOT do is touch Postgres or Stripe. A probe that queried the database
 * would report the API as down during a Supabase blip that the app can survive — and the mobile
 * client talks to Supabase directly for auth and realtime anyway, so it discovers that outage on
 * its own, with better information than this route could give it. That also keeps the endpoint
 * cheap enough to be hammered by an uptime monitor and useless to anyone probing for data.
 *
 * The response carries no session-derived and no configuration-derived values, so it is safe to
 * serve to an unauthenticated caller from any allowed origin. `no-store` still applies (see
 * `lib/api-response.ts`) — a cached "ok" is not a liveness answer.
 *
 * CORS is handled in `next.config.mjs` for the origins in MOBILE_ALLOWED_ORIGINS, and Next
 * answers the OPTIONS preflight for this route on its own.
 */

import { handleRoute, ok } from "@/lib/api-response"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export interface HealthPayload {
  status: "ok"
  service: "onpitch-web"
  /** Server clock, ISO 8601 with offset. Lets a client spot a badly skewed device clock. */
  time: string
  /** Seconds this server process has been running. Small numbers mean it keeps restarting. */
  uptimeSeconds: number
}

export async function GET(): Promise<Response> {
  return handleRoute<HealthPayload>(async () =>
    ok<HealthPayload>({
      status: "ok",
      service: "onpitch-web",
      time: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
    }),
  )
}
