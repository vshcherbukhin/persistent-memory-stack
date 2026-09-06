import { describe, expect, it, vi } from 'vitest'
import {
  PUBLIC_RELEASE_LINE,
  POST_UPDATE_RELEASE_NOTES_KEY,
  POST_UPDATE_RELEASE_NOTES_SEEN_KEY,
  POST_UPDATE_RELEASE_NOTES_SHOWN_VERSION_KEY,
  POST_UPDATE_HANDOFF_SEEN_KEY,
  handoffReloadVersion,
  isUpdateHandoffBlocking,
  shouldOpenPostUpdateMarkerReleaseNotes,
  postUpdateReloadVersion,
  shouldPollUpdateHandoff,
  shouldOpenPostUpdateReleaseNotes,
  shouldSkipPostUpdateMarkerAfterShownVersion,
  shouldReloadForDeployedVersion,
  updateCommandForBranch,
  updateHandoffTitle,
  updateStatusPollMs,
  waitForUpdateReloadReady,
} from './clientUpdate'

describe('client update reload handoff', () => {
  it('reloads only when the deployed dashboard is newer than the loaded bundle', () => {
    expect(shouldReloadForDeployedVersion('3.7.2', '3.7.3')).toBe(true)
    expect(shouldReloadForDeployedVersion('3.7.2', '3.7.2')).toBe(false)
    expect(shouldReloadForDeployedVersion('3.7.3', '3.7.2')).toBe(false)
    expect(shouldReloadForDeployedVersion('3.7.9', '3.7.10')).toBe(true)
  })

  it('uses the newest deployed or post-update marker version as the reload target', () => {
    expect(postUpdateReloadVersion('3.7.2', { releaseLine: PUBLIC_RELEASE_LINE, currentVersion: '3.7.2', lastSuccessfulUpdate: { releaseLine: PUBLIC_RELEASE_LINE, version: '3.7.3' } })).toBe('3.7.3')
    expect(postUpdateReloadVersion('3.7.2', { releaseLine: PUBLIC_RELEASE_LINE, currentVersion: '3.7.4', lastSuccessfulUpdate: { releaseLine: PUBLIC_RELEASE_LINE, version: '3.7.3' } })).toBe('3.7.4')
    expect(postUpdateReloadVersion('3.7.2', { releaseLine: PUBLIC_RELEASE_LINE, currentVersion: '3.7.2' })).toBeNull()
  })

  it('opens post-update release notes after the loaded bundle catches up or passes the pending version', () => {
    expect(shouldOpenPostUpdateReleaseNotes('3.7.4', '3.7.4')).toBe(true)
    expect(shouldOpenPostUpdateReleaseNotes('3.7.4', '3.7.3')).toBe(true)
    expect(shouldOpenPostUpdateReleaseNotes('3.7.3', '3.7.4')).toBe(false)
    expect(shouldOpenPostUpdateReleaseNotes('3.7.4', null)).toBe(false)
  })

  it('opens release notes once from a completed update marker when no reload handoff flag exists', () => {
    const marker = { releaseLine: PUBLIC_RELEASE_LINE, id: 'marker-1', version: '3.7.5' }

    expect(shouldOpenPostUpdateMarkerReleaseNotes('3.7.5', marker, null)).toBe(true)
    expect(shouldOpenPostUpdateMarkerReleaseNotes('3.7.6', marker, null)).toBe(true)
    expect(shouldOpenPostUpdateMarkerReleaseNotes('3.7.4', marker, null)).toBe(false)
    expect(shouldOpenPostUpdateMarkerReleaseNotes('3.7.5', marker, 'marker-1')).toBe(false)
    expect(shouldOpenPostUpdateMarkerReleaseNotes('3.7.5', null, null)).toBe(false)
  })

  it('does not reopen completed update marker notes after the same version was already shown', () => {
    const marker = { releaseLine: PUBLIC_RELEASE_LINE, id: 'marker-2', version: '3.8.0' }

    expect(shouldSkipPostUpdateMarkerAfterShownVersion('3.8.0', marker)).toBe(true)
    expect(shouldSkipPostUpdateMarkerAfterShownVersion('3.8.1', marker)).toBe(true)
    expect(shouldSkipPostUpdateMarkerAfterShownVersion('3.7.9', marker)).toBe(false)
    expect(shouldSkipPostUpdateMarkerAfterShownVersion(null, marker)).toBe(false)
    expect(shouldSkipPostUpdateMarkerAfterShownVersion('3.8.0', null)).toBe(false)
  })

  it('keeps status polling responsive even when no update card was visible before terminal update', () => {
    expect(updateStatusPollMs(null)).toBe(10_000)
    expect(updateStatusPollMs({ updateAvailable: false, running: false })).toBe(10_000)
    expect(updateStatusPollMs({ updateAvailable: true, running: false })).toBe(2_000)
    expect(updateStatusPollMs({ updateAvailable: false, running: true })).toBe(2_000)
  })

  it('keeps the update safety handoff active for every local dashboard, not only release notifications', () => {
    expect(shouldPollUpdateHandoff(true)).toBe(true)
    expect(shouldPollUpdateHandoff(false)).toBe(false)
  })

  it.each([undefined, null, '', '   ', 'master', ' master '])('targets public master explicitly instead of following the checkout (%s)', (branch) => {
    expect(updateCommandForBranch(branch)).toBe('npm run update-persistent-memory -- --branch master')
  })

  it('preserves intentional development and custom branch update commands', () => {
    expect(updateCommandForBranch('dev')).toBe('npm run update-persistent-memory -- --dev')
    expect(updateCommandForBranch('feature/team-test')).toBe('npm run update-persistent-memory -- --branch feature/team-test')
    expect(updateCommandForBranch("feature/user's-test")).toBe("npm run update-persistent-memory -- --branch 'feature/user'\\''s-test'")
  })

  it('waits for dashboard reload readiness before allowing an update reload', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ready: false, reason: 'starting' }), { status: 503 }))
      .mockResolvedValueOnce(Response.json({ ready: true }))

    await expect(waitForUpdateReloadReady('4.0.5', { attempts: 2, delayMs: 0, fetchImpl })).resolves.toEqual({ ready: true })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(fetchImpl).toHaveBeenCalledWith('/api/update/reload-ready?version=4.0.5', { cache: 'no-store' })
  })

  it('blocks dashboard reload while the update handoff is still active', () => {
    expect(isUpdateHandoffBlocking({ releaseLine: PUBLIC_RELEASE_LINE, active: true, phase: 'updating' })).toBe(true)
    expect(isUpdateHandoffBlocking({ releaseLine: PUBLIC_RELEASE_LINE, active: true, phase: 'rebuilding-dashboard' })).toBe(true)
    expect(isUpdateHandoffBlocking({ releaseLine: PUBLIC_RELEASE_LINE, active: true, phase: 'verifying' })).toBe(true)
    expect(isUpdateHandoffBlocking({ releaseLine: PUBLIC_RELEASE_LINE, active: true, phase: 'failed' })).toBe(true)
    expect(isUpdateHandoffBlocking({ active: true, phase: 'complete' })).toBe(false)
    expect(isUpdateHandoffBlocking({ active: false, phase: 'idle' })).toBe(false)
  })

  it('tells an older dashboard when live update rendering is unavailable without blocking the terminal update', () => {
    expect(updateHandoffTitle({ active: true, phase: 'updating', compatibility: true })).toBe('Live update view unavailable')
    expect(isUpdateHandoffBlocking({ releaseLine: PUBLIC_RELEASE_LINE, active: true, phase: 'updating', compatibility: true })).toBe(true)
  })

  it('uses completed handoff release version as the only handoff reload trigger', () => {
    expect(handoffReloadVersion('4.0.5', { releaseLine: PUBLIC_RELEASE_LINE, active: true, phase: 'complete', releaseNotesVersion: '4.0.6' })).toBe('4.0.6')
    expect(handoffReloadVersion('4.0.6', { releaseLine: PUBLIC_RELEASE_LINE, active: true, phase: 'complete', releaseNotesVersion: '4.0.6' })).toBeNull()
    expect(handoffReloadVersion('4.0.5', { releaseLine: PUBLIC_RELEASE_LINE, active: true, phase: 'verifying', releaseNotesVersion: '4.0.6' })).toBeNull()
    expect(handoffReloadVersion('4.0.5', { active: false, phase: 'idle' })).toBeNull()
  })

  it('reloads once for completed same-version handoffs such as local dashboard redeploys', () => {
    const handoff = { releaseLine: PUBLIC_RELEASE_LINE, active: true, id: 'redeploy-1', phase: 'complete', targetVersion: '4.0.6' } as const

    expect(handoffReloadVersion('4.0.6', handoff, null)).toBe('4.0.6')
    expect(handoffReloadVersion('4.0.6', handoff, 'redeploy-1')).toBeNull()
  })
})

describe('public release lineage after version reset', () => {
  it('ignores unmarked and foreign 4.x status/markers instead of requesting an impossible reload', () => {
    for (const releaseLine of [undefined, 'pre-public']) {
      expect(postUpdateReloadVersion('1.0.0', { releaseLine, currentVersion: '4.0.36', lastSuccessfulUpdate: { releaseLine, version: '4.0.36' } })).toBeNull()
      expect(postUpdateReloadVersion('1.0.0', { releaseLine: PUBLIC_RELEASE_LINE, currentVersion: '1.0.0', lastSuccessfulUpdate: { releaseLine, version: '4.0.36' } })).toBeNull()
      const marker = { releaseLine, id: 'old-marker', version: '4.0.36' }
      expect(shouldOpenPostUpdateMarkerReleaseNotes('1.0.0', marker, null)).toBe(false)
      expect(shouldSkipPostUpdateMarkerAfterShownVersion('4.0.36', marker)).toBe(false)
      expect(handoffReloadVersion('1.0.0', { releaseLine, active: true, id: 'old-complete', phase: 'complete', targetVersion: '4.0.36' })).toBeNull()
      for (const phase of ['updating', 'rebuilding-dashboard', 'verifying', 'failed'] as const) {
        expect(isUpdateHandoffBlocking({ releaseLine, active: true, phase, targetVersion: '4.0.36' })).toBe(false)
      }
    }
  })

  it('still reloads and opens release notes for the next public release', () => {
    const marker = { releaseLine: PUBLIC_RELEASE_LINE, id: 'public-marker', version: '1.0.1' }
    expect(postUpdateReloadVersion('1.0.0', { releaseLine: PUBLIC_RELEASE_LINE, currentVersion: '1.0.1', lastSuccessfulUpdate: marker })).toBe('1.0.1')
    expect(shouldOpenPostUpdateMarkerReleaseNotes('1.0.1', marker, null)).toBe(true)
    expect(handoffReloadVersion('1.0.0', { releaseLine: PUBLIC_RELEASE_LINE, active: true, id: 'public-complete', phase: 'complete', targetVersion: '1.0.1' })).toBe('1.0.1')
  })

  it('isolates browser release state without deleting old keys or suppressing first-public notes', () => {
    const oldState = new Map([
      ['pm:post-update-release-notes-version', '4.0.36'],
      ['pm:post-update-release-notes-seen-id', 'old-marker'],
      ['pm:post-update-release-notes-shown-version', '4.0.36'],
      ['pm:update-handoff-seen-id', 'old-handoff'],
    ])
    const snapshot = [...oldState]
    for (const key of [POST_UPDATE_RELEASE_NOTES_KEY, POST_UPDATE_RELEASE_NOTES_SEEN_KEY, POST_UPDATE_RELEASE_NOTES_SHOWN_VERSION_KEY, POST_UPDATE_HANDOFF_SEEN_KEY]) {
      expect(key).toContain(PUBLIC_RELEASE_LINE)
      expect(oldState.has(key)).toBe(false)
    }
    const marker = { releaseLine: PUBLIC_RELEASE_LINE, id: 'public-first', version: '1.0.0' }
    expect(shouldSkipPostUpdateMarkerAfterShownVersion(oldState.get(POST_UPDATE_RELEASE_NOTES_SHOWN_VERSION_KEY), marker)).toBe(false)
    expect(shouldOpenPostUpdateMarkerReleaseNotes('1.0.0', marker, oldState.get(POST_UPDATE_RELEASE_NOTES_SEEN_KEY))).toBe(true)
    expect([...oldState]).toEqual(snapshot)
  })
})
