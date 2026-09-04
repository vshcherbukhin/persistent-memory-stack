import { describe, expect, it } from 'vitest'
import { aggregateRecallMeasurements, measureRecallResult } from './recall-context-metrics.ts'

const fact = {
  uuid: 'fact-1',
  name: 'DEPENDS_ON',
  fact: 'Alpha depends on Beta.',
  source_name: 'Alpha',
  target_name: 'Beta',
}

describe('recall_context benchmark metrics', () => {
  it('measures legacy duplicate fact occupancy and bytes', () => {
    const measurement = measureRecallResult({
      content: [{ type: 'text', text: 'legacy' }],
      structuredContent: {
        graph: { facts: [fact] },
        entities: [{ name: 'Alpha', facts: [fact] }],
        timeline: { entries: [{ ...fact, status: 'valid' }] },
        contradictions: { results: [{ superseded: fact, superseded_by: null }] },
      },
    })

    expect(measurement.responseSchemaVersion).toBe(1)
    expect(measurement.factOccurrences).toBe(4)
    expect(measurement.uniqueFacts).toBe(1)
    expect(measurement.duplicateOccurrences).toBe(3)
    expect(measurement.duplicateOccupancy).toBe(0.75)
    expect(measurement.duplicateFactBytes).toBeGreaterThan(0)
    expect(measurement.estimatedTokens).toBeGreaterThan(0)
  })

  it('measures a v2 fact registry and reports dangling references', () => {
    const measurement = measureRecallResult({
      content: [{ type: 'text', text: 'v2' }],
      structuredContent: {
        schemaVersion: 2,
        facts: { 'fact-1': fact },
        graph: { factRefs: ['fact-1'] },
        entities: [{ name: 'Alpha', factRefs: ['fact-1', 'missing'] }],
        timeline: { entries: [{ factRef: 'fact-1', status: 'valid' }] },
        contradictions: { results: [] },
      },
    })

    expect(measurement.factOccurrences).toBe(4)
    expect(measurement.uniqueFacts).toBe(1)
    expect(measurement.danglingFactRefs).toEqual(['missing'])
    expect(measurement.duplicateFactBytes).toBe(0)
  })

  it('aggregates byte, token, duplicate, and integrity measurements', () => {
    const first = measureRecallResult({ structuredContent: { graph: { facts: [fact] } } })
    const second = measureRecallResult({ structuredContent: { graph: { facts: [fact, fact] } } })
    const aggregate = aggregateRecallMeasurements([first, second])

    expect(aggregate.samples).toBe(2)
    expect(aggregate.resultBytes.total).toBe(first.resultBytes + second.resultBytes)
    expect(aggregate.estimatedTokens.total).toBe(first.estimatedTokens + second.estimatedTokens)
    expect(aggregate.facts.duplicates).toBe(1)
    expect(aggregate.danglingFactRefs).toBe(0)
  })
})
