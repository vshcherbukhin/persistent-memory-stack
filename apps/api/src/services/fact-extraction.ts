import { ownerPrisma } from '@pm/db'
import {
  LlmProviderError,
  makeExtractionLLM,
  resolveExtractionModel,
  type ExtractionLLM,
  type VerdictRaw,
} from '../protocol/llm/client.ts'
import { FACT_EXTRACTION_PROMPT } from '../protocol/prompt.ts'
import { modelDependencyHealth } from './model-dependency-health.ts'

export type FactExtractionProvider = 'anthropic' | 'openai'
export type FactExtractionKeySource = 'settings' | 'env' | 'missing'

export interface FactExtractionModelOption {
  value: string
  label: string
  provider: FactExtractionProvider
}

export const DEFAULT_FACT_EXTRACTION_PROVIDER: FactExtractionProvider = 'anthropic'
export const DEFAULT_FACT_EXTRACTION_MODEL = 'claude-haiku-4-5-20251001'
/** The Settings probe must settle well before the outer MCP API timeout. */
export const FACT_EXTRACTION_TEST_TIMEOUT_MS = 15_000

export const FACT_EXTRACTION_MODELS: FactExtractionModelOption[] = [
  { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', provider: 'anthropic' },
  { value: 'claude-sonnet-5', label: 'Claude Sonnet 5', provider: 'anthropic' },
  { value: 'gpt-4o', label: 'GPT-4o', provider: 'openai' },
  { value: 'gpt-5.4', label: 'GPT-5.4', provider: 'openai' },
]

const MODEL_PROVIDER = new Map(FACT_EXTRACTION_MODELS.map((model) => [model.value, model.provider] as const))

export interface FactExtractionKeyState {
  hasKey: boolean
  source: FactExtractionKeySource
  masked: string | null
}

export interface EffectiveFactExtractionSettings {
  provider: FactExtractionProvider
  model: string
  availableModels: FactExtractionModelOption[]
  apiKeyMasked: string | null
  apiKeySource: FactExtractionKeySource
  keys: Record<FactExtractionProvider, FactExtractionKeyState>
}

interface FactExtractionRow {
  factExtractionProvider?: string | null
  factExtractionModel?: string | null
  factExtractionAnthropicApiKey?: string | null
  factExtractionOpenaiApiKey?: string | null
}

export interface FactExtractionRuntimeConfig {
  provider: FactExtractionProvider
  model: string
  apiKey: string
  apiKeySource: FactExtractionKeySource
}

export interface FactExtractionTestInput {
  model: string
  apiKey?: string | null
}

export interface FactExtractionTestResult {
  ok: boolean
  provider: FactExtractionProvider
  model: string
  message: string
  details?: string
  outcome?: 'accept' | 'restructure' | 'reject'
  reason?: string
}

export const FACT_EXTRACTION_TEST_PAYLOAD = {
  content:
    '[component_fact_extraction_probe] gotcha: the dashboard fact extraction test must validate the selected model and API key without saving a memory. Root cause: System Settings probes call the Shape-gate LLM only. Fix: accept this seeded backend probe as the connectivity check.',
  metadata: {
    category: 'gotcha',
    source: 'gotcha-discovered',
    entities: ['component_fact_extraction_probe'],
  },
} as const

export function providerForFactExtractionModel(model: string): FactExtractionProvider | null {
  return MODEL_PROVIDER.get(model) ?? null
}

export function normalizeFactExtractionProvider(value: unknown): FactExtractionProvider {
  return value === 'openai' ? 'openai' : 'anthropic'
}

export function maskSecret(secret: string | null | undefined): string | null {
  const trimmed = secret?.trim()
  if (!trimmed) return null
  if (trimmed.length <= 8) return 'set'
  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`
}

function keyState(settingsKey: string | null | undefined, envKey: string | undefined): FactExtractionKeyState {
  const stored = settingsKey?.trim()
  if (stored) return { hasKey: true, source: 'settings', masked: maskSecret(stored) }
  const fallback = envKey?.trim()
  if (fallback) return { hasKey: true, source: 'env', masked: maskSecret(fallback) }
  return { hasKey: false, source: 'missing', masked: null }
}

function rawKeyForProvider(
  provider: FactExtractionProvider,
  row: FactExtractionRow | null,
  env: NodeJS.ProcessEnv,
): { apiKey: string; source: FactExtractionKeySource } {
  const settingsKey =
    provider === 'anthropic' ? row?.factExtractionAnthropicApiKey : row?.factExtractionOpenaiApiKey
  const envKey = provider === 'anthropic' ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY
  const stored = settingsKey?.trim()
  if (stored) return { apiKey: stored, source: 'settings' }
  const fallback = envKey?.trim()
  if (fallback) return { apiKey: fallback, source: 'env' }
  return { apiKey: '', source: 'missing' }
}

export function effectiveFactExtractionFromRow(
  row: FactExtractionRow | null,
  env: NodeJS.ProcessEnv = process.env,
): EffectiveFactExtractionSettings {
  const rowProvider = normalizeFactExtractionProvider(row?.factExtractionProvider ?? env.EXTRACTION_PROVIDER)
  const model =
    row?.factExtractionModel?.trim() ||
    resolveExtractionModel(rowProvider, env.EXTRACTION_MODEL) ||
    DEFAULT_FACT_EXTRACTION_MODEL
  const provider = providerForFactExtractionModel(model) ?? rowProvider
  const keys = {
    anthropic: keyState(row?.factExtractionAnthropicApiKey, env.ANTHROPIC_API_KEY),
    openai: keyState(row?.factExtractionOpenaiApiKey, env.OPENAI_API_KEY),
  }
  const selected = keys[provider]
  return {
    provider,
    model,
    availableModels: FACT_EXTRACTION_MODELS,
    apiKeyMasked: selected.masked,
    apiKeySource: selected.source,
    keys,
  }
}

export async function getEffectiveFactExtractionSettings(
  env: NodeJS.ProcessEnv = process.env,
): Promise<EffectiveFactExtractionSettings> {
  const row = await ownerPrisma.systemSettings.findUnique({ where: { id: 'singleton' } })
  return effectiveFactExtractionFromRow(row, env)
}

export async function getFactExtractionRuntimeConfig(
  input: Partial<FactExtractionTestInput> = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<FactExtractionRuntimeConfig> {
  const row = await ownerPrisma.systemSettings.findUnique({ where: { id: 'singleton' } })
  const effective = effectiveFactExtractionFromRow(row, env)
  const model = input.model?.trim() || effective.model
  const provider = providerForFactExtractionModel(model) ?? effective.provider
  const suppliedKey = input.apiKey?.trim()
  if (suppliedKey) return { provider, model, apiKey: suppliedKey, apiKeySource: 'settings' }
  const key = rawKeyForProvider(provider, row, env)
  return { provider, model, apiKey: key.apiKey, apiKeySource: key.source }
}

export function envForFactExtractionRuntime(
  runtime: FactExtractionRuntimeConfig,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...env,
    EXTRACTION_PROVIDER: runtime.provider,
    EXTRACTION_MODEL: runtime.model,
    ...(runtime.provider === 'anthropic'
      ? { ANTHROPIC_API_KEY: runtime.apiKey }
      : { OPENAI_API_KEY: runtime.apiKey }),
  }
}

export async function makeConfiguredExtractionLLM(
  input: Partial<FactExtractionTestInput> = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ llm: ExtractionLLM; runtime: FactExtractionRuntimeConfig }> {
  const runtime = await getFactExtractionRuntimeConfig(input, env)
  return { llm: await makeExtractionLLM(envForFactExtractionRuntime(runtime, env)), runtime }
}

export function factExtractionCacheKey(runtime: FactExtractionRuntimeConfig): string {
  return `${runtime.provider}\n${runtime.model}\n${runtime.apiKeySource}\n${runtime.apiKey}`
}

function healthTarget(runtime: FactExtractionRuntimeConfig): Pick<FactExtractionRuntimeConfig, 'provider' | 'model'> | undefined {
  return providerForFactExtractionModel(runtime.model) === runtime.provider
    ? { provider: runtime.provider, model: runtime.model }
    : undefined
}

async function recordFactExtractionSuccess(runtime: FactExtractionRuntimeConfig): Promise<void> {
  const target = healthTarget(runtime)
  try {
    await modelDependencyHealth.recordSuccess({
      capability: 'fact_extraction',
      observerScope: 'server',
      ...target,
      observedAt: new Date(),
    })
  } catch {
    // Health telemetry is diagnostic. Never turn a completed provider call into
    // a failed memory write or Settings probe when persistence is unavailable.
  }
}

async function recordFactExtractionFailure(
  runtime: FactExtractionRuntimeConfig,
  code:
    | 'fact_extraction_quota_exhausted'
    | 'fact_extraction_provider_overloaded'
    | 'fact_extraction_provider_rate_limited'
    | 'fact_extraction_provider_unavailable'
    | 'fact_extraction_timeout'
    | 'fact_extraction_probe_rejected',
  state: 'degraded' | 'unhealthy',
): Promise<void> {
  const target = healthTarget(runtime)
  try {
    await modelDependencyHealth.recordFailure({
      capability: 'fact_extraction',
      observerScope: 'server',
      ...target,
      failure: { code, state },
      observedAt: new Date(),
    })
  } catch {
    // The normalized provider result remains authoritative when telemetry fails.
  }
}

function healthFailureCode(error: LlmProviderError): Parameters<typeof recordFactExtractionFailure>[1] {
  switch (error.code) {
    case 'extraction_provider_overloaded':
      return 'fact_extraction_provider_overloaded'
    case 'extraction_provider_rate_limited':
      return 'fact_extraction_provider_rate_limited'
    default:
      return error.code
  }
}

/**
 * Classify once and persist only canonical, redacted fact-extraction health.
 * This is shared by real memory writes and the System Settings probe.
 */
export async function classifyFactExtraction(
  llm: ExtractionLLM,
  runtime: FactExtractionRuntimeConfig | null,
  systemPrompt: string,
  userJson: string,
  options?: { signal?: AbortSignal; recordSuccess?: boolean },
): Promise<VerdictRaw> {
  try {
    const verdict = await llm.classify(systemPrompt, userJson, options)
    if (runtime && options?.recordSuccess !== false) await recordFactExtractionSuccess(runtime)
    return verdict
  } catch (err) {
    if (runtime && err instanceof LlmProviderError) {
      await recordFactExtractionFailure(
        runtime,
        healthFailureCode(err),
        err.retryable ? 'degraded' : 'unhealthy',
      )
    }
    throw err
  }
}

export async function testFactExtractionSettings(
  input: FactExtractionTestInput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<FactExtractionTestResult> {
  const runtime = await getFactExtractionRuntimeConfig(input, env)
  if (!runtime.apiKey) {
    return {
      ok: false,
      provider: runtime.provider,
      model: runtime.model,
      message: `${runtime.provider === 'anthropic' ? 'Claude' : 'OpenAI'} API key is missing.`,
      details: 'Enter an API key or configure the matching env key before testing fact extraction.',
    }
  }

  const controller = new AbortController()
  let timedOut = false
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      timedOut = true
      controller.abort()
      reject(new Error('Fact extraction test timed out.'))
    }, FACT_EXTRACTION_TEST_TIMEOUT_MS)
  })
  try {
    const llm = await makeExtractionLLM(envForFactExtractionRuntime(runtime, env))
    const classification = classifyFactExtraction(
      llm,
      runtime,
      FACT_EXTRACTION_PROMPT,
      JSON.stringify(FACT_EXTRACTION_TEST_PAYLOAD),
      { signal: controller.signal, recordSuccess: false },
    )
    const verdict = await Promise.race([classification, timeout])
    if (verdict.outcome === 'reject') {
      await recordFactExtractionFailure(runtime, 'fact_extraction_probe_rejected', 'unhealthy')
      return {
        ok: false,
        provider: runtime.provider,
        model: runtime.model,
        message: 'Fact extraction responded, but rejected the seeded probe.',
        outcome: verdict.outcome,
        reason: verdict.reason,
        details: verdict.missing?.length ? `Missing: ${verdict.missing.join(', ')}` : undefined,
      }
    }
    await recordFactExtractionSuccess(runtime)
    return {
      ok: true,
      provider: runtime.provider,
      model: runtime.model,
      message: `Fact extraction test passed with ${runtime.model}.`,
      outcome: verdict.outcome,
      reason: verdict.reason,
    }
  } catch (err) {
    if (timedOut) {
      await recordFactExtractionFailure(runtime, 'fact_extraction_timeout', 'degraded')
      return {
        ok: false,
        provider: runtime.provider,
        model: runtime.model,
        message: 'Fact extraction test timed out.',
        details: 'The provider did not respond before the test deadline.',
      }
    }
    return {
      ok: false,
      provider: runtime.provider,
      model: runtime.model,
      message: err instanceof LlmProviderError ? err.message : 'Fact extraction test failed.',
      details: err instanceof LlmProviderError ? undefined : 'The provider could not complete the test. Check its configuration and try again.',
    }
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle)
  }
}
