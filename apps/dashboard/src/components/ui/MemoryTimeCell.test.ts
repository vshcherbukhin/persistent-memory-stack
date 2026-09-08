import { expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryTimeCell } from './MemoryTimeCell'

it('renders the same hydration snapshot across server and browser time zones', () => {
  const originalZone = process.env.TZ
  try {
    const outputs = ['UTC', 'America/Toronto', 'Asia/Tokyo'].map(zone => {
      process.env.TZ = zone
      return renderToStaticMarkup(createElement(MemoryTimeCell, { value: '2026-09-08T01:15:00.000Z' }))
    })
    expect(new Set(outputs).size).toBe(1)
    expect(outputs[0]).toContain('dateTime="2026-09-08T01:15:00.000Z">2026-09-08</time>')
  } finally {
    if (originalZone === undefined) delete process.env.TZ
    else process.env.TZ = originalZone
  }
})

it('keeps invalid dates from breaking server rendering', () => {
  expect(renderToStaticMarkup(createElement(MemoryTimeCell, { value: 'invalid' }))).toContain('>Unknown</time>')
})
