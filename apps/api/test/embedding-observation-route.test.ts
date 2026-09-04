import { describe, expect, it } from 'vitest'
import { clientEmbeddingHealthTarget } from '../src/routes/embedding-health.ts'

describe('client-managed embedding health observations', () => {
  it('derives the observer scope from the authenticated user instead of accepting one from an MCP client', () => {
    expect(clientEmbeddingHealthTarget(
      { userId: '51bb2e90-2cc2-49d8-b8f3-685d3e7e4f80' },
      { provider: 'ollama', model: 'qwen3-embedding:4b' },
    )).toEqual({
      observerScope: 'client:51bb2e90-2cc2-49d8-b8f3-685d3e7e4f80',
      provider: 'ollama',
      model: 'qwen3-embedding:4b',
    })
  })
})
