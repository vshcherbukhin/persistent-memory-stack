import { existsSync, readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import type { FastifyInstance } from 'fastify'
import { EMBEDDING_MODELS, validateEmbeddingSelection, type EmbeddingSelection } from './embedding-config.js'

export interface EmbeddingTestInput extends EmbeddingSelection { apiKey?: string }
export interface EmbeddingTestResult {
  ok: boolean
  provider: string
  model: string
  dim: number
  message: string
  details?: string
}
const PROBE_TEXT = 'Persistent Memory embedding connection check.'
const MAX_RESPONSE_BYTES = 256 * 1024

function localProbeUrl(savedBaseUrl = 'http://127.0.0.1:11434'): string | null {
  try {
    const url = new URL(savedBaseUrl)
    if (url.hostname === 'host.docker.internal') url.hostname = '127.0.0.1'
    if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash) return null
    url.pathname = `${url.pathname.replace(/\/$/, '')}/api/embed`
    return url.toString()
  } catch { return null }
}

/** Classify bounded provider data into our own text. Never echo its message,
 * arbitrary codes or transport errors: they may contain credentials. */
function httpFailure(status: number, provider: string, payload?: unknown): string {
  const error = payload && typeof payload === 'object' && 'error' in payload ? payload.error : null
  const fields = error && typeof error === 'object' ? error as Record<string, unknown> : {}
  const code = typeof fields.code === 'string' ? fields.code : ''
  const message = typeof fields.message === 'string' ? fields.message.slice(0, 8192).toLowerCase() : ''
  if (provider === 'openai') {
    if ([401, 403].includes(status) && (code === 'unsupported_country_region_territory' || /country,? region|unsupported (country|region|territory)/.test(message))) {
      return 'OpenAI reports that this request comes from an unsupported country or region. Check the network location and OpenAI supported countries; changing the model allowlist will not resolve this.'
    }
    if ([401, 403].includes(status) && (code === 'ip_not_authorized' || /ip.*(not authorized|not allowed|allowlist)/.test(message))) {
      return 'OpenAI reports an IP allowlist restriction. Check that this computer\'s network is permitted by the OpenAI project or organization.'
    }
    if (status === 403 && /missing scopes?:[^\n]*\b(?:api\.)?model\.request\b/.test(message)) {
      return 'OpenAI reports a missing model.request permission. In the API key\'s project, allow Model capabilities → Request for the key and its user or service account. Embeddings need request access to /v1/embeddings; adding models to the project allowlist alone is not enough. Retest after the permission change takes effect.'
    }
    if ([403, 404].includes(status) && (code === 'model_not_found' || /(?:access to|allowed to (?:use|access)) (?:this |the )?model/.test(message))) {
      return 'OpenAI reports that the selected model is unavailable or not accessible to this key. Check the model allowlist in the project that owns this API key and its Model capabilities → Request permission, then retest.'
    }
    if (status === 401) return 'OpenAI could not authenticate this API key. Use an OpenAI Platform API key from the intended project, then test again.'
    if (status === 403) return 'OpenAI denied this embedding request. Check Model capabilities → Request permission for this API key and its user or service account, as well as the project model allowlist. Model access alone does not grant request permission. If those are correct, check project IP restrictions and the network location.'
    if (status === 429 && ['insufficient_quota', 'credit_balance_exhausted', 'organization_spend_limit_exceeded', 'project_spend_limit_exceeded', 'organization_usage_limit_exceeded'].includes(code)) {
      return 'OpenAI reports an API billing, spend or usage limit. Check API credits and the project/organization limits before retrying; changing model permissions will not resolve this.'
    }
  }
  if (status === 401) return 'The provider could not authenticate this API key. Check that it belongs to the selected embedding provider.'
  if (status === 403) return 'The provider denied this embedding request. Check the API key permissions, model access and account restrictions.'
  if (status === 429) return 'The provider rate limit or account quota was reached. Check API billing/quota, then retry.'
  if (status === 404) return 'The embedding model is unavailable. For Ollama, download the selected model first.'
  return 'The provider could not complete the embedding request. Retry after checking the provider service.'
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('empty response')
  const reader = response.body.getReader()
  let bytes = 0
  const chunks: Uint8Array[] = []
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) throw new Error('oversized response')
      chunks.push(value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } finally { await reader.cancel().catch(() => {}) }
}

/** One fixed, small synthetic input. Never reads memories or accepts a user URL. */
export async function testEmbeddingConnection(
  raw: Partial<EmbeddingTestInput>,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 15_000,
  savedOllamaUrl?: string,
): Promise<EmbeddingTestResult> {
  const base = { provider: String(raw.provider ?? ''), model: String(raw.model ?? ''), dim: Number(raw.dim) }
  const fail = (message: string, details?: string): EmbeddingTestResult => ({ ...base, ok: false, message, ...(details ? { details } : {}) })
  const issue = validateEmbeddingSelection(raw)
  if (issue) return fail(issue)
  const input = raw as EmbeddingTestInput
  const key = typeof input.apiKey === 'string' ? input.apiKey.trim() : ''
  if (input.provider !== 'ollama' && !key) return fail('Enter the embedding provider API key before testing.')
  if (/[\r\n]/.test(key)) return fail('The API key must be a single line.')
  const local = input.provider === 'ollama'
  const url = local ? localProbeUrl(savedOllamaUrl) : input.provider === 'openai'
    ? 'https://api.openai.com/v1/embeddings' : 'https://api.voyageai.com/v1/embeddings'
  if (!url) return fail('The saved Ollama endpoint must use a local loopback address without URL credentials. Check OLLAMA_URL before testing.')
  const body: Record<string, unknown> = { model: input.model, input: [PROBE_TEXT] }
  if (local) {
    body.truncate = true
    body.keep_alive = 0 // Release test-only model RAM immediately after the probe.
    if (input.dim !== EMBEDDING_MODELS[input.model]!.nativeDim) body.dimensions = input.dim
  } else if (input.provider === 'openai') {
    body.encoding_format = 'float'
    body.dimensions = input.dim
  } else {
    body.input_type = 'document'
    body.output_dimension = input.dim
    body.truncation = true
  }
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')) }, timeoutMs)
  })
  let failureStatus: number | undefined
  try {
    const operation = async (): Promise<EmbeddingTestResult> => {
      const response = await fetchImpl(url, {
        method: 'POST', signal: controller.signal, redirect: 'error',
        headers: { 'content-type': 'application/json', ...(!local ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify(body),
      })
      if (!response.ok) {
        failureStatus = response.status
        const error = await readBoundedJson(response).catch(() => undefined)
        return fail(`Embedding test failed with HTTP ${response.status}.`, httpFailure(response.status, input.provider, error))
      }
      const json = await readBoundedJson(response) as { embeddings?: unknown[]; data?: Array<{ index?: number; embedding?: unknown }> }
      const vector = local ? json.embeddings?.length === 1 ? json.embeddings[0] : null
        : json.data?.length === 1 && json.data[0]?.index === 0 ? json.data[0].embedding : null
      if (!Array.isArray(vector) || vector.length !== input.dim || !vector.every(value => typeof value === 'number' && Number.isFinite(value)) || !vector.some(value => value !== 0)) {
        return fail('The provider returned an invalid embedding vector.', `Expected one finite, nonzero ${input.dim}-dimension vector. Check the selected model and dimensions.`)
      }
      return { ...base, ok: true, message: `Embedding test passed with ${input.model} (${input.dim} dimensions).` }
    }
    return await Promise.race([operation(), timeout])
  } catch {
    // Keep the known rejection if its diagnostic body is malformed or stalls.
    // The same overall deadline bounds success and error response bodies.
    if (failureStatus !== undefined) return fail(`Embedding test failed with HTTP ${failureStatus}.`, httpFailure(failureStatus, input.provider))
    return fail(controller.signal.aborted ? 'Embedding test timed out. Retry when the provider is reachable.' : 'Embedding test could not complete. Check the provider connection and selected model.')
  } finally { clearTimeout(timer) }
}

export interface EmbeddingTestRouteOptions {
  fetchImpl?: typeof fetch
  /** Reserve the same activity as install/pull before any asynchronous probe. */
  beginTest?: () => (() => void) | null
  /** Local model probes must pass the same resource policy as pulling/installing. */
  checkLocalResources?: (selection: EmbeddingSelection) => Promise<string | null>
}

export function registerEmbeddingTestRoute(app: FastifyInstance, envPath: string, options: EmbeddingTestRouteOptions = {}): void {
  app.post<{ Body: Partial<EmbeddingTestInput> }>('/api/embedding/test', async (req, reply) => {
    const release = options.beginTest?.()
    if (release === null) return reply.code(409).send({ ok: false, error: 'installation_active', message: 'An installation or embedding test is running. Wait for it to finish before testing.' })
    try {
      const input = req.body ?? {}
      const issue = validateEmbeddingSelection(input)
      if (issue) return { ok: false, message: issue }
      if (input.provider === 'ollama') {
        const blocked = options.checkLocalResources
          ? await options.checkLocalResources(input as EmbeddingSelection)
          : 'Check machine resources before testing a local embedding model.'
        if (blocked) return { ok: false, message: blocked }
      }
      const saved = existsSync(envPath) ? parseEnv(readFileSync(envPath, 'utf8')) : {}
      const apiKey = typeof input.apiKey === 'string' && input.apiKey.trim() ? input.apiKey.trim()
        : input.provider === 'openai' ? saved.OPENAI_API_KEY : input.provider === 'voyage' ? saved.VOYAGE_API_KEY : undefined
      // The browser cannot select a request destination. Only the saved local
      // endpoint can override the default, and it is restricted to loopback above.
      return await testEmbeddingConnection({ ...input, apiKey }, options.fetchImpl, 15_000, saved.OLLAMA_URL)
    } finally { release?.() }
  })
}
