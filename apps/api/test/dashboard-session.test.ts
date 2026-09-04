import { describe, it, expect, beforeEach, vi } from 'vitest'

const h = vi.hoisted(() => ({
  pepper: 'dashboard-session-test-pepper',
  now: 1_725_000_000_000,
  userRow: null as Record<string, unknown> | null,
  lastFindUniqueWhere: undefined as unknown,
}))

vi.mock('../src/config.ts', () => ({
  config: {
    TOKEN_PEPPER: h.pepper,
  },
}))

vi.mock('@pm/db', () => ({
  ownerPrisma: {
    appUser: {
      findUnique: vi.fn(async (args: { where: unknown }) => {
        h.lastFindUniqueWhere = args.where
        return h.userRow
      }),
    },
  },
}))

import {
  issueDashboardSession,
  verifyDashboardSession,
  isDashboardSessionToken,
} from '../src/auth/dashboard-session.ts'

function user(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'user-1',
    teamId: 'team-1',
    adminLevel: 'admin',
    passwordChangedAt: new Date(h.now - 60_000),
    ...overrides,
  }
}

beforeEach(() => {
  h.userRow = null
  h.lastFindUniqueWhere = undefined
  h.now = 1_725_000_000_000
})

describe('dashboard session tokens', () => {
  it('issues a signed short-lived dashboard session and resolves it by user id', async () => {
    h.userRow = user()
    const token = issueDashboardSession({ userId: 'user-1', nowMs: h.now, ttlSeconds: 300 })

    expect(isDashboardSessionToken(token)).toBe(true)
    const resolved = await verifyDashboardSession(token, { nowMs: h.now + 1_000 })

    expect(resolved?.id).toBe('user-1')
    expect(h.lastFindUniqueWhere).toEqual({ id: 'user-1' })
  })

  it('rejects tampered or expired dashboard sessions', async () => {
    h.userRow = user()
    const token = issueDashboardSession({ userId: 'user-1', nowMs: h.now, ttlSeconds: 1 })
    const tampered = token.replace(/.$/, (last) => (last === 'a' ? 'b' : 'a'))

    expect(await verifyDashboardSession(tampered, { nowMs: h.now })).toBeNull()
    expect(await verifyDashboardSession(token, { nowMs: h.now + 2_000 })).toBeNull()
  })

  it('rejects sessions issued before the user changed password', async () => {
    h.userRow = user({ passwordChangedAt: new Date(h.now + 5_000) })
    const token = issueDashboardSession({ userId: 'user-1', nowMs: h.now, ttlSeconds: 300 })

    expect(await verifyDashboardSession(token, { nowMs: h.now + 6_000 })).toBeNull()
  })
})
