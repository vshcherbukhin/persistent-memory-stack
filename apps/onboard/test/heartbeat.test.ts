import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IdleLifecycle } from '../server/idle-lifecycle.ts'
import { startWizardHeartbeat } from '../web/src/heartbeat.ts'

class Page extends EventTarget {
  visibilityState = 'visible'

  visibility(state: 'visible' | 'hidden'): void {
    this.visibilityState = state
    this.dispatchEvent(new Event('visibilitychange'))
  }
}

let cleanup: (() => void) | undefined

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
})

afterEach(() => {
  cleanup?.()
  cleanup = undefined
  vi.useRealTimers()
})

describe('visible wizard heartbeat', () => {
  it('keeps the wizard alive during more than 30 minutes of visible form filling', async () => {
    const page = new Page()
    const idle = new IdleLifecycle()
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => {
      idle.touch()
      return new Response('{}')
    })
    cleanup = startWizardHeartbeat({ page, fetchImpl })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    for (let minute = 0; minute < 45; minute++) {
      await vi.advanceTimersByTimeAsync(60_000)
      expect(idle.shouldExit()).toBe(false)
    }
    expect(fetchImpl).toHaveBeenCalledTimes(46)
    expect(fetchImpl.mock.calls.every(([url, options]) =>
      url === '/healthz' && options?.method === 'GET' && options.cache === 'no-store' && !options.body,
    )).toBe(true)
  })

  it('sends nothing for hidden pages, then pings immediately when visible', async () => {
    const page = new Page()
    page.visibilityState = 'hidden'
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'))
    cleanup = startWizardHeartbeat({ page, fetchImpl })
    await vi.advanceTimersByTimeAsync(31 * 60_000)
    expect(fetchImpl).not.toHaveBeenCalled()
    page.visibility('visible')
    expect(fetchImpl).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(0)
    page.visibility('hidden')
    await vi.advanceTimersByTimeAsync(31 * 60_000)
    expect(fetchImpl).toHaveBeenCalledOnce()
    page.visibility('visible')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('lets the idle server expire once the wizard is hidden', async () => {
    const page = new Page()
    const idle = new IdleLifecycle()
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => {
      idle.touch()
      return new Response('{}')
    })
    cleanup = startWizardHeartbeat({ page, fetchImpl })
    await vi.advanceTimersByTimeAsync(0)
    page.visibility('hidden')
    await vi.advanceTimersByTimeAsync(31 * 60_000)
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(idle.shouldExit()).toBe(true)
  })

  it('absorbs network rejections and retries on the next interval', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Failed to fetch'))
    cleanup = startWizardHeartbeat({ page: new Page(), fetchImpl })
    await vi.advanceTimersByTimeAsync(3 * 60_000)
    expect(fetchImpl).toHaveBeenCalledTimes(4)
  })

  it('prevents overlap and aborts a request that lasts five seconds', async () => {
    const page = new Page()
    let firstSignal: AbortSignal | null | undefined
    const fetchImpl = vi.fn<typeof fetch>()
      .mockImplementationOnce((_url, options) => new Promise((_resolve, reject) => {
        firstSignal = options?.signal
        firstSignal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      }))
      .mockResolvedValue(new Response('{}'))
    cleanup = startWizardHeartbeat({ page, fetchImpl })
    page.visibility('hidden')
    page.visibility('visible')
    expect(fetchImpl).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(4999)
    expect(firstSignal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(firstSignal?.aborted).toBe(true)
    page.visibility('visible')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('cleanup aborts the active request and removes the timer and visibility listener', async () => {
    const page = new Page()
    const removeListener = vi.spyOn(page, 'removeEventListener')
    let signal: AbortSignal | null | undefined
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      signal = options?.signal
      signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    }))
    cleanup = startWizardHeartbeat({ page, fetchImpl })
    cleanup()
    expect(signal?.aborted).toBe(true)
    expect(removeListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function))
    page.visibility('visible')
    await vi.advanceTimersByTimeAsync(31 * 60_000)
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
})
