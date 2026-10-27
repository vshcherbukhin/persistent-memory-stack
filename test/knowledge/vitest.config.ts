import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { include: ['test/knowledge/*.test.ts'], fileParallelism: false, maxWorkers: 1, testTimeout: 20000, hookTimeout: 20000, setupFiles: ['apps/api/test/setup.ts'] } })
