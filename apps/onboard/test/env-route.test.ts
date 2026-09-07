import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHmac } from 'node:crypto'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerEnvWriteRoute, type EnvWriteRouteOptions } from '../server/env-route.ts'
import { parseEnvFile } from '../server/install.ts'
import type { Answers } from '../server/env.ts'

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof fs>()
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) }
})

const secretKeys = [
  'TOKEN_PEPPER', 'POSTGRES_PASSWORD', 'PM_APP_PASSWORD', 'MINIO_ROOT_PASSWORD',
  'FALKORDB_PASSWORD', 'QDRANT_API_KEY', 'DOCKER_CONTROL_TOKEN', 'UPDATE_RUNNER_TOKEN', 'USAGE_INGEST_TOKEN',
] as const
const answers: Answers = {
  deploymentMode: 'local', embeddingMode: 'server', embedProvider: 'ollama',
  embedModel: 'qwen3-embedding:4b', embedDim: 2560, extractionProvider: 'openai',
  extractionModel: 'gpt-4o', openaiApiKey: 'placeholder-provider-key', graphBackend: 'falkordb',
}

describe('POST /api/env secret preservation', () => {
  const cleanup: Array<() => Promise<void>> = []
  afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0)) await close() })

  function setup(initial?: string, options: EnvWriteRouteOptions = {}) {
    const root = mkdtempSync(join(tmpdir(), 'pm-env-route-'))
    const envPath = join(root, '.env.persistent-memory')
    if (initial !== undefined) writeFileSync(envPath, initial)
    const app = Fastify({ logger: false })
    registerEnvWriteRoute(app, envPath, options)
    cleanup.push(async () => { await app.close(); rmSync(root, { recursive: true, force: true }) })
    return {
      read: () => parseEnvFile(readFileSync(envPath, 'utf8')),
      markInstalled: () => {
        mkdirSync(join(root, '.local', 'install-artifacts'), { recursive: true })
        writeFileSync(join(root, '.local', 'install-artifacts', 'success.json'), JSON.stringify({ version: 1, embedding: { provider: 'ollama', model: answers.embedModel, dimension: answers.embedDim } }))
      },
      save: (next: Answers = answers) => app.inject({ method: 'POST', url: '/api/env', payload: { answers: next } }),
    }
  }

  it('keeps all generated credentials and a signed session valid over repeated configuration saves', async () => {
    const fixture = setup()
    expect((await fixture.save()).json().issues).toEqual([])
    const first = fixture.read()
    for (const key of secretKeys) expect(first[key]!.length).toBeGreaterThan(20)
    const signSession = (pepper: string) => createHmac('sha256', pepper).update('test-session-payload').digest('base64url')
    const savedSessionSignature = signSession(first.TOKEN_PEPPER!)

    for (const semaphoreLimit of [1, 2]) {
      const response = await fixture.save({ ...answers, semaphoreLimit, openaiApiKey: '' })
      expect(response.statusCode).toBe(200)
      expect(response.json().issues).toEqual([])
      const saved = fixture.read()
      for (const key of secretKeys) expect(saved[key], key).toBe(first[key])
      expect(signSession(saved.TOKEN_PEPPER!)).toBe(savedSessionSignature)
      expect(saved.DATABASE_URL).toContain(`:${first.PM_APP_PASSWORD}@`)
      expect(saved.DATABASE_MIGRATE_URL).toContain(`:${first.POSTGRES_PASSWORD}@`)
      expect(saved.SEMAPHORE_LIMIT).toBe(String(semaphoreLimit))
      expect(saved.OPENAI_API_KEY).toBe(answers.openaiApiKey)
      expect(response.json().preview).not.toContain(first.TOKEN_PEPPER)
    }
  })

  it('does not overwrite a working env with an invalid provider/model/dimension combination', async () => {
    const fixture = setup()
    await fixture.save()
    const before = fixture.read()
    const result = await fixture.save({ ...answers, embedProvider: 'openai' })
    expect(result.statusCode).toBe(422)
    expect(fixture.read()).toEqual(before)
  })

  it('does not save configuration while an installation is running', async () => {
    const readInstalledPin = vi.fn(async () => null)
    const fixture = setup('OPENAI_API_KEY=preserved-key\n', { readInstalledPin, canWrite: () => false })
    const before = fixture.read()
    const response = await fixture.save()
    expect(response.statusCode).toBe(409)
    expect(response.json().error).toBe('installation_active')
    expect(readInstalledPin).not.toHaveBeenCalled()
    expect(fixture.read()).toEqual(before)
  })

  it('rechecks installation activity after the asynchronous stored-data probe', async () => {
    let active = false
    const fixture = setup('OPENAI_API_KEY=preserved-key\n', {
      canWrite: () => !active,
      readInstalledPin: async () => { active = true; return null },
    })
    const before = fixture.read()
    const response = await fixture.save()
    expect(response.statusCode).toBe(409)
    expect(response.json().error).toBe('installation_active')
    expect(fixture.read()).toEqual(before)
  })

  it('keeps the previous env intact when disk exhaustion prevents the replacement write', async () => {
    const fixture = setup()
    await fixture.save()
    const before = fixture.read()
    const { writeFileSync: write } = await vi.importActual<typeof fs>('node:fs')
    vi.mocked(fs.writeFileSync).mockImplementation((file, data, options) => {
      if (String(file).endsWith('.tmp')) throw Object.assign(new Error('No space left on device'), { code: 'ENOSPC' })
      return write(file, data, options)
    })
    try {
      const result = await fixture.save({ ...answers, semaphoreLimit: 1 })
      expect(result.statusCode).toBe(500)
      expect(fixture.read()).toEqual(before)
    } finally { vi.mocked(fs.writeFileSync).mockImplementation(write) }
  })

  it('allows a failed-install draft to change from local to remote embeddings without Ollama', async () => {
    const fixture = setup()
    await fixture.save()
    const before = fixture.read()
    const result = await fixture.save({ ...answers, embedProvider: 'openai', embedModel: 'text-embedding-3-small', embedDim: 1536 })
    expect(result.statusCode).toBe(200)
    expect(fixture.read().EMBED_PROVIDER).toBe('openai')
    expect(fixture.read().TOKEN_PEPPER).toBe(before.TOKEN_PEPPER)
  })

  it('requires an embedding migration when a completed installation uses a different vector pin', async () => {
    const fixture = setup()
    await fixture.save()
    fixture.markInstalled()
    const before = fixture.read()
    const result = await fixture.save({ ...answers, embedProvider: 'openai', embedModel: 'text-embedding-3-small', embedDim: 1536 })
    expect(result.statusCode).toBe(409)
    expect(result.json().error).toBe('embedding_migration_required')
    expect(fixture.read()).toEqual(before)
  })

  it('keeps an unchanged configuration repairable while a legacy database is stopped', async () => {
    const readInstalledPin = vi.fn(async () => { throw new Error('database unavailable') })
    const fixture = setup('EMBED_PROVIDER=ollama\nEMBED_MODEL=qwen3-embedding:4b\nEMBED_DIM=2560\n', { readInstalledPin })
    expect((await fixture.save()).statusCode).toBe(200)
    expect(readInstalledPin).not.toHaveBeenCalled()
    const before = fixture.read()
    expect((await fixture.save({ ...answers, embedProvider: 'openai', embedModel: 'text-embedding-3-small', embedDim: 1536 })).statusCode).toBe(409)
    expect(fixture.read()).toEqual(before)
  })

  it('preserves a saved quoted pepper expression and fills missing service secrets once', async () => {
    const storedPepper = "'saved-pepper-with-#-literal' # retain this value"
    const fixture = setup(`TOKEN_PEPPER=${storedPepper}\nPOSTGRES_PASSWORD=saved-db-password\nUPDATE_RUNNER_TOKEN=\n`)
    expect((await fixture.save()).statusCode).toBe(200)
    const first = fixture.read()
    expect(first.TOKEN_PEPPER).toBe(storedPepper)
    expect(first.POSTGRES_PASSWORD).toBe('saved-db-password')
    for (const key of secretKeys.filter(key => key !== 'TOKEN_PEPPER' && key !== 'POSTGRES_PASSWORD')) {
      expect(first[key]!.length).toBeGreaterThan(20)
    }
    expect((await fixture.save()).statusCode).toBe(200)
    const second = fixture.read()
    for (const key of secretKeys) expect(second[key], key).toBe(first[key])
  })
  it('preserves operator volume/container identity, paths, ports and load tuning', async () => {
    const settings = { PM_VOLUME_PREFIX: 'existing_personal', PM_CONTAINER_PREFIX: 'existing-personal', COMPOSE_PROJECT_NAME: 'existing-personal',
      PM_NETWORK_NAME: 'existing_network', PM_DASHBOARD_PORT: '13200', PM_API_PORT: '18090',
      PM_RUNTIME_ROOT: '"C:/Memory Data/runtime"', PM_COORDINATOR_STATE_DIR: '"C:/Memory Data/state"',
      EMBED_BATCH_SIZE: '1', WORKER_CONCURRENCY: '1' }
    const fixture = setup(Object.entries(settings).map(([key, value]) => `${key}=${value}`).join('\n'))
    expect((await fixture.save()).statusCode).toBe(200)
    expect(fixture.read()).toMatchObject(settings)
    expect((await fixture.save()).statusCode).toBe(200)
    expect(fixture.read()).toMatchObject(settings)
  })
})
