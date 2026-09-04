import { describe, it, expect, vi } from 'vitest'

vi.mock('@pm/db', () => ({
  ownerPrisma: {
    appUser: {
      findUnique: vi.fn(),
    },
  },
}))

import { createLocalAuthLimiter } from '../src/routes/local-auth.ts'

describe('local dashboard auth limiter', () => {
  it('locks an IP after five failed password attempts and resets on success', () => {
    let now = 1_000
    const limiter = createLocalAuthLimiter({ now: () => now, maxFailures: 5, windowMs: 60_000 })

    for (let i = 0; i < 5; i++) {
      expect(limiter.isLimited('127.0.0.1')).toBe(false)
      limiter.recordFailure('127.0.0.1')
    }

    expect(limiter.isLimited('127.0.0.1')).toBe(true)
    expect(limiter.isLimited('127.0.0.2')).toBe(false)

    limiter.recordSuccess('127.0.0.1')
    expect(limiter.isLimited('127.0.0.1')).toBe(false)

    limiter.recordFailure('127.0.0.1')
    now += 60_001
    expect(limiter.isLimited('127.0.0.1')).toBe(false)
  })
})
