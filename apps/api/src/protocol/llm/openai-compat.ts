/**
 * persistent-memory-api — OpenAI-compatible extraction-LLM backend (Phase 7).
 *
 * Serves EXTRACTION_PROVIDER=openai AND the local-Ollama test path. Ollama
 * exposes an OpenAI-compatible Chat Completions API at `${OLLAMA_URL}/v1`, so a
 * test points EXTRACTION_BASE_URL there and Ollama ignores the api key.
 *
 * Against REAL OpenAI we use strict Structured Outputs (response_format
 * json_schema, strict:true) so the verdict maps EXACTLY to the schema — no
 * prompt-coaxing or manual parsing. The local-Ollama/custom-endpoint path
 * (EXTRACTION_BASE_URL set) may not support json_schema, so it falls back to the
 * weaker json_object mode where parseVerdict()'s fence-strip is load-bearing.
 * Either way a parse failure becomes an LlmResponseError the gate maps to a 422.
 */
import OpenAI from 'openai'
import {
  type ExtractionLLM,
  type VerdictRaw,
  classifyProviderFailure,
  parseVerdict,
  LlmResponseError,
  VERDICT_SCHEMA_STRICT,
} from './client.ts'
import { recordUsageFireAndForget } from '@pm/db'

/**
 * Pick the response_format: real OpenAI (no custom base URL) gets strict
 * Structured Outputs (json_schema, strict:true); a custom endpoint (Ollama at
 * EXTRACTION_BASE_URL) may not support json_schema, so it falls back to json_object.
 * Pure + exported for unit testing.
 */
export function chooseResponseFormat(env: NodeJS.ProcessEnv): Record<string, unknown> {
  if (env.EXTRACTION_BASE_URL) return { type: 'json_object' }
  return { type: 'json_schema', json_schema: { name: 'verdict', strict: true, schema: VERDICT_SCHEMA_STRICT as unknown as Record<string, unknown> } }
}

export class OpenAICompatExtractionLLM implements ExtractionLLM {
  private readonly client: OpenAI
  private readonly model: string
  private readonly responseFormat: Record<string, unknown>

  constructor(model: string, env: NodeJS.ProcessEnv) {
    this.model = model
    this.responseFormat = chooseResponseFormat(env)
    this.client = new OpenAI({
      apiKey: env.OPENAI_API_KEY ?? 'ollama', // Ollama ignores the key
      baseURL: env.EXTRACTION_BASE_URL ?? undefined, // tests: `${OLLAMA_URL}/v1`
    })
  }

  async classify(
    systemPrompt: string,
    userJson: string,
    options?: { signal?: AbortSignal },
  ): Promise<VerdictRaw> {
    let resp: Awaited<ReturnType<typeof this.client.chat.completions.create>>
    try {
      resp = await this.client.chat.completions.create({
        model: this.model,
        response_format: this.responseFormat as unknown as Parameters<typeof this.client.chat.completions.create>[0]['response_format'],
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userJson },
        ],
      }, { signal: options?.signal })
    } catch (err) {
      if (options?.signal?.aborted) throw err
      throw classifyProviderFailure('OpenAI', this.model, err) ?? err
    }
    recordUsageFireAndForget({
      service: 'fact-extraction', model: this.model,
      tokensIn: resp.usage?.prompt_tokens ?? 0, tokensOut: resp.usage?.completion_tokens ?? 0,
    })
    const content = resp.choices[0]?.message?.content
    if (!content) {
      throw new LlmResponseError('OpenAI-compat extraction response had no content')
    }
    return parseVerdict(content) // tolerant: fence-strip fallback for Ollama
  }
}
