import { describe, expect, it, vi } from 'vitest'
import type { ModelDependencyHealthStore } from '../src/services/model-dependency-health.ts'

const db = vi.hoisted(() => ({ ownerPrisma: undefined as ModelDependencyHealthStore | undefined }))

vi.mock('@pm/db', () => ({
  get ownerPrisma() {
    return db.ownerPrisma
  },
}))

describe('model dependency health API boot order', () => {
  it('imports before initDb and resolves ownerPrisma only when a later call needs it', async () => {
    const healthModule = await import('../src/services/model-dependency-health.ts')

    expect(healthModule.modelDependencyHealth).toBeDefined()
    db.ownerPrisma = {
      modelDependencyHealth: {
        findUnique: async () => null,
        findMany: async () => [],
        upsert: async () => { throw new Error('not used') },
        updateMany: async () => ({ count: 0 }),
      },
      $transaction: async (operation) => operation({ modelDependencyHealth: db.ownerPrisma!.modelDependencyHealth }),
    }

    await expect(healthModule.modelDependencyHealth.getSafeHealth('fact_extraction', 'server'))
      .resolves.toMatchObject({ state: 'unknown' })
  })
})
