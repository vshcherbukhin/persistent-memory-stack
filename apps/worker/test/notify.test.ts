/**
 * Slack send-routing (P1, bot-token extension).
 *
 * `slackTargets(row)` is the pure routing decision behind notifyAlert: prefer the
 * BOT path (one chat.postMessage per channel id) when a bot token AND ≥1 channel are
 * configured; otherwise fall back to the incoming-webhook; otherwise nothing. Pinned
 * here so the fan-out (one target per channel) + the precedence can't silently drift.
 */
import { describe, it, expect } from 'vitest'
import { externalNotificationChannelsEnabled, slackTargets, severityMeets } from '../src/notify.ts'

const base = { slackWebhookUrl: null as string | null, slackBotToken: null as string | null, slackChannelIds: [] as string[] }

describe('slackTargets routing', () => {
  it('bot token + channels → one bot target per channel', () => {
    expect(slackTargets({ ...base, slackBotToken: 'xoxb-1', slackChannelIds: ['C1', 'C2'] })).toEqual([
      { kind: 'bot', token: 'xoxb-1', channel: 'C1' },
      { kind: 'bot', token: 'xoxb-1', channel: 'C2' },
    ])
  })

  it('bot token but NO channels → falls back to webhook if present', () => {
    expect(slackTargets({ ...base, slackBotToken: 'xoxb-1', slackWebhookUrl: 'https://h/x' })).toEqual([
      { kind: 'webhook', url: 'https://h/x' },
    ])
  })

  it('bot token, no channels, no webhook → none', () => {
    expect(slackTargets({ ...base, slackBotToken: 'xoxb-1' })).toEqual([])
  })

  it('no bot → webhook', () => {
    expect(slackTargets({ ...base, slackWebhookUrl: 'https://h/x' })).toEqual([{ kind: 'webhook', url: 'https://h/x' }])
  })

  it('neither configured → none', () => {
    expect(slackTargets(base)).toEqual([])
  })
})

describe('severityMeets (unchanged, regression guard)', () => {
  it('passes at/above floor, blocks below', () => {
    expect(severityMeets('high', 'high')).toBe(true)
    expect(severityMeets('low', 'high')).toBe(false)
    expect(severityMeets('medium', 'low')).toBe(true)
  })
})

describe('externalNotificationChannelsEnabled', () => {
  it('disables email/Slack fan-out in local personal deployments', () => {
    expect(externalNotificationChannelsEnabled('local')).toBe(false)
    expect(externalNotificationChannelsEnabled('server')).toBe(true)
  })
})
