import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))

/**
 * persistent-memory — LIVE integration suite (Phase 4).
 *
 * Pure-HTTP, end-to-end against an ALREADY-RUNNING local stack (api at
 * http://localhost:8090 by default; override with PM_API_BASE). These specs hit
 * SHARED live state (Postgres + Qdrant + MinIO + Graphiti through the api), so:
 *
 *   • SEQUENTIAL — no parallelism. `fileParallelism: false` forces maxWorkers to
 *     1 (vitest 4), so the four spec files run one after another and never
 *     interleave writes to the same teams/memories; `isolate: false` reuses one
 *     worker, and `sequence.concurrent: false` keeps tests in-file serial.
 *   • GENEROUS TIMEOUTS — server-side embedding (Ollama on the host) and the
 *     async ingest pipeline (extract → chunk → embed → Graphiti) are slow on a
 *     cold stack, so testTimeout is 60s and hookTimeout (provision + teardown) is
 *     120s.
 *
 * This config is NOT part of the default `npm test` — it needs an isolated live
 * stack + a PM_BOOTSTRAP_TOKEN. `npm run dev-test:run` supplies both after
 * proving `/config` belongs to its marked disposable server-mode stack.
 */
export default defineConfig({
  test: {
    // Resolve include patterns relative to this directory, not the repo root.
    root: here,
    environment: 'node',
    include: ['**/*.test.ts'],
    // One fork, no isolation, no file-level parallelism → strictly sequential
    // against the shared live stack (vitest 4 top-level pool API).
    pool: 'forks',
    fileParallelism: false, // forces maxWorkers → 1 (no cross-file interleave)
    isolate: false, // reuse the single worker across files
    sequence: { concurrent: false }, // in-file tests stay serial
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // No retries — a flaky live result should be visible, not papered over.
    retry: 0,
    globalSetup: './global-setup.ts',
  },
})
