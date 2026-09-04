/**
 * worker/notify — security-alert notifications (Phase 8, #10).
 *
 * BEST-EFFORT by construction: a failed notification NEVER blocks the triggering op
 * (every send is caught; the fan-out uses Promise.allSettled). This is the OPPOSITE
 * of the DLP gate (which fails closed) — a down mail relay must not stop a scan.
 *
 * Routing (the user's model): for a finding in team X, notify X's NotifySettings row
 * AND the GLOBAL row (teamId NULL — the super-admin/support fan-out across all teams).
 * Per-team recipients + Slack webhooks live in the NotifySettings CONTROL table (read
 * via ownerPrisma — owner-only, no RLS); the SMTP RELAY creds + From are env (config).
 * Each row's minSeverity filters.
 */
import nodemailer from 'nodemailer'
import webpush from 'web-push'
import { ownerPrisma } from '@pm/db'
import { config } from './config.ts'

export type AlertSeverity = 'low' | 'medium' | 'high'
const RANK: Record<AlertSeverity, number> = { low: 0, medium: 1, high: 2 }

export interface AlertMessage {
  subject: string
  body: string
  severity: AlertSeverity
}

/** Does `sev` meet a row's configured minimum severity? Unknown min ⇒ 'high' (strict). */
export function severityMeets(sev: AlertSeverity, min: string): boolean {
  const floor = (RANK as Record<string, number>)[min] ?? RANK.high
  return RANK[sev] >= floor
}

async function sendSlack(url: string, msg: AlertMessage): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: `*[${msg.severity.toUpperCase()}]* ${msg.subject}\n${msg.body}` }),
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) throw new Error(`slack webhook ${res.status}`)
}

/** A resolved Slack delivery target for one NotifySettings row. */
export type SlackTarget =
  | { kind: 'bot'; token: string; channel: string }
  | { kind: 'webhook'; url: string }

/** The Slack-relevant fields of a NotifySettings row. */
export interface SlackRoutable {
  slackWebhookUrl: string | null
  slackBotToken: string | null
  slackChannelIds: string[]
}

/**
 * Resolve a row's Slack delivery targets. PRECEDENCE: a configured bot token WITH
 * ≥1 channel id → one chat.postMessage per channel (the bot path); otherwise the
 * incoming-webhook (if any); otherwise nothing. (A bot token with no channels is
 * inert, so we fall back to the webhook rather than silently dropping the alert.)
 */
export function slackTargets(row: SlackRoutable): SlackTarget[] {
  if (row.slackBotToken && row.slackChannelIds.length > 0) {
    return row.slackChannelIds.map((channel) => ({ kind: 'bot', token: row.slackBotToken!, channel }))
  }
  if (row.slackWebhookUrl) return [{ kind: 'webhook', url: row.slackWebhookUrl }]
  return []
}

export function externalNotificationChannelsEnabled(deploymentMode: string = config.DEPLOYMENT_MODE): boolean {
  return deploymentMode !== 'local'
}

export interface BrowserPushAlertRow {
  enabled: boolean
  notificationTypes: string[]
}

export function browserPushRowsForAlert<T extends BrowserPushAlertRow>(rows: T[], type = 'securityAlerts'): T[] {
  return rows.filter((row) => row.enabled && row.notificationTypes.includes(type))
}

function isExpiredBrowserPush(err: unknown): boolean {
  const statusCode = typeof err === 'object' && err != null && 'statusCode' in err
    ? Number((err as { statusCode?: unknown }).statusCode)
    : 0
  return statusCode === 404 || statusCode === 410
}

async function sendLocalBrowserPushAlert(teamId: string, msg: AlertMessage): Promise<number> {
  const cfg = await ownerPrisma.browserPushConfig.findUnique({
    where: { id: 'singleton' },
    select: { publicKey: true, privateKey: true, subject: true },
  })
  if (!cfg) return 0
  const rows = await ownerPrisma.browserPushSubscription.findMany({
    where: { teamId, enabled: true, notificationTypes: { has: 'securityAlerts' } },
    select: { id: true, endpoint: true, p256dh: true, auth: true, enabled: true, notificationTypes: true },
  })
  const targets = browserPushRowsForAlert(rows)
  await Promise.allSettled(targets.map(async (row) => {
    try {
      await webpush.sendNotification(
        { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
        JSON.stringify({
          title: msg.subject,
          body: msg.body,
          data: { type: 'securityAlerts', url: '/security' },
        }),
        {
          TTL: 60 * 60,
          urgency: 'high',
          vapidDetails: cfg,
        },
      )
    } catch (err) {
      if (isExpiredBrowserPush(err)) {
        await ownerPrisma.browserPushSubscription.deleteMany({ where: { id: row.id } })
      } else {
        console.warn('WARN: [notify] browser push failed:', err)
      }
    }
  }))
  return targets.length
}

/**
 * Post an alert to one channel via the Slack Web API (bot token). chat.postMessage
 * returns HTTP 200 even on a logical failure with {ok:false,error}, so the body's
 * `ok` is checked too. Throws on any failure (the caller swallows per-channel, so one
 * bad channel can't block the others). The token is NEVER logged.
 */
async function sendSlackViaBot(token: string, channel: string, msg: AlertMessage): Promise<void> {
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${token}` },
    body: JSON.stringify({ channel, text: `*[${msg.severity.toUpperCase()}]* ${msg.subject}\n${msg.body}` }),
    signal: AbortSignal.timeout(8000),
  })
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string }
  if (!res.ok || !data.ok) {
    throw new Error(`slack chat.postMessage failed (channel ${channel}): ${data.error ?? res.status}`)
  }
}

async function sendEmail(to: string[], msg: AlertMessage): Promise<void> {
  // Email needs a relay + a From + recipients; otherwise it's a silent no-op.
  if (!config.SMTP_HOST || !config.ALERT_EMAIL_FROM || to.length === 0) return
  const transporter = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE, // true=465 implicit TLS, false=587 STARTTLS
    auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASS } : undefined,
    connectionTimeout: 8000,
    greetingTimeout: 8000,
    socketTimeout: 8000,
  })
  await transporter.sendMail({
    from: config.ALERT_EMAIL_FROM,
    to: to.join(', '),
    subject: `[${msg.severity.toUpperCase()}] ${msg.subject}`,
    text: msg.body,
  })
}

/**
 * Notify the team's + the global NotifySettings channels for an alert. Best-effort:
 * reads the rows (failure → skip + warn), fans out to every enabled+in-severity row's
 * channels, swallows per-channel errors. Returns the number of channels attempted.
 */
export async function notifyAlert(teamId: string, msg: AlertMessage): Promise<number> {
  if (!externalNotificationChannelsEnabled()) return sendLocalBrowserPushAlert(teamId, msg)

  let rows: {
    enabled: boolean
    minSeverity: string
    emailRecipients: string[]
    slackWebhookUrl: string | null
    slackBotToken: string | null
    slackChannelIds: string[]
  }[]
  try {
    rows = await ownerPrisma.notifySettings.findMany({
      where: { OR: [{ teamId }, { teamId: null }] },
      select: { enabled: true, minSeverity: true, emailRecipients: true, slackWebhookUrl: true, slackBotToken: true, slackChannelIds: true },
    })
  } catch (err) {
    console.warn('WARN: [notify] failed to read NotifySettings (skipping notification):', err)
    return 0
  }
  const tasks: Promise<unknown>[] = []
  for (const row of rows) {
    if (!row.enabled) continue
    if (!severityMeets(msg.severity, row.minSeverity)) continue
    for (const t of slackTargets(row)) {
      if (t.kind === 'bot') {
        tasks.push(sendSlackViaBot(t.token, t.channel, msg).catch((e) => console.warn('WARN: [notify] slack bot failed:', e)))
      } else {
        tasks.push(sendSlack(t.url, msg).catch((e) => console.warn('WARN: [notify] slack webhook failed:', e)))
      }
    }
    if (row.emailRecipients.length > 0) {
      tasks.push(sendEmail(row.emailRecipients, msg).catch((e) => console.warn('WARN: [notify] email failed:', e)))
    }
  }
  await Promise.allSettled(tasks)
  return tasks.length
}
