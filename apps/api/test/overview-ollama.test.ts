import { beforeEach, describe, expect, it, vi } from 'vitest'

const docker = vi.hoisted(() => ({
  listServices: vi.fn(),
  ollamaInfo: vi.fn(),
}))

vi.mock('../src/services/docker.ts', () => ({
  ...docker,
  DockerUnavailableError: class DockerUnavailableError extends Error {},
}))

vi.mock('@pm/db', () => ({ ownerPrisma: {}, runInTenant: vi.fn() }))
vi.mock('../src/services/scheduled.ts', () => ({ listScheduledJobs: vi.fn() }))
vi.mock('../src/services/usage.ts', () => ({ aggregateUsage: vi.fn() }))
vi.mock('../src/services/settings.ts', () => ({ getEffectiveSettings: vi.fn() }))
vi.mock('../src/services/mcp-sessions.ts', () => ({ listMcpClients: vi.fn(), pruneIdleMcpClients: vi.fn() }))

import { serviceOverview } from '../src/routes/dashboard/overview.ts'

describe('dashboard overview Ollama health', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    docker.listServices.mockResolvedValue([
      { service: 'api', name: 'api', id: 'api', state: 'running', status: 'Up', health: 'healthy', controllable: false },
    ])
  })

  it('passes the active Ollama model into the probe so a model-missing result stays unhealthy', async () => {
    docker.ollamaInfo.mockResolvedValue({
      service: 'ollama (host)', name: 'host Ollama', id: '', state: 'reachable',
      status: 'configured model missing', health: 'unhealthy', controllable: false,
    })

    const result = await serviceOverview({ activeEmbedModel: 'qwen3-embedding:4b', embeddingMode: 'server' })

    expect(docker.ollamaInfo).toHaveBeenCalledWith({ model: 'qwen3-embedding:4b', provider: 'ollama' })
    expect(result.services).toMatchObject({ total: 2, healthy: 1, active: 1, unhealthy: 1, failed: 1 })
  })

  it.each(['text-embedding-3-small', 'voyage-4'])('omits the absent optional host for API embeddings (%s)', async (activeEmbedModel) => {
    const result = await serviceOverview({ activeEmbedModel, embeddingMode: 'server' })

    expect(docker.ollamaInfo).not.toHaveBeenCalled()
    expect(result.services).toMatchObject({ total: 1, healthy: 1, unhealthy: 0, failed: 0 })
  })

  it('does not probe this server host when Ollama embeddings run on a client', async () => {
    const result = await serviceOverview({ activeEmbedModel: 'qwen3-embedding:4b', embeddingMode: 'client-bridge' })

    expect(docker.ollamaInfo).not.toHaveBeenCalled()
    expect(result.services).toMatchObject({ total: 1, healthy: 1, unhealthy: 0, failed: 0 })
  })

  it('keeps a missing required Ollama host in the failed total', async () => {
    docker.ollamaInfo.mockResolvedValue({
      service: 'ollama (host)', name: 'host Ollama', id: '', state: 'unreachable',
      status: 'host-managed', health: 'unhealthy', controllable: false,
    })

    const result = await serviceOverview({ activeEmbedModel: 'qwen3-embedding:4b', embeddingMode: 'server' })

    expect(result.services).toMatchObject({ total: 2, healthy: 1, unhealthy: 1, failed: 1 })
  })
})
