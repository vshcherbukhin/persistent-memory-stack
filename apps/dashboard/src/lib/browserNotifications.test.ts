import { afterEach, describe, expect, it, vi } from 'vitest'
import { enableBrowserNotifications } from './browserNotifications'

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) },
    removeItem: (key) => { values.delete(key) },
    clear: () => { values.clear() },
    key: (index) => [...values.keys()][index] ?? null,
    get length() { return values.size },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('enableBrowserNotifications', () => {
  it('waits for the active service worker before subscribing on a fresh install', async () => {
    const inactiveSubscribe = vi.fn().mockRejectedValue(new Error('Subscription failed - no active Service Worker'))
    const activeSubscribe = vi.fn().mockResolvedValue({
      toJSON: () => ({
        endpoint: 'https://push.example.test/subscription',
        expirationTime: null,
        keys: { p256dh: 'key', auth: 'auth' },
      }),
    })
    const inactiveRegistration = {
      pushManager: {
        getSubscription: vi.fn().mockResolvedValue(null),
        subscribe: inactiveSubscribe,
      },
    }
    const activeRegistration = {
      active: { state: 'activated' },
      pushManager: {
        getSubscription: vi.fn().mockResolvedValue(null),
        subscribe: activeSubscribe,
      },
    }
    const serviceWorker = {
      register: vi.fn().mockResolvedValue(inactiveRegistration),
      getRegistration: vi.fn().mockResolvedValue(undefined),
      ready: Promise.resolve(activeRegistration),
    }

    vi.stubGlobal('window', {
      Notification: { permission: 'granted', requestPermission: vi.fn() },
      PushManager: class PushManager {},
      atob: (value: string) => atob(value),
      localStorage: memoryStorage(),
    })
    vi.stubGlobal('navigator', { serviceWorker, userAgent: 'vitest' })
    vi.stubGlobal('Notification', { permission: 'granted', requestPermission: vi.fn() })
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(Response.json({ publicKey: 'AQ' }))
      .mockResolvedValueOnce(Response.json({}))
      .mockResolvedValueOnce(Response.json({})))

    await expect(enableBrowserNotifications(['memoryAdded'])).resolves.toBeUndefined()

    expect(inactiveSubscribe).not.toHaveBeenCalled()
    expect(activeSubscribe).toHaveBeenCalledOnce()
    expect(serviceWorker.register).toHaveBeenCalledWith('/pm-sw.js')
  })
})
