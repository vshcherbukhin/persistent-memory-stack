import { describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.ts'
import { LlmProviderError } from '../src/protocol/llm/client.ts'

describe('fact extraction provider API errors', () => {
  it('returns a non-retryable 503 for quota exhaustion', async () => {
    const app = buildApp()
    app.get('/test/fact-extraction-quota', async () => {
      throw new LlmProviderError(
        'fact_extraction_quota_exhausted',
        'Fact extraction is out of tokens. The memory was not saved.',
        'Anthropic',
        'claude-haiku-4-5-20251001',
        402,
        false,
        new Error('redacted upstream payload'),
      )
    })

    try {
      const response = await app.inject({ method: 'GET', url: '/test/fact-extraction-quota' })
      expect(response.statusCode).toBe(503)
      expect(response.json()).toEqual({
        error: 'fact_extraction_quota_exhausted',
        message: 'Fact extraction is out of tokens. The memory was not saved.',
        provider: 'Anthropic',
        model: 'claude-haiku-4-5-20251001',
        retryable: false,
      })
    } finally {
      await app.close()
    }
  })
})
