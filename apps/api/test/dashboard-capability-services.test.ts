import { describe, expect, it, vi } from 'vitest'

vi.mock('@pm/shared', () => ({ MODEL_REGISTRY: {} }))
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

import { dependencyHealthToServiceRows } from '../src/routes/dashboard/services.ts'

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
    const [factExtraction, embeddings] = dependencyHealthToServiceRows(health)

    expect(factExtraction).toMatchObject({
      service: 'fact-extraction', health: 'healthy', status: 'Latest request or test succeeded.',
    })
    expect(embeddings).toMatchObject({
      service: 'embeddings', health: null, status: 'Not observed yet. Run a test to establish health.',
    })
  })
})
