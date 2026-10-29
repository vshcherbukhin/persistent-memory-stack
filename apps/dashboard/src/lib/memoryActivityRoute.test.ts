import { beforeEach, describe, expect, it, vi } from 'vitest'

const { memoryActivity, requireSession } = vi.hoisted(() => ({ memoryActivity: vi.fn(), requireSession: vi.fn() }))
vi.mock('@/lib/api', () => ({
  api: { memoryActivity },
  ApiError: class extends Error {},
  UnauthorizedError: class extends Error {},
  ForbiddenError: class extends Error {},
}))
vi.mock('@/lib/session', () => ({ requireSession }))

import { GET } from '../app/api/memory-activity/route'

beforeEach(() => {
  memoryActivity.mockReset()
  requireSession.mockReset()
  requireSession.mockResolvedValue({ userId: 'fixture-owner' })
})

describe('authenticated activity proxy', () => {
  it('requires a session and forwards only the summary with no caching and request cancellation', async () => {
    const summary = { read: { active: 0, state: 'idle', lastCompletedAt: null }, write: { active: 1, state: 'active', lastCompletedAt: null }, update: { active: 0, state: 'starting', lastCompletedAt: null } }
    memoryActivity.mockResolvedValue(summary)
    const request = new Request('http://localhost/api/memory-activity')
    const response = await GET(request)
    expect(requireSession).toHaveBeenCalledOnce()
    expect(memoryActivity).toHaveBeenCalledWith(request.signal)
    expect(requireSession.mock.invocationCallOrder[0]).toBeLessThan(memoryActivity.mock.invocationCallOrder[0])
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual(summary)
  })

  it('does not call the backend without an authenticated dashboard session', async () => {
    requireSession.mockRejectedValue(new Error('login required'))
    await expect(GET(new Request('http://localhost/api/memory-activity'))).rejects.toThrow('login required')
    expect(memoryActivity).not.toHaveBeenCalled()
  })

  it('returns an unavailable response without leaking backend error details', async () => {
    memoryActivity.mockRejectedValue(new Error('private failure details'))
    const response = await GET(new Request('http://localhost/api/memory-activity'))
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'memory_activity_unavailable' })
  })
})
