import { describe, expect, it } from 'vitest'
import { capabilityHealthPresentation } from './capabilityHealth'

it('shows starting with retry guidance even if a previous probe succeeded', () => {
  expect(capabilityHealthPresentation({
    capability: 'embeddings', observerScope: 'server', state: 'starting', provider: 'ollama', model: 'qwen3-embedding:4b',
    lastSuccessAt: '2026-10-27T00:00:00Z', firstFailureAt: null, lastFailureAt: null, failureCode: 'embeddings_starting',
    safeMessage: 'Embeddings service is still launching.', retryable: true, consecutiveFailures: 0,
    observedAt: '2026-10-28T00:00:00Z', updatedAt: '2026-10-28T00:00:00Z',
  })).toMatchObject({ badge: 'starting', tone: 'warn', recovery: 'Wait for the embedding model to become ready, then retry.' })
})

describe('capabilityHealthPresentation', () => {
  it('makes quota exhaustion a red, actionable, safe status', () => {
    expect(capabilityHealthPresentation({
      capability: 'fact_extraction',
      observerScope: 'server',
      state: 'unhealthy',
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      lastSuccessAt: null,
      firstFailureAt: '2026-07-12T12:00:00.000Z',
      lastFailureAt: '2026-07-12T12:00:00.000Z',
      failureCode: 'fact_extraction_quota_exhausted',
      safeMessage: 'Fact extraction is out of tokens. The memory was not saved.',
      retryable: false,
      consecutiveFailures: 1,
      observedAt: '2026-07-12T12:00:00.000Z',
      updatedAt: '2026-07-12T12:00:00.000Z',
    })).toEqual({
      badge: 'out of tokens',
      tone: 'bad',
      message: 'Fact extraction is out of tokens. The memory was not saved.',
      recovery: 'Add tokens or update the provider account, then run a test.',
      observedAt: '2026-07-12 12:00:00 UTC',
    })
  })

  it('keeps unknown health distinct from a healthy capability', () => {
    expect(capabilityHealthPresentation({
      capability: 'embeddings',
      observerScope: 'server',
      state: 'unknown',
      provider: null,
      model: null,
      lastSuccessAt: null,
      firstFailureAt: null,
      lastFailureAt: null,
      failureCode: null,
      safeMessage: null,
      retryable: null,
      consecutiveFailures: 0,
      observedAt: null,
      updatedAt: null,
    })).toEqual({
      badge: 'not checked',
      tone: 'warn',
      message: 'No successful request or test has reported this capability yet.',
      recovery: 'Run a test to establish health.',
      observedAt: 'not observed',
    })
  })
})
