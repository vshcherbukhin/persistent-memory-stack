import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  systemSettingsFindUnique: vi.fn(),
}))

vi.mock('@pm/db', () => ({
  ownerPrisma: {
    systemSettings: { findUnique: db.systemSettingsFindUnique },
  },
}))

import {
  FACT_EXTRACTION_TEST_PAYLOAD,
  FACT_EXTRACTION_MODELS,
  getEffectiveFactExtractionSettings,
  maskSecret,
  providerForFactExtractionModel,
} from '../src/services/fact-extraction.ts'
import { classifyProviderFailure, LlmProviderError } from '../src/protocol/llm/client.ts'
import { VALID_SOURCES } from '../src/protocol/shapes.ts'

describe('fact extraction model catalog', () => {
  it('offers the requested Claude and OpenAI model choices', () => {
    expect(FACT_EXTRACTION_MODELS.map((m) => m.value)).toEqual([
      'claude-haiku-4-5-20251001',
      'claude-sonnet-5',
      'gpt-4o',
      'gpt-5.4',
    ])
    expect(providerForFactExtractionModel('claude-haiku-4-5-20251001')).toBe('anthropic')
    expect(providerForFactExtractionModel('claude-sonnet-5')).toBe('anthropic')
    expect(providerForFactExtractionModel('gpt-4o')).toBe('openai')
    expect(providerForFactExtractionModel('gpt-5.4')).toBe('openai')
  })
})

describe('FACT_EXTRACTION_TEST_PAYLOAD', () => {
  it('uses Shape-gate-valid source metadata for the seeded backend probe', () => {
    expect(VALID_SOURCES).toContain(FACT_EXTRACTION_TEST_PAYLOAD.metadata.source)
    expect(FACT_EXTRACTION_TEST_PAYLOAD.content).toContain('component_fact_extraction_probe')
  })
})

describe('maskSecret', () => {
  it('never returns the raw API key', () => {
    expect(maskSecret('sk-ant-api03-abcdef1234567890')).toBe('sk-a...7890')
    expect(maskSecret('short')).toBe('set')
    expect(maskSecret('')).toBeNull()
  })
})

describe('getEffectiveFactExtractionSettings', () => {
  beforeEach(() => {
    db.systemSettingsFindUnique.mockReset()
  })

  it('falls back to env model/key when the singleton has no fact-extraction override', async () => {
    db.systemSettingsFindUnique.mockResolvedValue(null)

    const settings = await getEffectiveFactExtractionSettings({
      EXTRACTION_PROVIDER: 'anthropic',
      EXTRACTION_MODEL: 'claude-haiku-4-5-20251001',
      ANTHROPIC_API_KEY: 'sk-ant-api03-envkey9999',
    } as NodeJS.ProcessEnv)

    expect(settings.provider).toBe('anthropic')
    expect(settings.model).toBe('claude-haiku-4-5-20251001')
    expect(settings.keys.anthropic).toMatchObject({
      hasKey: true,
      source: 'env',
      masked: 'sk-a...9999',
    })
  })

  it('uses the stored key for the selected provider without exposing the raw value', async () => {
    db.systemSettingsFindUnique.mockResolvedValue({
      factExtractionProvider: 'openai',
      factExtractionModel: 'gpt-5.4',
      factExtractionAnthropicApiKey: null,
      factExtractionOpenaiApiKey: 'sk-openai-secret-1234',
    })

    const settings = await getEffectiveFactExtractionSettings({ OPENAI_API_KEY: 'sk-env-0000' } as NodeJS.ProcessEnv)

    expect(settings.provider).toBe('openai')
    expect(settings.model).toBe('gpt-5.4')
    expect(settings.keys.openai).toEqual({
      hasKey: true,
      source: 'settings',
      masked: 'sk-o...1234',
    })
  })
})

describe('fact extraction provider failures', () => {
  it('produces canonical log fields without serializing a provider cause', () => {
    const rawCause = new Error('provider response includes raw-token-should-not-log')
    const error = new LlmProviderError(
      'fact_extraction_quota_exhausted',
      'Fact extraction is out of tokens. The memory was not saved.',
      'Anthropic',
      'claude-haiku-4-5-20251001',
      402,
      false,
      rawCause,
    )

    const fields = (error as unknown as { toLogFields(): Record<string, unknown> }).toLogFields()

    expect(fields).toEqual({
      code: 'fact_extraction_quota_exhausted',
      provider: 'Anthropic',
      model: 'claude-haiku-4-5-20251001',
      upstreamStatus: 402,
      retryable: false,
    })
    expect(JSON.stringify(fields)).not.toContain('raw-token-should-not-log')
  })

  it('classifies exhausted token, quota, credit, and budget responses as the same non-retryable safe error', () => {
    for (const message of [
      'Your account is out of tokens for this period.',
      'Insufficient quota remaining.',
      'Billing credit balance exhausted.',
      'Monthly budget exceeded.',
    ]) {
      const err = classifyProviderFailure('Anthropic', 'claude-haiku-4-5-20251001', {
        status: 402,
        error: { error: { type: 'insufficient_quota', message } },
      })

      expect(err).toMatchObject({
        code: 'fact_extraction_quota_exhausted',
        retryable: false,
        provider: 'Anthropic',
        model: 'claude-haiku-4-5-20251001',
      })
      expect(err?.message).toBe('Fact extraction is out of tokens. The memory was not saved.')
    }
  })

  it('normalizes direct and nested code-only or message-only quota exhaustion signals', () => {
    for (const err of [
      { code: 'insufficient_quota' },
      { message: 'Your account is out of credits.' },
      { error: { code: 'billing_hard_limit_reached' } },
      { error: { error: { message: 'Token budget exceeded.' } } },
    ]) {
      expect(classifyProviderFailure('OpenAI', 'gpt-5.4', err)).toMatchObject({
        code: 'fact_extraction_quota_exhausted',
        retryable: false,
      })
    }
  })

  it('keeps rate-limit classification for non-quota 429 responses', () => {
    expect(classifyProviderFailure('OpenAI', 'gpt-5.4', { status: 429, message: 'Too many requests.' }))
      .toMatchObject({ code: 'extraction_provider_rate_limited', retryable: true })
  })

  it('normalizes an otherwise unclassified provider response without exposing its payload', () => {
    const err = classifyProviderFailure('OpenAI', 'gpt-5.4', {
      status: 502,
      message: 'upstream response carried secret provider diagnostics',
    })

    expect(err).toMatchObject({
      code: 'fact_extraction_provider_unavailable',
      retryable: true,
      message: 'Fact extraction provider is unavailable. The memory was not saved.',
    })
    expect(err?.message).not.toContain('secret provider diagnostics')
  })
})
