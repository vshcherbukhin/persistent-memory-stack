import webpush from 'web-push'
import { ownerPrisma } from '@pm/db'
import { config } from '../config.ts'

export const BROWSER_PUSH_TYPES = [
  'newReleases',
  'memoryAdded',
  'memoryUpdated',
  'memoryRemoved',
  'securityAlerts',
] as const

export type BrowserPushType = (typeof BROWSER_PUSH_TYPES)[number]

export const DEFAULT_BROWSER_PUSH_TYPES: BrowserPushType[] = [...BROWSER_PUSH_TYPES]

const BROWSER_PUSH_CONFIG_ID = 'singleton'

export interface BrowserPushVapidConfig {
  publicKey: string
  privateKey: string
  subject: string
}

export interface BrowserPushConfigStore {
  read(): Promise<BrowserPushVapidConfig | null>
  create(input: BrowserPushVapidConfig): Promise<BrowserPushVapidConfig>
}

export interface BrowserPushSubscriptionInput {
  endpoint: string
  keys: {
    p256dh: string
    auth: string
  }
  types?: unknown
  userId: string
  teamId: string
  userAgent?: string | null
}

export interface BrowserPushWriteData {
  endpoint: string
  p256dh: string
  auth: string
  notificationTypes: BrowserPushType[]
  userId: string
  teamId: string
  userAgent: string | null
  enabled: true
}

export interface BrowserPushDeliveryRow {
  id: string
  endpoint: string
  p256dh: string
  auth: string
  enabled: boolean
  notificationTypes: string[]
}

export interface BrowserPushNotification {
  type: BrowserPushType
  title: string
  body?: string
  url?: string
  tag?: string
}

export interface BrowserPushNotifyInput extends BrowserPushNotification {
  teamId?: string | null
  userId?: string | null
  ignoreTypeFilter?: boolean
}

function isBrowserPushType(value: unknown): value is BrowserPushType {
  return typeof value === 'string' && (BROWSER_PUSH_TYPES as readonly string[]).includes(value)
}

export function normalizeBrowserPushTypes(value: unknown): BrowserPushType[] {
  if (!Array.isArray(value)) return DEFAULT_BROWSER_PUSH_TYPES
  const seen = new Set<BrowserPushType>()
  for (const item of value) {
    if (isBrowserPushType(item)) seen.add(item)
  }
  return [...seen]
}

export async function getOrCreateVapidConfig(
  store: BrowserPushConfigStore,
  generate: () => { publicKey: string; privateKey: string },
  subject: string,
): Promise<BrowserPushVapidConfig> {
  const existing = await store.read()
  if (existing) return existing
  const keys = generate()
  return store.create({ publicKey: keys.publicKey, privateKey: keys.privateKey, subject })
}

export function browserPushWriteData(input: BrowserPushSubscriptionInput): BrowserPushWriteData {
  return {
    endpoint: input.endpoint,
    p256dh: input.keys.p256dh,
    auth: input.keys.auth,
    notificationTypes: normalizeBrowserPushTypes(input.types),
    userId: input.userId,
    teamId: input.teamId,
    userAgent: input.userAgent?.trim() || null,
    enabled: true,
  }
}

export function isExpiredPushSubscriptionError(err: unknown): boolean {
  const statusCode = typeof err === 'object' && err != null && 'statusCode' in err
    ? Number((err as { statusCode?: unknown }).statusCode)
    : 0
  return statusCode === 404 || statusCode === 410
}

export async function deliverBrowserPushRows(
  rows: BrowserPushDeliveryRow[],
  notification: BrowserPushNotification,
  send: (subscription: webpush.PushSubscription, payload: string) => Promise<unknown>,
  removeExpired: (id: string) => Promise<unknown>,
): Promise<number> {
  const payload = JSON.stringify({
    title: notification.title,
    body: notification.body ?? '',
    ...(notification.tag ? { tag: notification.tag } : {}),
    data: {
      type: notification.type,
      url: notification.url ?? '/',
    },
  })
  let attempted = 0
  for (const row of rows) {
    if (!row.enabled) continue
    // Release notices follow the browser opt-in, without a separate event preference.
    if (notification.type !== 'newReleases' && !row.notificationTypes.includes(notification.type)) continue
    attempted += 1
    try {
      await send({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } }, payload)
    } catch (err) {
      if (isExpiredPushSubscriptionError(err)) await removeExpired(row.id)
      else console.warn('WARN: [browser-push] send failed:', err)
    }
  }
  return attempted
}

function vapidSubject(): string {
  const email = config.LOCAL_USER_EMAIL.trim()
  return email ? `mailto:${email}` : 'mailto:notifications@persistent-memory.local'
}

export async function ensureBrowserPushConfig(): Promise<BrowserPushVapidConfig> {
  return getOrCreateVapidConfig(
    {
      read: () =>
        ownerPrisma.browserPushConfig.findUnique({
          where: { id: BROWSER_PUSH_CONFIG_ID },
          select: { publicKey: true, privateKey: true, subject: true },
        }) as Promise<BrowserPushVapidConfig | null>,
      create: (input) =>
        ownerPrisma.browserPushConfig.upsert({
          where: { id: BROWSER_PUSH_CONFIG_ID },
          create: { id: BROWSER_PUSH_CONFIG_ID, ...input },
          update: {},
          select: { publicKey: true, privateKey: true, subject: true },
        }) as Promise<BrowserPushVapidConfig>,
    },
    () => webpush.generateVAPIDKeys(),
    vapidSubject(),
  )
}

export async function saveBrowserPushSubscription(input: BrowserPushSubscriptionInput): Promise<{
  enabled: boolean
  notificationTypes: BrowserPushType[]
}> {
  const data = browserPushWriteData(input)
  const row = await ownerPrisma.browserPushSubscription.upsert({
    where: { endpoint: data.endpoint },
    create: data,
    update: {
      p256dh: data.p256dh,
      auth: data.auth,
      notificationTypes: data.notificationTypes,
      userId: data.userId,
      teamId: data.teamId,
      userAgent: data.userAgent,
      enabled: true,
      lastSeenAt: new Date(),
    },
    select: { enabled: true, notificationTypes: true },
  })
  return { enabled: row.enabled, notificationTypes: normalizeBrowserPushTypes(row.notificationTypes) }
}

export async function deleteBrowserPushSubscription(userId: string, endpoint?: string): Promise<number> {
  const result = await ownerPrisma.browserPushSubscription.deleteMany({
    where: { userId, ...(endpoint ? { endpoint } : {}) },
  })
  return result.count
}

export async function updateBrowserPushPreferences(userId: string, types: unknown): Promise<{
  count: number
  notificationTypes: BrowserPushType[]
}> {
  const notificationTypes = normalizeBrowserPushTypes(types)
  const result = await ownerPrisma.browserPushSubscription.updateMany({
    where: { userId, enabled: true },
    data: { notificationTypes, lastSeenAt: new Date() },
  })
  return { count: result.count, notificationTypes }
}

export async function sendBrowserPushNotification(input: BrowserPushNotifyInput): Promise<number> {
  if (config.DEPLOYMENT_MODE !== 'local') return 0
  const ignoreTypeFilter = input.ignoreTypeFilter || input.type === 'newReleases'
  const cfg = await ensureBrowserPushConfig()
  const rows = await ownerPrisma.browserPushSubscription.findMany({
    where: {
      enabled: true,
      ...(input.teamId ? { teamId: input.teamId } : {}),
      ...(input.userId ? { userId: input.userId } : {}),
      ...(ignoreTypeFilter ? {} : { notificationTypes: { has: input.type } }),
    },
    select: { id: true, endpoint: true, p256dh: true, auth: true, enabled: true, notificationTypes: true },
  })
  const deliveryRows = ignoreTypeFilter
    ? rows.map((row) => ({ ...row, notificationTypes: row.notificationTypes.includes(input.type) ? row.notificationTypes : [...row.notificationTypes, input.type] }))
    : rows
  return deliverBrowserPushRows(
    deliveryRows,
    input,
    (subscription, payload) =>
      webpush.sendNotification(subscription, payload, {
        TTL: 60 * 60,
        urgency: input.type === 'securityAlerts' ? 'high' : 'normal',
        vapidDetails: cfg,
      }),
    (id) => ownerPrisma.browserPushSubscription.deleteMany({ where: { id } }),
  )
}
