import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  listProjectScopes: vi.fn(),
  dpListMemories: vi.fn(),
}))

vi.mock('@/lib/session', () => ({
  requireSession: mocks.requireSession,
  isSuperuser: () => false,
}))
vi.mock('@/lib/api', () => ({
  normalizeMemorySurface: () => 'personal',
  api: {
    listProjectScopes: mocks.listProjectScopes,
    dpListMemories: mocks.dpListMemories,
  },
}))
vi.mock('../app/(dashboard)/memories/MemoriesClient', () => ({ MemoriesClient: () => null }))

import MemoriesPage from '../app/(dashboard)/memories/page'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.requireSession.mockResolvedValue({ adminLevel: 'none', teamId: 'test-team' })
  mocks.listProjectScopes.mockResolvedValue([])
  mocks.dpListMemories.mockResolvedValue({ results: [], total: 0, nextCursor: null, badges: [] })
})

afterEach(() => vi.unstubAllEnvs())

describe('Memory Graph availability', () => {
  it.each([
    [undefined, true],
    ['true', true],
    ['false', false],
  ] as const)('renders an empty member memory page with flag %s as enabled=%s', async (flag, enabled) => {
    vi.stubEnv('PM_MEMORY_GRAPH_UI_ENABLED', flag)

    const page = await MemoriesPage({})

    expect(page.props.graphEnabled).toBe(enabled)
    expect(page.props.initialTotal).toBe(0)
    expect(page.props.isAdmin).toBe(false)
    expect(mocks.dpListMemories).toHaveBeenCalledExactlyOnceWith({ limit: 50 }, 'personal')
  })
})
