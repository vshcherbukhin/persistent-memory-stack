import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EMBEDDING_MODELS, validateEmbeddingSelection } from '../server/embedding-config.ts'
import { registerEmbeddingTestRoute, testEmbeddingConnection } from '../server/embedding-test.ts'
import { MODEL_REGISTRY } from '../../../packages/shared/src/embeddings/registry.ts'
import { genSecrets, renderEnv, validateEnvForDeploy, type Answers } from '../server/env.ts'
import { parseEnvFile } from '../server/install.ts'

const openai = { provider: 'openai' as const, model: 'text-embedding-3-small', dim: 1536, apiKey: 'test-only-key' }
const vector = (dim: number) => Array.from({ length: dim }, () => 0.125)
const response = (dim: number) => new Response(JSON.stringify({ data: [{ index: 0, embedding: vector(dim) }] }))

describe('installer embedding catalog', () => {
  it('stays aligned with the runtime model/provider/dimension registry', () => {
    expect(Object.keys(EMBEDDING_MODELS).sort()).toEqual(Object.keys(MODEL_REGISTRY).sort())
    for (const [model, spec] of Object.entries(EMBEDDING_MODELS)) {
      expect(spec).toEqual({ provider: MODEL_REGISTRY[model]!.provider, nativeDim: MODEL_REGISTRY[model]!.nativeDim,
        ...(MODEL_REGISTRY[model]!.supportedDims ? { supportedDims: MODEL_REGISTRY[model]!.supportedDims } : {}) })
    }
    expect(validateEmbeddingSelection({ ...openai, dim: 1.5 })).toMatch(/dimensions/)
    expect(validateEmbeddingSelection({ ...openai, model: 'qwen3-embedding:4b' })).toMatch(/provider/)
  })

  it.each([
    { provider: 'openai' as const, model: 'text-embedding-3-small', dim: 1536, key: 'OPENAI_API_KEY' },
    { provider: 'voyage' as const, model: 'voyage-3-large', dim: 1024, key: 'VOYAGE_API_KEY' },
  ])('validates $provider installs without requiring an Ollama endpoint', ({ provider, model, dim, key }) => {
    const answers: Answers = { embeddingMode: 'server', embedProvider: provider, embedModel: model, embedDim: dim,
      extractionProvider: 'anthropic', extractionModel: 'claude-haiku-4-5-20251001', anthropicApiKey: 'synthetic-anthropic-key',
      openaiApiKey: 'synthetic-openai-key', voyageApiKey: 'synthetic-voyage-key', graphBackend: 'falkordb' }
    const env = parseEnvFile(renderEnv(answers, genSecrets()))
    delete env.OLLAMA_URL
    expect(validateEnvForDeploy(env)).toEqual([])
    delete env[key]
    expect(validateEnvForDeploy(env)).toEqual(expect.arrayContaining([{ key, message: `${key} is required before deployment.` }]))
  })
})

describe('embedding connection probe', () => {
  it('calls OpenAI with one synthetic string, the chosen dimensions, and no private user data', async () => {
    const fetcher = vi.fn(async () => response(1536))
    expect((await testEmbeddingConnection(openai, fetcher)).ok).toBe(true)
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.openai.com/v1/embeddings')
    expect(JSON.parse(init.body as string)).toEqual({ model: openai.model, input: ['Persistent Memory embedding connection check.'], encoding_format: 'float', dimensions: 1536 })
    expect(init.headers).toMatchObject({ authorization: 'Bearer test-only-key' })
    expect(init.redirect).toBe('error')
  })

  it('uses Voyage input_type and output_dimension', async () => {
    const fetcher = vi.fn(async () => response(1024))
    expect((await testEmbeddingConnection({ ...openai, provider: 'voyage', model: 'voyage-3-large', dim: 1024 }, fetcher)).ok).toBe(true)
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.voyageai.com/v1/embeddings')
    expect(JSON.parse(init.body as string)).toMatchObject({ input_type: 'document', output_dimension: 1024 })
  })
  it.each(['voyage-4', 'voyage-4-large', 'voyage-4-lite'])('probes current Voyage model %s with supported dimensions', async model => {
    const fetcher = vi.fn(async () => response(2048))
    expect((await testEmbeddingConnection({ ...openai, provider: 'voyage', model, dim: 2048 }, fetcher)).ok).toBe(true)
  })

  it('unloads a local probe model instead of keeping its RAM allocated', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ embeddings: [vector(1024)] })))
    expect((await testEmbeddingConnection({ provider: 'ollama', model: 'qwen3-embedding:0.6b', dim: 1024 }, fetcher)).ok).toBe(true)
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:11434/api/embed')
    expect(JSON.parse(init.body as string)).toMatchObject({ keep_alive: 0 })
  })

  it.each([401, 403, 429, 503])('reports HTTP %s without leaking a provider body/key', async status => {
    const result = await testEmbeddingConnection(openai, async () => new Response(`Your key is ${openai.apiKey}`, { status }))
    expect(result.ok).toBe(false)
    expect(result.message).toContain(String(status))
    expect(JSON.stringify(result)).not.toContain(openai.apiKey)
  })

  it('explains missing request permission separately from the project model allowlist', async () => {
    const result = await testEmbeddingConnection(openai, async () => new Response(JSON.stringify({ error: {
      message: `You have insufficient permissions. Missing scopes: model.request. Key ${openai.apiKey}`, type: 'invalid_request_error',
    } }), { status: 403 }))
    expect(result.details).toContain('missing model.request permission')
    expect(result.details).toContain('/v1/embeddings')
    expect(result.details).toContain('allowlist alone is not enough')
    expect(JSON.stringify(result)).not.toContain(openai.apiKey)
  })

  it.each([
    [401, 'invalid_api_key', 'could not authenticate'],
    [403, 'unsupported_country_region_territory', 'unsupported country or region'],
    [401, 'ip_not_authorized', 'IP allowlist restriction'],
    [404, 'model_not_found', 'model is unavailable or not accessible'],
    [429, 'credit_balance_exhausted', 'billing, spend or usage limit'],
  ])('classifies HTTP %s / %s without reflecting provider fields', async (status, code, hint) => {
    const result = await testEmbeddingConnection(openai, async () => new Response(JSON.stringify({ error: { code, message: openai.apiKey } }), { status: Number(status) }))
    expect(result.details).toContain(hint)
    expect(JSON.stringify(result)).not.toContain(openai.apiKey)
  })

  it.each([null, { error: null }, { error: { message: {}, code: ['invalid_api_key'] } }, { error: { message: openai.apiKey, code: openai.apiKey } }])('handles an unknown 403 without declaring the key invalid or echoing fields', async payload => {
    const result = await testEmbeddingConnection(openai, async () => new Response(JSON.stringify(payload), { status: 403 }))
    expect(result.details).toContain('OpenAI denied this embedding request')
    expect(result.details).toContain('Model capabilities')
    expect(JSON.stringify(result)).not.toContain(openai.apiKey)
  })

  it('does not apply OpenAI-specific scopes to Voyage failures', async () => {
    const result = await testEmbeddingConnection({ ...openai, provider: 'voyage', model: 'voyage-4', dim: 1024 }, async () => new Response(JSON.stringify({ error: { message: 'Missing scopes: model.request' } }), { status: 403 }))
    expect(result.details).toContain('provider denied')
    expect(result.details).not.toContain('OpenAI')
  })

  it('preserves HTTP rejection when an error body exceeds the byte limit', async () => {
    const result = await testEmbeddingConnection(openai, async () => new Response(openai.apiKey.repeat(30_000), { status: 403 }))
    expect(result.message).toContain('HTTP 403')
    expect(JSON.stringify(result)).not.toContain(openai.apiKey)
  })

  it('preserves HTTP rejection when its error body stalls until the deadline', async () => {
    const result = await testEmbeddingConnection(openai, async () => new Response(new ReadableStream({ start() {} }), { status: 403 }), 20)
    expect(result.message).toContain('HTTP 403')
    expect(result.ok).toBe(false)
  })

  it('rejects wrong-sized, nonnumeric, null and all-zero vectors', async () => {
    for (const embedding of [vector(10), [null, ...vector(1535)], ['1', ...vector(1535)], Array(1536).fill(0)]) {
      const result = await testEmbeddingConnection(openai, async () => new Response(JSON.stringify({ data: [{ index: 0, embedding }] })))
      expect(result.ok).toBe(false)
      expect(result.message).toContain('invalid embedding vector')
    }
  })

  it('rejects unknown models and missing keys without making an API call', async () => {
    const fetcher = vi.fn()
    expect((await testEmbeddingConnection({ ...openai, model: 'invented' }, fetcher)).ok).toBe(false)
    expect((await testEmbeddingConnection({ ...openai, apiKey: '' }, fetcher)).ok).toBe(false)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('bounds the response body and does not echo malformed provider content', async () => {
    const result = await testEmbeddingConnection(openai, async () => new Response('x'.repeat(256 * 1024 + 1)))
    expect(result.ok).toBe(false)
    expect(JSON.stringify(result).length).toBeLessThan(500)
  })

  it('bounds response-body reads as well as the initial connection', async () => {
    const result = await testEmbeddingConnection(openai, async () => new Response(new ReadableStream({ start() {} })), 20)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('timed out')
  })

  it('never returns transport exceptions that may contain authorization secrets', async () => {
    const result = await testEmbeddingConnection(openai, async () => { throw new Error(`connection ${openai.apiKey}`) })
    expect(JSON.stringify(result)).not.toContain(openai.apiKey)
  })
})

describe('embedding test route', () => {
  const cleanup: Array<() => Promise<void>> = []
  afterEach(async () => { for (const close of cleanup.splice(0)) await close() })

  function setup(checkLocalResources?: () => Promise<string | null>, savedOllamaUrl?: string) {
    const root = mkdtempSync(join(tmpdir(), 'pm-embedding-test-'))
    const envPath = join(root, '.env.persistent-memory')
    writeFileSync(envPath, "OPENAI_API_KEY='saved-key' # dotenv comment\n" + (savedOllamaUrl ? `OLLAMA_URL=${savedOllamaUrl}\n` : ''))
    const app = Fastify({ logger: false })
    const fetcher = vi.fn(async () => response(1536))
    registerEmbeddingTestRoute(app, envPath, { fetchImpl: fetcher, checkLocalResources })
    cleanup.push(async () => { await app.close(); rmSync(root, { recursive: true, force: true }) })
    return { app, fetcher }
  }

  it('uses a saved dotenv key without sending the key back to the browser', async () => {
    const { app, fetcher } = setup()
    const result = await app.inject({ method: 'POST', url: '/api/embedding/test', payload: { ...openai, apiKey: '' } })
    expect(result.json().ok).toBe(true)
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.headers).toMatchObject({ authorization: 'Bearer saved-key' })
    expect(result.body).not.toContain('saved-key')
  })

  it('uses the newly entered key instead of a previous saved key', async () => {
    const { app, fetcher } = setup()
    const result = await app.inject({ method: 'POST', url: '/api/embedding/test', payload: { ...openai, apiKey: '  replacement-key  ' } })
    expect(result.json().ok).toBe(true)
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.headers).toMatchObject({ authorization: 'Bearer replacement-key' })
    expect(result.body).not.toContain('replacement-key')
  })

  it('does not use a saved OpenAI key for a Voyage request', async () => {
    const { app, fetcher } = setup()
    const result = await app.inject({ method: 'POST', url: '/api/embedding/test', payload: { provider: 'voyage', model: 'voyage-4', dim: 1024 } })
    expect(result.json().ok).toBe(false)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('uses a saved custom local Ollama port and ignores browser-supplied URLs', async () => {
    const { app, fetcher } = setup(async () => null, 'http://host.docker.internal:22434')
    fetcher.mockImplementation(async () => new Response(JSON.stringify({ embeddings: [vector(1024)] })))
    const result = await app.inject({ method: 'POST', url: '/api/embedding/test', payload: {
      provider: 'ollama', model: 'qwen3-embedding:0.6b', dim: 1024, ollamaUrl: 'https://untrusted.example',
    } })
    expect(result.json().ok).toBe(true)
    const [url] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:22434/api/embed')
  })

  it.each(['http://untrusted.example:11434', 'http://user:password@localhost:11434', 'file:///tmp/ollama'])('does not probe an unsafe saved Ollama endpoint %s', async endpoint => {
    const { app, fetcher } = setup(async () => null, endpoint)
    const result = await app.inject({ method: 'POST', url: '/api/embedding/test', payload: { provider: 'ollama', model: 'qwen3-embedding:0.6b', dim: 1024 } })
    expect(result.json().ok).toBe(false)
    expect(result.body).not.toContain('password')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each([undefined, async () => 'Local embeddings are unavailable on this machine.'])('never loads a local model without passing resource checks', async callback => {
    const { app, fetcher } = setup(callback)
    const result = await app.inject({ method: 'POST', url: '/api/embedding/test', payload: { provider: 'ollama', model: 'qwen3-embedding:4b', dim: 2560 } })
    expect(result.json().ok).toBe(false)
    expect(fetcher).not.toHaveBeenCalled()
  })
})
