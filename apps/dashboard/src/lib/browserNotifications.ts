'use client'

import type { BrowserPushNotificationType, BrowserPushSubscriptionInput } from './types'

export const BROWSER_NOTIFICATION_KEY = 'pm:browserNotifications'
export const LEGACY_LAPTOP_NOTIFICATION_KEY = 'pm:laptopNotifications'
export const BROWSER_NOTIFICATION_TYPES_KEY = 'pm:browserNotificationTypes'

export const PERSONAL_NOTIFICATION_TYPES = [
  { id: 'memoryAdded', label: 'Memory added' },
  { id: 'memoryUpdated', label: 'Memory updated' },
  { id: 'memoryRemoved', label: 'Memory removed' },
  { id: 'securityAlerts', label: 'Security alerts' },
] as const

export type BrowserNotificationType = BrowserPushNotificationType

export const DEFAULT_BROWSER_NOTIFICATION_TYPES = PERSONAL_NOTIFICATION_TYPES.map((option) => option.id)

const NOTIFICATION_SENT_PREFIX = 'pm:browserNotificationSent:'
const SERVICE_WORKER_PATH = '/pm-sw.js'

function storage(): Storage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function browserNotificationsSupported(): boolean {
  return typeof window !== 'undefined'
    && 'Notification' in window
    && 'serviceWorker' in navigator
    && 'PushManager' in window
}

export function migrateLegacyBrowserNotificationSetting(): void {
  const store = storage()
  if (!store) return
  const current = store.getItem(BROWSER_NOTIFICATION_KEY)
  const legacy = store.getItem(LEGACY_LAPTOP_NOTIFICATION_KEY)
  if (current == null && legacy != null) store.setItem(BROWSER_NOTIFICATION_KEY, legacy)
  if (legacy != null) store.removeItem(LEGACY_LAPTOP_NOTIFICATION_KEY)
}

export function readBrowserNotificationsRequested(): boolean {
  const store = storage()
  if (!store) return false
  migrateLegacyBrowserNotificationSetting()
  return store.getItem(BROWSER_NOTIFICATION_KEY) === 'on'
}

export function saveBrowserNotificationsRequested(enabled: boolean): void {
  storage()?.setItem(BROWSER_NOTIFICATION_KEY, enabled ? 'on' : 'off')
}

export function normalizeBrowserNotificationTypes(value: unknown): BrowserNotificationType[] {
  if (!Array.isArray(value)) return DEFAULT_BROWSER_NOTIFICATION_TYPES
  const allowed = new Set<BrowserNotificationType>(PERSONAL_NOTIFICATION_TYPES.map((option) => option.id))
  const next = value.filter((item): item is BrowserNotificationType => allowed.has(item as BrowserNotificationType))
  return next
}

export function readBrowserNotificationTypes(): BrowserNotificationType[] {
  const store = storage()
  if (!store) return DEFAULT_BROWSER_NOTIFICATION_TYPES
  try {
    return normalizeBrowserNotificationTypes(JSON.parse(store.getItem(BROWSER_NOTIFICATION_TYPES_KEY) ?? 'null'))
  } catch {
    return DEFAULT_BROWSER_NOTIFICATION_TYPES
  }
}

export function saveBrowserNotificationTypes(next: BrowserNotificationType[]): void {
  storage()?.setItem(BROWSER_NOTIFICATION_TYPES_KEY, JSON.stringify(normalizeBrowserNotificationTypes(next)))
}

export function canSendBrowserNotification(type: BrowserNotificationType): boolean {
  return browserNotificationsSupported()
    && readBrowserNotificationsRequested()
    && Notification.permission === 'granted'
    && (type === 'newReleases' || readBrowserNotificationTypes().includes(type))
}

function urlBase64ToArrayBuffer(value: string): ArrayBuffer {
  const padding = '='.repeat((4 - (value.length % 4)) % 4)
  const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = window.atob(base64)
  const output = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i)
  return output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength)
}

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...init?.headers,
    },
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { message?: string; error?: string }
    throw new Error(body.message ?? body.error ?? `${path} returned ${res.status}`)
  }
  return (await res.json()) as T
}

async function activeBrowserNotificationServiceWorker(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register(SERVICE_WORKER_PATH)
  return navigator.serviceWorker.ready
}

async function currentSubscription(): Promise<PushSubscription | null> {
  if (!browserNotificationsSupported()) return null
  const registration = await activeBrowserNotificationServiceWorker()
  return registration.pushManager.getSubscription()
}

export async function refreshBrowserNotificationServiceWorker(): Promise<void> {
  if (!browserNotificationsSupported()) return
  const registration = await navigator.serviceWorker.getRegistration(SERVICE_WORKER_PATH)
  if (registration) await registration.update()
}

export async function enableBrowserNotifications(types: BrowserNotificationType[] = readBrowserNotificationTypes()): Promise<void> {
  if (!browserNotificationsSupported()) throw new Error('Browser notifications are not supported by this browser.')
  const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission
  if (permission !== 'granted') throw new Error('Browser notifications were not enabled.')

  const { publicKey } = await apiJson<{ publicKey: string }>('/api/browser-push/public-key')
  const registration = await activeBrowserNotificationServiceWorker()
  const existing = await registration.pushManager.getSubscription()
  const subscription = existing ?? await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToArrayBuffer(publicKey),
  })
  const json = subscription.toJSON()
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    throw new Error('Browser returned an incomplete push subscription.')
  }
  const notificationTypes = normalizeBrowserNotificationTypes(types)
  const body: BrowserPushSubscriptionInput = {
    endpoint: json.endpoint,
    expirationTime: json.expirationTime ?? null,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
    notificationTypes: notificationTypes as BrowserPushNotificationType[],
    userAgent: navigator.userAgent,
  }
  await apiJson('/api/browser-push/subscription', { method: 'PUT', body: JSON.stringify(body) })
  saveBrowserNotificationTypes(notificationTypes)
  saveBrowserNotificationsRequested(true)
  await apiJson('/api/browser-push/test', { method: 'POST' })
}

export async function disableBrowserNotifications(): Promise<void> {
  const subscription = await currentSubscription()
  const endpoint = subscription?.endpoint
  if (subscription) await subscription.unsubscribe().catch(() => false)
  await apiJson('/api/browser-push/subscription', { method: 'DELETE', body: JSON.stringify({ ...(endpoint ? { endpoint } : {}) }) })
  saveBrowserNotificationsRequested(false)
}

export async function updateBrowserNotificationPreferences(types: BrowserNotificationType[]): Promise<void> {
  const next = normalizeBrowserNotificationTypes(types)
  saveBrowserNotificationTypes(next)
  if (!browserNotificationsSupported() || !readBrowserNotificationsRequested() || Notification.permission !== 'granted') return
  await apiJson('/api/browser-push/preferences', {
    method: 'PATCH',
    body: JSON.stringify({ notificationTypes: next }),
  })
}

export async function sendBrowserNotification(
  type: BrowserNotificationType,
  title: string,
  options?: NotificationOptions,
): Promise<boolean> {
  if (!canSendBrowserNotification(type)) return false
  try {
    await apiJson('/api/browser-push/notify', {
      method: 'POST',
      body: JSON.stringify({
        type,
        title,
        body: options?.body,
        tag: options?.tag,
        url: typeof options?.data === 'object' && options.data && 'url' in options.data ? String((options.data as { url?: unknown }).url) : '/',
      }),
    })
    return true
  } catch {
    return false
  }
}

export async function sendBrowserNotificationOnce(
  type: BrowserNotificationType,
  key: string,
  title: string,
  options?: NotificationOptions,
): Promise<boolean> {
  const store = storage()
  const fullKey = `${NOTIFICATION_SENT_PREFIX}${type}:${key}`
  if (store?.getItem(fullKey) === '1') return false
  const sent = await sendBrowserNotification(type, title, options)
  if (sent) store?.setItem(fullKey, '1')
  return sent
}
