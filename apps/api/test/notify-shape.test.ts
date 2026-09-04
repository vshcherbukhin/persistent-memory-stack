/**
 * Notify-settings GET redaction (P1, Slack-bot extension).
 *
 * BOTH Slack secrets MUST NEVER be returned by the GET endpoint (mirrors how SMTP_PASS
 * stays in env): the bot token (xoxb-…) AND the incoming-webhook URL (it embeds a secret
 * token in its path). The GET shape exposes only `slackBotConfigured` /
 * `slackWebhookConfigured` booleans + the (non-secret) channel ids. This unit pins that
 * neither secret can escape through the public row shape.
 */
import { describe, it, expect } from 'vitest'
import { publicNotifyRow } from '../src/routes/dashboard/notify-shape.ts'

const row = {
  teamId: 't1',
  enabled: true,
  emailRecipients: ['a@b.c'],
  slackWebhookUrl: 'https://hooks.slack.com/services/T0/B0/SECRETWEBHOOKTOKEN',
  minSeverity: 'high',
  slackBotToken: 'xoxb-super-secret',
  slackChannelIds: ['C123', 'C456'],
}

describe('publicNotifyRow (GET redaction)', () => {
  it('NEVER includes the raw slack bot token OR the webhook URL (both are secrets)', () => {
    const out = publicNotifyRow(row)
    const json = JSON.stringify(out)
    expect(json).not.toContain('xoxb-super-secret')
    expect(json).not.toContain('SECRETWEBHOOKTOKEN')
    expect(json).not.toContain('hooks.slack.com')
    expect('slackBotToken' in out).toBe(false)
    expect('slackWebhookUrl' in out).toBe(false)
  })

  it('exposes *Configured booleans = true when the secrets are set', () => {
    const out = publicNotifyRow(row)
    expect(out.slackBotConfigured).toBe(true)
    expect(out.slackWebhookConfigured).toBe(true)
  })

  it('*Configured = false when the secret is null or empty', () => {
    expect(publicNotifyRow({ ...row, slackBotToken: null }).slackBotConfigured).toBe(false)
    expect(publicNotifyRow({ ...row, slackBotToken: '' }).slackBotConfigured).toBe(false)
    expect(publicNotifyRow({ ...row, slackWebhookUrl: null }).slackWebhookConfigured).toBe(false)
    expect(publicNotifyRow({ ...row, slackWebhookUrl: '' }).slackWebhookConfigured).toBe(false)
  })

  it('passes through channel ids + the non-secret fields', () => {
    const out = publicNotifyRow(row)
    expect(out.slackChannelIds).toEqual(['C123', 'C456'])
    expect(out.teamId).toBe('t1')
    expect(out.enabled).toBe(true)
    expect(out.minSeverity).toBe('high')
    expect(out.emailRecipients).toEqual(['a@b.c'])
  })
})
