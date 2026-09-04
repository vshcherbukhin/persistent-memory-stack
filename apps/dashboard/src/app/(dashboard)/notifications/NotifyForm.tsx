'use client'

import { useActionState, useEffect, useMemo, useState } from 'react'
import { Select } from '@/components/ui/Select'
import { Input } from '@/components/ui/Input'
import { Checkbox } from '@/components/ui/Checkbox'
import { useToast } from '@/components/ui/Toast'
import {
  DEFAULT_BROWSER_NOTIFICATION_TYPES,
  PERSONAL_NOTIFICATION_TYPES,
  browserNotificationsSupported,
  disableBrowserNotifications,
  enableBrowserNotifications,
  migrateLegacyBrowserNotificationSetting,
  readBrowserNotificationTypes,
  readBrowserNotificationsRequested,
  refreshBrowserNotificationServiceWorker,
  updateBrowserNotificationPreferences,
  type BrowserNotificationType,
} from '@/lib/browserNotifications'
import type { MemorySurface, NotifySettings } from '@/lib/types'
import type { NotifyState } from './actions'

const INIT: NotifyState = {}
type Action = (prev: NotifyState, fd: FormData) => Promise<NotifyState>
type SlackMode = 'webhook' | 'bot' | 'off'

const orderedBrowserNotificationTypes = (types: BrowserNotificationType[]) => {
  const selected = new Set(types)
  return PERSONAL_NOTIFICATION_TYPES
    .filter((option) => selected.has(option.id))
    .map((option) => option.id)
}

const sameBrowserNotificationTypes = (a: BrowserNotificationType[], b: BrowserNotificationType[]) =>
  orderedBrowserNotificationTypes(a).join('|') === orderedBrowserNotificationTypes(b).join('|')

interface FormVals {
  enabled: boolean
  emailRecipients: string
  slackMode: SlackMode
  slackWebhookUrl: string // write-only; '' = keep stored
  slackBotToken: string // write-only; '' = keep stored
  slackChannelIds: string
  minSeverity: string
}

/**
 * Notification routing form (P5). FULLY CONTROLLED so Save is a true dirty gate:
 * it's always visible but enabled ONLY when the current values differ from the saved
 * baseline — reverting an edit (incl. toggling the checkbox back) re-disables it. All
 * options are shown at once (no enabled-based collapse). Slack delivery is a mutually
 * exclusive choice (incoming webhook OR bot token + channel ids); both secrets are
 * write-only (the api never returns them — a blank field keeps the stored value).
 */
export function NotifyForm({
  action,
  current,
  targetKind,
  teamId,
  surface,
  personalMode = false,
}: {
  action: Action
  current: NotifySettings | null
  targetKind: 'team' | 'system'
  teamId?: string | null
  surface: MemorySurface
  personalMode?: boolean
}) {
  const [state, formAction, pending] = useActionState(action, INIT)
  const toast = useToast()

  const seed = useMemo<FormVals>(
    () => ({
      enabled: current?.enabled ?? false,
      emailRecipients: (current?.emailRecipients ?? []).join(', '),
      slackMode: personalMode ? 'off' : current?.slackBotConfigured ? 'bot' : current?.slackWebhookConfigured ? 'webhook' : 'off',
      slackWebhookUrl: '',
      slackBotToken: '',
      slackChannelIds: (current?.slackChannelIds ?? []).join(', '),
      minSeverity: current?.minSeverity ?? 'high',
    }),
    [current, personalMode],
  )

  const [vals, setVals] = useState<FormVals>(seed)
  const [base, setBase] = useState<FormVals>(seed) // last-saved baseline
  const [webhookCfg, setWebhookCfg] = useState(!!current?.slackWebhookConfigured)
  const [botCfg, setBotCfg] = useState(!!current?.slackBotConfigured)
  const [draftBrowserNotifications, setDraftBrowserNotifications] = useState(false)
  const [savedBrowserNotifications, setSavedBrowserNotifications] = useState(false)
  const [draftBrowserNotificationTypes, setDraftBrowserNotificationTypes] = useState<BrowserNotificationType[]>(DEFAULT_BROWSER_NOTIFICATION_TYPES)
  const [savedBrowserNotificationTypes, setSavedBrowserNotificationTypes] = useState<BrowserNotificationType[]>(DEFAULT_BROWSER_NOTIFICATION_TYPES)
  const [browserBusy, setBrowserBusy] = useState(false)

  const dirty = useMemo(() => JSON.stringify(vals) !== JSON.stringify(base), [vals, base])
  const browserEnabledDirty = draftBrowserNotifications !== savedBrowserNotifications
  const browserTypeDirty = useMemo(
    () => !sameBrowserNotificationTypes(draftBrowserNotificationTypes, savedBrowserNotificationTypes),
    [draftBrowserNotificationTypes, savedBrowserNotificationTypes],
  )
  const browserSettingsDirty = browserEnabledDirty || (draftBrowserNotifications && browserTypeDirty)
  const browserNotificationTypesLocked = !draftBrowserNotifications || browserBusy
  const set = <K extends keyof FormVals>(k: K, v: FormVals[K]) => setVals((s) => ({ ...s, [k]: v }))

  useEffect(() => {
    if (!state.nonce) return
    if (state.ok) {
      toast.success('Notification settings saved.')
      // New baseline = what we submitted, but the write-only secrets reset to "keep".
      if (vals.slackWebhookUrl) setWebhookCfg(true)
      if (vals.slackBotToken) setBotCfg(true)
      const saved = { ...vals, slackWebhookUrl: '', slackBotToken: '' }
      setVals(saved)
      setBase(saved)
    } else if (state.error) toast.error(state.error)
  }, [state.nonce]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!personalMode) return
    if (!browserNotificationsSupported()) {
      setDraftBrowserNotifications(false)
      setSavedBrowserNotifications(false)
      return
    }

    migrateLegacyBrowserNotificationSetting()
    const registered = readBrowserNotificationsRequested() && Notification.permission === 'granted'
    const notificationTypes = readBrowserNotificationTypes()
    setDraftBrowserNotifications(registered)
    setSavedBrowserNotifications(registered)
    setDraftBrowserNotificationTypes(notificationTypes)
    setSavedBrowserNotificationTypes(notificationTypes)
    if (registered) void refreshBrowserNotificationServiceWorker()
  }, [personalMode])

  const saveBrowserNotificationSettings = async () => {
    if (!browserSettingsDirty || browserBusy) return
    const nextTypes = orderedBrowserNotificationTypes(draftBrowserNotificationTypes)
    setBrowserBusy(true)
    try {
      if (draftBrowserNotifications) {
        if (!savedBrowserNotifications) {
          await enableBrowserNotifications(nextTypes)
        } else if (browserTypeDirty) {
          await updateBrowserNotificationPreferences(nextTypes)
        }
        setDraftBrowserNotificationTypes(nextTypes)
        setSavedBrowserNotificationTypes(nextTypes)
      } else {
        if (savedBrowserNotifications) await disableBrowserNotifications()
        setDraftBrowserNotificationTypes(savedBrowserNotificationTypes)
      }
      setSavedBrowserNotifications(draftBrowserNotifications)
      toast.success('Notification settings saved.')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save notification settings.')
    } finally {
      setBrowserBusy(false)
    }
  }

  const toggleBrowserNotificationType = (id: BrowserNotificationType, enabled: boolean) => {
    if (browserNotificationTypesLocked) return
    const next = enabled ? Array.from(new Set([...draftBrowserNotificationTypes, id])) : draftBrowserNotificationTypes.filter((item) => item !== id)
    setDraftBrowserNotificationTypes(orderedBrowserNotificationTypes(next))
  }

  const toggleBrowserNotificationsDraft = (enabled: boolean) => {
    if (browserBusy) return
    if (enabled && !browserNotificationsSupported()) {
      setDraftBrowserNotifications(false)
      toast.error('Browser notifications are not supported by this browser.')
      return
    }
    setDraftBrowserNotifications(enabled)
  }

  if (personalMode) {
    return (
      <div className="settings-form-stack browser-notification-settings">
        <Checkbox
          checked={draftBrowserNotifications}
          onChange={toggleBrowserNotificationsDraft}
          label="Enable Chrome/browser notifications"
          disabled={browserBusy}
        />

        <div className="seg-group personal-notification-types">
          <span className="section-label">Notify me about</span>
          <div className="notification-checks">
            {PERSONAL_NOTIFICATION_TYPES.map((option) => (
              <Checkbox
                key={option.id}
                checked={draftBrowserNotificationTypes.includes(option.id)}
                onChange={(v) => toggleBrowserNotificationType(option.id, v)}
                label={option.label}
                disabled={browserNotificationTypesLocked}
              />
            ))}
          </div>
          <div className="personal-notification-actions">
            <button
              type="button"
              className="primary"
              disabled={!browserSettingsDirty || browserBusy}
              onClick={() => void saveBrowserNotificationSettings()}
            >
              {browserBusy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <form action={formAction} style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 560 }}>
      <input type="hidden" name="targetKind" value={targetKind} />
      <input type="hidden" name="teamId" value={teamId ?? ''} />
      <input type="hidden" name="surface" value={surface} />
      <Checkbox name="enabled" checked={vals.enabled} onChange={(v) => set('enabled', v)} label="Enabled" />
      <div className="field" style={{ marginBottom: 0 }}>
        <label htmlFor="emailRecipients">Email recipients (comma-separated)</label>
        <Input
          id="emailRecipients"
          name="emailRecipients"
          type="text"
          placeholder="alerts@team.example, lead@team.example"
          value={vals.emailRecipients}
          onChange={(e) => set('emailRecipients', e.target.value)}
        />
      </div>

      <div className="seg-group">
        <span className="section-label">Slack delivery</span>
        <input type="hidden" name="slackMode" value={vals.slackMode} />
        <div className="seg">
          {(['webhook', 'bot', 'off'] as const).map((m) => (
            <button type="button" key={m} className={`seg-btn${vals.slackMode === m ? ' active' : ''}`} onClick={() => set('slackMode', m)}>
              {m === 'webhook' ? 'Incoming webhook' : m === 'bot' ? 'Bot + channels' : 'Off'}
            </button>
          ))}
        </div>
      </div>

      {!personalMode && vals.slackMode === 'webhook' ? (
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="slackWebhookUrl">Slack incoming-webhook URL</label>
          <Input
            id="slackWebhookUrl"
            name="slackWebhookUrl"
            type="password"
            autoComplete="off"
            placeholder={webhookCfg ? '•••• configured — leave blank to keep' : 'https://hooks.slack.com/services/…'}
            value={vals.slackWebhookUrl}
            onChange={(e) => set('slackWebhookUrl', e.target.value)}
          />
          {webhookCfg ? <span className="field-hint">A webhook is configured (write-only — embeds a secret). Enter a new URL to replace it.</span> : null}
        </div>
      ) : null}

      {!personalMode && vals.slackMode === 'bot' ? (
        <>
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="slackBotToken">Slack bot token (xoxb-…)</label>
            <Input
              id="slackBotToken"
              name="slackBotToken"
              type="password"
              autoComplete="off"
              placeholder={botCfg ? '•••• configured — leave blank to keep' : 'xoxb-…'}
              value={vals.slackBotToken}
              onChange={(e) => set('slackBotToken', e.target.value)}
            />
            {botCfg ? <span className="field-hint">A bot token is configured (write-only). Enter a new token to replace it.</span> : null}
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="slackChannelIds">Channel IDs (comma-separated)</label>
            <Input
              id="slackChannelIds"
              name="slackChannelIds"
              type="text"
              placeholder="C0123ABC, C0456DEF"
              value={vals.slackChannelIds}
              onChange={(e) => set('slackChannelIds', e.target.value)}
            />
            <span className="field-hint">The bot posts each alert to these channels — it needs the <code>chat:write</code> scope and must be invited to each one.</span>
          </div>
        </>
      ) : null}

      <div className="field" style={{ marginBottom: 0 }}>
        <label htmlFor="minSeverity">Minimum severity</label>
        <Select
          name="minSeverity"
          ariaLabel="Minimum severity"
          value={vals.minSeverity}
          onChange={(v) => set('minSeverity', v)}
          options={[{ value: 'low', label: 'low' }, { value: 'medium', label: 'medium' }, { value: 'high', label: 'high' }]}
        />
      </div>

      <div className="row">
        <button type="submit" className="primary" disabled={pending || !dirty}>{pending ? 'Saving…' : 'Save'}</button>
      </div>
    </form>
  )
}
