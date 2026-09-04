import { requireControlPlane, isSuperuser } from '@/lib/session'
import { api, normalizeMemorySurface } from '@/lib/api'
import type { UpdateNotificationSettings } from '@/lib/types'
import { NotificationsClient, type NotificationTarget } from './NotificationsClient'
import { UpdateNotificationsCard } from './UpdateNotificationsCard'
import { saveUpdateNotificationsAction, testUpdateNotificationsAction } from './actions'
import { SettingsLayout, SettingsPageFrame, SettingsSection, type SettingsNavItem } from '@/components/settings/SettingsShell'
import { NotifyForm } from './NotifyForm'
import { saveNotifyTargetAction } from './actions'

export const dynamic = 'force-dynamic'

/**
 * Notifications — where security alerts (DLP findings) are sent. admin+ baseline:
 * a team-admin edits their own team's routing; a super-admin additionally edits the
 * GLOBAL row (the support fan-out across all teams). Slack delivery is either an
 * incoming webhook OR a bot token + channel ids; both are write-only secrets. The
 * SMTP relay credentials live in env (not here). Notifications default OFF.
 */
export default async function NotificationsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = searchParams ? await searchParams : {}
  const surface = normalizeMemorySurface(Array.isArray(params.space) ? params.space[0] : params.space)
  const requestedSetting = Array.isArray(params.setting) ? params.setting[0] : params.setting
  const localWho = await requireControlPlane()
  const who = surface === 'shared' ? await api.memoryWhoami('shared') : localWho
  const personalMode = who.deploymentMode === 'local' && surface === 'personal'
  const superuser = isSuperuser(who)
  const teams = superuser && !personalMode ? await api.listTeams(surface) : []
  const baseSettings = await api.getNotifySettings(undefined, surface)
  const teamSettings = superuser
    ? await Promise.all(teams.map(async (team) => ({ team, settings: (await api.getNotifySettings(team.id, surface)).team })))
    : []
  const targets: NotificationTarget[] = personalMode
    ? [
        {
          id: 'system',
          kind: 'system',
          name: 'System Notifications',
          description: 'Browser notification preferences for this personal memory stack.',
          teamId: null,
          current: baseSettings.global,
        },
      ]
    : superuser
      ? [
          {
            id: 'system',
            kind: 'system',
            name: 'System Notifications',
            description: 'Fallback/support routing for alerts across all teams.',
            teamId: null,
            current: baseSettings.global,
          },
          ...teamSettings.map(({ team, settings }) => ({
            id: `team:${team.id}`,
            kind: 'team' as const,
            name: team.name,
            description: 'Team-specific security alert routing.',
            teamId: team.id,
            current: settings,
          })),
        ]
    : [
        {
          id: `team:${who.teamId ?? 'own'}`,
          kind: 'team',
          name: who.teamName ?? 'Your team',
          description: 'Security alert routing for your team.',
          teamId: who.teamId,
          current: baseSettings.team,
        },
      ]
  const showUpdateSettings = isSuperuser(who) && personalMode
  let updateSettings: UpdateNotificationSettings | null = null
  let updateSettingsError: string | null = null
  if (showUpdateSettings) {
    try {
      updateSettings = await api.getUpdateSettings()
    } catch (err) {
      updateSettingsError = err instanceof Error ? err.message : 'Update settings unavailable'
    }
  }
  const personalSettings: SettingsNavItem[] = [
    ...(showUpdateSettings ? [{
      id: 'application-updates',
      label: 'Application updates',
      description: 'Release checks and update source',
      href: notificationsSettingHref(surface, 'application-updates'),
    }] : []),
    {
      id: 'system-notifications',
      label: 'System notifications',
      description: 'Browser alerts and event types',
      href: notificationsSettingHref(surface, 'system-notifications'),
    },
  ]
  const activeSetting = personalSettings.some((item) => item.id === requestedSetting)
    ? requestedSetting!
    : personalSettings[0]?.id ?? 'system-notifications'

  if (personalMode) {
    return (
      <SettingsPageFrame>
        <SettingsLayout items={personalSettings} activeId={activeSetting}>
          {showUpdateSettings ? (
            <SettingsSection
              id="application-updates"
              title="Application updates"
              description="Configure the Bitbucket/Stash source used for local dashboard release checks."
            >
              <UpdateNotificationsCard
                action={saveUpdateNotificationsAction}
                testAction={testUpdateNotificationsAction}
                current={updateSettings}
                error={updateSettingsError}
              />
            </SettingsSection>
          ) : null}
          <SettingsSection
            id="system-notifications"
            title="System notifications"
            description="Choose which personal dashboard events can use Chrome/browser notifications."
          >
            <NotifyForm
              action={saveNotifyTargetAction}
              current={targets[0]?.current ?? null}
              targetKind="system"
              teamId={null}
              surface={surface}
              personalMode
            />
          </SettingsSection>
        </SettingsLayout>
      </SettingsPageFrame>
    )
  }

  return (
    <>
      <h1>Notifications</h1>
      <p className="muted" style={{ maxWidth: 720 }}>
        Where security alerts are delivered. Email is sent through the system SMTP relay (configured in env); recipients and Slack delivery are set per-team here. Delivery is best-effort — a failed notification never blocks a scan or a write.
      </p>
      <NotificationsClient
        targets={targets}
        surface={surface}
        showTargets
        personalMode={false}
      />
    </>
  )
}

function notificationsSettingHref(surface: 'personal' | 'shared', setting: string): string {
  const params = new URLSearchParams()
  if (surface === 'shared') params.set('space', 'shared')
  params.set('setting', setting)
  return `/notifications?${params.toString()}`
}
