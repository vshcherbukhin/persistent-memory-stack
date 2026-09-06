import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export type ExtractionProvider = 'anthropic' | 'openai'

export interface ExtractionTestInput {
  provider: ExtractionProvider
  model: string
  apiKey: string
}

export interface ExtractionTestResult {
  ok: boolean
  provider: ExtractionProvider
  model: string
  message: string
  details?: string
  outcome?: 'accept' | 'restructure' | 'reject'
  reason?: string
}

interface VerdictRaw {
  outcome: 'accept' | 'restructure' | 'reject'
  facts: string[]
  restructured_content: string
  reason: string
  missing: string[]
  suggestion?: string
  confidence?: number
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    outcome: { type: 'string', enum: ['accept', 'restructure', 'reject'] },
    facts: { type: 'array', items: { type: 'string' } },
    restructured_content: { type: 'string' },
    reason: { type: 'string' },
    missing: { type: 'array', items: { type: 'string' } },
    suggestion: { type: 'string' },
    confidence: { type: 'number' },
  },
  required: ['outcome', 'facts', 'restructured_content', 'reason', 'missing'],
  additionalProperties: false,
} as const

const VERDICT_SCHEMA_STRICT = {
  type: 'object',
  properties: {
    outcome: { type: 'string', enum: ['accept', 'restructure', 'reject'] },
    facts: { type: 'array', items: { type: 'string' } },
    restructured_content: { type: 'string' },
    reason: { type: 'string' },
    missing: { type: 'array', items: { type: 'string' } },
    suggestion: { type: ['string', 'null'] },
    confidence: { type: ['number', 'null'] },
  },
  required: ['outcome', 'facts', 'restructured_content', 'reason', 'missing', 'suggestion', 'confidence'],
  additionalProperties: false,
} as const

// Use the first accepted example from fact-extraction.md §8. The probe is
// ordinary memory content, not an instruction asking the model to accept it.
const FACT_EXTRACTION_TEST_PAYLOAD = {
  content:
    "[component_floating_overlay] Clicks are intercepted after opening a dropdown. Root cause: overlay not dismissed after selection. Fix: dismiss via page.getByTestId('FloatingOverlay').click(). Prevention: all DS Dropdown callers must dismiss overlay after selectOption.",
  metadata: {
    category: 'gotcha',
    entities: ['component_floating_overlay'],
    source: 'heal-cycle',
  },
} as const

const here = dirname(fileURLToPath(import.meta.url))
const promptCandidates = [
  resolve(here, '../../../prompts/fact-extraction.md'),
  process.env.FACT_EXTRACTION_PROMPT_FILE ? resolve(process.env.FACT_EXTRACTION_PROMPT_FILE) : '',
].filter(Boolean)
let promptCache: string | null = null

function factExtractionPrompt(): string {
  if (promptCache) return promptCache
  for (const candidate of promptCandidates) {
    if (existsSync(candidate)) {
      promptCache = readFileSync(candidate, 'utf8')
      return promptCache
    }
  }
  throw new Error(`fact-extraction.md not found; checked ${promptCandidates.join(', ')}`)
}

function providerLabel(provider: ExtractionProvider): string {
  return provider === 'anthropic' ? 'Anthropic' : 'OpenAI'
}

function normalizeProvider(provider: unknown): ExtractionProvider {
  return provider === 'openai' ? 'openai' : 'anthropic'
}

function isAnthropicOat(token: string): boolean {
  return token.includes('sk-ant-oat')
}

function requestFor(input: ExtractionTestInput): { url: string; init: RequestInit } {
  const systemPrompt = factExtractionPrompt()
  const userJson = JSON.stringify(FACT_EXTRACTION_TEST_PAYLOAD)
  if (input.provider === 'anthropic') {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
    }
    if (isAnthropicOat(input.apiKey)) {
      headers.authorization = `Bearer ${input.apiKey}`
      headers['anthropic-beta'] = 'oauth-2025-04-20'
    } else {
      headers['x-api-key'] = input.apiKey
    }
    return {
      url: 'https://api.anthropic.com/v1/messages',
      init: {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: input.model,
          max_tokens: 1024,
          system: systemPrompt,
          messages: [{ role: 'user', content: userJson }],
          output_config: { format: { type: 'json_schema', schema: VERDICT_SCHEMA } },
        }),
      },
    }
  }
  return {
    url: 'https://api.openai.com/v1/chat/completions',
    init: {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${input.apiKey}`,
      },
      body: JSON.stringify({
        model: input.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userJson },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'verdict', strict: true, schema: VERDICT_SCHEMA_STRICT },
        },
      }),
    },
  }
}

function parseVerdict(raw: string): VerdictRaw {
  let text = raw.trim()
  if (text.startsWith('```')) {
    text = text.replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```\s*$/, '').trim()
  }
  const obj = JSON.parse(text) as Record<string, unknown>
  const outcome = obj.outcome
  if (outcome !== 'accept' && outcome !== 'restructure' && outcome !== 'reject') {
    throw new Error(`extraction LLM returned unknown outcome: ${String(outcome)}`)
  }
  return {
    outcome,
    facts: Array.isArray(obj.facts) ? obj.facts.map(String) : [],
    restructured_content: typeof obj.restructured_content === 'string' ? obj.restructured_content : '',
    reason: typeof obj.reason === 'string' ? obj.reason : '',
    missing: Array.isArray(obj.missing) ? obj.missing.map(String) : [],
    suggestion: typeof obj.suggestion === 'string' && obj.suggestion ? obj.suggestion : undefined,
    confidence: typeof obj.confidence === 'number' && Number.isFinite(obj.confidence)
      ? Math.min(1, Math.max(0, obj.confidence))
      : undefined,
  }
}

function verdictText(provider: ExtractionProvider, json: unknown): string {
  const response = json as Record<string, unknown>
  if (provider === 'anthropic') {
    const content = response.content
    if (Array.isArray(content)) {
      const textBlock = content.find((item) => {
        const block = item as Record<string, unknown>
        return block.type === 'text' && typeof block.text === 'string'
      }) as Record<string, unknown> | undefined
      if (typeof textBlock?.text === 'string') return textBlock.text
    }
    throw new Error('Anthropic extraction response had no text block.')
  }
  const choices = response.choices
  if (Array.isArray(choices)) {
    const first = choices[0] as Record<string, unknown> | undefined
    const message = first?.message as Record<string, unknown> | undefined
    if (typeof message?.content === 'string') return message.content
  }
  throw new Error('OpenAI extraction response had no message content.')
}

export async function testExtractionConnection(
  rawInput: Partial<ExtractionTestInput>,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 15_000,
): Promise<ExtractionTestResult> {
  const provider = normalizeProvider(rawInput.provider)
  const model = rawInput.model?.trim() || (provider === 'anthropic' ? 'claude-haiku-4-5-20251001' : 'gpt-4o')
  const apiKey = rawInput.apiKey?.trim() ?? ''
  if (!apiKey) {
    return {
      ok: false,
      provider,
      model,
      message: `${providerLabel(provider)} API key is missing.`,
      details: 'Enter the matching API key before testing fact extraction.',
    }
  }

  try {
    const req = requestFor({ provider, model, apiKey })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let res: Response
    try {
      res = await fetchImpl(req.url, { ...req.init, signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) {
      const details = await res.text().then((text) => text.slice(0, 600)).catch(() => '')
      return {
        ok: false,
        provider,
        model,
        message: `Fact extraction test failed with HTTP ${res.status}.`,
        details: details || `${providerLabel(provider)} rejected the probe request.`,
      }
    }
    const verdict = parseVerdict(verdictText(provider, await res.json()))
    if (verdict.outcome === 'reject') {
      return {
        ok: false,
        provider,
        model,
        message: 'Connection succeeded, but the model rejected the built-in extraction sample. Retry the test.',
        outcome: verdict.outcome,
        reason: verdict.reason,
        details: [verdict.reason, verdict.missing.length ? `Missing: ${verdict.missing.join(', ')}` : ''].filter(Boolean).join('\n') || undefined,
      }
    }
    return {
      ok: true,
      provider,
      model,
      message: `Fact extraction test passed with ${model}.`,
      outcome: verdict.outcome,
      reason: verdict.reason,
    }
  } catch (err) {
    return {
      ok: false,
      provider,
      model,
      message: 'Fact extraction test failed.',
      details: err instanceof Error ? err.message : String(err),
    }
  }
}
