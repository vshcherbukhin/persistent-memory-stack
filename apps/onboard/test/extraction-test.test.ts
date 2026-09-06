import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { testExtractionConnection, type ExtractionProvider } from '../server/extraction-test'

const prompt = readFileSync(new URL('../../../prompts/fact-extraction.md', import.meta.url), 'utf8')
const examples = [...prompt.matchAll(/Input:\r?\n([^\r\n]+)\r?\nOutput:\r?\n([^\r\n]+)/g)]
  .map((match) => ({ input: JSON.parse(match[1]!), output: JSON.parse(match[2]!) }))
const acceptedExample = examples.find((example) => example.output.outcome === 'accept')!

function responseFor(provider: ExtractionProvider, verdict: Record<string, unknown>): Response {
  const text = JSON.stringify(verdict)
  const body = provider === 'openai'
    ? { choices: [{ message: { content: text } }] }
    : { content: [{ type: 'text', text }] }
  return new Response(JSON.stringify(body), { status: 200 })
}

describe.each(['openai', 'anthropic'] as const)('%s extraction sample', (provider) => {
  it('sends the canonical accepted example with complete shape and exact entity metadata', async () => {
    let requests = 0
    const fakeFetch = (async (_url, init) => {
      requests++
      const body = JSON.parse(String(init?.body))
      const system = provider === 'openai' ? body.messages[0].content : body.system
      const user = body.messages.find((message: { role: string }) => message.role === 'user').content
      const sample = JSON.parse(user)
      expect(system).toBe(prompt)
      expect(sample).toEqual(acceptedExample.input)
      expect(sample.content.length).toBeGreaterThanOrEqual(40)
      expect(sample.metadata.entities.some((entity: string) => sample.content.includes(entity))).toBe(true)
      for (const marker of ['Root cause:', 'Fix:', 'Prevention:']) expect(sample.content).toContain(marker)
      return responseFor(provider, acceptedExample.output)
    }) as typeof fetch

    expect(await testExtractionConnection({ provider, apiKey: 'placeholder-test-key' }, fakeFetch))
      .toMatchObject({ ok: true, outcome: 'accept' })
    expect(requests).toBe(1)
  })

  it('keeps a model rejection blocked and explains that the connection succeeded', async () => {
    let requests = 0
    const fakeFetch = (async () => {
      requests++
      return responseFor(provider, {
        outcome: 'reject', facts: [], restructured_content: '',
        reason: 'The model could not match the entity.', missing: ['graph_entity_in_content'],
      })
    }) as typeof fetch

    const result = await testExtractionConnection({ provider, apiKey: 'placeholder-test-key' }, fakeFetch)
    expect(result).toMatchObject({
      ok: false, outcome: 'reject',
      message: 'Connection succeeded, but the model rejected the built-in extraction sample. Retry the test.',
      reason: 'The model could not match the entity.',
      details: 'The model could not match the entity.\nMissing: graph_entity_in_content',
    })
    expect(requests).toBe(1)
  })

  it('keeps provider authentication failures distinct from sample rejection', async () => {
    const fakeFetch = (async () => new Response('Invalid authentication', { status: 401 })) as typeof fetch
    const result = await testExtractionConnection({ provider, apiKey: 'placeholder-test-key' }, fakeFetch)
    expect(result).toMatchObject({ ok: false, message: 'Fact extraction test failed with HTTP 401.' })
    expect(result).not.toHaveProperty('outcome')
  })
})
