import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ importMemories: vi.fn(), requireSession: vi.fn(), confirmBulkDelete: vi.fn() }))
vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    constructor(readonly status: number, readonly code: string, message: string, readonly details?: string) { super(message) }
  }
  return {
    api: { importMemories: mocks.importMemories, dpConfirmBulkDeleteMemories: mocks.confirmBulkDelete }, ApiError,
    UnauthorizedError: class extends Error {}, ForbiddenError: class extends Error {},
    normalizeMemorySurface: (value: unknown) => value === 'shared' ? 'shared' : 'personal',
  }
})
vi.mock('@/lib/session', () => ({ requireSession: mocks.requireSession, requireControlPlane: vi.fn(), isSuperuser: vi.fn() }))

import { ApiError } from '@/lib/api'
import { bulkDeleteAction, importMemoriesAction } from '../app/(dashboard)/memories/actions'

describe('import Server Action error contract', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireSession.mockResolvedValue({ adminLevel: 'admin' })
  })

  it('returns the server code and message as data instead of a production-redacted exception', async () => {
    mocks.importMemories.mockRejectedValue(new ApiError(422, 'invalid_import', 'Row shape is invalid', 'row 1'))
    await expect(importMemoriesAction([{ content: 'example' }])).resolves.toEqual({ ok: false, error: 'HTTP 422 · invalid_import: Row shape is invalid (row 1)', rejected: true })
  })

  it('returns nested timeout causes to the browser', async () => {
    mocks.importMemories.mockRejectedValue(new TypeError('fetch failed', { cause: { code: 'UND_ERR_HEADERS_TIMEOUT' } }))
    expect(await importMemoriesAction([{}])).toMatchObject({ ok: false, error: expect.stringContaining('UND_ERR_HEADERS_TIMEOUT') })
  })

  it('checks authorization before submitting rows', async () => {
    mocks.requireSession.mockResolvedValue({ adminLevel: 'none' })
    expect(await importMemoriesAction([{}])).toEqual({ ok: false, error: 'Import requires admin.', rejected: true })
    expect(mocks.importMemories).not.toHaveBeenCalled()
  })

  it('shows the actual stale bulk-delete preview error after restoring a review', async () => {
    mocks.confirmBulkDelete.mockRejectedValue(new ApiError(409, 'preview_expired', 'Preview expired. Review the live scope again.'))
    expect(await bulkDeleteAction({ previewToken: 'expired' })).toEqual({ ok: false, error: 'Preview expired. Review the live scope again.' })
  })

  it('returns a row result and strips source team identity on the personal surface', async () => {
    const result = { imported: 1, embedded: 1, pending: 0, errors: 0, details: [] }
    mocks.importMemories.mockResolvedValue(result)
    expect(await importMemoriesAction([{ id: 'example', teamId: 'old-team' }], 'old-team', 'persistent-memory-stack')).toEqual({ ok: true, result })
    expect(mocks.importMemories).toHaveBeenCalledWith([{ id: 'example' }], undefined, 'persistent-memory-stack', 'personal')
  })
})
