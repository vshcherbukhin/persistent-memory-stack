import { describe, expect, it } from 'vitest'
import { idleSessionIds } from '../src/http-idle.ts'

describe('Streamable HTTP idle timeout', () => {
  it('selects sessions idle beyond the configured timeout', () => {
    const nowMs = 1_000_000
    const sessions = new Map([
      ['fresh', { lastRequestAt: nowMs - 899_000 }],
      ['idle', { lastRequestAt: nowMs - 900_000 }],
    ])

    expect(idleSessionIds(sessions, 900, nowMs)).toEqual(['idle'])
    expect(idleSessionIds(sessions, 0, nowMs)).toEqual([])
  })
})
