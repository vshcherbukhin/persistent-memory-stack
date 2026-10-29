import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CorpusShapePanel } from '../app/(dashboard)/OverviewPanels'
import { overviewMemorySummary } from './overviewSummary'

describe('Overview partial read fallbacks', () => {
  it('does not claim the corpus is empty after a supplementary read failure', () => {
    const result = overviewMemorySummary({ memoryCount: 961, recentAvailable: false, recentSummary: null, pendingAvailable: true, pendingCount: 0 })
    expect(result).toBe('Recent memory activity is temporarily unavailable')
    expect(result).not.toContain('No memories yet')
  })
  it('distinguishes an unavailable queue, no recent writes, and a known empty corpus', () => {
    const input = { memoryCount: 1, recentAvailable: true, recentSummary: null, pendingAvailable: true, pendingCount: 0 }
    expect(overviewMemorySummary(input)).toBe('No recent writes recorded')
    expect(overviewMemorySummary({ ...input, memoryCount: 0 })).toContain('No memories yet')
    expect(overviewMemorySummary({ ...input, pendingAvailable: false })).toBe('Embedding queue is temporarily unavailable')
    expect(overviewMemorySummary({ ...input, recentSummary: '+2 in the last 24h', pendingCount: 2 })).toBe('+2 in the last 24h · 2 awaiting embedding')
  })
  it('does not diagnose the graph service as unreachable from an unavailable distribution read', () => {
    const html = renderToStaticMarkup(createElement(CorpusShapePanel, { badges: [], unavailable: true }))
    expect(html).toContain('temporarily unavailable')
    expect(html).not.toContain('graph service is unreachable')
  })
})
