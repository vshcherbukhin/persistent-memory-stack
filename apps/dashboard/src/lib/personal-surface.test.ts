import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const src = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const root = (path: string) => readFileSync(new URL(`../../../../${path}`, import.meta.url), 'utf8')

describe('personal memory surface contract', () => {
  it('keeps the personal memories table and detail badges team-free', () => {
    const memories = src('../app/(dashboard)/memories/MemoriesClient.tsx')

    expect(memories).toContain("const isPersonalSurface = surface === 'personal'")
    expect(memories).toContain("const showTeamColumn = surface === 'shared'")
    expect(memories).toContain('const tableColumns = useMemo')
    expect(memories).toContain('const teamWidth = showTeamColumn')
    expect(memories).toContain('fixedMemoryColumn(teamWidth)')
    expect(memories).toContain('{showTeamColumn ? <div>Team</div> : null}')
    expect(memories).toContain('teamLabel={showTeamColumn ? memoryTeamName(viewing) : null}')
    expect(memories).toContain('teamLabel ? <DetailBadge label="team" value={teamLabel} /> : null')
  })

  it('keeps personal import/export copy and metadata independent from teams', () => {
    const tools = src('../app/(dashboard)/memories/DashboardTools.tsx')

    expect(tools).toContain("const isPersonalSurface = surface === 'personal'")
    expect(tools).toContain("ownerConfirmation: true")
    expect(tools).toContain("isPersonalSurface ? 'personal memories'")
    expect(tools).toContain('I confirm these records belong to my personal knowledge space.')
    expect(tools).toContain("exportFileName(exportOptions, ext, isPersonalSurface ? 'personal' : 'shared')")
  })

  it('hides team/super-admin chrome in local personal mode', () => {
    const nav = src('../components/Nav.tsx')
    const header = src('../components/AppHeader.tsx')
    const profile = src('../components/ProfileModal.tsx')
    const settings = src('../app/(dashboard)/settings/page.tsx')

    expect(nav).not.toContain("label: 'Team', localOnly: true")
    expect(nav).not.toContain("label: 'Mounts'")
    expect(header).not.toContain('LOCAL_SHARED_TITLES')
    expect(header).toContain('Personal memories')
    expect(header).toContain('{teamName && !localMode ?')
    expect(header).toContain('{!localMode ? <span className={`role-badge ${roleClass} head-role`}>{roleLabel}</span> : null}')
    expect(profile).toContain('!localMode ? <span className={`role-badge ${roleClass}`}>{roleLabel}</span> : null')
    expect(profile).toContain('{!localMode && profile.teamName ? <span className="head-team">{profile.teamName}</span> : null}')
    expect(settings).toContain("const personalMode = who.deploymentMode === 'local'")
    expect(settings).toContain('...(!personalMode')
    expect(settings).toContain("id: 'dashboard-login'")
    expect(settings).not.toContain('SharedConnectionForm')
  })

  it('exposes one personal space and the Community label', () => {
    const nav = src('../components/Nav.tsx')
    const layout = src('../app/(dashboard)/layout.tsx')
    expect(nav).toContain('Community version')
    expect(nav).not.toContain('space-switch')
    expect(nav).not.toContain('Shared memories')
    expect(nav).not.toContain('SHARED_LINKS')
    expect(nav).not.toContain("label: 'Connection'")
    expect(layout).not.toContain('sharedConnection')
  })

  it('retires sharing and multi-owner administration pages in local production builds', () => {
    for (const page of ['connection', 'grants', 'teams', 'users']) {
      const source = src(`../app/(dashboard)/${page}/page.tsx`)
      expect(source).toContain('notFound()')
      expect(source).toContain("export const dynamic = 'force-dynamic'")
    }
  })

  it('keeps personal notifications target-free and Slack-free', () => {
    const page = src('../app/(dashboard)/notifications/page.tsx')
    const client = src('../app/(dashboard)/notifications/NotificationsClient.tsx')
    const form = src('../app/(dashboard)/notifications/NotifyForm.tsx')
    const browserNotifications = src('browserNotifications.ts')
    const shell = src('../components/settings/SettingsShell.tsx')

    expect(page).toContain('const personalMode = who.deploymentMode ===')
    expect(page).not.toContain('profile?.email')
    expect(page).not.toContain('api.getProfile')
    expect(page).toContain('if (personalMode)')
    expect(page).toContain('<SettingsPageFrame')
    expect(page).not.toContain('title="Notifications"')
    expect(page).not.toContain('Local dashboard notification preferences for browser-based alerts')
    expect(page).toContain('<SettingsLayout')
    expect(page).not.toContain('Application updates')
    expect(page).toContain('System notifications')
    expect(shell).toContain('settings-shell')
    expect(shell).toContain('settings-page-frame')
    expect(shell).not.toContain('settings-page-head')
    expect(shell).toContain('settings-nav')
    expect(shell).toContain("'use client'")
    expect(shell).toContain('window.history.pushState')
    expect(shell).toContain('role="tab"')
    expect(shell).not.toContain('<a ')
    expect(shell).not.toContain('<a\n')
    expect(client).toContain('showTargets = true')
    expect(client).toContain('{showTargets ? (')
    expect(form).toContain('personalMode')
    expect(form).toContain('Enable Chrome/browser notifications')
    expect(form).toContain('PERSONAL_NOTIFICATION_TYPES')
    expect(form).toContain('draftBrowserNotifications')
    expect(form).toContain('savedBrowserNotifications')
    expect(form).toContain('draftBrowserNotificationTypes')
    expect(form).toContain('savedBrowserNotificationTypes')
    expect(form).toContain('browserEnabledDirty')
    expect(form).toContain('browserTypeDirty')
    expect(form).toContain('browserSettingsDirty')
    expect(form).toContain('saveBrowserNotificationSettings')
    expect(form).toContain('toggleBrowserNotificationsDraft')
    expect(form).toContain('browserNotificationTypesLocked')
    expect(form).toContain('onChange={toggleBrowserNotificationsDraft}')
    expect(form).toContain('disabled={browserNotificationTypesLocked}')
    expect(form).toContain('disabled={!browserSettingsDirty || browserBusy}')
    expect(form).toContain("toast.success('Notification settings saved.')")
    const saveBrowserSettings = form.slice(
      form.indexOf('const saveBrowserNotificationSettings'),
      form.indexOf('  const toggleBrowserNotificationType'),
    )
    const toggleBrowserType = form.slice(
      form.indexOf('const toggleBrowserNotificationType'),
      form.indexOf('  const toggleBrowserNotificationsDraft'),
    )
    const toggleBrowserEnabled = form.slice(
      form.indexOf('const toggleBrowserNotificationsDraft'),
      form.indexOf('  if (personalMode)'),
    )
    expect(saveBrowserSettings).toContain('await enableBrowserNotifications(nextTypes)')
    expect(saveBrowserSettings).toContain('await updateBrowserNotificationPreferences(nextTypes)')
    expect(saveBrowserSettings).toContain('await disableBrowserNotifications()')
    expect(toggleBrowserType).not.toContain('updateBrowserNotificationPreferences')
    expect(toggleBrowserType).not.toContain('enableBrowserNotifications')
    expect(toggleBrowserType).not.toContain('disableBrowserNotifications')
    expect(toggleBrowserEnabled).not.toContain('updateBrowserNotificationPreferences')
    expect(toggleBrowserEnabled).not.toContain('enableBrowserNotifications')
    expect(toggleBrowserEnabled).not.toContain('disableBrowserNotifications')
    expect(browserNotifications).not.toContain("label: 'New releases'")
    expect(browserNotifications).toContain("label: 'Memory added'")
    expect(browserNotifications).toContain("label: 'Memory updated'")
    expect(browserNotifications).toContain("label: 'Memory removed'")
    expect(browserNotifications).toContain("label: 'Security alerts'")
    expect(browserNotifications).toContain('pm:laptopNotifications')
    expect(form).not.toContain('Browser notification permission is tied to this Chrome/browser profile')
    expect(form).not.toContain('Registered for this browser profile')
    expect(form).not.toContain('Notification type choices are saved immediately in this browser.')
    expect(client).not.toContain('state-badge ok')
    expect(form).not.toContain("personalMode ? 'Email' : 'Email recipients (comma-separated)'")
    expect(form).toContain('if (personalMode)')
  })

  it('does not collapse repeated browser push events with a default service-worker tag', () => {
    const serviceWorker = root('apps/dashboard/public/pm-sw.js')
    const form = src('../app/(dashboard)/notifications/NotifyForm.tsx')

    expect(serviceWorker).toContain('self.skipWaiting()')
    expect(serviceWorker).toContain('self.clients.claim()')
    expect(serviceWorker).toContain("if (typeof payload.tag === 'string' && payload.tag.trim()) options.tag = payload.tag")
    expect(serviceWorker).not.toContain("payload.data?.type || 'persistent-memory'")
    expect(form).toContain('refreshBrowserNotificationServiceWorker')
  })

  it('omits team flags from personal exports and uninstall exports', () => {
    const actions = src('../app/(dashboard)/memories/actions.ts')
    const apiRoute = root('apps/api/src/routes/knowledge-archive.ts')
    const exportRoute = apiRoute.slice(apiRoute.indexOf("routes.get('/memories/export'"), apiRoute.indexOf("routes.post('/memories/import'"))
    const uninstall = root('deploy/scripts/uninstall.sh')

    expect(actions).toContain('stripTeamFieldsFromPersonalExport')
    expect(actions).toContain("surface === 'personal' ? stripTeamFieldsFromPersonalExport(envelope) : envelope")
    expect(exportRoute).toContain("schema:'pm.memory-export/2'")
    expect(exportRoute).toContain('knowledgeWhere(req.query)')
    expect(exportRoute).not.toMatch(/\bteamId\s*:/)
    expect(exportRoute).toContain('revisionHistory')
    expect(uninstall).not.toContain("'teamId', m.team_id::text")
    expect(uninstall).not.toContain("'teamName'")
    expect(uninstall).not.toContain("'teamId', NULL")
  })

  it('never reads old credentials or proxies to a shared memory server', () => {
    const api = src('api.ts')
    expect(api).toContain("'sharing_retired'")
    expect(api).toContain('normalizeMemorySurface(surface)')
    expect(api).not.toContain('PM_SHARED_API_URL')
    expect(api).not.toContain('PM_SHARED_USER_TOKEN')
    expect(api).not.toContain('/dashboard/shared-connection')
    expect(api).not.toContain('connection.apiUrl')
  })

  it('does not send an empty JSON content type on no-body API calls', () => {
    const api = src('api.ts')

    expect(api).toContain('const headers = new Headers(init?.headers)')
    expect(api).toContain("if (init?.body != null && !headers.has('content-type')) headers.set('content-type', 'application/json')")
    expect(api).not.toContain("'content-type': 'application/json',")
    expect(api).toContain("sendBrowserPushTest: () => call<BrowserPushSendResult>('/dashboard/browser-push/test', { method: 'POST' })")
  })
})
