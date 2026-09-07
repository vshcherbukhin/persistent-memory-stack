import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EMBEDDING_CORPUS_TABLES } from '../../../layers/core/schema/embedding-corpus.js'

const mocks = vi.hoisted(() => ({
  adapter: vi.fn(),
  client: vi.fn(),
  settingsUpsert: vi.fn(),
  settingsFind: vi.fn(),
  transaction: vi.fn(),
  executeRaw: vi.fn(),
  queryRaw: vi.fn(),
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
    systemSettings = { upsert: mocks.settingsUpsert, findUnique: mocks.settingsFind }
    $transaction = mocks.transaction
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
let occupiedTables: string[]

beforeEach(() => {
  vi.resetAllMocks()
  settings = null
  users = []
  occupiedTables = []
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
  mocks.settingsFind.mockImplementation(async () => settings)
  mocks.executeRaw.mockResolvedValue(0)
  mocks.queryRaw.mockImplementation(async () => occupiedTables.map(table_name => ({ table_name })))
  mocks.transaction.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) => {
    const previous = settings ? { ...settings } : null
    try {
      return await run({
        systemSettings: { upsert: mocks.settingsUpsert, findUnique: mocks.settingsFind },
        $executeRawUnsafe: mocks.executeRaw,
        $queryRawUnsafe: mocks.queryRaw,
      })
    } catch (error) {
      settings = previous
      throw error
    }
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

async function runSeed(mode: 'local' | 'server', failure?: RegExp): Promise<void> {
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
  if (failure) {
    expect(console.error).toHaveBeenCalledWith('ERROR: [seed] failed:', expect.objectContaining({ message: expect.stringMatching(failure) }))
    expect(process.exit).toHaveBeenCalledWith(1)
  } else {
    expect(console.error).not.toHaveBeenCalled()
    expect(process.exit).not.toHaveBeenCalled()
  }
  expect(mocks.teamWrite).not.toHaveBeenCalled()
  expect(mocks.teamGrantWrite).not.toHaveBeenCalled()
}

describe('bootstrap seed entrypoint', () => {
  it('creates only settings in local mode and leaves local identity to the API', async () => {
    await runSeed('local')

    expect(mocks.settingsUpsert).toHaveBeenCalledExactlyOnceWith({
      where: { id: 'singleton' },
      update: { embeddingMode: 'server', activeEmbedModel: 'mock-embed-model', activeEmbedDim: 2560 },
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
    settings = { ...settings, factExtractionModel: 'operator-saved-extraction' }
    users[0]!.displayName = 'Operator-renamed admin'
    const savedSettings = { ...settings }
    const savedUser = { ...users[0] }
    const randomCalls = mocks.randomBytes.mock.calls.length
    occupiedTables = ['memory']
    mocks.queryRaw.mockClear()

    await runSeed('server')

    expect(settings).toEqual(savedSettings)
    expect(users).toEqual([savedUser])
    expect(mocks.settingsUpsert).toHaveBeenCalledOnce()
    expect(mocks.queryRaw).not.toHaveBeenCalled()
    expect(mocks.userCount).toHaveBeenCalledTimes(2)
    expect(mocks.userCreate).toHaveBeenCalledOnce()
    expect(mocks.randomBytes).toHaveBeenCalledTimes(randomCalls)
    expect(mocks.hash).toHaveBeenCalledTimes(2)
    expect(mocks.writeFile).toHaveBeenCalledOnce()
    expect(mocks.chmod).toHaveBeenCalledOnce()
    expect(mocks.disconnect).toHaveBeenCalledTimes(2)
    expect(vi.mocked(console.log).mock.calls.filter(([line]) => String(line).includes('BOOTSTRAP SUPERUSER CREDENTIALS'))).toHaveLength(1)
  })

  it('reconciles only the embedding pin on an empty failed-install retry and remains idempotent', async () => {
    await runSeed('server')
    settings = { ...settings, factExtractionModel: 'saved-extraction', factExtractionOpenaiApiKey: 'saved-placeholder', localUserEmail: 'saved@example.invalid' }
    const priorSettings = { ...settings }
    const priorUsers = structuredClone(users)
    vi.stubEnv('EMBED_MODEL', 'text-embedding-3-small')
    vi.stubEnv('EMBED_DIM', '1536')
    vi.stubEnv('OPENAI_API_KEY', 'different-placeholder')
    mocks.settingsUpsert.mockClear()
    mocks.executeRaw.mockClear()
    mocks.queryRaw.mockClear()
    await runSeed('server')

    expect(settings).toEqual({ ...priorSettings, activeEmbedModel: 'text-embedding-3-small', activeEmbedDim: 1536 })
    expect(mocks.settingsUpsert.mock.calls[0]![0].update).toEqual({ embeddingMode: 'server', activeEmbedModel: 'text-embedding-3-small', activeEmbedDim: 1536 })
    expect(users).toEqual(priorUsers)
    expect(mocks.userCreate).toHaveBeenCalledOnce()
    expect(mocks.writeFile).toHaveBeenCalledOnce()
    expect(mocks.hash).toHaveBeenCalledTimes(2)
    const statements = mocks.executeRaw.mock.calls.map(([sql]) => String(sql))
    expect(statements).toEqual([
      "SET LOCAL lock_timeout = '5s'",
      "SET LOCAL statement_timeout = '10s'",
      'SET LOCAL row_security = off',
      'LOCK TABLE public.system_settings IN SHARE ROW EXCLUSIVE MODE',
      `LOCK TABLE ${EMBEDDING_CORPUS_TABLES.map(table => `public."${table}"`).join(', ')} IN SHARE MODE`,
    ])
    for (const table of EMBEDDING_CORPUS_TABLES) expect(mocks.queryRaw.mock.calls[0]![0]).toContain(`EXISTS (SELECT 1 FROM public."${table}")`)
    expect(mocks.executeRaw.mock.invocationCallOrder.at(-1)).toBeLessThan(mocks.queryRaw.mock.invocationCallOrder[0]!)
    expect(mocks.queryRaw.mock.invocationCallOrder[0]).toBeLessThan(mocks.settingsUpsert.mock.invocationCallOrder[0]!)
    expect(mocks.transaction).toHaveBeenLastCalledWith(expect.any(Function), { isolationLevel: 'ReadCommitted', maxWait: 5000, timeout: 15000 })
    await runSeed('server')
    expect(mocks.settingsUpsert).toHaveBeenCalledOnce()
    expect(mocks.queryRaw).toHaveBeenCalledOnce()
  })

  it.each(EMBEDDING_CORPUS_TABLES)('rejects a changed pin when %s retains data or pending work', async (table) => {
    await runSeed('local')
    const previous = { ...settings }
    vi.stubEnv('EMBED_MODEL', 'different-model')
    occupiedTables = [table]
    mocks.settingsUpsert.mockClear()
    await runSeed('server', /Existing memories, documents or graph work prevent changing/)
    expect(settings).toEqual(previous)
    expect(mocks.settingsUpsert).not.toHaveBeenCalled()
    expect(mocks.userCreate).not.toHaveBeenCalled()
    expect(mocks.randomBytes).not.toHaveBeenCalled()
  })

  it('refuses to initialize an unpinned database that already contains corpus data', async () => {
    occupiedTables = ['source']
    await runSeed('local', /Existing memories, documents or graph work/)
    expect(settings).toBeNull()
    expect(mocks.settingsUpsert).not.toHaveBeenCalled()
  })

  it.each([{ state: 'running' }, { state: 'completed' }, {}])('preserves non-null migration state %j when a changed pin is requested', async (embeddingSwitch) => {
    await runSeed('local')
    settings = { ...settings, embeddingSwitch }
    const previous = { ...settings }
    vi.stubEnv('EMBED_DIM', '1024')
    mocks.settingsUpsert.mockClear()
    mocks.queryRaw.mockClear()
    await runSeed('local', /saved embedding pin has migration state/)
    expect(settings).toEqual(previous)
    expect(mocks.settingsUpsert).not.toHaveBeenCalled()
    expect(mocks.queryRaw).not.toHaveBeenCalled()
  })

  it.each(['relation does not exist', 'canceling statement due to lock timeout', 'query would be affected by row-level security policy'])('fails closed when corpus verification fails: %s', async (message) => {
    await runSeed('local')
    const previous = { ...settings }
    vi.stubEnv('EMBED_MODEL', 'different-model')
    mocks.settingsUpsert.mockClear()
    mocks.queryRaw.mockRejectedValueOnce(new Error(message))
    await runSeed('local', new RegExp(message))
    expect(settings).toEqual(previous)
    expect(mocks.settingsUpsert).not.toHaveBeenCalled()
  })

  it('does not inspect or update settings after a lock failure', async () => {
    mocks.executeRaw.mockRejectedValueOnce(new Error('lock timeout'))
    await runSeed('local', /lock timeout/)
    expect(mocks.settingsFind).not.toHaveBeenCalled()
    expect(mocks.queryRaw).not.toHaveBeenCalled()
    expect(mocks.settingsUpsert).not.toHaveBeenCalled()
  })

  it.each(['0', '-1', '2.5', 'not-a-number'])('rejects invalid embedding dimensions before querying the database: %s', async (value) => {
    vi.stubEnv('EMBED_DIM', value)
    await runSeed('local', /positive integer EMBED_DIM/)
    expect(mocks.transaction).not.toHaveBeenCalled()
  })
})
