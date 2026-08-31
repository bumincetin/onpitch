/**
 * instrumentation.ts
 *
 * Next runs `register()` once per server process, before the first request is served. It is the
 * earliest hook the application controls.
 *
 * That is the whole point: a deploy missing `STRIPE_WEBHOOK_SECRET` should fail here rather
 * than at the first customer's payment, where the charge succeeds and the webhook that would
 * have confirmed their booking fails signature verification.
 *
 * WHAT THROWING HERE ACTUALLY DOES, measured rather than assumed:
 *
 *   • `next build` does not run this hook at all. A build with a broken environment succeeds.
 *     The validation is a RUNTIME gate, not a build gate.
 *   • `next start` runs it, and on a throw the process still binds its port and still logs
 *     "Ready" — Next prints that before the hook resolves — then answers 500 to every request,
 *     logging this error each time.
 *
 * So a bad deploy serves nothing, but it does hold an open socket. The platform health check
 * must therefore be an HTTP one; a TCP check would see the port and call it healthy.
 *
 * `runtime === "nodejs"` guards the edge runtime, which the middleware runs in and which has a
 * different (much smaller) environment. Validating the full server schema there would fail every
 * time on variables the edge runtime is never given.
 */

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return

  const { assertServerEnv } = await import("@/lib/env")

  try {
    assertServerEnv()
  } catch (error) {
    // The message lists every problem and echoes no values. Print it plainly — a stack trace
    // here is noise, because the fault is in the deployment's configuration, not in the code.
    console.error(`\n${error instanceof Error ? error.message : String(error)}\n`)
    throw error
  }
}
