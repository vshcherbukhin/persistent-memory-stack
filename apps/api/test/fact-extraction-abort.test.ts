import { describe, expect, it, vi } from 'vitest'

vi.mock('@pm/db', () => ({ recordUsageFireAndForget: vi.fn() }))

import { OpenAICompatExtractionLLM } from '../src/protocol/llm/openai-compat.ts'
import { AnthropicExtractionLLM } from '../src/protocol/llm/anthropic.ts'

describe('OpenAI fact-extraction cancellation', () => {
  it('passes the abort signal to the provider and preserves its cancellation error', async () => {
    const llm = new OpenAICompatExtractionLLM('gpt-4o', { OPENAI_API_KEY: 'test-key' } as NodeJS.ProcessEnv)
    const providerAbort = Object.assign(new Error('request cancelled'), { name: 'AbortError' })
    const create = vi.fn().mockRejectedValue(providerAbort)
    Object.defineProperty(llm, 'client', {
      value: { chat: { completions: { create } } },
    })
    const controller = new AbortController()
    controller.abort(providerAbort)

    await expect(llm.classify('system', '{"content":"probe"}', { signal: controller.signal }))
      .rejects.toBe(providerAbort)
    expect(create).toHaveBeenCalledWith(expect.any(Object), { signal: controller.signal })
  })
})

describe('Anthropic fact-extraction cancellation', () => {
  it('passes the abort signal to the provider and preserves its cancellation error', async () => {
    const llm = new AnthropicExtractionLLM('claude-haiku-4-5-20251001', {
      ANTHROPIC_API_KEY: 'test-key',
    } as NodeJS.ProcessEnv)
    const providerAbort = Object.assign(new Error('request cancelled'), { name: 'AbortError' })
    const create = vi.fn().mockRejectedValue(providerAbort)
    Object.defineProperty(llm, 'client', {
      value: { messages: { create } },
    })
    const controller = new AbortController()
    controller.abort(providerAbort)

    await expect(llm.classify('system', '{"content":"probe"}', { signal: controller.signal }))
      .rejects.toBe(providerAbort)
    expect(create).toHaveBeenCalledWith(expect.any(Object), { signal: controller.signal })
  })
})
