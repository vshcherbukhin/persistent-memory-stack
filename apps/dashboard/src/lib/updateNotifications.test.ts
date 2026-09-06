import { existsSync, readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { updateCommandForBranch, updateStatusPollMs } from './clientUpdate'

const mocks = vi.hoisted(() => ({ requireControlPlane: vi.fn(), getNotifySettings: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/session', () => ({ requireControlPlane: mocks.requireControlPlane, isSuperuser: () => true }))
vi.mock('@/lib/api', () => ({
  api: { getNotifySettings: mocks.getNotifySettings },
  normalizeMemorySurface: () => 'personal',
}))
vi.mock('../app/(dashboard)/notifications/NotifyForm', () => ({
  NotifyForm: () => createElement('div', null, 'Browser notification preferences'),
}))
vi.mock('../app/(dashboard)/notifications/NotificationsClient', () => ({ NotificationsClient: () => null }))

import NotificationsPage from '../app/(dashboard)/notifications/page'
import * as actions from '../app/(dashboard)/notifications/actions'

const src = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

beforeEach(() => {
  vi.clearAllMocks()
  mocks.requireControlPlane.mockResolvedValue({ deploymentMode: 'local', adminLevel: 'superuser' })
  mocks.getNotifySettings.mockResolvedValue({ global: null, team: null })
})

describe('automatic public release checks', () => {
  it.each([undefined, 'application-updates'])('renders notification preferences without an update-source configuration tab (%s)', async (setting) => {
    const page = await NotificationsPage({ searchParams: Promise.resolve(setting ? { setting } : {}) })
    const markup = renderToStaticMarkup(page)
    expect(markup).toContain('System notifications')
    expect(markup).toContain('Browser notification preferences')
    expect(markup).toContain('role="tab"')
    expect(markup).not.toContain('application-updates')
    expect(markup).not.toContain('GitHub token')
    expect(markup).not.toContain('Test connection')
    expect(markup).not.toContain('Update source')
    expect(mocks.getNotifySettings).toHaveBeenCalledExactlyOnceWith(undefined, 'personal')
    expect(existsSync(new URL('../app/(dashboard)/notifications/UpdateNotificationsCard.tsx', import.meta.url))).toBe(false)
  })

  it('has no server action or dashboard client method for changing or testing update sources', () => {
    expect(Object.keys(actions)).toEqual(['saveNotifyTargetAction'])
    const api = src('api.ts')
    expect(api).not.toContain('/dashboard/update/settings')
    expect(api).not.toContain('/dashboard/update/test')
    expect(api).toContain("updateStatus: () => call<UpdateStatus>('/dashboard/update')")
    expect(api).toContain("startUpdate: () => call<{ ok: boolean }>('/dashboard/update/start', { method: 'POST' })")
  })

  it('polls for releases before an update is available and keeps the explicit terminal update command', () => {
    expect(updateStatusPollMs(null)).toBe(10_000)
    expect(updateStatusPollMs({ updateAvailable: false, running: false })).toBe(10_000)
    expect(updateStatusPollMs({ updateAvailable: true, running: false })).toBe(2_000)
    expect(updateCommandForBranch('master')).toBe('npm run update-persistent-memory -- --branch master')
    const header = src('../components/AppHeader.tsx')
    expect(header).toContain('const updatesEnabled = localMode && canStartUpdate')
    expect(header).toContain('void refreshUpdateStatus()')
    expect(header).toContain("fetch('/api/update/status', { cache: 'no-store' })")
    expect(header).toContain('window.setInterval(() => void refreshUpdateStatus(), updatePollMs)')
    expect(header).toContain('Run the terminal updater from this repository.')
    expect(header).not.toContain("fetch('/api/update/start'")
    expect(header).toContain("data: { url: '/overview' }")
  })
})
