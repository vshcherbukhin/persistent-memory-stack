import { beforeEach, describe, expect, it, vi } from 'vitest'
import { handleMemoryUpdateResult } from './memoryUpdateResult'

const mocked = vi.hoisted(() => {
  class ApiError extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
      message: string,
      readonly details?: string,
    ) {
      super(message)
      this.name = 'ApiError'
    }
  }

  return {
    ApiError,
    updateMemory: vi.fn(),
    dpUpdateMemory: vi.fn(),
    requireSession: vi.fn(),
    canAccessControlPlane: vi.fn(),
  }
})

vi.mock('@/lib/api', () => ({
  ApiError: mocked.ApiError,
  api: {
    updateMemory: mocked.updateMemory,
    dpUpdateMemory: mocked.dpUpdateMemory,
  },
  normalizeMemorySurface: (surface: unknown) => surface === 'shared' ? 'shared' : 'personal',
}))

vi.mock('@/lib/session', () => ({
  requireSession: mocked.requireSession,
  requireControlPlane: vi.fn(),
  isSuperuser: vi.fn(),
}))

vi.mock('@/lib/authz', () => ({
  canAccessControlPlane: mocked.canAccessControlPlane,
}))

import { updateMemoryAction } from '../app/(dashboard)/memories/actions'

describe('memory update error handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocked.requireSession.mockResolvedValue({ adminLevel: 'superuser' })
    mocked.canAccessControlPlane.mockReturnValue(true)
  })

  it('returns an expected API conflict as serializable Server Action data', async () => {
    mocked.updateMemory.mockRejectedValue(new mocked.ApiError(
      409,
      'project_graph_history_immutable',
      'Project history is immutable after graph sync. Create a new memory in the target project instead.',
    ))

    await expect(updateMemoryAction({
      id: 'memory-id',
      project: 'target-project',
      surface: 'personal',
    })).resolves.toEqual({
      ok: false,
      error: 'Project history is immutable after graph sync. Create a new memory in the target project instead.',
    })
    expect(mocked.updateMemory).toHaveBeenCalledOnce()
  })

  it('still throws unexpected failures for error reporting', async () => {
    mocked.updateMemory.mockRejectedValue(new Error('unexpected failure'))

    await expect(updateMemoryAction({
      id: 'memory-id',
      content: 'updated content',
      surface: 'personal',
    })).rejects.toThrow('unexpected failure')
  })

  it('toasts the error without running editor close or refresh callbacks', async () => {
    const onError = vi.fn()
    const onSuccess = vi.fn()

    await expect(handleMemoryUpdateResult(
      { ok: false, error: 'Keep this actionable message.' },
      onError,
      onSuccess,
    )).resolves.toBe(false)

    expect(onError).toHaveBeenCalledWith('Keep this actionable message.')
    expect(onSuccess).not.toHaveBeenCalled()
  })

  it('runs editor close and refresh callbacks only after success', async () => {
    const onError = vi.fn()
    const onSuccess = vi.fn().mockResolvedValue(undefined)

    await expect(handleMemoryUpdateResult(
      { ok: true },
      onError,
      onSuccess,
    )).resolves.toBe(true)

    expect(onError).not.toHaveBeenCalled()
    expect(onSuccess).toHaveBeenCalledOnce()
  })
})
