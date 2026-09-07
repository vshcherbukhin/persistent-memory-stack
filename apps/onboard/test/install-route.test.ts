import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerInstallRoute } from '../server/install-route.ts'
import { registerEnvWriteRoute } from '../server/env-route.ts'
import { registerEmbeddingTestRoute } from '../server/embedding-test.ts'
import { genSecrets, renderEnv, type Answers } from '../server/env.ts'
import type { InstallContext, InstallEvent, WizardPayload } from '../server/install.ts'
import { GiB, type ResourceSnapshot } from '../shared/resource-policy.ts'

const answers: Answers = {
  deploymentMode: 'local', embeddingMode: 'server', embedProvider: 'openai',
  embedModel: 'text-embedding-3-small', embedDim: 1536,
  extractionProvider: 'openai', extractionModel: 'gpt-4o', openaiApiKey: 'synthetic-key', graphBackend: 'falkordb',
}
const disk = { path: '/test', resolvedPath: '/test', filesystemId: 'test-disk', status: 'ok' as const, totalBytes: 500 * GiB, freeBytes: 200 * GiB }
const resources: ResourceSnapshot = {
  capturedAt: '2026-09-07T00:00:00Z',
  host: { platform: 'darwin', arch: 'arm64', cpuCount: 8, totalMemoryBytes: 32 * GiB, freeMemoryBytes: 16 * GiB },
  installDisk: disk, ollamaDisk: disk, dockerHostDisk: disk,
  docker: { status: 'ok', context: 'local', cpuCount: 8, arch: 'arm64', totalMemoryBytes: 8 * GiB, storageFreeBytes: 100 * GiB },
}
const wizard: WizardPayload = {
  flow: 'full', mcpRuntime: 'stream', apiUrl: 'http://localhost:8090', ollamaUrl: 'http://localhost:11434',
  streamUrl: 'http://localhost:8091/mcp', token: '', wrapperPath: '/test/wrapper', home: '/test',
  apps: { claudeCli: false, claudeDesktop: false, codexCli: false, codexDesktop: false },
  regLevel: 'global', projectPaths: [], ruleBody: '', memoryBlock: '',
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe('installation activity and saved configuration', () => {
  const cleanup: Array<() => Promise<void>> = []
  afterEach(async () => { for (const close of cleanup.splice(0)) await close() })

  function setup() {
    const root = mkdtempSync(join(tmpdir(), 'pm-install-route-'))
    const envPath = join(root, '.env.persistent-memory')
    const original = renderEnv(answers, genSecrets())
    writeFileSync(envPath, original)
    const app = Fastify({ logger: false })
    let active = false
    const begin = () => {
      if (active) return null
      active = true
      return () => { active = false }
    }
    const readResources = vi.fn(async () => resources)
    const buildWizard = vi.fn(() => wizard)
    const run = vi.fn(async (_context: InstallContext, emit: (event: InstallEvent) => void) => { emit({ type: 'done', ok: true }) })
    const localResources = vi.fn(async (): Promise<string | null> => null)
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ embeddings: [Array(1024).fill(0.125)] })))
    registerInstallRoute(app, { root, envPath, beginInstallation: begin, readResources, buildWizard, run })
    registerEnvWriteRoute(app, envPath, { canWrite: () => !active })
    registerEmbeddingTestRoute(app, envPath, { beginTest: begin, checkLocalResources: localResources, fetchImpl: fetcher })
    cleanup.push(async () => { await app.close(); rmSync(root, { recursive: true, force: true }) })
    return {
      app, envPath, original, readResources, buildWizard, run, localResources, fetcher,
      active: () => active,
      install: () => app.inject({ method: 'POST', url: '/api/install', payload: {} }),
      test: (model = 'qwen3-embedding:0.6b', dim = 1024) => app.inject({ method: 'POST', url: '/api/embedding/test', payload: { provider: 'ollama', model, dim } }),
      save: () => app.inject({ method: 'POST', url: '/api/env', payload: { answers: { ...answers, openaiApiKey: 'replacement-key' } } }),
    }
  }

  it('locks the saved env before waiting on resources and blocks competing installs and model tests', async () => {
    const fixture = setup()
    const entered = deferred<void>()
    const releaseProbe = deferred<ResourceSnapshot>()
    fixture.readResources.mockImplementation(async () => { entered.resolve(); return releaseProbe.promise })
    const installing = fixture.install().then(result => result)
    await entered.promise
    expect(fixture.active()).toBe(true)
    expect((await fixture.save()).statusCode).toBe(409)
    expect((await fixture.test()).statusCode).toBe(409)
    expect((await fixture.install()).statusCode).toBe(409)
    expect(fixture.fetcher).not.toHaveBeenCalled()
    expect(readFileSync(fixture.envPath, 'utf8')).toBe(fixture.original)
    releaseProbe.resolve(resources)
    expect((await installing).statusCode).toBe(200)
    expect(fixture.run).toHaveBeenCalledOnce()
    expect(fixture.run.mock.calls[0]?.[0].env.OPENAI_API_KEY).toBe('synthetic-key')
    expect(fixture.active()).toBe(false)
  })

  it('holds the same lock while a model test validates resources, then releases it on denial', async () => {
    const fixture = setup()
    const entered = deferred<void>()
    const result = deferred<string | null>()
    fixture.localResources.mockImplementation(async () => { entered.resolve(); return result.promise })
    const testing = fixture.test().then(reply => reply)
    await entered.promise
    expect((await fixture.install()).statusCode).toBe(409)
    expect((await fixture.test('qwen3-embedding:4b', 2560)).statusCode).toBe(409)
    expect((await fixture.save()).statusCode).toBe(409)
    result.resolve('Not enough memory for a local model.')
    expect((await testing).json().ok).toBe(false)
    expect(fixture.fetcher).not.toHaveBeenCalled()
    expect(fixture.active()).toBe(false)
    expect((await fixture.install()).statusCode).toBe(200)
  })

  it('prevents installation and a different local model test throughout an in-flight embedding request', async () => {
    const fixture = setup()
    const entered = deferred<void>()
    const result = deferred<Response>()
    fixture.fetcher.mockImplementation(async () => { entered.resolve(); return result.promise })
    const testing = fixture.test().then(reply => reply)
    await entered.promise
    expect((await fixture.install()).statusCode).toBe(409)
    expect((await fixture.test('qwen3-embedding:4b', 2560)).statusCode).toBe(409)
    expect(fixture.fetcher).toHaveBeenCalledOnce()
    result.resolve(new Response(JSON.stringify({ embeddings: [Array(1024).fill(0.125)] })))
    expect((await testing).json().ok).toBe(true)
    expect(fixture.active()).toBe(false)
    expect((await fixture.install()).statusCode).toBe(200)
  })

  it.each(['missing-env', 'invalid-env', 'requirements', 'probe-error', 'wizard-error', 'install-error'])('releases activity after %s so a corrected retry can run', async failure => {
    const fixture = setup()
    if (failure === 'missing-env') rmSync(fixture.envPath)
    if (failure === 'invalid-env') writeFileSync(fixture.envPath, 'EMBED_PROVIDER=openai\n')
    if (failure === 'requirements') fixture.readResources.mockResolvedValue({ ...resources, host: { ...resources.host, totalMemoryBytes: 4 * GiB } })
    if (failure === 'probe-error') fixture.readResources.mockRejectedValue(new Error('resource probe unavailable'))
    if (failure === 'wizard-error') fixture.buildWizard.mockImplementation(() => { throw new Error('wizard could not be built') })
    if (failure === 'install-error') fixture.run.mockRejectedValue(new Error('synthetic install failure'))
    const failed = await fixture.install()
    const status = failure.endsWith('-env') ? 400 : failure === 'requirements' ? 422 : failure === 'install-error' ? 200 : 500
    expect(failed.statusCode).toBe(status)
    if (failure === 'install-error') expect(failed.body).toContain('"ok":false')
    expect(fixture.active()).toBe(false)
    writeFileSync(fixture.envPath, fixture.original)
    fixture.readResources.mockResolvedValue(resources)
    fixture.buildWizard.mockReturnValue(wizard)
    fixture.run.mockImplementation(async (_context, emit) => { emit({ type: 'done', ok: true }) })
    const retry = await fixture.install()
    expect(retry.statusCode).toBe(200)
    expect(retry.body).toContain('"ok":true')
    expect(fixture.active()).toBe(false)
  })
})
