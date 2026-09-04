/**
 * Unit matrix for token verification + identity derivation (auth/token-service.ts).
 *
 * These exercise the REAL argon2id verify path against REAL stored hashes, but
 * stub the two side-effecting imports the module pulls in at load time:
 *   • ../config.ts — would Zod-validate process.env (requires DATABASE_URL etc).
 *   • @pm/db        — would open two Postgres pools (prisma.ts was migrated to
 *                     @pm/db in Phase 6). We hand it a fake ownerPrisma whose
 *                     findUnique/findMany we drive per test.
 *
 * Covered: parseToken/extractBearer edge cases; verifyToken valid / expired /
 * wrong-secret / unknown-tokenId / revoked / malformed-header / malformed-hash;
 * deriveIdentity (the new TenantCtx — nullable team + role booleans; reads are
 * universal so there is no readable-team set to resolve).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import argon2 from 'argon2'

// ── Shared, per-test-mutable fixtures driving the fake ownerPrisma. ──────────
const TEST_PEPPER = 'unit-test-pepper'

const h = vi.hoisted(() => {
  return {
    pepper: 'unit-test-pepper',
    // The single user row findUnique({ where: { tokenId } }) resolves to.
    userRow: null as Record<string, unknown> | null,
    // The team_grant rows resolveMountedTeams' findMany resolves to.
    grantRows: [] as { grantorTeamId: string }[],
    // Captured arg the code passed to findUnique (assert O(1) tokenId lookup).
    lastFindUniqueWhere: undefined as unknown,
    lastUpdateArgs: undefined as { where: unknown; data: Record<string, unknown> } | undefined,
  }
})

vi.mock('../src/config.ts', () => ({
  config: {
    TOKEN_PEPPER: h.pepper,
    ARGON2_MEMORY_KIB: 19456,
    ARGON2_TIME_COST: 2,
    ARGON2_PARALLELISM: 1,
  },
}))

vi.mock('@pm/db', () => ({
  ownerPrisma: {
    appUser: {
      findUnique: vi.fn(async (args: { where: unknown }) => {
        h.lastFindUniqueWhere = args.where
        return h.userRow
      }),
      update: vi.fn(async (args: { where: unknown; data: Record<string, unknown> }) => {
        h.lastUpdateArgs = args
        return { id: (args.where as { id?: string }).id ?? 'user-1', ...args.data }
      }),
    },
    teamGrant: {
      findMany: vi.fn(async () => h.grantRows),
    },
  },
}))

// Import AFTER the mocks are registered.
import {
  parseToken,
  extractBearer,
  verifyToken,
  issueToken,
  revokeToken,
  resolveMountedTeams,
  deriveIdentity,
} from '../src/auth/token-service.ts'
import { issueDashboardSession } from '../src/auth/dashboard-session.ts'

// argon2id params mirrored from layers/core/schema/seed.ts (verify reads params from the
// stored hash, so these only matter for producing a verifiable fixture).
const argonOptions: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
}

/** Build a stored tokenHash exactly as the seed/dashboard minting path would. */
async function hashSecret(secret: string): Promise<string> {
  return argon2.hash(secret + TEST_PEPPER, argonOptions)
}

/** A baseline valid AppUser row with a known secret already hashed in. */
async function makeUser(
  overrides: Partial<Record<string, unknown>> = {},
  secret = 'good-secret-value',
): Promise<Record<string, unknown>> {
  return {
    id: 'user-1',
    teamId: 'team-own',
    adminLevel: 'none',
    tokenId: 'tok123',
    tokenHash: await hashSecret(secret),
    tokenExpires: null,
    ...overrides,
  }
}

beforeEach(() => {
  h.userRow = null
  h.grantRows = []
  h.lastFindUniqueWhere = undefined
  h.lastUpdateArgs = undefined
})

// ── parseToken / extractBearer ───────────────────────────────────────────────
describe('parseToken — split on FIRST dot only', () => {
  it('splits a well-formed token', () => {
    expect(parseToken('abc.def')).toEqual({ tokenId: 'abc', secret: 'def' })
  })
  it('keeps later dots inside the secret', () => {
    expect(parseToken('abc.def.ghi')).toEqual({ tokenId: 'abc', secret: 'def.ghi' })
  })
  it('rejects undefined / empty', () => {
    expect(parseToken(undefined)).toBeNull()
    expect(parseToken('')).toBeNull()
  })
  it('rejects no dot, leading dot, trailing dot', () => {
    expect(parseToken('nodot')).toBeNull()
    expect(parseToken('.leading')).toBeNull()
    expect(parseToken('trailing.')).toBeNull()
  })
})

describe('extractBearer — strip a case-insensitive Bearer prefix', () => {
  it('extracts and trims', () => {
    expect(extractBearer('Bearer abc.def')).toBe('abc.def')
    expect(extractBearer('bearer   abc.def  ')).toBe('abc.def')
  })
  it('returns undefined for missing / non-bearer headers', () => {
    expect(extractBearer(undefined)).toBeUndefined()
    expect(extractBearer('Basic abc.def')).toBeUndefined()
  })
})

// ── verifyToken matrix (the four the task names + defense-in-depth cases). ───
describe('verifyToken', () => {
  it('VALID token → returns the AppUser, looked up O(1) by tokenId', async () => {
    h.userRow = await makeUser({ tokenId: 'tok123' }, 'good-secret-value')

    const user = await verifyToken('Bearer tok123.good-secret-value')

    expect(user).not.toBeNull()
    expect((user as { id: string }).id).toBe('user-1')
    // Proves the lookup keyed on the indexed tokenId, not a row scan.
    expect(h.lastFindUniqueWhere).toEqual({ tokenId: 'tok123' })
  })

  it('WRONG-SECRET → null (argon2 verify fails)', async () => {
    h.userRow = await makeUser({ tokenId: 'tok123' }, 'good-secret-value')
    expect(await verifyToken('Bearer tok123.WRONG-secret')).toBeNull()
  })

  it('EXPIRED token → null (tokenExpires in the past)', async () => {
    h.userRow = await makeUser(
      { tokenId: 'tok123', tokenExpires: new Date(Date.now() - 60_000) },
      'good-secret-value',
    )
    expect(await verifyToken('Bearer tok123.good-secret-value')).toBeNull()
  })

  it('future-expiry token still VALID', async () => {
    h.userRow = await makeUser(
      { tokenId: 'tok123', tokenExpires: new Date(Date.now() + 3_600_000) },
      'good-secret-value',
    )
    expect(await verifyToken('Bearer tok123.good-secret-value')).not.toBeNull()
  })

  it('UNKNOWN tokenId → null (findUnique returns no row)', async () => {
    h.userRow = null
    expect(await verifyToken('Bearer ghost.whatever')).toBeNull()
  })

  it('REVOKED (tokenHash NULLed) → null without running argon2', async () => {
    h.userRow = await makeUser({ tokenId: 'tok123' }, 'good-secret-value')
    h.userRow.tokenHash = null
    expect(await verifyToken('Bearer tok123.good-secret-value')).toBeNull()
  })

  it('malformed / missing Authorization header → null (no DB hit)', async () => {
    expect(await verifyToken(undefined)).toBeNull()
    expect(await verifyToken('Bearer not-a-valid-token')).toBeNull()
    expect(await verifyToken('Basic tok123.good-secret-value')).toBeNull()
  })

  it('garbage stored hash → null, never throws (treated as denial, not 500)', async () => {
    h.userRow = await makeUser({ tokenId: 'tok123' }, 'good-secret-value')
    h.userRow.tokenHash = 'not-a-real-argon2-hash'
    await expect(verifyToken('Bearer tok123.good-secret-value')).resolves.toBeNull()
  })
})

describe('issueToken / revokeToken', () => {
  it('records a real issue timestamp when minting a token', async () => {
    const expiresAt = new Date(Date.now() + 3_600_000)
    const before = Date.now()

    const issued = await issueToken('user-issue', expiresAt)

    expect(issued.tokenId).toBeTruthy()
    expect(issued.wireToken).toContain('.')
    expect(issued.expiresAt).toBe(expiresAt)
    expect(h.lastUpdateArgs?.where).toEqual({ id: 'user-issue' })
    expect(h.lastUpdateArgs?.data.tokenExpires).toBe(expiresAt)
    expect(h.lastUpdateArgs?.data.tokenIssuedAt).toBeInstanceOf(Date)
    expect((h.lastUpdateArgs?.data.tokenIssuedAt as Date).getTime()).toBeGreaterThanOrEqual(before)
  })

  it('clears the issue timestamp when revoking a token', async () => {
    await revokeToken('user-revoke')

    expect(h.lastUpdateArgs).toEqual({
      where: { id: 'user-revoke' },
      data: { tokenId: null, tokenHash: null, tokenExpires: null, tokenIssuedAt: null },
    })
  })
})

// ── deriveIdentity — the new TenantCtx (nullable team + role booleans). ──────
describe('deriveIdentity', () => {
  it('invalid token → null', async () => {
    h.userRow = null
    expect(await deriveIdentity('Bearer ghost.whatever')).toBeNull()
  })

  it('dashboard session → tenant ctx, using the session user id lookup path', async () => {
    const now = Date.now()
    h.userRow = await makeUser(
      {
        id: 'session-user',
        teamId: 'team-own',
        adminLevel: 'admin',
        passwordChangedAt: new Date(now - 60_000),
      },
      'unused-secret',
    )
    h.grantRows = [{ grantorTeamId: 'team-a' }]
    const session = issueDashboardSession({ userId: 'session-user', nowMs: now, ttlSeconds: 300 })

    const ctx = await deriveIdentity(`Bearer ${session}`)

    expect(h.lastFindUniqueWhere).toEqual({ id: 'session-user' })
    expect(ctx).toEqual({
      userId: 'session-user',
      teamId: 'team-own',
      adminLevel: 'admin',
      isTeamMember: true,
      isTeamAdmin: true,
      isGlobalSuperuser: false,
      mountedTeamIds: ['team-a'],
      insideTenantTx: false,
    })
  })

  it('team-bound admin → isTeamAdmin, mounts resolved', async () => {
    h.userRow = await makeUser(
      { id: 'user-1', teamId: 'team-own', adminLevel: 'admin', tokenId: 'tok123' },
      'good-secret-value',
    )
    h.grantRows = [{ grantorTeamId: 'team-a' }] // team-own mounts team-a
    const ctx = await deriveIdentity('Bearer tok123.good-secret-value')
    expect(ctx).toEqual({
      userId: 'user-1',
      teamId: 'team-own',
      adminLevel: 'admin',
      isTeamMember: true,
      isTeamAdmin: true,
      isGlobalSuperuser: false,
      mountedTeamIds: ['team-a'],
      insideTenantTx: false,
    })
  })

  it('plain team member → isTeamMember only; no mounts → empty', async () => {
    h.userRow = await makeUser({ teamId: 'team-own', adminLevel: 'none', tokenId: 'tok123' }, 'good-secret-value')
    const ctx = await deriveIdentity('Bearer tok123.good-secret-value')
    expect(ctx?.isTeamMember).toBe(true)
    expect(ctx?.isTeamAdmin).toBe(false)
    expect(ctx?.isGlobalSuperuser).toBe(false)
    expect(ctx?.mountedTeamIds).toEqual([])
  })

  it('team-less super-admin → global, NOT a team member, no mounts', async () => {
    h.userRow = await makeUser({ teamId: null, adminLevel: 'superuser', tokenId: 'tok123' }, 'good-secret-value')
    const ctx = await deriveIdentity('Bearer tok123.good-secret-value')
    expect(ctx?.teamId).toBeNull()
    expect(ctx?.isTeamMember).toBe(false)
    expect(ctx?.isGlobalSuperuser).toBe(true)
    expect(ctx?.mountedTeamIds).toEqual([])
  })
})

describe('resolveMountedTeams', () => {
  it('returns grantor teams (de-duped, own excluded)', async () => {
    h.grantRows = [{ grantorTeamId: 'team-a' }, { grantorTeamId: 'team-a' }, { grantorTeamId: 'team-own' }]
    expect(await resolveMountedTeams('team-own')).toEqual(['team-a'])
  })
  it('no mounts → empty', async () => {
    h.grantRows = []
    expect(await resolveMountedTeams('team-own')).toEqual([])
  })
})
