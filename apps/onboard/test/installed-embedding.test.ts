import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readInstalledEmbeddingPin } from '../server/installed-embedding.ts'
import { EMBEDDING_CORPUS_TABLES } from '../../../layers/core/schema/embedding-corpus.ts'

describe('legacy installed embedding pin guard', () => {
  const roots: string[] = []
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true }) })
  const setup = () => {
    const root = mkdtempSync(join(tmpdir(), 'pm-installed-pin-')); roots.push(root)
    const envPath = join(root, '.env.persistent-memory')
    writeFileSync(envPath, 'PM_VOLUME_PREFIX=test_memory\nPM_CONTAINER_PREFIX=test-memory\nPOSTGRES_USER=pmuser\nPOSTGRES_DB=persistent_memory\n')
    return { root, envPath }
  }
  const mounted = JSON.stringify({ running: true, service: 'postgres', mounts: [{ Type: 'volume', Name: 'test_memory_postgres_data', Destination: '/var/lib/postgresql/data' }] })
  function responses(hasData: boolean) {
    return vi.fn().mockResolvedValueOnce('test_memory_postgres_data\ntest_memory_qdrant_data').mockResolvedValueOnce(mounted)
      .mockResolvedValueOnce(JSON.stringify([...EMBEDDING_CORPUS_TABLES, 'system_settings']))
      .mockResolvedValueOnce(JSON.stringify({ hasData, model: 'qwen3-embedding:4b', dim: 2560 }))
  }
  it('allows a fresh draft with no installation data volumes', async () => {
    const { root, envPath } = setup()
    const run = vi.fn(async () => 'another_app_volume')
    expect(await readInstalledEmbeddingPin(root, envPath, run)).toBeNull()
    expect(run).toHaveBeenCalledTimes(1)
  })
  it('reads a legacy corpus pin without relying on a completion marker or env default', async () => {
    const { root, envPath } = setup(); const run = responses(true)
    expect(await readInstalledEmbeddingPin(root, envPath, run)).toEqual({ provider: 'ollama', model: 'qwen3-embedding:4b', dim: 2560 })
    for (const call of run.mock.calls.filter(call => call[0][0] === 'exec')) {
      expect(call[0].at(-1)).toContain('BEGIN READ ONLY')
      expect(call[0].at(-1)).toContain('statement_timeout')
      expect(call[0]).not.toContain('PGPASSWORD')
    }
  })
  it('allows an empty draft DB to be reconciled later by transactional bootstrap', async () => {
    const { root, envPath } = setup()
    expect(await readInstalledEmbeddingPin(root, envPath, responses(false))).toBeNull()
  })
  it('fails closed on stopped or unrelated postgres instead of inferring an empty corpus', async () => {
    const { root, envPath } = setup()
    for (const state of [{ running: false }, { running: true, service: 'postgres', mounts: [] }]) {
      const run = vi.fn().mockResolvedValueOnce('test_memory_postgres_data').mockResolvedValueOnce(JSON.stringify(state))
      await expect(readInstalledEmbeddingPin(root, envPath, run)).rejects.toThrow(/Start or recover/)
      expect(run).toHaveBeenCalledTimes(2)
    }
  })
  it('fails closed when only graph/vector storage remains', async () => {
    const { root, envPath } = setup()
    await expect(readInstalledEmbeddingPin(root, envPath, vi.fn(async () => 'test_memory_qdrant_data'))).rejects.toThrow(/could not be checked/)
  })
  it('does not classify a partial schema as empty', async () => {
    const { root, envPath } = setup()
    const run = vi.fn().mockResolvedValueOnce('test_memory_postgres_data').mockResolvedValueOnce(mounted)
      .mockResolvedValueOnce(JSON.stringify(['system_settings', 'memory']))
    await expect(readInstalledEmbeddingPin(root, envPath, run)).rejects.toThrow(/could not be checked/)
  })
  it('does not reveal a failed command stderr or credentials', async () => {
    const { root, envPath } = setup()
    await expect(readInstalledEmbeddingPin(root, envPath, vi.fn(async () => { throw new Error('secret-test-credential') }))).rejects.toThrow(/Existing memory storage/)
  })
})
