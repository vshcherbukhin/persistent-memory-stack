import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

/**
 * persistent-memory-dashboard — vitest config.
 *
 * Unit and static React markup tests run in Node. Server-only integrations
 * are mocked in action tests; no browser or running Next server is needed.
 *
 * The `@/` alias mirrors tsconfig.json paths so test imports match app imports.
 */
export default defineConfig({
  // Next preserves JSX for its compiler; component markup tests need it transformed here.
  oxc: { jsx: { runtime: 'automatic' } },
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
