/**
 * Embedding usage sink — estimateTokens (pure) + the DI sink (set/emit/no-op/swallow).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { setEmbedUsageSink, emitEmbedUsage, estimateTokens } from '../src/embeddings/usage-sink.ts'

afterEach(() => setEmbedUsageSink(null))

describe('estimateTokens', () => {
  it('ceil(Σlen/4); empty → 0', () => {
    expect(estimateTokens([])).toBe(0)
    expect(estimateTokens(['abcd'])).toBe(1)
    expect(estimateTokens(['abcde'])).toBe(2) // 5/4 → ceil 2
    expect(estimateTokens(['ab', 'cde'])).toBe(2) // total 5 → 2
  })
})

describe('emitEmbedUsage / setEmbedUsageSink', () => {
  it('is a no-op when no sink is set (never throws)', () => {
    expect(() => emitEmbedUsage({ provider: 'ollama', model: 'm', tokens: 5 })).not.toThrow()
  })
  it('forwards to a set sink', () => {
    const sink = vi.fn()
    setEmbedUsageSink(sink)
    emitEmbedUsage({ provider: 'openai', model: 'm', tokens: 7 })
    expect(sink).toHaveBeenCalledWith({ provider: 'openai', model: 'm', tokens: 7 })
  })
  it('swallows a throwing sink (never breaks embedding)', () => {
    setEmbedUsageSink(() => { throw new Error('bad sink') })
    expect(() => emitEmbedUsage({ provider: 'voyage', model: 'm', tokens: 1 })).not.toThrow()
  })
})
