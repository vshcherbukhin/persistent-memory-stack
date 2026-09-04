import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // Two release-contract tests deliberately build shared `dist/` and deploy
    // artifacts. Parallel files race those mutable outputs and make the build
    // duration nondeterministic, so serialize this package's files only.
    fileParallelism: false,
  },
})
