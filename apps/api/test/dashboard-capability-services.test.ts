import { beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'

vi.mock('../src/authz/guards.ts', () => ({ requireSuperuser: vi.fn() }))
vi.mock('../src/services/docker.ts', () => ({
  DockerUnavailableError: class DockerUnavailableError extends Error {},
  actOnService: vi.fn(),
  listServices: vi.fn(),
  ollamaInfo: vi.fn(),
  serviceLogs: vi.fn(),
  terminateMcpService: vi.fn(),
}))
vi.mock('../src/services/mcp-sessions.ts', () => ({ listMcpClients: vi.fn(), pruneIdleMcpClients: vi.fn(), terminateMcpClient: vi.fn() }))
vi.mock('../src/services/settings.ts', () => ({ getEffectiveSettings: vi.fn() }))
vi.mock('../src/services/dashboard-capability-health.ts', () => ({ getDashboardCapabilityHealth: vi.fn() }))

import { dashboardServiceRoutes, dependencyHealthToServiceRows } from '../src/routes/dashboard/services.ts'
import { listServices, ollamaInfo } from '../src/services/docker.ts'
import { getEffectiveSettings } from '../src/services/settings.ts'
import { getDashboardCapabilityHealth } from '../src/services/dashboard-capability-health.ts'
import { listMcpClients } from '../src/services/mcp-sessions.ts'

const health = {
  factExtraction: {
    capability: 'fact_extraction' as const, observerScope: 'server', state: 'healthy' as const,
    provider: 'anthropic' as const, model: 'claude-haiku-4-5-20251001', lastSuccessAt: new Date(),
    firstFailureAt: null, lastFailureAt: null, failureCode: null, safeMessage: null,
    retryable: null, consecutiveFailures: 0, observedAt: new Date(), updatedAt: new Date(),
  },
  embeddings: {
    capability: 'embeddings' as const, observerScope: 'server', state: 'unknown' as const,
    provider: null, model: null, lastSuccessAt: null, firstFailureAt: null, lastFailureAt: null,
    failureCode: null, safeMessage: null, retryable: null, consecutiveFailures: 0, observedAt: null, updatedAt: null,
  },
  ollamaHost: {
    capability: 'ollama_host' as const, observerScope: 'host', state: 'healthy' as const,
    provider: 'ollama' as const, model: 'qwen3-embedding:4b', lastSuccessAt: new Date(),
    firstFailureAt: null, lastFailureAt: null, failureCode: null, safeMessage: null,
    retryable: null, consecutiveFailures: 0, observedAt: new Date(), updatedAt: new Date(),
  },
}

describe('logical dependency service rows', () => {
  it('uses truthful detail when healthy and when no observation exists', () => {
    const [factExtraction, embeddings] = dependencyHealthToServiceRows(health, {
      activeEmbedModel: 'text-embedding-3-small', factExtraction: { model: 'claude-haiku-4-5-20251001' },
    })

    expect(factExtraction).toMatchObject({
      service: 'fact-extraction', health: 'healthy', status: 'Latest request or test succeeded.',
      configuredModel: 'claude-haiku-4-5-20251001',
    })
    expect(embeddings).toMatchObject({
      service: 'embeddings', health: null, state: 'unknown', status: 'Not observed yet. Run a test to establish health.',
      configuredModel: 'text-embedding-3-small',
    })
  })
})

describe('dashboard service list Ollama dependency', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(listServices).mockResolvedValue([
      { service: 'api', name: 'api', id: 'api', state: 'running', status: 'Up', health: 'healthy', controllable: false },
    ])
    vi.mocked(getDashboardCapabilityHealth).mockResolvedValue(health)
    vi.mocked(listMcpClients).mockReturnValue([])
  })

  async function servicesFor(activeEmbedModel: string, embeddingMode: 'server' | 'client-bridge' = 'server') {
    vi.mocked(getEffectiveSettings).mockResolvedValue({
      activeEmbedModel, embeddingMode, mcpSessionIdleTimeoutSeconds: 900,
      factExtraction: { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
    } as Awaited<ReturnType<typeof getEffectiveSettings>>)
    const app = Fastify()
    app.setValidatorCompiler(validatorCompiler)
    app.setSerializerCompiler(serializerCompiler)
    app.addHook('onRequest', (req, _reply, done) => {
      req.identity = {
        userId: '11111111-1111-4111-8111-111111111111',
        teamId: '22222222-2222-4222-8222-222222222222',
        adminLevel: 'none', isTeamMember: true, isTeamAdmin: false,
        isGlobalSuperuser: false, mountedTeamIds: [], insideTenantTx: false,
      }
      done()
    })
    await app.register(dashboardServiceRoutes)
    try {
      const result = await app.inject({ method: 'GET', url: '/services' })
      expect(result.statusCode).toBe(200)
      return result.json() as { services: Array<{ service: string; health: string | null }> }
    } finally {
      await app.close()
    }
  }

  it.each(['text-embedding-3-small', 'voyage-4'])('omits the optional host row and probe for API embeddings (%s)', async (model) => {
    const result = await servicesFor(model)

    expect(ollamaInfo).not.toHaveBeenCalled()
    expect(result.services.map((row) => row.service)).toEqual(['api', 'fact-extraction', 'embeddings'])
  })

  it('does not monitor this host for client-managed Ollama embeddings', async () => {
    const result = await servicesFor('qwen3-embedding:4b', 'client-bridge')

    expect(ollamaInfo).not.toHaveBeenCalled()
    expect(result.services.map((row) => row.service)).not.toContain('ollama (host)')
  })

  it('keeps the required host failure visible for local Ollama embeddings', async () => {
    vi.mocked(ollamaInfo).mockResolvedValue({
      service: 'ollama (host)', name: 'host Ollama', id: '', state: 'unreachable',
      status: 'host-managed', health: 'unhealthy', controllable: false, logsAvailable: false,
    })

    const result = await servicesFor('qwen3-embedding:4b')

    expect(ollamaInfo).toHaveBeenCalledWith({ provider: 'ollama', model: 'qwen3-embedding:4b' })
    expect(result.services.find((row) => row.service === 'ollama (host)')).toMatchObject({ health: 'unhealthy' })
  })
})
