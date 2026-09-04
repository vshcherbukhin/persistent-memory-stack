/**
 * /dashboard/notify-settings — per-team + global security-alert notification routing
 * (Phase 8, #10; Slack-bot extension P1).
 *
 * NotifySettings is a CONTROL table (owner-only, NO RLS) → read/written via
 * ownerPrisma; scoping is enforced HERE in code (RLS does not apply):
 *   • a team-admin manages ONLY their own team's row;
 *   • a super-admin manages ANY team's row AND the GLOBAL row (teamId NULL) whose
 *     channels are notified on findings ACROSS ALL teams (the support fan-out).
 * Per-team recipients + Slack config live in the row; the SMTP RELAY credentials
 * (incl. the SMTP_PASS secret) stay in env — never written to the DB.
 *
 * Slack delivery (P1): either an incoming-webhook URL, OR a BOT token (xoxb-…) + a
 * list of channel ids. The bot token is a SECRET — GET returns `slackBotConfigured`
 * (a boolean) and NEVER the raw token (publicNotifyRow); PUT preserves the existing
 * token when the field is omitted (preserve-if-blank, like the API-key pattern).
 * Notifications default OFF.
 *
 * Registered inside the requireAdmin control scope; the GLOBAL row PUT additionally
 * requires superuser.
 */
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod/v4'
import { ownerPrisma } from '@pm/db'
import { requireSuperuser } from '../../authz/guards.ts'
import { forbidden } from '../../authz/errors.ts'
import { publicNotifyRow, type NotifyRowFull } from './notify-shape.ts'

// The redaction-safe GET/response shape (NO raw bot token, NO raw webhook URL — both are
// secrets; see notify-shape.ts).
const SettingsRow = z.object({
  teamId: z.string().nullable(),
  enabled: z.boolean(),
  emailRecipients: z.array(z.string()),
  slackWebhookConfigured: z.boolean(),
  slackBotConfigured: z.boolean(),
  slackChannelIds: z.array(z.string()),
  minSeverity: z.string(),
})

const Body = z.object({
  enabled: z.boolean().default(false), // OFF by default (P1)
  emailRecipients: z.array(z.string().email()).max(50).default([]),
  // Both Slack secrets are preserve-if-blank: undefined = keep the stored value; null =
  // clear. (The webhook URL embeds a secret, so like the bot token it is never echoed and
  // is only re-sent when changed.)
  slackWebhookUrl: z.string().url().nullable().optional(),
  slackBotToken: z.string().nullable().optional(),
  slackChannelIds: z.array(z.string().min(1)).max(50).default([]),
  minSeverity: z.enum(['low', 'medium', 'high']).default('high'),
})

// Select the FULL row (incl. the secret) for internal use; publicNotifyRow redacts it.
const SELECT = {
  teamId: true,
  enabled: true,
  emailRecipients: true,
  slackWebhookUrl: true,
  slackBotToken: true,
  slackChannelIds: true,
  minSeverity: true,
} as const

/** Build the Prisma write data, preserving the stored Slack secrets when omitted. */
function buildData(body: z.infer<typeof Body>): Record<string, unknown> {
  const data: Record<string, unknown> = {
    enabled: body.enabled,
    emailRecipients: body.emailRecipients,
    slackChannelIds: body.slackChannelIds,
    minSeverity: body.minSeverity,
  }
  // Only touch a secret when its field was sent: null → clear, value → set, undefined → keep.
  if (body.slackWebhookUrl !== undefined) data.slackWebhookUrl = body.slackWebhookUrl
  if (body.slackBotToken !== undefined) {
    data.slackBotToken = body.slackBotToken === '' ? null : body.slackBotToken
  }
  return data
}

export async function dashboardNotifySettingsRoutes(app: FastifyInstance): Promise<void> {
  const z4 = app.withTypeProvider<ZodTypeProvider>()

  // ── GET /dashboard/notify-settings — the caller's team row + (super only) global ─
  z4.get(
    '/notify-settings',
    {
      schema: {
        querystring: z.object({ teamId: z.string().uuid().optional() }),
        response: { 200: z.object({ team: SettingsRow.nullable(), global: SettingsRow.nullable() }), 403: z.object({ error: z.string() }) },
      },
    },
    async (req, reply) => {
      const id = req.identity!
      // team-admin → own team only; super → may query any team (and sees global).
      const targetTeam = req.query.teamId ?? id.teamId ?? null
      if (req.query.teamId && !id.isGlobalSuperuser && req.query.teamId !== id.teamId) {
        throw forbidden('cross_team_denied', 'You may only view your own team\'s notification settings.')
      }
      const team = targetTeam
        ? ((await ownerPrisma.notifySettings.findUnique({ where: { teamId: targetTeam }, select: SELECT })) as NotifyRowFull | null)
        : null
      const global = id.isGlobalSuperuser
        ? ((await ownerPrisma.notifySettings.findFirst({ where: { teamId: null }, select: SELECT })) as NotifyRowFull | null)
        : null
      return reply.code(200).send({ team: team ? publicNotifyRow(team) : null, global: global ? publicNotifyRow(global) : null })
    },
  )

  // ── PUT /dashboard/notify-settings — upsert a TEAM row (own team, or any if super) ─
  z4.put(
    '/notify-settings',
    {
      schema: {
        querystring: z.object({ teamId: z.string().uuid().optional() }),
        body: Body,
        response: { 200: SettingsRow, 400: z.object({ error: z.string() }), 403: z.object({ error: z.string() }) },
      },
    },
    async (req, reply) => {
      const id = req.identity!
      const targetTeam = req.query.teamId ?? id.teamId
      if (!targetTeam) {
        return reply.code(400).send({ error: 'no_team', message: 'Provide teamId (you are team-less).' } as never)
      }
      if (!id.isGlobalSuperuser && targetTeam !== id.teamId) {
        throw forbidden('cross_team_denied', 'You may only edit your own team\'s notification settings.')
      }
      const data = buildData(req.body)
      const row = (await ownerPrisma.notifySettings.upsert({
        where: { teamId: targetTeam },
        create: { teamId: targetTeam, ...data },
        update: data,
        select: SELECT,
      })) as NotifyRowFull
      return reply.code(200).send(publicNotifyRow(row))
    },
  )

  // ── PUT /dashboard/notify-settings/global — the cross-team support row (superuser) ─
  z4.put(
    '/notify-settings/global',
    {
      preHandler: [requireSuperuser],
      schema: { body: Body, response: { 200: SettingsRow } },
    },
    async (req, reply) => {
      const data = buildData(req.body)
      // Singleton global row (teamId NULL). Postgres allows multiple NULLs on the
      // @unique, so enforce one here: find-then-update, else create.
      const existing = await ownerPrisma.notifySettings.findFirst({ where: { teamId: null }, select: { id: true } })
      const row = (existing
        ? await ownerPrisma.notifySettings.update({ where: { id: existing.id }, data, select: SELECT })
        : await ownerPrisma.notifySettings.create({ data: { teamId: null, ...data }, select: SELECT })) as NotifyRowFull
      return reply.code(200).send(publicNotifyRow(row))
    },
  )
}
