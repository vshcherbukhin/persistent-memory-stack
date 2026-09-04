/**
 * The api's Docker client (services/docker.ts) is now a thin HTTP client to the
 * docker-control sidecar — the parsers moved there. This covers what the api owns:
 * the security-relevant FAILURE MAPPING (no token / unreachable / non-2xx all →
 * DockerUnavailableError → 503) plus the happy path, and the host-Ollama probe.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// config validates the full env at import; mock it to the two values we exercise.
vi.mock('../src/config.ts', () => ({
  config: {
    DOCKER_CONTROL_URL: 'http://docker-control:9090',
    DOCKER_CONTROL_TOKEN: 'secret-token',
    OLLAMA_URL: 'http://host.docker.internal:11434',
    MINIO_ROOT_USER: 'test',
    MINIO_ROOT_PASSWORD: 'test',
    QDRANT_API_KEY: 'qdrant-secret',
    FALKORDB_PASSWORD: 'falkor-secret',
  },
}))

const health = vi.hoisted(() => ({
  recordSuccess: vi.fn(),
  recordFailure: vi.fn(),
}))

vi.mock('../src/services/model-dependency-health.ts', () => ({
  modelDependencyHealth: health,
}))

import {
  listServices,
  serviceLogs,
  actOnService,
  terminateMcpService,
  ollamaInfo,
  DockerUnavailableError,
} from '../src/services/docker.ts'

const okJson = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

afterEach(() => vi.unstubAllGlobals())

describe('docker client — happy path forwards to the sidecar with the bearer', () => {
  it('listServices returns the services array and presents the token', async () => {
    const fetchMock = vi.fn(async () => okJson({ services: [{ service: 'api' }] }))
    vi.stubGlobal('fetch', fetchMock)
    const rows = await listServices()
    expect(rows).toEqual([{ service: 'api' }])
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('http://docker-control:9090/services')
    expect((init as RequestInit).headers).toMatchObject({ authorization: 'Bearer secret-token' })
  })

  it('serviceLogs + actOnService hit the right method/path', async () => {
    const fetchMock = vi.fn(async (_u: string, init: RequestInit) =>
      init.method === 'POST' ? okJson({ ok: true }) : okJson({ logs: 'hello' }),
    )
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)
    expect(await serviceLogs('api', 50)).toBe('hello')
    expect(fetchMock.mock.calls[0]![0]).toContain('/services/api/logs?tail=50')
    expect(await actOnService('api', 'restart')).toEqual({ ok: true })
    expect(fetchMock.mock.calls[1]![0]).toContain('/services/api/restart')
    expect((fetchMock.mock.calls[1]![1] as RequestInit).method).toBe('POST')
  })

  it('terminateMcpService hits the separate MCP termination path', async () => {
    const fetchMock = vi.fn(async () => okJson({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)

    expect(await terminateMcpService('abcdef123456')).toEqual({ ok: true })

    expect(fetchMock.mock.calls[0]![0]).toBe('http://docker-control:9090/services/abcdef123456/terminate')
    expect((fetchMock.mock.calls[0]![1] as RequestInit).method).toBe('POST')
  })

  it('adds UI links and includes credentials only when requested', async () => {
    const fetchMock = vi.fn(async () =>
      okJson({
        services: [
          { service: 'qdrant', name: 'persistent-memory-qdrant', id: 'q', state: 'running', status: 'Up', health: null },
          { service: 'falkordb', name: 'persistent-memory-falkordb', id: 'f', state: 'running', status: 'Up', health: null },
          { service: 'minio', name: 'persistent-memory-minio', id: 'm', state: 'running', status: 'Up', health: null },
        ],
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const publicRows = await listServices()
    expect(publicRows.find((s) => s.service === 'qdrant')?.ui).toEqual({
      label: 'Dashboard',
      url: 'http://localhost:7333/dashboard',
    })
    expect(publicRows.find((s) => s.service === 'qdrant')?.credentials).toBeUndefined()
    expect(publicRows.find((s) => s.service === 'falkordb')?.credentials).toBeUndefined()
    expect(publicRows.find((s) => s.service === 'minio')?.credentials).toBeUndefined()

    const adminRows = await listServices({ includeCredentials: true })
    expect(adminRows.find((s) => s.service === 'qdrant')?.credentials).toEqual([
      { label: 'API key', value: 'qdrant-secret' },
    ])
    expect(adminRows.find((s) => s.service === 'falkordb')?.credentials).toEqual([
      { label: 'User', value: 'default' },
      { label: 'Password', value: 'falkor-secret' },
    ])
    expect(adminRows.find((s) => s.service === 'minio')?.credentials).toEqual([
      { label: 'User', value: 'test' },
      { label: 'Password', value: 'test' },
    ])
  })
})

describe('docker client — every failure maps to DockerUnavailableError', () => {
  it('non-2xx from the sidecar', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })))
    await expect(listServices()).rejects.toBeInstanceOf(DockerUnavailableError)
  })
  it('network/throw (sidecar unreachable)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }))
    await expect(listServices()).rejects.toMatchObject({ code: 'docker_unavailable', statusCode: 503 })
  })
})

describe('ollamaInfo — host probe, never throws', () => {
  beforeEach(() => {
    health.recordSuccess.mockReset()
    health.recordFailure.mockReset()
    health.recordSuccess.mockResolvedValue(undefined)
    health.recordFailure.mockResolvedValue(undefined)
  })

  it('parses tags, confirms the configured model, and explicitly marks host logs unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ models: [{ name: 'qwen3-embedding:4b' }] }), { status: 200 })))

    expect(await ollamaInfo({ model: 'qwen3-embedding:4b', provider: 'ollama' })).toMatchObject({
      state: 'reachable',
      health: 'healthy',
      configuredModel: 'qwen3-embedding:4b',
      configuredModelState: 'present',
      logsAvailable: false,
    })
    expect(health.recordSuccess).toHaveBeenCalledWith(expect.objectContaining({
      capability: 'ollama_host', observerScope: 'host', provider: 'ollama', model: 'qwen3-embedding:4b',
    }))
  })

  it('is unhealthy when Ollama is reachable but the configured Ollama model is absent', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ models: [{ name: 'nomic-embed-text:latest' }] }), { status: 200 })))

    expect(await ollamaInfo({ model: 'qwen3-embedding:4b', provider: 'ollama' })).toMatchObject({
      state: 'reachable', health: 'unhealthy', configuredModelState: 'missing', logsAvailable: false,
    })
    expect(health.recordFailure).toHaveBeenCalledWith(expect.objectContaining({
      capability: 'ollama_host', observerScope: 'host',
      failure: { code: 'ollama_model_unavailable', state: 'unhealthy' },
    }))
  })
  it('treats malformed tag payloads as an unavailable host probe, not a missing configured model', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{not-json', { status: 200 })))

    expect(await ollamaInfo({ model: 'qwen3-embedding:4b', provider: 'ollama' })).toMatchObject({
      state: 'unreachable', health: 'unhealthy', logsAvailable: false,
    })
    expect(health.recordFailure).toHaveBeenCalledWith(expect.objectContaining({
      capability: 'ollama_host', observerScope: 'host',
      failure: { code: 'ollama_host_unavailable', state: 'unhealthy' },
    }))
  })
  it.each([
    ['an object without models', {}],
    ['a non-array models field', { models: {} }],
  ])('treats valid JSON with %s as an unavailable host probe', async (_label, payload) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })))

    expect(await ollamaInfo({ model: 'qwen3-embedding:4b', provider: 'ollama' })).toMatchObject({
      state: 'unreachable', health: 'unhealthy', logsAvailable: false,
    })
    expect(health.recordFailure).toHaveBeenCalledWith(expect.objectContaining({
      capability: 'ollama_host', observerScope: 'host',
      failure: { code: 'ollama_host_unavailable', state: 'unhealthy' },
    }))
    expect(health.recordFailure).not.toHaveBeenCalledWith(expect.objectContaining({
      failure: { code: 'ollama_model_unavailable', state: 'unhealthy' },
    }))
  })
  it('unreachable when fetch rejects', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down') }))
    expect(await ollamaInfo({ model: 'qwen3-embedding:4b', provider: 'ollama' })).toMatchObject({ state: 'unreachable', health: 'unhealthy', logsAvailable: false })
    expect(health.recordFailure).toHaveBeenCalledWith(expect.objectContaining({
      capability: 'ollama_host', observerScope: 'host',
      failure: { code: 'ollama_host_unavailable', state: 'unhealthy' },
    }))
  })
})
