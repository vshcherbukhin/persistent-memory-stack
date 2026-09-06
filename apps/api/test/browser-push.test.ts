import { describe, expect, it, vi } from 'vitest'
import {
  browserPushWriteData,
  deliverBrowserPushRows,
  getOrCreateVapidConfig,
  isExpiredPushSubscriptionError,
} from '../src/services/browser-push.ts'

describe('browser push VAPID config', () => {
  it('generates VAPID keys once and reuses the persisted config', async () => {
    const created: unknown[] = []
    const store = {
      current: null as null | { publicKey: string; privateKey: string; subject: string },
      async read() {
        return this.current
      },
      async create(input: { publicKey: string; privateKey: string; subject: string }) {
        created.push(input)
        this.current = input
        return input
      },
    }
    const generate = vi
      .fn()
      .mockReturnValueOnce({ publicKey: 'public-1', privateKey: 'private-1' })
      .mockReturnValueOnce({ publicKey: 'public-2', privateKey: 'private-2' })

    await expect(getOrCreateVapidConfig(store, generate, 'mailto:test@example.com')).resolves.toMatchObject({
      publicKey: 'public-1',
      privateKey: 'private-1',
      subject: 'mailto:test@example.com',
    })
    await expect(getOrCreateVapidConfig(store, generate, 'mailto:other@example.com')).resolves.toMatchObject({
      publicKey: 'public-1',
      privateKey: 'private-1',
      subject: 'mailto:test@example.com',
    })

    expect(generate).toHaveBeenCalledTimes(1)
    expect(created).toHaveLength(1)
  })
})

describe('browser push subscription data', () => {
  it('normalizes selected notification types while preserving endpoint keys separately', () => {
    expect(
      browserPushWriteData({
        endpoint: 'https://push.example.test/sub',
        keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
        types: ['memoryAdded', 'bad-type', 'securityAlerts'],
        userId: 'user-1',
        teamId: 'team-1',
        userAgent: 'Chrome',
      }),
    ).toEqual({
      endpoint: 'https://push.example.test/sub',
      p256dh: 'p256dh-key',
      auth: 'auth-key',
      notificationTypes: ['memoryAdded', 'securityAlerts'],
      userId: 'user-1',
      teamId: 'team-1',
      userAgent: 'Chrome',
      enabled: true,
    })

    expect(browserPushWriteData({
      endpoint: 'https://push.example.test/sub',
      keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
      types: [],
      userId: 'user-1',
      teamId: 'team-1',
    }).notificationTypes).toEqual([])
  })
})

describe('browser push delivery', () => {
  it('sends release notices without a separate event preference while respecting disabled browser subscriptions', async () => {
    const enabled = { id: 'enabled', endpoint: 'https://push.example.test/enabled', p256dh: 'a', auth: 'b', enabled: true, notificationTypes: [] }
    const disabled = { ...enabled, id: 'disabled', endpoint: 'https://push.example.test/disabled', enabled: false }
    const send = vi.fn(async () => {})
    expect(await deliverBrowserPushRows([enabled, disabled], { type: 'newReleases', title: 'Update available' }, send, async () => {})).toBe(1)
    expect(send).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ endpoint: enabled.endpoint }), expect.any(String))
  })

  it('filters by enabled type and removes expired subscriptions', async () => {
    const sent: string[] = []
    const removed: string[] = []
    const rows = [
      { id: 'send', endpoint: 'https://push.example.test/send', p256dh: 'a', auth: 'b', enabled: true, notificationTypes: ['securityAlerts'] },
      { id: 'wrong-type', endpoint: 'https://push.example.test/wrong', p256dh: 'a', auth: 'b', enabled: true, notificationTypes: ['memoryAdded'] },
      { id: 'disabled', endpoint: 'https://push.example.test/disabled', p256dh: 'a', auth: 'b', enabled: false, notificationTypes: ['securityAlerts'] },
      { id: 'gone', endpoint: 'https://push.example.test/gone', p256dh: 'a', auth: 'b', enabled: true, notificationTypes: ['securityAlerts'] },
    ]

    const attempted = await deliverBrowserPushRows(rows, {
      type: 'securityAlerts',
      title: 'Security alert detected',
      body: 'Review the dashboard.',
      url: '/security',
    }, async (subscription, payload) => {
      sent.push(`${subscription.endpoint}:${JSON.parse(payload).title}`)
      if (subscription.endpoint.endsWith('/gone')) {
        throw Object.assign(new Error('expired'), { statusCode: 410 })
      }
    }, async (id) => {
      removed.push(id)
    })

    expect(attempted).toBe(2)
    expect(sent).toEqual([
      'https://push.example.test/send:Security alert detected',
      'https://push.example.test/gone:Security alert detected',
    ])
    expect(removed).toEqual(['gone'])
  })

  it('recognizes push-service 404 and 410 responses as expired subscriptions', () => {
    expect(isExpiredPushSubscriptionError({ statusCode: 404 })).toBe(true)
    expect(isExpiredPushSubscriptionError({ statusCode: 410 })).toBe(true)
    expect(isExpiredPushSubscriptionError({ statusCode: 500 })).toBe(false)
    expect(isExpiredPushSubscriptionError(new Error('network'))).toBe(false)
  })

  it('omits replacement tags by default and preserves explicit tags', async () => {
    const payloads: unknown[] = []
    const row = { id: 'send', endpoint: 'https://push.example.test/send', p256dh: 'a', auth: 'b', enabled: true, notificationTypes: ['memoryAdded'] }

    await deliverBrowserPushRows([row], {
      type: 'memoryAdded',
      title: 'Memory added',
      body: 'A personal memory was added.',
      url: '/memories',
    }, async (_subscription, payload) => {
      payloads.push(JSON.parse(payload))
    }, async () => {})

    await deliverBrowserPushRows([row], {
      type: 'memoryAdded',
      title: 'Memory added',
      tag: 'browser-push-enabled',
    }, async (_subscription, payload) => {
      payloads.push(JSON.parse(payload))
    }, async () => {})

    expect(payloads[0]).not.toHaveProperty('tag')
    expect(payloads[1]).toMatchObject({ tag: 'browser-push-enabled' })
  })
})
