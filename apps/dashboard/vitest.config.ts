import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

/**
 * persistent-memory-dashboard — vitest config.
 *
 * Scoped to the pure, dependency-free unit tests (src/lib/*.test.ts). These
 * never import Next.js server-only modules (cookies / redirect / fetch), so no
 * jsdom or Next test harness is needed — a plain node environment suffices.
 *
 * The `@/` alias mirrors tsconfig.json paths so test imports match app imports.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
