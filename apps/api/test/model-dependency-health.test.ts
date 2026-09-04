import { describe, expect, it } from 'vitest'
import {
  createModelDependencyHealthService,
  type ModelDependencyHealthRecord,
  type RecordModelDependencyFailure,
  type ModelDependencyHealthStore,
} from '../src/services/model-dependency-health.ts'

type ModelDependencyHealthWhereInput = {
  capability: string
  observerScope: string
  observedAt: { lte: Date }
}

function createStore(): {
  store: ModelDependencyHealthStore
  rows: ModelDependencyHealthRecord[]
  updateWheres: ModelDependencyHealthWhereInput[]
} {
  const rows: ModelDependencyHealthRecord[] = []
  const updateWheres: ModelDependencyHealthWhereInput[] = []
  const repository = {
    async findUnique({ where }: { where: { capability_observerScope: { capability: string; observerScope: string } } }) {
      const key = where.capability_observerScope
      return rows.find((row) => row.capability === key.capability && row.observerScope === key.observerScope) ?? null
    },
    async findMany() {
      return [...rows].sort((left, right) => right.observedAt.getTime() - left.observedAt.getTime())
    },
    async upsert({
      where,
      create,
    }: {
      where: { capability_observerScope: { capability: string; observerScope: string } }
      create: ModelDependencyHealthRecord
      update: Record<string, never>
    }) {
      const key = where.capability_observerScope
      const existing = rows.find((row) => row.capability === key.capability && row.observerScope === key.observerScope)
      if (existing) return existing
      rows.push(create)
      return create
    },
    async updateMany({
      where,
      data,
    }: {
      where: ModelDependencyHealthWhereInput
      data: Partial<ModelDependencyHealthRecord>
    }) {
      if ('capability_observerScope' in where) throw new Error('updateMany must receive a scalar Prisma WhereInput')
      updateWheres.push(where)
      const row = rows.find((candidate) => candidate.capability === where.capability && candidate.observerScope === where.observerScope)
      if (!row || row.observedAt > where.observedAt.lte) return { count: 0 }
      Object.assign(row, data)
      return { count: 1 }
    },
  }

  return {
    rows,
    updateWheres,
    store: {
      modelDependencyHealth: repository,
      $transaction: async (operation) => operation({ modelDependencyHealth: repository }),
    } as unknown as ModelDependencyHealthStore,
  }
}

describe('model dependency health', () => {
  it('derives a bounded safe message and unhealthy state from a canonical failure', async () => {
    const { store, rows } = createStore()
    const health = createModelDependencyHealthService(store)

    await health.recordFailure({
      capability: 'fact_extraction',
      observerScope: 'server',
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      failure: { code: 'fact_extraction_quota_exhausted', state: 'unhealthy' },
      observedAt: new Date('2026-07-12T10:00:00.000Z'),
    })

    expect(rows[0]).toMatchObject({
      state: 'unhealthy',
      failureCode: 'fact_extraction_quota_exhausted',
      retryable: false,
      safeMessage: 'Fact extraction is out of tokens. The memory was not saved.',
    })
  })

  it('keeps a newer failure active when an older success arrives later', async () => {
    const { store } = createStore()
    const health = createModelDependencyHealthService(store)

    await health.recordFailure({
      capability: 'fact_extraction',
      observerScope: 'server',
      failure: { code: 'fact_extraction_quota_exhausted', state: 'unhealthy' },
      observedAt: new Date('2026-07-12T10:02:00.000Z'),
    })
    const result = await health.recordSuccess({
      capability: 'fact_extraction',
      observerScope: 'server',
      observedAt: new Date('2026-07-12T10:01:00.000Z'),
    })

    expect(result).toMatchObject({
      state: 'unhealthy',
      failureCode: 'fact_extraction_quota_exhausted',
      consecutiveFailures: 1,
    })
  })

  it('clears an active failure after a newer real success', async () => {
    const { store } = createStore()
    const health = createModelDependencyHealthService(store)

    await health.recordFailure({
      capability: 'embeddings',
      observerScope: 'server',
      provider: 'ollama',
      model: 'nomic-embed-text',
      failure: { code: 'embedding_provider_unavailable', state: 'unhealthy' },
      observedAt: new Date('2026-07-12T10:00:00.000Z'),
    })
    const result = await health.recordSuccess({
      capability: 'embeddings',
      observerScope: 'server',
      provider: 'ollama',
      model: 'nomic-embed-text',
      observedAt: new Date('2026-07-12T10:03:00.000Z'),
    })

    expect(result).toMatchObject({
      capability: 'embeddings',
      observerScope: 'server',
      state: 'healthy',
      provider: 'ollama',
      model: 'nomic-embed-text',
      failureCode: null,
      safeMessage: null,
      retryable: null,
      consecutiveFailures: 0,
    })
  })

  it('uses a scalar Prisma WhereInput for post-upsert recovery updates', async () => {
    const { store, updateWheres } = createStore()
    const health = createModelDependencyHealthService(store)
    const failureAt = new Date('2026-07-12T10:00:00.000Z')
    const recoveryAt = new Date('2026-07-12T10:03:00.000Z')

    await health.recordFailure({
      capability: 'fact_extraction',
      observerScope: 'server',
      failure: { code: 'fact_extraction_quota_exhausted', state: 'unhealthy' },
      observedAt: failureAt,
    })
    await expect(health.recordSuccess({
      capability: 'fact_extraction',
      observerScope: 'server',
      observedAt: recoveryAt,
    })).resolves.toMatchObject({ state: 'healthy' })

    expect(updateWheres).toEqual([{
      capability: 'fact_extraction',
      observerScope: 'server',
      observedAt: { lte: recoveryAt },
    }])
  })

  it('keeps client-observed health isolated by observer scope and returns safe DTOs newest first', async () => {
    const { store } = createStore()
    const health = createModelDependencyHealthService(store)

    await health.recordFailure({
      capability: 'embeddings',
      observerScope: 'client:51bb2e90-2cc2-49d8-b8f3-685d3e7e4f80',
      provider: 'ollama',
      model: 'nomic-embed-text',
      failure: { code: 'embedding_provider_unavailable', state: 'unhealthy' },
      observedAt: new Date('2026-07-12T10:01:00.000Z'),
    })
    await health.recordSuccess({
      capability: 'embeddings',
      observerScope: 'client:43fa7904-0973-4676-9d29-b811c3ecefdf',
      observedAt: new Date('2026-07-12T10:02:00.000Z'),
    })

    expect(await health.getSafeHealth('embeddings', 'client:51bb2e90-2cc2-49d8-b8f3-685d3e7e4f80')).toMatchObject({ state: 'unhealthy' })
    expect(await health.getSafeHealth('embeddings', 'client:43fa7904-0973-4676-9d29-b811c3ecefdf')).toMatchObject({ state: 'healthy' })
    expect(await health.listSafeHealth()).toMatchObject([
      { observerScope: 'client:43fa7904-0973-4676-9d29-b811c3ecefdf', state: 'healthy' },
      { observerScope: 'client:51bb2e90-2cc2-49d8-b8f3-685d3e7e4f80', state: 'unhealthy' },
    ])
  })

  it('returns an explicit unknown safe DTO when no observation exists', async () => {
    const { store } = createStore()
    const health = createModelDependencyHealthService(store)

    await expect(health.getSafeHealth('fact_extraction', 'server')).resolves.toMatchObject({
      capability: 'fact_extraction',
      observerScope: 'server',
      state: 'unknown',
      observedAt: null,
      failureCode: null,
    })
  })

  it('rejects untrusted fields and invalid canonical target values before persistence', async () => {
    const { store, rows } = createStore()
    const health = createModelDependencyHealthService(store)

    await expect(health.recordFailure({
      capability: 'fact extraction',
      observerScope: 'client:raw body',
      provider: 'x-api-key: secret',
      model: '{"error":"raw upstream body"}',
      code: 'not_a_canonical_failure',
      safeMessage: 'Bearer secret and arbitrary caller prose',
      retryable: false,
      failure: { code: 'fact_extraction_quota_exhausted', state: 'unhealthy' },
      observedAt: new Date('2026-07-12T10:00:00.000Z'),
    } as unknown as RecordModelDependencyFailure)).rejects.toThrow(/canonical model dependency health input/i)

    expect(rows).toEqual([])
  })

  it('rejects invalid capability, failure-code, and observer-scope combinations before persistence', async () => {
    const { store, rows } = createStore()
    const health = createModelDependencyHealthService(store)
    const observedAt = new Date('2026-07-12T10:00:00.000Z')

    for (const input of [
      {
        capability: 'fact_extraction', observerScope: 'client:51bb2e90-2cc2-49d8-b8f3-685d3e7e4f80',
        failure: { code: 'fact_extraction_quota_exhausted', state: 'unhealthy' },
      },
      {
        capability: 'fact_extraction', observerScope: 'server',
        failure: { code: 'embedding_provider_unavailable', state: 'unhealthy' },
      },
      {
        capability: 'ollama_host', observerScope: 'server', provider: 'ollama', model: 'nomic-embed-text',
        failure: { code: 'ollama_host_unavailable', state: 'unhealthy' },
      },
      {
        capability: 'embeddings', observerScope: 'client:anthropic_api_key_secret', provider: 'ollama', model: 'nomic-embed-text',
        failure: { code: 'embedding_provider_unavailable', state: 'unhealthy' },
      },
    ]) {
      await expect(health.recordFailure({ ...input, observedAt } as never)).rejects.toThrow(/canonical model dependency health input/i)
    }

    expect(rows).toEqual([])
  })
})
