import { describe, expect, it, vi } from 'vitest'

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
  it('passes the active Ollama model into the probe so a model-missing result stays unhealthy', async () => {
    docker.listServices.mockResolvedValue([
      { service: 'api', name: 'api', id: 'api', state: 'running', status: 'Up', health: 'healthy', controllable: false },
    ])
    docker.ollamaInfo.mockResolvedValue({
      service: 'ollama (host)', name: 'host Ollama', id: '', state: 'reachable',
      status: 'configured model missing', health: 'unhealthy', controllable: false,
    })

    const result = await serviceOverview({ model: 'qwen3-embedding:4b', provider: 'ollama' })

    expect(docker.ollamaInfo).toHaveBeenCalledWith({ model: 'qwen3-embedding:4b', provider: 'ollama' })
    expect(result.services).toMatchObject({ total: 2 })
  })
})
