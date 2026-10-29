import { MODEL_REGISTRY } from '@pm/shared'
import { config } from '../config.ts'

export type OllamaTarget = { model: string; dim: number }
export type OllamaReadiness = {
  state: 'starting' | 'ready' | 'unavailable' | 'model_missing' | 'invalid_embedding'
  message: string
  observedAt: Date
  readyAt: Date | null
}

const STARTING = 'Embeddings service is still launching. Please try again shortly.'
const sameModel = (left: string, right: string) => left.replace(/:latest$/, '') === right.replace(/:latest$/, '')

/** Residency is cheap to check; a real, synthetic embedding establishes readiness.
 * Callers never wait for model loading, and concurrent callers share one warm-up.
 * No user text, configuration changes, model pulls or permanent keep-alive.
 */
export function createOllamaReadiness(options: {
  baseUrl: string
  fetch?: typeof fetch
  now?: () => number
  checkTimeoutMs?: number
  warmupTimeoutMs?: number
  cacheMs?: number
  startupGraceMs?: number
}) {
  const request = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  const now = options.now ?? Date.now
  type Entry = { value: OllamaReadiness; checkedAt: number; createdAt: number; hasReady: boolean; lastLeaseAttempt: number; check?: Promise<OllamaReadiness>; warming?: Promise<void>; refreshing?: Promise<void> }
  // One active pin. A switch cannot let an older model's completion mark the new one ready.
  let active: { key: string; entry: Entry } | undefined

  async function json(path: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
    const response = await request(`${options.baseUrl.replace(/\/$/, '')}${path}`, {
      ...init, signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) throw new Error(`Ollama readiness HTTP ${response.status}`)
    // The deadline covers the body as well as the response headers.
    return response.json()
  }

  function names(body: unknown): string[] {
    if (!body || typeof body !== 'object' || !Array.isArray((body as { models?: unknown }).models)) throw new Error('Invalid Ollama model list')
    return (body as { models: Array<{ name?: string; model?: string }> }).models
      .flatMap(model => [model.name, model.model]).filter((name): name is string => typeof name === 'string')
  }

  function set(entry: Entry, state: OllamaReadiness['state'], message: string, readyAt: Date | null = null) {
    entry.value = { state, message, observedAt: new Date(now()), readyAt }
    return entry.value
  }

  function warm(entry: Entry, target: OllamaTarget) {
    if (entry.warming) return
    set(entry, 'starting', STARTING)
    entry.warming = (async () => {
      try {
        const spec = MODEL_REGISTRY[target.model]
        const result = await json('/api/embed', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: target.model, input: ['Embedding readiness check.'], truncate: true, keep_alive: '5m',
            ...(spec?.supportedDims && spec.supportedDims.length > 1 && target.dim !== spec.nativeDim ? { dimensions: target.dim } : {}),
          }),
        }, options.warmupTimeoutMs ?? 30_000) as { embeddings?: unknown }
        const vectors = result?.embeddings
        if (!Array.isArray(vectors) || vectors.length !== 1 || !Array.isArray(vectors[0])
          || vectors[0].length !== target.dim || !vectors[0].every(value => typeof value === 'number' && Number.isFinite(value))) {
          set(entry, 'invalid_embedding', 'The configured embedding model did not return a valid vector. Check the model and pin.')
        } else {
          entry.hasReady = true
          set(entry, 'ready', 'The configured embedding model is ready.', new Date(now()))
        }
      } catch (error) {
        const timeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
        set(entry, timeout ? 'starting' : 'unavailable', timeout ? STARTING : 'Embeddings are unavailable. Check Ollama and retry.')
      } finally {
        entry.warming = undefined
        entry.checkedAt = now()
      }
    })()
  }

  /** Refresh the existing runner lease only while callers are using this stack.
   * Empty input schedules the model but performs no text embedding. A dashboard
   * read must neither wait for this nor claim a new successful vector probe.
   */
  function refreshLease(entry: Entry, target: OllamaTarget, expiresAt: number) {
    if (!Number.isFinite(expiresAt) || expiresAt - now() > 60_000 || entry.refreshing || now() - entry.lastLeaseAttempt < 30_000) return
    entry.lastLeaseAttempt = now()
    entry.refreshing = (async () => {
      try {
        await json('/api/embed', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: target.model, input: [], keep_alive: '5m' }),
        }, 3_000)
      } catch {
        // The next residency check remains authoritative. Back off instead of
        // turning a failed lease refresh into false readiness or a retry storm.
      } finally { entry.refreshing = undefined }
    })()
  }

  return {
    async inspect(target: OllamaTarget): Promise<OllamaReadiness> {
      const key = `${target.model}|${target.dim}`
      if (active?.key !== key) active = { key, entry: { value: { state: 'starting', message: STARTING, observedAt: new Date(now()), readyAt: null }, checkedAt: -Infinity, createdAt: now(), hasReady: false, lastLeaseAttempt: -Infinity } }
      const entry = active.entry
      if (entry.warming) return entry.value
      if (entry.check) return entry.check
      if (now() - entry.checkedAt < (options.cacheMs ?? 1_000)) return entry.value
      entry.check = (async () => {
        try {
          const running = await json('/api/ps', {}, options.checkTimeoutMs ?? 1_000)
          const resident = names(running).some(name => sameModel(name, target.model))
          const row = (running as { models: Array<{ name?: string; model?: string; expires_at?: string }> }).models
            .find(model => [model.name, model.model].some(name => typeof name === 'string' && sameModel(name, target.model)))
          const expiresAt = row?.expires_at ? Date.parse(row.expires_at) : NaN
          if (resident && (!Number.isFinite(expiresAt) || expiresAt > now()) && entry.value.state === 'ready') {
            refreshLease(entry, target, expiresAt)
            return entry.value
          }
          const installed = names(await json('/api/tags', {}, options.checkTimeoutMs ?? 1_000)).some(name => sameModel(name, target.model))
          if (!installed) return set(entry, 'model_missing', 'Configured Ollama embedding model is unavailable. Pull the configured model, then retry.')
          warm(entry, target)
          return entry.value
        } catch {
          const launching = !entry.hasReady && now() - entry.createdAt < (options.startupGraceMs ?? 120_000)
          return set(entry, launching ? 'starting' : 'unavailable', launching ? STARTING : 'Ollama is unavailable. Start Ollama and retry.')
        } finally {
          entry.checkedAt = now()
          entry.check = undefined
        }
      })()
      return entry.check
    },
  }
}

export const ollamaReadiness = createOllamaReadiness({ baseUrl: config.OLLAMA_URL })

export class EmbeddingsNotReadyError extends Error {
  readonly statusCode = 503
  readonly code: string
  readonly retryable: boolean
  constructor(readonly readiness: OllamaReadiness) {
    super(readiness.message)
    this.code = readiness.state === 'starting' ? 'embeddings_starting' : readiness.state === 'model_missing' || readiness.state === 'invalid_embedding' ? 'embedding_model_unavailable' : 'embedding_provider_unavailable'
    this.retryable = readiness.state === 'starting' || readiness.state === 'unavailable'
  }
}
