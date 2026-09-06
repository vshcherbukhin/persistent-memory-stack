import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  systemSettingsFindUnique: vi.fn(),
}))
const llm = vi.hoisted(() => ({ classify: vi.fn() }))
const health = vi.hoisted(() => ({
  recordSuccess: vi.fn(),
  recordFailure: vi.fn(),
}))

vi.mock('@pm/db', () => ({
  ownerPrisma: {
    systemSettings: { findUnique: db.systemSettingsFindUnique },
  },
}))

vi.mock('../src/services/model-dependency-health.ts', () => ({
  modelDependencyHealth: health,
}))

vi.mock('../src/protocol/llm/client.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/protocol/llm/client.ts')>()),
  makeExtractionLLM: vi.fn(async () => llm),
}))

import { LlmProviderError } from '../src/protocol/llm/client.ts'
import { FACT_EXTRACTION_TEST_PAYLOAD, testFactExtractionSettings } from '../src/services/fact-extraction.ts'
import { FACT_EXTRACTION_PROMPT } from '../src/protocol/prompt.ts'
import { testExtractionConnection } from '../../onboard/server/extraction-test.ts'

const RUNTIME_ROW = {
  factExtractionProvider: 'anthropic',
  factExtractionModel: 'claude-haiku-4-5-20251001',
  factExtractionAnthropicApiKey: 'test-key',
  factExtractionOpenaiApiKey: null,
}

describe('fact extraction capability health', () => {
  beforeEach(() => {
    db.systemSettingsFindUnique.mockReset()
    db.systemSettingsFindUnique.mockResolvedValue(RUNTIME_ROW)
    llm.classify.mockReset()
    health.recordSuccess.mockReset()
    health.recordFailure.mockReset()
    health.recordSuccess.mockResolvedValue(undefined)
    health.recordFailure.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('records canonical server health success when the Settings probe is green', async () => {
    llm.classify.mockResolvedValue({
      outcome: 'accept',
      facts: [],
      restructured_content: '',
      reason: '',
      missing: [],
    })

    const result = await testFactExtractionSettings({ model: 'claude-haiku-4-5-20251001' })

    expect(result.ok).toBe(true)
    expect(health.recordSuccess).toHaveBeenCalledWith(expect.objectContaining({
      capability: 'fact_extraction',
      observerScope: 'server',
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      observedAt: expect.any(Date),
    }))
  })

  it.each([
    ['anthropic', 'claude-haiku-4-5-20251001'],
    ['openai', 'gpt-4o'],
  ] as const)('sends the same canonical serialized sample from API and onboarding for %s', async (provider, model) => {
    const verdict = { outcome: 'accept', facts: [FACT_EXTRACTION_TEST_PAYLOAD.content], restructured_content: '', reason: '', missing: [] }
    llm.classify.mockResolvedValue(verdict)
    const apiResult = await testFactExtractionSettings({ model, apiKey: 'placeholder-test-key' }, {})
    expect(apiResult).toMatchObject({ ok: true, provider, model })
    expect(llm.classify).toHaveBeenCalledOnce()
    expect(llm.classify.mock.calls[0]?.[0]).toBe(FACT_EXTRACTION_PROMPT)
    const apiUserJson = llm.classify.mock.calls[0]?.[1]
    expect(apiUserJson).toBe(JSON.stringify(FACT_EXTRACTION_TEST_PAYLOAD))

    const calls: RequestInit[] = []
    const fakeFetch = (async (_url, init) => {
      calls.push(init ?? {})
      const body = provider === 'anthropic'
        ? { content: [{ type: 'text', text: JSON.stringify(verdict) }] }
        : { choices: [{ message: { content: JSON.stringify(verdict) } }] }
      return new Response(JSON.stringify(body), { status: 200 })
    }) as typeof fetch
    await expect(testExtractionConnection({ provider, model, apiKey: 'placeholder-test-key' }, fakeFetch))
      .resolves.toMatchObject({ ok: true, provider, model })
    expect(calls).toHaveLength(1)
    const request = JSON.parse(String(calls[0]!.body)) as { system?: string; messages: Array<{ role: string; content: string }> }
    expect(request.messages.find((message) => message.role === 'user')?.content).toBe(apiUserJson)
    expect(provider === 'anthropic' ? request.system : request.messages.find((message) => message.role === 'system')?.content).toBe(FACT_EXTRACTION_PROMPT)
  })

  it('records the canonical quota failure without returning a provider payload', async () => {
    llm.classify.mockRejectedValue(new LlmProviderError(
      'fact_extraction_quota_exhausted',
      'Fact extraction is out of tokens. The memory was not saved.',
      'Anthropic',
      'claude-haiku-4-5-20251001',
      402,
      false,
      new Error('provider payload must never surface'),
    ))

    const result = await testFactExtractionSettings({ model: 'claude-haiku-4-5-20251001' })

    expect(result).toMatchObject({
      ok: false,
      message: 'Fact extraction is out of tokens. The memory was not saved.',
    })
    expect(JSON.stringify(result)).not.toContain('provider payload must never surface')
    expect(health.recordFailure).toHaveBeenCalledWith(expect.objectContaining({
      capability: 'fact_extraction',
      observerScope: 'server',
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      failure: { code: 'fact_extraction_quota_exhausted', state: 'unhealthy' },
      observedAt: expect.any(Date),
    }))
  })

  it('maps retryable API error names to the canonical health failure code', async () => {
    llm.classify.mockRejectedValue(new LlmProviderError(
      'extraction_provider_overloaded',
      'Fact extraction provider Anthropic is overloaded while validating memory content. Retry shortly; the memory was not saved.',
      'Anthropic',
      'claude-haiku-4-5-20251001',
      529,
      true,
      new Error('provider payload must never surface'),
    ))

    const result = await testFactExtractionSettings({ model: 'claude-haiku-4-5-20251001' })

    expect(result.ok).toBe(false)
    expect(health.recordFailure).toHaveBeenCalledWith(expect.objectContaining({
      failure: { code: 'fact_extraction_provider_overloaded', state: 'degraded' },
    }))
  })

  it('returns the green Settings result when success telemetry is unavailable', async () => {
    llm.classify.mockResolvedValue({
      outcome: 'restructure',
      facts: [],
      restructured_content: 'rewritten probe',
      reason: '',
      missing: [],
    })
    health.recordSuccess.mockRejectedValueOnce(new Error('telemetry backend unavailable'))

    await expect(testFactExtractionSettings({ model: 'claude-haiku-4-5-20251001' }))
      .resolves.toMatchObject({ ok: true, outcome: 'restructure' })
  })

  it('clears the Settings deadline after a green probe settles', async () => {
    vi.useFakeTimers()
    llm.classify.mockResolvedValue({
      outcome: 'accept',
      facts: [],
      restructured_content: '',
      reason: '',
      missing: [],
    })

    await expect(testFactExtractionSettings({ model: 'claude-haiku-4-5-20251001' }))
      .resolves.toMatchObject({ ok: true })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('preserves the quota result when failure telemetry is unavailable', async () => {
    llm.classify.mockRejectedValue(new LlmProviderError(
      'fact_extraction_quota_exhausted',
      'Fact extraction is out of tokens. The memory was not saved.',
      'Anthropic',
      'claude-haiku-4-5-20251001',
      402,
      false,
      new Error('provider payload must never surface'),
    ))
    health.recordFailure.mockRejectedValueOnce(new Error('telemetry backend unavailable'))

    await expect(testFactExtractionSettings({ model: 'claude-haiku-4-5-20251001' }))
      .resolves.toMatchObject({
        ok: false,
        message: 'Fact extraction is out of tokens. The memory was not saved.',
      })
  })

  it('records a canonical failure instead of clearing health when the probe verdict rejects', async () => {
    llm.classify.mockResolvedValue({
      outcome: 'reject',
      facts: [],
      restructured_content: '',
      reason: 'probe rejected',
      missing: ['entity_quality'],
    })

    const result = await testFactExtractionSettings({ model: 'claude-haiku-4-5-20251001' })

    expect(result).toMatchObject({
      ok: false,
      outcome: 'reject',
      message: 'Connection succeeded, but the model rejected the built-in extraction sample. Retry the test.',
      reason: 'probe rejected',
      details: 'probe rejected\nMissing: entity_quality',
    })
    expect(health.recordSuccess).not.toHaveBeenCalled()
    expect(health.recordFailure).toHaveBeenCalledWith(expect.objectContaining({
      failure: { code: 'fact_extraction_probe_rejected', state: 'unhealthy' },
    }))
  })

  it.each([
    { reason: 'graph entity was not recognized', missing: [], details: 'graph entity was not recognized' },
    { reason: '', missing: ['graph_entity_in_content'], details: 'Missing: graph_entity_in_content' },
    { reason: '', missing: [], details: undefined },
  ])('retains rejection diagnostics without inventing missing fields: $details', async ({ reason, missing, details }) => {
    llm.classify.mockResolvedValue({ outcome: 'reject', facts: [], restructured_content: '', reason, missing })
    const result = await testFactExtractionSettings({ model: 'gpt-4o', apiKey: 'placeholder-test-key' }, {})
    expect(result).toMatchObject({ ok: false, outcome: 'reject', reason, details })
    expect(health.recordSuccess).not.toHaveBeenCalled()
    expect(health.recordFailure).toHaveBeenCalledWith(expect.objectContaining({
      failure: { code: 'fact_extraction_probe_rejected', state: 'unhealthy' },
    }))
  })

  it('aborts an unresponsive Settings probe and records a redacted timeout failure', async () => {
    vi.useFakeTimers()
    llm.classify.mockImplementation((_system: string, _user: string, options?: { signal?: AbortSignal }) =>
      new Promise((_, reject) => {
        options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true })
      }),
    )

    let settled = false
    const resultPromise = testFactExtractionSettings({ model: 'claude-haiku-4-5-20251001' })
      .then((result) => {
        settled = true
        return result
      })

    await vi.advanceTimersByTimeAsync(20_000)
    expect(settled).toBe(true)
    const result = await resultPromise
    expect(result).toMatchObject({ ok: false, message: 'Fact extraction test timed out.' })
    expect(health.recordFailure).toHaveBeenCalledWith(expect.objectContaining({
      capability: 'fact_extraction',
      observerScope: 'server',
      failure: { code: 'fact_extraction_timeout', state: 'degraded' },
    }))
    expect(llm.classify.mock.calls[0]?.[2]).toMatchObject({ signal: expect.any(AbortSignal) })
  })

  it('settles at the finite deadline even when the classifier ignores aborts', async () => {
    vi.useFakeTimers()
    llm.classify.mockImplementation(() => new Promise(() => undefined))

    let settled = false
    const resultPromise = testFactExtractionSettings({ model: 'claude-haiku-4-5-20251001' })
      .then((result) => {
        settled = true
        return result
      })

    await vi.advanceTimersByTimeAsync(20_000)
    expect(settled).toBe(true)
    await expect(resultPromise).resolves.toMatchObject({ ok: false, message: 'Fact extraction test timed out.' })
  })
})
