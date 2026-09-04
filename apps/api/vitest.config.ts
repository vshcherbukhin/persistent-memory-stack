import { defineConfig } from 'vitest/config'

// setupFiles runs before each test file's imports → seeds the minimal env that
// config.ts validates at import (see test/setup.ts). Unit tests never connect.
export default defineConfig({
  test: {
    setupFiles: ['./test/setup.ts'],
  },
})
