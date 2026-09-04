/**
 * persistent-memory-api — Anthropic extraction-LLM backend (Phase 7).
 *
 * One Messages API call per write, using STRUCTURED OUTPUTS
 * (output_config.format json_schema) so the verdict is guaranteed-parseable on the
 * configured model (claude-sonnet-4-6 default) — the upgrade over the Python
 * fence-strip. parseVerdict() is still applied as a belt-and-suspenders normalizer.
 *
 * TOKEN MODEL — server-mode, NOT mem0's laptop OAT chain. This runs as a Docker
 * service on the QA VM: it reads ANTHROPIC_API_KEY from the shared .env. We do
 * NOT port resolve_token()/Keychain/credentials.json/CLAUDE_CODE_OAUTH_TOKEN —
 * those are laptop affordances; the `security` binary is absent in a container
 * and porting them is a security smell. BUT ANTHROPIC_API_KEY may hold EITHER a
 * standard API key (sk-ant-api03…, → x-api-key) OR a long-lived `claude setup-token`
 * OAT (sk-ant-oat01…, → OAuth Bearer) — the same credential mem0 uses. isOat()
 * routes to the Bearer path for the latter (see the apiKey:null note below).
 */
import Anthropic from '@anthropic-ai/sdk'
import {
  type ExtractionLLM,
  type VerdictRaw,
  VERDICT_SCHEMA,
  classifyProviderFailure,
  parseVerdict,
  LlmResponseError,
} from './client.ts'
import { recordUsageFireAndForget } from '@pm/db'

/** OAT detection — dev affordance only (see file header). */
function isOat(token: string): boolean {
  return token.includes('sk-ant-oat')
}

export class AnthropicExtractionLLM implements ExtractionLLM {
  private readonly client: Anthropic
  private readonly model: string

  constructor(model: string, env: NodeJS.ProcessEnv) {
    this.model = model
    const token = env.ANTHROPIC_API_KEY ?? ''
    if (!token) {
      throw new Error(
        'EXTRACTION_PROVIDER=anthropic requires ANTHROPIC_API_KEY in the shared .env ' +
          '(server-mode token resolution — no Keychain/OAT chain in the container).',
      )
    }
    // maxRetries: the SDK retries 429/5xx with exponential backoff and RESPECTS the
    // Retry-After / anthropic-ratelimit-*-reset headers, so transient rate limits
    // (e.g. a `claude setup-token` OAT contended by an active Claude Code session)
    // ride out the per-minute window instead of surfacing as a 500 on every write.
    const maxRetries = 6
    this.client = isOat(token)
      ? new Anthropic({
          // A `claude setup-token` OAT (long-lived) authenticates ONLY via Bearer
          // + the oauth beta header. apiKey:null is LOAD-BEARING: the SDK otherwise
          // auto-reads process.env.ANTHROPIC_API_KEY and sends it as x-api-key even
          // when authToken is set → "401 invalid x-api-key". Suppress that here.
          apiKey: null,
          authToken: token,
          maxRetries,
          defaultHeaders: {
            'anthropic-beta': 'oauth-2025-04-20',
            'anthropic-dangerous-direct-browser-access': 'true',
          },
        })
      : new Anthropic({ apiKey: token, maxRetries })
  }

  async classify(
    systemPrompt: string,
    userJson: string,
    options?: { signal?: AbortSignal },
  ): Promise<VerdictRaw> {
    let resp: Anthropic.Message
    try {
      resp = await this.client.messages.create({
        model: this.model,
        max_tokens: 1024,
        system: systemPrompt, // fact-extraction.md
        messages: [{ role: 'user', content: userJson }],
        // Guaranteed-parseable JSON (structured outputs). additionalProperties:false
        // + the five required keys pin the verdict shape (VERDICT_SCHEMA).
        output_config: { format: { type: 'json_schema', schema: VERDICT_SCHEMA } },
      } as Anthropic.MessageCreateParamsNonStreaming, { signal: options?.signal })
    } catch (err) {
      if (options?.signal?.aborted) throw err
      throw classifyProviderFailure('Anthropic', this.model, err) ?? err
    }

    recordUsageFireAndForget({
      service: 'fact-extraction', model: this.model,
      tokensIn: resp.usage.input_tokens, tokensOut: resp.usage.output_tokens,
    })
    const textBlock = resp.content.find((b) => b.type === 'text')
    if (!textBlock || textBlock.type !== 'text') {
      throw new LlmResponseError('Anthropic extraction response had no text block')
    }
    // structured outputs guarantee the first text block is valid JSON; the
    // tolerant parse is the belt-and-suspenders normalizer.
    return parseVerdict(textBlock.text)
  }
}
