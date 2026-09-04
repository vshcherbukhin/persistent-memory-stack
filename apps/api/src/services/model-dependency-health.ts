import { ownerPrisma } from '@pm/db'

export type ModelDependencyCapability = 'fact_extraction' | 'embeddings' | 'ollama_host'
export type ModelDependencyHealthState = 'healthy' | 'degraded' | 'unhealthy' | 'unknown'
export type ModelDependencyProvider = 'anthropic' | 'openai' | 'ollama' | 'voyage'
export type ModelDependencyFailureCode =
  | 'fact_extraction_quota_exhausted'
  | 'fact_extraction_provider_overloaded'
  | 'fact_extraction_provider_rate_limited'
  | 'fact_extraction_provider_unavailable'
  | 'fact_extraction_timeout'
  | 'fact_extraction_probe_rejected'
  | 'embedding_quota_exhausted'
  | 'embedding_provider_rate_limited'
  | 'embedding_provider_unavailable'
  | 'embedding_model_unavailable'
  | 'embedding_timeout'
  | 'ollama_host_unavailable'
  | 'ollama_model_unavailable'

type FailureState = 'degraded' | 'unhealthy'
type HealthKey = { capability: ModelDependencyCapability; observerScope: string }
type ModelDependencyHealthWhereInput = HealthKey & { observedAt: { lte: Date } }

const FAILURE_POLICY: Record<ModelDependencyFailureCode, { state: FailureState; message: string; retryable: boolean }> = {
  fact_extraction_quota_exhausted: {
    state: 'unhealthy', message: 'Fact extraction is out of tokens. The memory was not saved.', retryable: false,
  },
  fact_extraction_provider_overloaded: {
    state: 'degraded', message: 'Fact extraction provider is overloaded. Retry shortly.', retryable: true,
  },
  fact_extraction_provider_rate_limited: {
    state: 'degraded', message: 'Fact extraction provider is rate-limited. Retry shortly.', retryable: true,
  },
  fact_extraction_provider_unavailable: {
    state: 'degraded', message: 'Fact extraction provider is unavailable. Retry shortly.', retryable: true,
  },
  fact_extraction_timeout: {
    state: 'degraded', message: 'Fact extraction test timed out before the provider responded.', retryable: true,
  },
  fact_extraction_probe_rejected: {
    state: 'unhealthy', message: 'Fact extraction rejected the configured probe.', retryable: false,
  },
  embedding_provider_unavailable: {
    state: 'unhealthy', message: 'Embeddings are unavailable.', retryable: true,
  },
  embedding_quota_exhausted: {
    state: 'unhealthy', message: 'Embeddings are out of tokens.', retryable: false,
  },
  embedding_provider_rate_limited: {
    state: 'degraded', message: 'Embedding provider is rate-limited. Retry shortly.', retryable: true,
  },
  embedding_model_unavailable: {
    state: 'unhealthy', message: 'Configured embedding model is unavailable.', retryable: false,
  },
  embedding_timeout: {
    state: 'degraded', message: 'Embedding provider timed out. Retry shortly.', retryable: true,
  },
  ollama_host_unavailable: {
    state: 'unhealthy', message: 'Ollama host is unavailable.', retryable: true,
  },
  ollama_model_unavailable: {
    state: 'unhealthy', message: 'Configured Ollama embedding model is unavailable.', retryable: false,
  },
}

const MODELS_BY_PROVIDER: Record<ModelDependencyProvider, readonly string[]> = {
  anthropic: ['claude-haiku-4-5-20251001', 'claude-sonnet-5'],
  openai: ['gpt-4o', 'gpt-5.4', 'text-embedding-3-large', 'text-embedding-3-small'],
  ollama: ['qwen3-embedding:0.6b', 'qwen3-embedding:4b', 'qwen3-embedding:8b', 'nomic-embed-text'],
  voyage: ['voyage-3-large'],
}

export interface ModelDependencyHealthRecord {
  capability: ModelDependencyCapability
  observerScope: string
  state: Exclude<ModelDependencyHealthState, 'unknown'>
  provider: ModelDependencyProvider | null
  model: string | null
  lastSuccessAt: Date | null
  firstFailureAt: Date | null
  lastFailureAt: Date | null
  failureCode: ModelDependencyFailureCode | null
  safeMessage: string | null
  retryable: boolean | null
  consecutiveFailures: number
  observedAt: Date
  updatedAt: Date
}

export interface SafeModelDependencyHealthDto extends Omit<ModelDependencyHealthRecord, 'state' | 'observedAt' | 'updatedAt'> {
  state: ModelDependencyHealthState
  observedAt: Date | null
  updatedAt: Date | null
}

export interface RecordModelDependencyFailure {
  capability: ModelDependencyCapability
  observerScope: string
  provider?: ModelDependencyProvider
  model?: string
  failure: { code: ModelDependencyFailureCode; state: FailureState }
  observedAt: Date
}

export interface RecordModelDependencySuccess {
  capability: ModelDependencyCapability
  observerScope: string
  provider?: ModelDependencyProvider
  model?: string
  observedAt: Date
}

interface ModelDependencyHealthRepository {
  findUnique(args: { where: { capability_observerScope: HealthKey } }): Promise<ModelDependencyHealthRecord | null>
  findMany(): Promise<ModelDependencyHealthRecord[]>
  upsert(args: { where: { capability_observerScope: HealthKey }; create: ModelDependencyHealthRecord; update: Record<string, never> }): Promise<ModelDependencyHealthRecord>
  updateMany(args: { where: ModelDependencyHealthWhereInput; data: Partial<ModelDependencyHealthRecord> }): Promise<{ count: number }>
}

interface ModelDependencyHealthTransaction { modelDependencyHealth: ModelDependencyHealthRepository }
export interface ModelDependencyHealthStore {
  modelDependencyHealth: ModelDependencyHealthRepository
  $transaction<T>(operation: (transaction: ModelDependencyHealthTransaction) => Promise<T>): Promise<T>
}

function canonicalError(): Error { return new Error('Invalid canonical model dependency health input.') }
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean { return Object.keys(value).every((key) => allowed.includes(key)) }
function isCapability(value: unknown): value is ModelDependencyCapability { return value === 'fact_extraction' || value === 'embeddings' || value === 'ollama_host' }
function isProvider(value: unknown): value is ModelDependencyProvider { return value === 'anthropic' || value === 'openai' || value === 'ollama' || value === 'voyage' }
function isScope(value: unknown): value is string {
  return value === 'server' || value === 'host'
    || (typeof value === 'string' && /^client:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value))
}

function assertTarget(input: Record<string, unknown>): asserts input is Record<string, unknown> & HealthKey {
  if (!isCapability(input.capability) || !isScope(input.observerScope)) throw canonicalError()
  const provider = input.provider
  const model = input.model
  if (provider !== undefined && !isProvider(provider)) throw canonicalError()
  if (model !== undefined && (typeof model !== 'string' || !provider || !MODELS_BY_PROVIDER[provider].includes(model))) throw canonicalError()
  if (input.capability === 'fact_extraction' && provider !== undefined && provider !== 'anthropic' && provider !== 'openai') throw canonicalError()
  if (input.capability === 'embeddings' && provider !== undefined && provider !== 'ollama' && provider !== 'openai' && provider !== 'voyage') throw canonicalError()
  if (input.capability === 'ollama_host' && provider !== undefined && provider !== 'ollama') throw canonicalError()
  if (input.capability === 'fact_extraction' && input.observerScope !== 'server') throw canonicalError()
  if (input.capability === 'ollama_host' && input.observerScope !== 'host') throw canonicalError()
  if (input.capability === 'embeddings' && input.observerScope !== 'server' && !input.observerScope.startsWith('client:')) throw canonicalError()
  if ((provider === undefined) !== (model === undefined)) throw canonicalError()
}

function assertFailure(input: Record<string, unknown>): asserts input is Record<string, unknown> & RecordModelDependencyFailure {
  if (!hasOnlyKeys(input, ['capability', 'observerScope', 'provider', 'model', 'failure', 'observedAt']) || !(input.observedAt instanceof Date)) throw canonicalError()
  assertTarget(input)
  if (!isObject(input.failure) || !hasOnlyKeys(input.failure, ['code', 'state'])) throw canonicalError()
  const code = input.failure.code
  const state = input.failure.state
  if (typeof code !== 'string' || !(code in FAILURE_POLICY) || FAILURE_POLICY[code as ModelDependencyFailureCode].state !== state) throw canonicalError()
  if (input.capability === 'fact_extraction' && ![
    'fact_extraction_quota_exhausted',
    'fact_extraction_provider_overloaded',
    'fact_extraction_provider_rate_limited',
    'fact_extraction_provider_unavailable',
    'fact_extraction_timeout',
    'fact_extraction_probe_rejected',
  ].includes(code)) throw canonicalError()
  if (input.capability === 'embeddings' && ![
    'embedding_quota_exhausted',
    'embedding_provider_rate_limited',
    'embedding_provider_unavailable',
    'embedding_model_unavailable',
    'embedding_timeout',
  ].includes(code)) throw canonicalError()
  if (input.capability === 'ollama_host' && ![
    'ollama_host_unavailable',
    'ollama_model_unavailable',
  ].includes(code)) throw canonicalError()
}

function assertSuccess(input: Record<string, unknown>): asserts input is Record<string, unknown> & RecordModelDependencySuccess {
  if (!hasOnlyKeys(input, ['capability', 'observerScope', 'provider', 'model', 'observedAt']) || !(input.observedAt instanceof Date)) throw canonicalError()
  assertTarget(input)
}

function toSafeDto(record: ModelDependencyHealthRecord): SafeModelDependencyHealthDto { return { ...record } }
function unknownDto(capability: ModelDependencyCapability, observerScope: string): SafeModelDependencyHealthDto {
  return { capability, observerScope, state: 'unknown', provider: null, model: null, lastSuccessAt: null, firstFailureAt: null, lastFailureAt: null, failureCode: null, safeMessage: null, retryable: null, consecutiveFailures: 0, observedAt: null, updatedAt: null }
}
function keyFor(input: HealthKey): HealthKey { return { capability: input.capability, observerScope: input.observerScope } }

function failureRecord(input: RecordModelDependencyFailure): ModelDependencyHealthRecord {
  const policy = FAILURE_POLICY[input.failure.code]
  return { capability: input.capability, observerScope: input.observerScope, state: policy.state, provider: input.provider ?? null, model: input.model ?? null, lastSuccessAt: null, firstFailureAt: input.observedAt, lastFailureAt: input.observedAt, failureCode: input.failure.code, safeMessage: policy.message, retryable: policy.retryable, consecutiveFailures: 1, observedAt: input.observedAt, updatedAt: input.observedAt }
}
function successRecord(input: RecordModelDependencySuccess): ModelDependencyHealthRecord {
  return { capability: input.capability, observerScope: input.observerScope, state: 'healthy', provider: input.provider ?? null, model: input.model ?? null, lastSuccessAt: input.observedAt, firstFailureAt: null, lastFailureAt: null, failureCode: null, safeMessage: null, retryable: null, consecutiveFailures: 0, observedAt: input.observedAt, updatedAt: input.observedAt }
}

export function createModelDependencyHealthService(store: ModelDependencyHealthStore) {
  async function applyObservation(input: RecordModelDependencyFailure | RecordModelDependencySuccess, next: (current: ModelDependencyHealthRecord) => ModelDependencyHealthRecord): Promise<SafeModelDependencyHealthDto> {
    const key = keyFor(input)
    return store.$transaction(async (transaction) => {
      const existing = await transaction.modelDependencyHealth.findUnique({ where: { capability_observerScope: key } })
      if (existing && existing.observedAt > input.observedAt) return toSafeDto(existing)
      const initial = 'failure' in input ? failureRecord(input) : successRecord(input)
      const reserved = await transaction.modelDependencyHealth.upsert({ where: { capability_observerScope: key }, create: initial, update: {} })
      if (reserved.observedAt > input.observedAt || (!existing && reserved.observedAt.getTime() === input.observedAt.getTime())) return toSafeDto(reserved)
      await transaction.modelDependencyHealth.updateMany({ where: { ...key, observedAt: { lte: input.observedAt } }, data: next(reserved) })
      const latest = await transaction.modelDependencyHealth.findUnique({ where: { capability_observerScope: key } })
      if (!latest) throw new Error('model dependency health observation was not persisted')
      return toSafeDto(latest)
    })
  }
  return {
    async recordFailure(input: RecordModelDependencyFailure): Promise<SafeModelDependencyHealthDto> {
      assertFailure(input as unknown as Record<string, unknown>)
      const policy = FAILURE_POLICY[input.failure.code]
      return applyObservation(input, (current) => ({ ...current, state: policy.state, provider: input.provider ?? current.provider, model: input.model ?? current.model, firstFailureAt: current.state === 'healthy' ? input.observedAt : current.firstFailureAt ?? input.observedAt, lastFailureAt: input.observedAt, failureCode: input.failure.code, safeMessage: policy.message, retryable: policy.retryable, consecutiveFailures: current.state === 'healthy' ? 1 : current.consecutiveFailures + 1, observedAt: input.observedAt, updatedAt: input.observedAt }))
    },
    async recordSuccess(input: RecordModelDependencySuccess): Promise<SafeModelDependencyHealthDto> {
      assertSuccess(input as unknown as Record<string, unknown>)
      return applyObservation(input, (current) => ({ ...current, state: 'healthy', provider: input.provider ?? current.provider, model: input.model ?? current.model, lastSuccessAt: input.observedAt, firstFailureAt: null, lastFailureAt: null, failureCode: null, safeMessage: null, retryable: null, consecutiveFailures: 0, observedAt: input.observedAt, updatedAt: input.observedAt }))
    },
    async getSafeHealth(capability: ModelDependencyCapability, observerScope: string): Promise<SafeModelDependencyHealthDto> {
      assertTarget({ capability, observerScope })
      const record = await store.modelDependencyHealth.findUnique({ where: { capability_observerScope: { capability, observerScope } } })
      return record ? toSafeDto(record) : unknownDto(capability, observerScope)
    },
    async listSafeHealth(): Promise<SafeModelDependencyHealthDto[]> { return (await store.modelDependencyHealth.findMany()).sort((left, right) => right.observedAt.getTime() - left.observedAt.getTime()).map(toSafeDto) },
  }
}

// `ownerPrisma` is assigned by initDb after API modules are imported. Keep a
// stable adapter here, but resolve that live binding only at the operation
// boundary so static API boot never captures an uninitialized client.
const liveOwnerPrismaStore: ModelDependencyHealthStore = {
  get modelDependencyHealth(): ModelDependencyHealthRepository {
    return ownerPrisma.modelDependencyHealth as unknown as ModelDependencyHealthRepository
  },
  $transaction<T>(operation: (transaction: ModelDependencyHealthTransaction) => Promise<T>): Promise<T> {
    return ownerPrisma.$transaction((transaction) => operation({
      modelDependencyHealth: transaction.modelDependencyHealth as unknown as ModelDependencyHealthRepository,
    }))
  },
}

export const modelDependencyHealth = createModelDependencyHealthService(liveOwnerPrismaStore)
