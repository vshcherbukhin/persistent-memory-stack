import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { preGate } from '../src/protocol/validation.ts'

interface FactExampleInput {
  content: string
  metadata: Record<string, unknown>
}

interface FactExampleOutput {
  outcome: 'accept' | 'restructure' | 'reject'
  facts: string[]
  restructured_content: string
  reason: string
  missing: string[]
}

const factPrompt = readFileSync(new URL('../../../prompts/fact-extraction.md', import.meta.url), 'utf8')
const graphPrompt = readFileSync(new URL('../../../prompts/graph-extraction.md', import.meta.url), 'utf8')

function examples<T>(prompt: string, label: 'Input' | 'Output'): T[] {
  const lines = prompt.split(/\r?\n/u)
  const parsed: T[] = []
  for (const [index, line] of lines.entries()) {
    if (line.trim() !== `${label}:`) continue
    const jsonLine = lines.slice(index + 1).find((candidate) => candidate.trim() !== '')
    if (!jsonLine) throw new Error(`${label} at line ${index + 1} has no JSON payload`)
    parsed.push(JSON.parse(jsonLine) as T)
  }
  return parsed
}

describe('extraction prompt examples', () => {
  it('keeps every fact few-shot structurally valid and shape-consistent', () => {
    const inputs = examples<FactExampleInput>(factPrompt, 'Input')
    const outputs = examples<FactExampleOutput>(factPrompt, 'Output')

    expect(inputs).toHaveLength(outputs.length)
    expect(inputs.length).toBeGreaterThanOrEqual(7)

    for (const [index, output] of outputs.entries()) {
      expect(Object.keys(output)).toEqual([
        'outcome',
        'facts',
        'restructured_content',
        'reason',
        'missing',
      ])
      if (output.outcome === 'accept') {
        expect(output.facts).toEqual([inputs[index]!.content])
        expect(output.restructured_content).toBe('')
        expect(output.reason).toBe('')
        expect(output.missing).toEqual([])
      } else if (output.outcome === 'restructure') {
        expect(output.facts).toEqual([output.restructured_content])
        expect(output.restructured_content).not.toBe('')
        expect(output.reason).toBe('')
        expect(output.missing).toEqual([])
      } else {
        expect(output.facts).toEqual([])
        expect(output.restructured_content).toBe('')
        expect(output.reason).not.toBe('')
        expect(output.missing.length).toBeGreaterThan(0)
      }
    }

    const prdExample = inputs.find((input) => input.content.includes('[prd_audit_export]'))
    expect(prdExample).toBeDefined()
    expect(preGate(prdExample!.content, prdExample!.metadata)).toEqual([])
  })

  it('keeps graph few-shots concrete, neutral, and inside the closed relation set', () => {
    expect(graphPrompt).toContain('tool_inventory_api_helper')
    expect(graphPrompt).toContain('prd_inventory_report -[gated_by]-> flag_enable_inventory_report')
    expect(graphPrompt).toContain('test_TC_6596 -[tests]-> modal_create_workspace_modal')

    const allowedRelations = new Set([
      'uses', 'depends_on', 'imports', 'extends', 'contains', 'has_child', 'part_of',
      'creates', 'builds', 'generates', 'requires', 'blocked_by', 'caused_by',
      'replaces', 'migrated_from', 'equivalent_to', 'configured_with', 'defaults_to',
      'overrides', 'gated_by', 'has_permission', 'validates', 'accepts', 'rejects',
      'tests', 'runs_on',
    ])
    const emittedRelations = [...graphPrompt.matchAll(/-\[([a-z_]+)\]->/gu)].map((match) => match[1]!)

    expect(emittedRelations.length).toBeGreaterThan(5)
    expect(emittedRelations.every((relation) => allowedRelations.has(relation))).toBe(true)
  })
})
