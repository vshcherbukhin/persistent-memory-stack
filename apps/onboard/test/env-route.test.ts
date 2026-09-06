import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHmac } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { registerEnvWriteRoute } from '../server/env-route.ts'
import { parseEnvFile } from '../server/install.ts'
import type { Answers } from '../server/env.ts'

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
  afterEach(async () => { for (const close of cleanup.splice(0)) await close() })

  function setup(initial?: string) {
    const root = mkdtempSync(join(tmpdir(), 'pm-env-route-'))
    const envPath = join(root, '.env.persistent-memory')
    if (initial !== undefined) writeFileSync(envPath, initial)
    const app = Fastify({ logger: false })
    registerEnvWriteRoute(app, envPath)
    cleanup.push(async () => { await app.close(); rmSync(root, { recursive: true, force: true }) })
    return {
      read: () => parseEnvFile(readFileSync(envPath, 'utf8')),
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

    for (const embedModel of ['second-test-model', 'third-test-model']) {
      const response = await fixture.save({ ...answers, embedModel, openaiApiKey: '' })
      expect(response.statusCode).toBe(200)
      expect(response.json().issues).toEqual([])
      const saved = fixture.read()
      for (const key of secretKeys) expect(saved[key], key).toBe(first[key])
      expect(signSession(saved.TOKEN_PEPPER!)).toBe(savedSessionSignature)
      expect(saved.DATABASE_URL).toContain(`:${first.PM_APP_PASSWORD}@`)
      expect(saved.DATABASE_MIGRATE_URL).toContain(`:${first.POSTGRES_PASSWORD}@`)
      expect(saved.EMBED_MODEL).toBe(embedModel)
      expect(saved.OPENAI_API_KEY).toBe(answers.openaiApiKey)
      expect(response.json().preview).not.toContain(first.TOKEN_PEPPER)
    }
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
})
