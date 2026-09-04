/**
 * Notify-settings PUBLIC row shape (P1, Slack-bot extension) — pure, no fastify/prisma.
 *
 * BOTH Slack delivery secrets are redacted out of the GET response: the bot token
 * (xoxb-…) AND the incoming-webhook URL (it embeds a secret token in its path,
 * hooks.slack.com/services/T…/B…/XXXX). Like SMTP_PASS, neither leaves the server —
 * the shape exposes only `slackBotConfigured` / `slackWebhookConfigured` booleans plus
 * the (non-secret) channel ids. Kept in its own module so the redaction is unit-tested
 * in isolation (api/test/notify-shape.test.ts).
 */

/** The full DB row (incl. the secrets) as selected for internal use. */
export interface NotifyRowFull {
  teamId: string | null
  enabled: boolean
  emailRecipients: string[]
  slackWebhookUrl: string | null
  minSeverity: string
  slackBotToken: string | null
  slackChannelIds: string[]
}

/** The redaction-safe shape returned to the dashboard (NO webhook URL, NO bot token). */
export interface PublicNotifyRow {
  teamId: string | null
  enabled: boolean
  emailRecipients: string[]
  slackWebhookConfigured: boolean
  slackBotConfigured: boolean
  slackChannelIds: string[]
  minSeverity: string
}

const isSet = (v: string | null): boolean => v !== null && v !== ''

export function publicNotifyRow(r: NotifyRowFull): PublicNotifyRow {
  return {
    teamId: r.teamId,
    enabled: r.enabled,
    emailRecipients: r.emailRecipients,
    slackWebhookConfigured: isSet(r.slackWebhookUrl),
    slackBotConfigured: isSet(r.slackBotToken),
    slackChannelIds: r.slackChannelIds,
    minSeverity: r.minSeverity,
  }
}
