import { describe, expect, it, vi } from 'vitest'
import {
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
    expect(postUpdateReloadVersion('3.7.2', { currentVersion: '3.7.2', lastSuccessfulUpdate: { version: '3.7.3' } })).toBe('3.7.3')
    expect(postUpdateReloadVersion('3.7.2', { currentVersion: '3.7.4', lastSuccessfulUpdate: { version: '3.7.3' } })).toBe('3.7.4')
    expect(postUpdateReloadVersion('3.7.2', { currentVersion: '3.7.2' })).toBeNull()
  })

  it('opens post-update release notes after the loaded bundle catches up or passes the pending version', () => {
    expect(shouldOpenPostUpdateReleaseNotes('3.7.4', '3.7.4')).toBe(true)
    expect(shouldOpenPostUpdateReleaseNotes('3.7.4', '3.7.3')).toBe(true)
    expect(shouldOpenPostUpdateReleaseNotes('3.7.3', '3.7.4')).toBe(false)
    expect(shouldOpenPostUpdateReleaseNotes('3.7.4', null)).toBe(false)
  })

  it('opens release notes once from a completed update marker when no reload handoff flag exists', () => {
    const marker = { id: 'marker-1', version: '3.7.5' }

    expect(shouldOpenPostUpdateMarkerReleaseNotes('3.7.5', marker, null)).toBe(true)
    expect(shouldOpenPostUpdateMarkerReleaseNotes('3.7.6', marker, null)).toBe(true)
    expect(shouldOpenPostUpdateMarkerReleaseNotes('3.7.4', marker, null)).toBe(false)
    expect(shouldOpenPostUpdateMarkerReleaseNotes('3.7.5', marker, 'marker-1')).toBe(false)
    expect(shouldOpenPostUpdateMarkerReleaseNotes('3.7.5', null, null)).toBe(false)
  })

  it('does not reopen completed update marker notes after the same version was already shown', () => {
    const marker = { id: 'marker-2', version: '3.8.0' }

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

  it('builds update commands from the configured update branch', () => {
    expect(updateCommandForBranch(null)).toBe('npm run update-persistent-memory')
    expect(updateCommandForBranch('master')).toBe('npm run update-persistent-memory')
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
    expect(isUpdateHandoffBlocking({ active: true, phase: 'updating' })).toBe(true)
    expect(isUpdateHandoffBlocking({ active: true, phase: 'rebuilding-dashboard' })).toBe(true)
    expect(isUpdateHandoffBlocking({ active: true, phase: 'verifying' })).toBe(true)
    expect(isUpdateHandoffBlocking({ active: true, phase: 'failed' })).toBe(true)
    expect(isUpdateHandoffBlocking({ active: true, phase: 'complete' })).toBe(false)
    expect(isUpdateHandoffBlocking({ active: false, phase: 'idle' })).toBe(false)
  })

  it('tells an older dashboard when live update rendering is unavailable without blocking the terminal update', () => {
    expect(updateHandoffTitle({ active: true, phase: 'updating', compatibility: true })).toBe('Live update view unavailable')
    expect(isUpdateHandoffBlocking({ active: true, phase: 'updating', compatibility: true })).toBe(true)
  })

  it('uses completed handoff release version as the only handoff reload trigger', () => {
    expect(handoffReloadVersion('4.0.5', { active: true, phase: 'complete', releaseNotesVersion: '4.0.6' })).toBe('4.0.6')
    expect(handoffReloadVersion('4.0.6', { active: true, phase: 'complete', releaseNotesVersion: '4.0.6' })).toBeNull()
    expect(handoffReloadVersion('4.0.5', { active: true, phase: 'verifying', releaseNotesVersion: '4.0.6' })).toBeNull()
    expect(handoffReloadVersion('4.0.5', { active: false, phase: 'idle' })).toBeNull()
  })

  it('reloads once for completed same-version handoffs such as local dashboard redeploys', () => {
    const handoff = { active: true, id: 'redeploy-1', phase: 'complete', targetVersion: '4.0.6' } as const

    expect(handoffReloadVersion('4.0.6', handoff, null)).toBe('4.0.6')
    expect(handoffReloadVersion('4.0.6', handoff, 'redeploy-1')).toBeNull()
  })
})
