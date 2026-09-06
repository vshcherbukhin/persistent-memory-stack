import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  adapter: vi.fn(),
  client: vi.fn(),
  settingsUpsert: vi.fn(),
  userCount: vi.fn(),
  userCreate: vi.fn(),
  teamWrite: vi.fn(),
  teamGrantWrite: vi.fn(),
  disconnect: vi.fn(),
  hash: vi.fn(),
  randomBytes: vi.fn(),
  writeFile: vi.fn(),
  chmod: vi.fn(),
}))

vi.mock('@prisma/adapter-pg', () => ({
  PrismaPg: class {
    constructor(options: unknown) { mocks.adapter(options) }
  },
}))
vi.mock('../../../generated/prisma/client.ts', () => ({
  PrismaClient: class {
    constructor(options: unknown) { mocks.client(options) }
    systemSettings = { upsert: mocks.settingsUpsert }
    appUser = { count: mocks.userCount, create: mocks.userCreate }
    // Any access to these models fails the test; seed owns no team/grant writes.
    team = new Proxy({}, { get: () => mocks.teamWrite })
    teamGrant = new Proxy({}, { get: () => mocks.teamGrantWrite })
    $disconnect = mocks.disconnect
  },
}))
vi.mock('argon2', () => ({ default: { argon2id: 2, hash: mocks.hash } }))
vi.mock('node:crypto', () => ({ randomBytes: mocks.randomBytes }))
vi.mock('node:fs/promises', () => ({ writeFile: mocks.writeFile, chmod: mocks.chmod }))

type Row = Record<string, unknown>
let settings: Row | null
let users: Row[]

beforeEach(() => {
  vi.resetAllMocks()
  settings = null
  users = []
  for (const [key, value] of Object.entries({
    DATABASE_MIGRATE_URL: 'postgresql://placeholder:placeholder@database.invalid/mock',
    DATABASE_URL: 'postgresql://placeholder:placeholder@runtime.invalid/mock',
    TOKEN_PEPPER: 'mock-pepper',
    BOOTSTRAP_SUPERUSER_EMAIL: 'bootstrap@example.invalid',
    BOOTSTRAP_SUPERUSER_NAME: 'Mock Bootstrap Admin',
    BOOTSTRAP_TOKEN_OUTPUT_PATH: '/virtual/mock-bootstrap-token.txt',
    ARGON2_MEMORY_KIB: '19456',
    ARGON2_TIME_COST: '2',
    ARGON2_PARALLELISM: '1',
    EMBED_MODEL: 'mock-embed-model',
    EMBED_DIM: '2560',
    EMBEDDING_MODE: 'server',
    EXTRACTION_PROVIDER: 'openai',
    EXTRACTION_MODEL: 'mock-extraction-model',
    ANTHROPIC_API_KEY: '',
    OPENAI_API_KEY: '',
  })) vi.stubEnv(key, value)

  mocks.settingsUpsert.mockImplementation(async ({ create, update }: { create: Row; update: Row }) => {
    settings = settings ? { ...settings, ...update } : { ...create }
    return settings
  })
  mocks.userCount.mockImplementation(async () => users.filter((user) => user.adminLevel === 'superuser').length)
  mocks.userCreate.mockImplementation(async ({ data }: { data: Row }) => {
    const user = { id: 'mock-admin-id', ...data }
    users.push(user)
    return user
  })
  mocks.teamWrite.mockImplementation(() => { throw new Error('Bootstrap must not write teams') })
  mocks.teamGrantWrite.mockImplementation(() => { throw new Error('Bootstrap must not write team grants') })
  mocks.hash.mockResolvedValueOnce('$argon2id$mock-token').mockResolvedValueOnce('$argon2id$mock-password')
  let randomByte = 0
  mocks.randomBytes.mockImplementation((size: number) => Buffer.alloc(size, ++randomByte))
  mocks.writeFile.mockResolvedValue(undefined)
  mocks.chmod.mockResolvedValue(undefined)
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

async function runSeed(mode: 'local' | 'server'): Promise<void> {
  vi.stubEnv('DEPLOYMENT_MODE', mode)
  vi.resetModules()
  // The real entrypoint starts main() on import. Wait for its own completion
  // boundary, including the failure path, instead of polling or sleeping.
  const disconnected = new Promise<void>((resolve) => {
    mocks.disconnect.mockImplementationOnce(async () => { resolve() })
  })
  await import('../../../layers/core/schema/seed.ts')
  await disconnected
  await Promise.resolve()
  expect(console.error).not.toHaveBeenCalled()
  expect(process.exit).not.toHaveBeenCalled()
  expect(mocks.teamWrite).not.toHaveBeenCalled()
  expect(mocks.teamGrantWrite).not.toHaveBeenCalled()
}

describe('bootstrap seed entrypoint', () => {
  it('creates only settings in local mode and leaves local identity to the API', async () => {
    await runSeed('local')

    expect(mocks.settingsUpsert).toHaveBeenCalledExactlyOnceWith({
      where: { id: 'singleton' },
      update: {},
      create: {
        id: 'singleton',
        embeddingMode: 'server',
        activeEmbedModel: 'mock-embed-model',
        activeEmbedDim: 2560,
        factExtractionProvider: 'openai',
        factExtractionModel: 'mock-extraction-model',
        factExtractionAnthropicApiKey: null,
        factExtractionOpenaiApiKey: null,
      },
    })
    expect(mocks.userCount).not.toHaveBeenCalled()
    expect(mocks.userCreate).not.toHaveBeenCalled()
    expect(mocks.randomBytes).not.toHaveBeenCalled()
    expect(mocks.hash).not.toHaveBeenCalled()
    expect(mocks.writeFile).not.toHaveBeenCalled()
    expect(mocks.chmod).not.toHaveBeenCalled()
    expect(mocks.disconnect).toHaveBeenCalledOnce()
  })

  it('creates settings and one teamless bootstrap admin on a fresh server', async () => {
    await runSeed('server')

    expect(mocks.adapter).toHaveBeenCalledExactlyOnceWith({
      connectionString: 'postgresql://placeholder:placeholder@database.invalid/mock',
    })
    expect(mocks.settingsUpsert).toHaveBeenCalledOnce()
    expect(mocks.userCount).toHaveBeenCalledExactlyOnceWith({ where: { adminLevel: 'superuser' } })
    expect(mocks.userCreate).toHaveBeenCalledExactlyOnceWith({ data: {
      teamId: null,
      adminLevel: 'superuser',
      tokenId: Buffer.alloc(8, 1).toString('base64url'),
      tokenHash: '$argon2id$mock-token',
      tokenExpires: null,
      tokenIssuedAt: expect.any(Date),
      email: 'bootstrap@example.invalid',
      displayName: 'Mock Bootstrap Admin',
      passwordHash: '$argon2id$mock-password',
      passwordTemporary: true,
    } })
    expect(mocks.hash).toHaveBeenCalledTimes(2)
    const token = `${Buffer.alloc(8, 1).toString('base64url')}.${Buffer.alloc(32, 2).toString('base64url')}`
    expect(mocks.writeFile).toHaveBeenCalledExactlyOnceWith('/virtual/mock-bootstrap-token.txt', `${token}\n`, { mode: 0o600 })
    expect(mocks.chmod).toHaveBeenCalledExactlyOnceWith('/virtual/mock-bootstrap-token.txt', 0o600)
    expect(mocks.disconnect).toHaveBeenCalledOnce()
  })

  it('preserves saved settings and admin credentials without reminting on repeated server runs', async () => {
    await runSeed('server')
    settings = { ...settings, activeEmbedModel: 'operator-saved-model', factExtractionModel: 'operator-saved-extraction' }
    users[0]!.displayName = 'Operator-renamed admin'
    const savedSettings = { ...settings }
    const savedUser = { ...users[0] }
    const randomCalls = mocks.randomBytes.mock.calls.length
    vi.stubEnv('EMBED_MODEL', 'different-installer-model')

    await runSeed('server')

    expect(settings).toEqual(savedSettings)
    expect(users).toEqual([savedUser])
    expect(mocks.settingsUpsert).toHaveBeenCalledTimes(2)
    expect(mocks.settingsUpsert.mock.calls[1]![0].update).toEqual({})
    expect(mocks.userCount).toHaveBeenCalledTimes(2)
    expect(mocks.userCreate).toHaveBeenCalledOnce()
    expect(mocks.randomBytes).toHaveBeenCalledTimes(randomCalls)
    expect(mocks.hash).toHaveBeenCalledTimes(2)
    expect(mocks.writeFile).toHaveBeenCalledOnce()
    expect(mocks.chmod).toHaveBeenCalledOnce()
    expect(mocks.disconnect).toHaveBeenCalledTimes(2)
    expect(vi.mocked(console.log).mock.calls.filter(([line]) => String(line).includes('BOOTSTRAP SUPERUSER CREDENTIALS'))).toHaveLength(1)
  })
})
