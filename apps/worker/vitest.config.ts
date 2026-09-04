import { defineConfig } from 'vitest/config'

// Seeds the minimal env config.ts validates at import (see test/setup.ts).
export default defineConfig({
  test: {
    setupFiles: ['./test/setup.ts'],
  },
})
