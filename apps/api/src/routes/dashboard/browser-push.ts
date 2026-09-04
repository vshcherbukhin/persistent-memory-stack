/**
 * /dashboard/browser-push — local personal dashboard Web Push registration.
 *
 * This is intentionally local-mode only. Server/shared installs keep notification
 * routing in notify_settings (email/Slack/team/global rows); personal installs get
 * browser-origin notifications tied to the current Chrome/browser profile.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod/v4'
import { config } from '../../config.ts'
import { forbidden } from '../../authz/errors.ts'
import {
  BROWSER_PUSH_TYPES,
  ensureBrowserPushConfig,
  deleteBrowserPushSubscription,
  saveBrowserPushSubscription,
  sendBrowserPushNotification,
  updateBrowserPushPreferences,
} from '../../services/browser-push.ts'

const BrowserPushType = z.enum(BROWSER_PUSH_TYPES)
const ErrorBody = z.object({ error: z.string(), message: z.string().optional() })
const SubscriptionBody = z.object({
  endpoint: z.string().url(),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
  notificationTypes: z.array(BrowserPushType).optional(),
  userAgent: z.string().optional(),
}).strict()
const DeleteBody = z.object({ endpoint: z.string().url().optional() }).strict()
const PreferencesBody = z.object({ notificationTypes: z.array(BrowserPushType).default([]) }).strict()
const NotifyBody = z.object({
  type: BrowserPushType,
  title: z.string().min(1).max(120),
  body: z.string().max(500).optional(),
  url: z.string().min(1).max(500).optional(),
  tag: z.string().min(1).max(80).optional(),
}).strict()

function requireLocalBrowserPushIdentity(req: FastifyRequest): { userId: string; teamId: string } {
  if (config.DEPLOYMENT_MODE !== 'local') {
    throw forbidden('browser_push_local_only', 'Browser push notifications are only available for local personal dashboards.')
  }
  const id = req.identity!
  if (!id.userId || !id.teamId) {
    throw forbidden('browser_push_identity_required', 'Browser push notifications require a local dashboard user and team.')
  }
  return { userId: id.userId, teamId: id.teamId }
}

export async function dashboardBrowserPushRoutes(app: FastifyInstance): Promise<void> {
  const z4 = app.withTypeProvider<ZodTypeProvider>()

  z4.get(
    '/browser-push/public-key',
    {
      schema: {
        response: { 200: z.object({ publicKey: z.string() }), 403: ErrorBody },
      },
    },
    async (req, reply) => {
      requireLocalBrowserPushIdentity(req)
      const cfg = await ensureBrowserPushConfig()
      return reply.code(200).send({ publicKey: cfg.publicKey })
    },
  )

  z4.put(
    '/browser-push/subscription',
    {
      schema: {
        body: SubscriptionBody,
        response: { 200: z.object({ enabled: z.boolean(), notificationTypes: z.array(BrowserPushType) }), 403: ErrorBody },
      },
    },
    async (req, reply) => {
      const id = requireLocalBrowserPushIdentity(req)
      const saved = await saveBrowserPushSubscription({
        endpoint: req.body.endpoint,
        keys: req.body.keys,
        types: req.body.notificationTypes,
        userId: id.userId,
        teamId: id.teamId,
        userAgent: req.body.userAgent,
      })
      return reply.code(200).send(saved)
    },
  )

  z4.delete(
    '/browser-push/subscription',
    {
      schema: {
        body: DeleteBody.optional(),
        response: { 200: z.object({ deleted: z.number() }), 403: ErrorBody },
      },
    },
    async (req, reply) => {
      const id = requireLocalBrowserPushIdentity(req)
      const deleted = await deleteBrowserPushSubscription(id.userId, req.body?.endpoint)
      return reply.code(200).send({ deleted })
    },
  )

  z4.patch(
    '/browser-push/preferences',
    {
      schema: {
        body: PreferencesBody,
        response: { 200: z.object({ count: z.number(), notificationTypes: z.array(BrowserPushType) }), 403: ErrorBody },
      },
    },
    async (req, reply) => {
      const id = requireLocalBrowserPushIdentity(req)
      const result = await updateBrowserPushPreferences(id.userId, req.body.notificationTypes)
      return reply.code(200).send(result)
    },
  )

  z4.post(
    '/browser-push/test',
    {
      schema: {
        response: { 200: z.object({ sent: z.number() }), 403: ErrorBody },
      },
    },
    async (req, reply) => {
      const id = requireLocalBrowserPushIdentity(req)
      const sent = await sendBrowserPushNotification({
        type: 'newReleases',
        userId: id.userId,
        teamId: id.teamId,
        title: 'Persistent Memory notifications enabled',
        body: 'Chrome/browser notifications are ready for this dashboard.',
        url: '/notifications',
        tag: 'browser-push-enabled',
        ignoreTypeFilter: true,
      })
      return reply.code(200).send({ sent })
    },
  )

  z4.post(
    '/browser-push/notify',
    {
      schema: {
        body: NotifyBody,
        response: { 200: z.object({ sent: z.number() }), 403: ErrorBody },
      },
    },
    async (req, reply) => {
      const id = requireLocalBrowserPushIdentity(req)
      const sent = await sendBrowserPushNotification({ ...req.body, userId: id.userId, teamId: id.teamId })
      return reply.code(200).send({ sent })
    },
  )
}
