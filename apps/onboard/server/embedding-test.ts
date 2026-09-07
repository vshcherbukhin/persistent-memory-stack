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

/** Do not expose provider error bodies or transport errors: either may echo keys. */
function httpFailure(status: number): string {
  if (status === 401 || status === 403) return 'The provider rejected this API key or its permissions. Check the matching provider key and model access.'
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
  try {
    const operation = async (): Promise<EmbeddingTestResult> => {
      const response = await fetchImpl(url, {
        method: 'POST', signal: controller.signal,
        headers: { 'content-type': 'application/json', ...(!local ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify(body),
      })
      if (!response.ok) {
        await response.body?.cancel().catch(() => {})
        return fail(`Embedding test failed with HTTP ${response.status}.`, httpFailure(response.status))
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
