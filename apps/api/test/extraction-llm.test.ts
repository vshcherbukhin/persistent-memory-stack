/**
 * Extraction-LLM defaults + OpenAI Structured Outputs selection (Phase: extraction
 * quality). Pure helpers only — no live LLM call.
 */
import { describe, it, expect } from 'vitest'
import { resolveExtractionModel, VERDICT_SCHEMA_STRICT } from '../src/protocol/llm/client.ts'
import { chooseResponseFormat } from '../src/protocol/llm/openai-compat.ts'

describe('resolveExtractionModel — quality-first defaults', () => {
  it('defaults to Haiku 4.5 (anthropic) / gpt-4o (openai)', () => {
    expect(resolveExtractionModel('anthropic')).toBe('claude-haiku-4-5-20251001')
    expect(resolveExtractionModel('openai')).toBe('gpt-4o')
  })
  it('EXTRACTION_MODEL overrides the default', () => {
    expect(resolveExtractionModel('anthropic', 'claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5-20251001')
    expect(resolveExtractionModel('openai', 'gpt-5.4')).toBe('gpt-5.4')
    expect(resolveExtractionModel('anthropic', '  ')).toBe('claude-haiku-4-5-20251001') // blank → default
  })
})

describe('chooseResponseFormat — strict OpenAI vs Ollama fallback', () => {
  it('real OpenAI (no base URL) → strict json_schema with the verdict schema', () => {
    const rf = chooseResponseFormat({} as NodeJS.ProcessEnv) as {
      type: string
      json_schema: { strict: boolean; schema: { required: string[]; additionalProperties: boolean } }
    }
    expect(rf.type).toBe('json_schema')
    expect(rf.json_schema.strict).toBe(true)
    // strict mode requires EVERY property in `required` (incl. suggestion)
    expect(rf.json_schema.schema.required).toContain('suggestion')
    expect(rf.json_schema.schema.additionalProperties).toBe(false)
  })
  it('custom endpoint (Ollama at EXTRACTION_BASE_URL) → json_object fallback', () => {
    const rf = chooseResponseFormat({ EXTRACTION_BASE_URL: 'http://host.docker.internal:11434/v1' } as unknown as NodeJS.ProcessEnv) as { type: string }
    expect(rf.type).toBe('json_object')
  })
})

describe('VERDICT_SCHEMA_STRICT', () => {
  it('is OpenAI-strict compatible (suggestion required + nullable, no extra props)', () => {
    expect(VERDICT_SCHEMA_STRICT.required).toContain('suggestion')
    expect(VERDICT_SCHEMA_STRICT.additionalProperties).toBe(false)
    expect(VERDICT_SCHEMA_STRICT.properties.suggestion.type).toEqual(['string', 'null'])
  })
})
