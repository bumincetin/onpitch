import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

/**
 * Vitest for the web app's pure logic.
 *
 * Scope is deliberate: this covers `lib/**` — the permission matrix, the response envelope, the
 * notification formatter — and not React components or route handlers. Those need a request
 * scope, a database and a session; testing them properly means integration tests against a real
 * Supabase, which the CI `migrations` job already stands up and which is the right place to add
 * them next. Half-mocking Postgres to assert on a stub proves nothing about RLS.
 *
 * The `@/` alias mirrors `tsconfig.json` so a test imports a module by the same specifier the
 * application does, rather than by a relative path that would drift.
 */
export default defineConfig({
  test: {
    environment: "node",
    // Forks, not the default worker threads. On Windows the thread pool's RPC channel times out
    // fetching `/@vite/env` before a single test runs — three files, three dead workers, "no
    // tests" and a green-looking exit that has verified nothing. A forked child process has its
    // own module registry and no such channel.
    pool: "forks",
    include: ["lib/**/*.test.ts"],
    // No globals: every test imports `describe`/`it`/`expect` explicitly, which is what makes a
    // test file readable on its own and lets `tsc` check it without an ambient type package.
    globals: false,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
})
