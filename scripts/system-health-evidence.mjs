/** Pure, fail-loud measurement helpers used by the isolated System Health run. */

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b)
  if (sorted.length === 0) return null
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]
}

export function isCanonicalUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

function summarizeTimings(values) {
  const nonNegative = values.filter((value) => Number.isInteger(value) && value >= 0)
  if (nonNegative.length === 0) return null
  return { p50: percentile(nonNegative, 0.5), p95: percentile(nonNegative, 0.95), max: Math.max(...nonNegative) }
}

export function summarizeOperation(name, samples) {
  if (!name || !Array.isArray(samples) || samples.length === 0) throw new Error('Operation name and at least one sample are required.')
  const successful = samples.filter((sample) => !sample.error)
  return {
    name,
    samples: samples.length,
    acknowledgementMs: summarizeTimings(samples.map((sample) => sample.acknowledgementMs)),
    convergenceMs: summarizeTimings(successful.map((sample) => sample.convergenceMs)),
    successCount: successful.length,
    failureCount: samples.length - successful.length,
  }
}

function key(row) {
  return `${row.service}\u0000${row.model}`
}

function counter(row, field) {
  if (!Number.isInteger(row?.[field]) || row[field] < 0) throw new Error(`Invalid ${field} counter.`)
  return row[field]
}

/**
 * Produce a non-overlapping before/after usage window. The caller chooses
 * disjoint windows (e.g. GraphUsageEvent for graph write vs rollup delta for
 * embeddings/fact extraction); this helper refuses counter reset or a new row
 * whose baseline cannot be proven.
 */
export function aggregateUsageWindow(operation, before, after) {
  const baseline = new Map(before.map((row) => [key(row), row]))
  return after.map((row) => {
    const prior = baseline.get(key(row))
    if (!prior) throw new Error(`Usage row ${row.service}/${row.model} is missing from the baseline.`)
    const delta = {}
    for (const field of ['requests', 'tokensIn', 'tokensOut']) {
      const value = counter(row, field) - counter(prior, field)
      if (value < 0) throw new Error(`Usage counter moved backwards for ${row.service}/${row.model}.`)
      delta[field] = value
    }
    return { operation, service: row.service, model: row.model, ...delta }
  }).filter((row) => row.requests > 0 || row.tokensIn > 0 || row.tokensOut > 0)
}
