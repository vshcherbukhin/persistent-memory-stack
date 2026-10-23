import { describe, expect, it, vi } from 'vitest'
import { MemoryImportRequestError, runMemoryImport } from './memoryImportRunner'
import { readApiErrorPayload } from './apiErrorPayload'
import { memoryImportTransportError } from './memoryImportError'
import { createMemoryToolsStore } from './memoryToolsStore'

const imported = { imported: 1, embedded: 1, pending: 0, errors: 0, details: [] }

describe('memory import recovery', () => {
  it('preserves schema paths and distinguishes a rejected request from an unknown outcome', async () => {
    const failure = readApiErrorPayload({ error: 'validation_error', issues: [{ instancePath: '/memories/0/shape', message: 'Invalid option: expected a known shape' }] }, 400)
    expect(failure.message).toContain('/memories/0/shape: Invalid option')
    const outcome = await runMemoryImport(['a'], vi.fn().mockRejectedValue(new MemoryImportRequestError(failure.message, true)), vi.fn())
    expect(outcome.interrupted).toMatchObject({ index: 1, rejected: true, message: failure.message })
  })
  it('acknowledges each row, preserves global error indices, and continues past row failures', async () => {
    const write = vi.fn().mockResolvedValueOnce(imported).mockResolvedValueOnce({
      imported: 0, embedded: 0, pending: 0, errors: 1,
      details: [{ index: 1, stage: 'safety_scan', message: 'Scanner unavailable' }],
    }).mockResolvedValueOnce(imported)
    const progress = vi.fn()
    const outcome = await runMemoryImport(['a', 'b', 'c'], write, progress)
    expect(write.mock.calls).toEqual([[['a']], [['b']], [['c']]])
    expect(progress.mock.calls.map(([value]) => value.completed)).toEqual([1, 2, 3])
    expect(outcome.result).toMatchObject({ imported: 2, embedded: 2, errors: 1, details: [{ index: 2 }] })
  })

  it('stops on a lost response without retrying and resumes only unconfirmed rows', async () => {
    const write = vi.fn().mockResolvedValueOnce(imported).mockRejectedValueOnce(new Error('HTTP 503 · unavailable'))
    const interrupted = await runMemoryImport(['a', 'b', 'c'], write, vi.fn())
    expect(write).toHaveBeenCalledTimes(2)
    expect(interrupted).toMatchObject({ completed: 1, result: { imported: 1 }, interrupted: { index: 2, message: 'HTTP 503 · unavailable' } })
    const resume = vi.fn().mockResolvedValue(imported)
    const finished = await runMemoryImport(['a', 'b', 'c'], resume, vi.fn(), interrupted)
    expect(resume.mock.calls).toEqual([[['b']], [['c']]])
    expect(finished).toMatchObject({ completed: 3, result: { imported: 3 } })
    expect(finished.interrupted).toBeUndefined()
  })

  it('reports the actual nested headers timeout and its unknown write outcome', () => {
    const error = new TypeError('fetch failed', { cause: Object.assign(new Error('Headers Timeout Error'), { code: 'UND_ERR_HEADERS_TIMEOUT' }) })
    expect(memoryImportTransportError(error)).toContain('UND_ERR_HEADERS_TIMEOUT')
    expect(memoryImportTransportError(error)).toContain('may still be processing')
  })

  it('keeps updates while a tool is unmounted and isolates spaces and browser sessions', () => {
    const session = createMemoryToolsStore()
    const render = vi.fn()
    const unsubscribe = session.subscribe(render)
    session.set('personal:import.progress', 0, 1)
    unsubscribe()
    session.set('personal:import.progress', 0, (previous) => previous + 1)
    expect(render).toHaveBeenCalledTimes(1)
    expect(session.get('personal:import.progress', 0)).toBe(2)
    expect(session.get('shared:import.progress', 0)).toBe(0)
    expect(createMemoryToolsStore().get('personal:import.progress', 0)).toBe(0)
  })
})
