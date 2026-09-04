import { getEncoding } from 'js-tiktoken'

const O200K = getEncoding('o200k_base')

type UnknownRecord = Record<string, unknown>

export type RecallMeasurement = {
  responseSchemaVersion: number
  resultBytes: number
  structuredBytes: number
  estimatedTokens: number
  planeBytes: {
    memories: number
    facts: number
    graph: number
    entities: number
    timeline: number
    contradictions: number
    followup: number
    summary: number
  }
  factOccurrences: number
  uniqueFacts: number
  duplicateOccurrences: number
  duplicateOccupancy: number
  duplicateFactBytes: number
  danglingFactRefs: string[]
}

export type RecallAggregate = {
  samples: number
  resultBytes: { total: number; p50: number; p95: number; max: number }
  estimatedTokens: { total: number; p50: number; p95: number; max: number }
  facts: {
    occurrences: number
    unique: number
    duplicates: number
    duplicateFactBytes: number
  }
  danglingFactRefs: number
}

function record(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : {}
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value ?? null), 'utf8')
}

function factUuid(value: unknown): string | null {
  const uuid = record(value).uuid
  return typeof uuid === 'string' && uuid.length > 0 ? uuid : null
}

function legacyFactOccurrences(context: UnknownRecord): UnknownRecord[] {
  const graphFacts = array(record(context.graph).facts).map(record)
  const entityFacts = array(context.entities).flatMap((entry) => array(record(entry).facts).map(record))
  const timelineFacts = array(record(context.timeline).entries).map(record)
  const contradictionFacts = array(record(context.contradictions).results).flatMap((item) => {
    const row = record(item)
    return [row.superseded, row.superseded_by].filter(Boolean).map(record)
  })
  return [...graphFacts, ...entityFacts, ...timelineFacts, ...contradictionFacts]
}

function v2FactRefs(context: UnknownRecord): string[] {
  const graphRefs = array(record(context.graph).factRefs)
  const entityRefs = array(context.entities).flatMap((entry) => array(record(entry).factRefs))
  const timelineRefs = array(record(context.timeline).entries).map((entry) => record(entry).factRef)
  const contradictionRefs = array(record(context.contradictions).results).flatMap((item) => {
    const row = record(item)
    return [row.supersededRef, row.supersededByRef].filter(Boolean)
  })
  return [...graphRefs, ...entityRefs, ...timelineRefs, ...contradictionRefs]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? 0
}

export function measureRecallResult(result: {
  content?: unknown
  structuredContent?: unknown
}): RecallMeasurement {
  const context = record(result.structuredContent)
  const schemaVersion = Number(context.schemaVersion ?? 1)
  const factRegistry = record(context.facts)
  const registryIds = new Set(Object.keys(factRegistry))
  const legacyFacts = schemaVersion >= 2 ? [] : legacyFactOccurrences(context)
  const refs = schemaVersion >= 2 ? v2FactRefs(context) : legacyFacts.map(factUuid).filter((id): id is string => Boolean(id))
  const uniqueLegacy = new Map<string, UnknownRecord>()
  for (const fact of legacyFacts) {
    const id = factUuid(fact)
    if (id && !uniqueLegacy.has(id)) uniqueLegacy.set(id, fact)
  }
  const uniqueFacts = schemaVersion >= 2 ? registryIds.size : uniqueLegacy.size
  const factOccurrences = refs.length
  const duplicateOccurrences = Math.max(0, factOccurrences - uniqueFacts)
  const legacyFactBytes = legacyFacts.reduce((total, fact) => total + bytes(fact), 0)
  const uniqueLegacyBytes = [...uniqueLegacy.values()].reduce((total, fact) => total + bytes(fact), 0)
  const danglingFactRefs = schemaVersion >= 2
    ? [...new Set(refs.filter((id) => !registryIds.has(id)))].sort()
    : []
  const serialized = JSON.stringify(result)
  const estimatedTokens = O200K.encode(serialized).length

  return {
    responseSchemaVersion: schemaVersion,
    resultBytes: Buffer.byteLength(serialized, 'utf8'),
    structuredBytes: bytes(context),
    estimatedTokens,
    planeBytes: {
      memories: bytes(context.memories),
      facts: bytes(context.facts),
      graph: bytes(context.graph),
      entities: bytes(context.entities),
      timeline: bytes(context.timeline),
      contradictions: bytes(context.contradictions),
      followup: bytes(context.followup),
      summary: bytes(context.contextSummary),
    },
    factOccurrences,
    uniqueFacts,
    duplicateOccurrences,
    duplicateOccupancy: factOccurrences === 0 ? 0 : duplicateOccurrences / factOccurrences,
    duplicateFactBytes: schemaVersion >= 2 ? 0 : Math.max(0, legacyFactBytes - uniqueLegacyBytes),
    danglingFactRefs,
  }
}

export function aggregateRecallMeasurements(measurements: RecallMeasurement[]): RecallAggregate {
  const resultBytes = measurements.map((measurement) => measurement.resultBytes)
  const estimatedTokens = measurements.map((measurement) => measurement.estimatedTokens)
  return {
    samples: measurements.length,
    resultBytes: {
      total: resultBytes.reduce((sum, value) => sum + value, 0),
      p50: percentile(resultBytes, 0.5),
      p95: percentile(resultBytes, 0.95),
      max: Math.max(0, ...resultBytes),
    },
    estimatedTokens: {
      total: estimatedTokens.reduce((sum, value) => sum + value, 0),
      p50: percentile(estimatedTokens, 0.5),
      p95: percentile(estimatedTokens, 0.95),
      max: Math.max(0, ...estimatedTokens),
    },
    facts: {
      occurrences: measurements.reduce((sum, value) => sum + value.factOccurrences, 0),
      unique: measurements.reduce((sum, value) => sum + value.uniqueFacts, 0),
      duplicates: measurements.reduce((sum, value) => sum + value.duplicateOccurrences, 0),
      duplicateFactBytes: measurements.reduce((sum, value) => sum + value.duplicateFactBytes, 0),
    },
    danglingFactRefs: measurements.reduce((sum, value) => sum + value.danglingFactRefs.length, 0),
  }
}
