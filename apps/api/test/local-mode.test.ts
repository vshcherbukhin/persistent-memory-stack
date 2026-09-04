/**
 * Local deployment mode (Phase 13, #Part5) — the database-backed identity + the boot
 * upsert. The auth-hook SELECTION (server→authenticate, local→authenticateLocal) is
 * a boot-time branch in app.ts proven by the live local-mode smoke; here we pin the
 * identity shape + that ensureLocalIdentity seeds and records the local team + super-user.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const db = vi.hoisted(() => ({
  localIdentityFindUnique: vi.fn(),
  localIdentityCreate: vi.fn(),
  teamFindUnique: vi.fn(),
  teamFindFirst: vi.fn(),
  appUserFindFirst: vi.fn(),
  teamUpsert: vi.fn(),
  teamCreate: vi.fn(),
  teamUpdate: vi.fn(),
  appUserFindUnique: vi.fn(),
  appUserCreate: vi.fn(),
  appUserUpdate: vi.fn(),
}))
const cfg = vi.hoisted(() => ({
  value: {
    LOCAL_TEAM_NAME: 'QA',
    LOCAL_USER_EMAIL: 'engineer@example.test',
    LOCAL_USER_DISPLAY_NAME: 'Example Engineer',
    LOCAL_USER_PASSWORD: '',
    LOCAL_USER_PASSWORD_CONFIGURED_AT: '',
    TOKEN_PEPPER: 'local-mode-test-pepper',
    ARGON2_MEMORY_KIB: 1024,
    ARGON2_TIME_COST: 1,
    ARGON2_PARALLELISM: 1,
  },
}))
vi.mock('@pm/db', () => ({
  ownerPrisma: {
    localIdentity: { findUnique: db.localIdentityFindUnique, create: db.localIdentityCreate },
    team: {
      findUnique: db.teamFindUnique,
      findFirst: db.teamFindFirst,
      upsert: db.teamUpsert,
      create: db.teamCreate,
      update: db.teamUpdate,
    },
    appUser: {
      findFirst: db.appUserFindFirst,
      findUnique: db.appUserFindUnique,
      create: db.appUserCreate,
      update: db.appUserUpdate,
    },
  },
}))
vi.mock('../src/config.ts', () => ({ config: cfg.value }))

import { localIdentity, ensureLocalIdentity } from '../src/auth/local-mode.ts'
import { readWhoamiProfile } from '../src/routes/whoami.ts'

const SEEDED_TEAM_ID = '8b96adbb-35d5-48b8-9b33-39c70f3f88cb'
const SEEDED_USER_ID = '94ad7cf6-ef23-45c8-b67c-3ab4652dbfc0'
const SEEDED_TEAM_NAME = 'Example Memory Team'
const SEEDED_USER_NAME = 'Example Engineer'
const SEEDED_USER_EMAIL = 'engineer@example.test'

function mockLocalIdentityRow(overrides: Record<string, unknown> = {}) {
  db.localIdentityFindUnique.mockResolvedValue({
    teamId: SEEDED_TEAM_ID,
    userId: SEEDED_USER_ID,
    user: {
      id: SEEDED_USER_ID,
      teamId: SEEDED_TEAM_ID,
      adminLevel: 'superuser',
      passwordHash: '$argon2id$old',
      passwordChangedAt: null,
      passwordTemporary: false,
      ...overrides,
    },
  })
}

describe('localIdentity', () => {
  beforeEach(() => {
    for (const fn of Object.values(db)) fn.mockReset()
    cfg.value.LOCAL_USER_PASSWORD = ''
    cfg.value.LOCAL_USER_PASSWORD_CONFIGURED_AT = ''
  })

  it('uses the seeded database user/team ids instead of code defaults', async () => {
    mockLocalIdentityRow()

    const id = await localIdentity()

    expect(id.userId).toBe(SEEDED_USER_ID)
    expect(id.teamId).toBe(SEEDED_TEAM_ID) // member of a real team → requireTeamMember passes
    expect(id.adminLevel).toBe('superuser')
    expect(id.isTeamMember).toBe(true)
    expect(id.isGlobalSuperuser).toBe(true)
    expect(id.isTeamAdmin).toBe(false)
    expect(id.mountedTeamIds).toEqual([])
    expect(id.insideTenantTx).toBe(false)
    expect(db.localIdentityFindUnique).toHaveBeenCalledOnce()
  })
})

describe('ensureLocalIdentity', () => {
  beforeEach(() => {
    for (const fn of Object.values(db)) fn.mockReset()
    cfg.value.LOCAL_USER_PASSWORD = ''
    cfg.value.LOCAL_USER_PASSWORD_CONFIGURED_AT = ''
    db.localIdentityFindUnique.mockResolvedValue(null)
    db.appUserFindFirst.mockResolvedValue(null)
  })

  it('creates generated DB rows and records their actual ids as the local identity', async () => {
    db.teamUpsert.mockResolvedValue({ id: SEEDED_TEAM_ID, name: SEEDED_TEAM_NAME })
    db.appUserCreate.mockResolvedValue({ id: SEEDED_USER_ID, teamId: SEEDED_TEAM_ID })

    const id = await ensureLocalIdentity()

    expect(id.userId).toBe(SEEDED_USER_ID)
    expect(id.teamId).toBe(SEEDED_TEAM_ID)
    expect(db.teamUpsert).toHaveBeenCalledOnce()
    expect(db.teamUpsert.mock.calls[0]![0].create).not.toHaveProperty('id')
    expect(db.appUserCreate).toHaveBeenCalledOnce()
    const u = db.appUserCreate.mock.calls[0]![0]
    expect(u.data).not.toHaveProperty('id')
    expect(u.data.teamId).toBe(SEEDED_TEAM_ID)
    expect(u.data.adminLevel).toBe('superuser')
    expect(db.localIdentityCreate).toHaveBeenCalledWith({
      data: { id: 'singleton', teamId: SEEDED_TEAM_ID, userId: SEEDED_USER_ID },
    })
  })

  it('applies a newer onboarding password to an existing local identity', async () => {
    cfg.value.LOCAL_USER_PASSWORD = 'new-local-password'
    cfg.value.LOCAL_USER_PASSWORD_CONFIGURED_AT = '2026-02-03T04:05:06.000Z'
    mockLocalIdentityRow({ passwordChangedAt: new Date('2026-02-03T04:04:00.000Z') })

    await ensureLocalIdentity()

    expect(db.appUserUpdate).toHaveBeenCalledWith({
      where: { id: SEEDED_USER_ID },
      data: expect.objectContaining({
        passwordHash: expect.stringContaining('$argon2id$'),
        passwordTemporary: false,
        passwordChangedAt: new Date('2026-02-03T04:05:06.000Z'),
      }),
    })
  })

  it('applies a legacy onboarding password once when the local password was never timestamped', async () => {
    cfg.value.LOCAL_USER_PASSWORD = 'legacy-env-password'
    cfg.value.LOCAL_USER_PASSWORD_CONFIGURED_AT = ''
    mockLocalIdentityRow({ passwordChangedAt: null })

    await ensureLocalIdentity()

    expect(db.appUserUpdate).toHaveBeenCalledWith({
      where: { id: SEEDED_USER_ID },
      data: expect.objectContaining({
        passwordHash: expect.stringContaining('$argon2id$'),
        passwordTemporary: false,
        passwordChangedAt: expect.any(Date),
      }),
    })
  })

  it('does not clear an existing legacy password when no onboarding password is present', async () => {
    cfg.value.LOCAL_USER_PASSWORD = ''
    cfg.value.LOCAL_USER_PASSWORD_CONFIGURED_AT = ''
    mockLocalIdentityRow({ passwordChangedAt: null })

    await ensureLocalIdentity()

    expect(db.appUserUpdate).not.toHaveBeenCalled()
  })

  it('does not reapply an older onboarding password over a dashboard profile change', async () => {
    cfg.value.LOCAL_USER_PASSWORD = 'stale-env-password'
    cfg.value.LOCAL_USER_PASSWORD_CONFIGURED_AT = '2026-02-03T04:05:06.000Z'
    mockLocalIdentityRow({ passwordChangedAt: new Date('2026-02-03T04:06:00.000Z') })

    await ensureLocalIdentity()

    expect(db.appUserUpdate).not.toHaveBeenCalled()
  })
})

describe('readWhoamiProfile', () => {
  beforeEach(() => {
    for (const fn of Object.values(db)) fn.mockReset()
  })

  it('returns the seeded human local user/team values instead of only synthetic ids', async () => {
    db.teamFindUnique.mockResolvedValue({ name: SEEDED_TEAM_NAME })
    db.appUserFindUnique.mockResolvedValue({ displayName: SEEDED_USER_NAME, email: SEEDED_USER_EMAIL })

    const profile = await readWhoamiProfile({
      userId: SEEDED_USER_ID,
      teamId: SEEDED_TEAM_ID,
      adminLevel: 'superuser',
      isTeamMember: true,
      isTeamAdmin: false,
      isGlobalSuperuser: true,
      mountedTeamIds: [],
      insideTenantTx: false,
    })

    expect(profile).toEqual({
      teamName: SEEDED_TEAM_NAME,
      userDisplayName: SEEDED_USER_NAME,
      userEmail: SEEDED_USER_EMAIL,
    })
    expect(db.teamFindUnique.mock.calls[0]![0].where.id).toBe(SEEDED_TEAM_ID)
    expect(db.appUserFindUnique.mock.calls[0]![0].where.id).toBe(SEEDED_USER_ID)
  })
})
