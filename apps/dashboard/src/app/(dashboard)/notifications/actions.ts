'use server'

import { revalidatePath } from 'next/cache'
import { api, normalizeMemorySurface } from '@/lib/api'
import { requireControlPlane, isSuperuser } from '@/lib/session'
import type { NotifySettingsInput } from '@/lib/types'

export interface NotifyState {
  ok?: boolean
  error?: string
  nonce?: number
}

function splitList(v: FormDataEntryValue | null): string[] {
  return String(v ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function text(v: FormDataEntryValue | null): string {
  return String(v ?? '').trim()
}

/**
 * Build the PUT body from the form. Slack delivery is mutually exclusive via `slackMode`
 * (webhook | bot | off). Secrets are PRESERVE-IF-BLANK within their mode: an empty field
 * keeps the stored secret (undefined), while switching modes clears the other channel's
 * secret. Email is split on comma/space.
 */
function parseBody(formData: FormData): NotifySettingsInput {
  const mode = String(formData.get('slackMode') ?? 'off')
  const body: NotifySettingsInput = {
    enabled: formData.get('enabled') === 'on',
    emailRecipients: splitList(formData.get('emailRecipients')),
    slackChannelIds: mode === 'bot' ? splitList(formData.get('slackChannelIds')) : [],
    minSeverity: String(formData.get('minSeverity') ?? 'high'),
  }
  if (mode === 'webhook') {
    const url = String(formData.get('slackWebhookUrl') ?? '').trim()
    if (url) body.slackWebhookUrl = url // empty = keep the stored URL
    body.slackBotToken = null // chose webhook → clear the bot token
  } else if (mode === 'bot') {
    const tok = String(formData.get('slackBotToken') ?? '').trim()
    if (tok) body.slackBotToken = tok // empty = keep the stored token
    body.slackWebhookUrl = null // chose bot → clear the webhook
  } else {
    // off → no Slack delivery
    body.slackWebhookUrl = null
    body.slackBotToken = null
  }
  return body
}

export async function saveNotifyTargetAction(_prev: NotifyState, formData: FormData): Promise<NotifyState> {
  const who = await requireControlPlane()
  const targetKind = text(formData.get('targetKind'))
  const teamId = text(formData.get('teamId'))
  const surface = normalizeMemorySurface(text(formData.get('surface')))

  if (surface === 'personal' && targetKind === 'system' && !isSuperuser(who)) {
    return { error: 'System notifications are superuser-only.', nonce: Date.now() }
  }
  if (surface === 'personal' && targetKind !== 'system' && teamId && !isSuperuser(who) && teamId !== who.teamId) {
    return { error: 'You may only edit your own team notifications.', nonce: Date.now() }
  }

  try {
    if (targetKind === 'system') await api.putGlobalNotifySettings(parseBody(formData), surface)
    else await api.putNotifySettings(parseBody(formData), teamId || undefined, surface)
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Save failed', nonce: Date.now() }
  }
  revalidatePath('/notifications')
  return { ok: true, nonce: Date.now() }
}
