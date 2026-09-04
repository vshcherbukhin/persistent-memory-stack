'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import { logoutAction } from '@/app/login/actions'
import {
  POST_UPDATE_HANDOFF_SEEN_KEY,
  POST_UPDATE_RELEASE_NOTES_KEY,
  POST_UPDATE_RELEASE_NOTES_SEEN_KEY,
  POST_UPDATE_RELEASE_NOTES_SHOWN_VERSION_KEY,
  handoffReloadVersion,
  isUpdateHandoffBlocking,
  postUpdateReloadVersion,
  shouldOpenPostUpdateMarkerReleaseNotes,
  shouldOpenPostUpdateReleaseNotes,
  shouldSkipPostUpdateMarkerAfterShownVersion,
  shouldPollUpdateHandoff,
  type UpdateHandoffState,
  updateCommandForBranch,
  updateHandoffProgress,
  updateHandoffTitle,
  updateStatusPollMs,
  waitForUpdateReloadReady,
} from '@/lib/clientUpdate'
import { APP_VERSION } from '@/lib/version'
import { sendBrowserNotificationOnce } from '@/lib/browserNotifications'
import { parseReleaseHistoryForUi, type ReleaseHistoryItem } from '@/lib/releaseHistory'
import type { UpdateStatus } from '@/lib/types'
import { Icon } from './ui/Icon'
import { Modal } from './ui/Modal'
import { Tooltip } from './ui/Tooltip'

/**
 * Dashboard top bar. Page title + subtitle derive from the active route. The top
 * bar shows team context only when the user belongs to a team, then the always-on
 * role badge, followed by the logout/lock control. In local mode with NO password
 * there's nothing to sign out of, so the control is hidden (showLogout=false).
 */
const TITLES: Record<string, [string, string]> = {
  overview: ['Overview', 'Control-plane summary — access entities only'],
  connection: ['Connection', 'Shared Memories Server connector'],
  memories: ['Memories', 'Read, search and edit memories across teams'],
  services: ['Services', 'Local stack monitor via the docker-control sidecar'],
  workers: ['Workers', 'Scheduled job monitor'],
  usage: ['Token usage', 'Model, service, and user request totals'],
  teams: ['Teams', 'Tenant boundaries — every memory is owned by a team'],
  users: ['Users', 'Members, admins, and their tokens'],
  tokens: ['Tokens', 'Issue, rotate and revoke MCP/API recovery tokens'],
  grants: ['Mounts', 'Directional, read-only cross-team memory links'],
  'team-settings': ['Team', 'Your team and the local user'],
  notifications: ['Notifications', 'Where security alerts are delivered'],
  security: ['Security', 'DLP / PII findings'],
  settings: ['System Settings', 'The embedding mode + pin (superuser-only)'],
  documentation: ['Documentation', 'Dashboard help for pages and tools'],
}

const LOCAL_TITLES: Record<string, [string, string]> = {
  overview: ['Overview', 'Personal memory stack summary'],
  connection: ['Connection', 'Shared Memories Server connector'],
  memories: ['Memories', 'Read, search and edit your personal memories'],
  services: ['Services', 'Local personal stack monitor'],
  workers: ['Workers', 'Personal stack scheduled jobs'],
  usage: ['Token usage', 'Model, service, and request totals'],
  security: ['Security', 'DLP / PII findings'],
  notifications: ['Notifications', 'Local dashboard notification settings'],
  settings: ['System Settings', 'Personal memory stack configuration'],
  documentation: ['Documentation', 'Dashboard help for pages and tools'],
}

const LOCAL_SHARED_TITLES: Record<string, [string, string]> = {
  overview: ['Overview', 'Shared Memories server summary'],
  connection: ['Connection', 'Shared Memories Server connector'],
  memories: ['Memories', 'Read, search and edit shared memories'],
  usage: ['Token usage', 'Shared server model, service, and request totals'],
  security: ['Security', 'Shared server DLP / PII findings'],
  notifications: ['Notifications', 'Shared server notification routing'],
  documentation: ['Documentation', 'Dashboard help for pages and tools'],
}

export function AppHeader({
  teamName,
  roleLabel,
  roleClass,
  showLogout,
  localMode,
  canStartUpdate,
  passwordTemporary,
}: {
  teamName: string | null
  roleLabel: string
  roleClass: 'super' | 'admin' | 'member'
  showLogout: boolean
  localMode: boolean
  canStartUpdate: boolean
  passwordTemporary: boolean
}) {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const seg = pathname.replace(/^\//, '').split('/')[0] || 'overview'
  const sharedSpace = localMode && (pathname.startsWith('/connection') || searchParams.get('space') === 'shared' || searchParams.get('surface') === 'shared')
  const documentationHref = `/documentation?space=${sharedSpace || searchParams.get('space') === 'shared' ? 'shared' : 'personal'}`
  const [title, sub] = sharedSpace && LOCAL_SHARED_TITLES[seg]
    ? LOCAL_SHARED_TITLES[seg]
    : localMode && LOCAL_TITLES[seg]
      ? LOCAL_TITLES[seg]
      : TITLES[seg] ?? TITLES.overview
  const [releaseOpen, setReleaseOpen] = useState(false)
  const [releaseText, setReleaseText] = useState<string | null>(null)
  const [releaseError, setReleaseError] = useState<string | null>(null)
  const releases = useMemo(() => (releaseText ? parseReleaseHistoryForUi(releaseText) : []), [releaseText])
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null)
  const [updateHandoff, setUpdateHandoffState] = useState<UpdateHandoffState | null>(null)
  const [updateError, setUpdateError] = useState<string | null>(null)
  const [updateOpen, setUpdateOpen] = useState(false)
  const [commandCopied, setCommandCopied] = useState(false)
  const reloadPendingRef = useRef(false)
  const updateHandoffRef = useRef<UpdateHandoffState | null>(null)
  const updatesEnabled = localMode && canStartUpdate
  const handoffPollingEnabled = shouldPollUpdateHandoff(localMode)
  const handoffBlocking = isUpdateHandoffBlocking(updateHandoff)
  const handoffProgress = updateHandoffProgress(updateHandoff)
  const updatePollMs = handoffBlocking ? 1_000 : updateStatusPollMs(updateStatus)
  const updateCommand = useMemo(() => updateCommandForBranch(updateStatus?.updateBranch), [updateStatus?.updateBranch])
  const updateBranch = updateStatus?.updateBranch?.trim() || 'master'
  const updateTargetsReleaseBranch = updateBranch === 'master'
  const updateToastSubtitle = !updateTargetsReleaseBranch && updateStatus?.latestVersion === updateStatus?.currentVersion
    ? `origin/${updateBranch} has newer commits`
    : `${updateStatus?.currentVersion ?? APP_VERSION} → ${updateStatus?.latestVersion ?? 'unknown'}`

  const setUpdateHandoff = (state: UpdateHandoffState | null) => {
    updateHandoffRef.current = state
    setUpdateHandoffState(state)
  }

  const openReleaseHistory = async () => {
    setReleaseOpen(true)
    if (releaseText != null || releaseError != null) return
    try {
      const res = await fetch('/release-history.md', { cache: 'no-store' })
      if (!res.ok) throw new Error(`release history returned ${res.status}`)
      setReleaseText(await res.text())
    } catch (e) {
      setReleaseError(e instanceof Error ? e.message : String(e))
    }
  }

  const openPostUpdateReleaseNotes = (marker?: UpdateStatus['lastSuccessfulUpdate']): boolean => {
    const pendingReleaseNotesVersion = window.localStorage.getItem(POST_UPDATE_RELEASE_NOTES_KEY)
    if (shouldOpenPostUpdateReleaseNotes(APP_VERSION, pendingReleaseNotesVersion)) {
      window.localStorage.removeItem(POST_UPDATE_RELEASE_NOTES_KEY)
      window.localStorage.setItem(POST_UPDATE_RELEASE_NOTES_SHOWN_VERSION_KEY, pendingReleaseNotesVersion!)
      if (marker?.id) window.localStorage.setItem(POST_UPDATE_RELEASE_NOTES_SEEN_KEY, marker.id)
      void openReleaseHistory()
      return true
    }

    const seenMarkerId = window.localStorage.getItem(POST_UPDATE_RELEASE_NOTES_SEEN_KEY)
    const shownVersion = window.localStorage.getItem(POST_UPDATE_RELEASE_NOTES_SHOWN_VERSION_KEY)
    if (shouldSkipPostUpdateMarkerAfterShownVersion(shownVersion, marker)) {
      if (marker?.id) window.localStorage.setItem(POST_UPDATE_RELEASE_NOTES_SEEN_KEY, marker.id)
      return false
    }
    if (shouldOpenPostUpdateMarkerReleaseNotes(APP_VERSION, marker, seenMarkerId)) {
      window.localStorage.setItem(POST_UPDATE_RELEASE_NOTES_SEEN_KEY, marker!.id)
      window.localStorage.setItem(POST_UPDATE_RELEASE_NOTES_SHOWN_VERSION_KEY, marker!.version)
      void openReleaseHistory()
      return true
    }
    return false
  }

  const notifyUpdateAvailable = (status: UpdateStatus): void => {
    if (!status.updateAvailable || !status.latestVersion) return
    void sendBrowserNotificationOnce('newReleases', status.latestVersion, 'Persistent Memory update available', {
      body: `Version ${status.latestVersion} is ready to install.`,
      data: { url: '/notifications?setting=application-updates' },
    })
  }

  const refreshUpdateHandoff = async (): Promise<UpdateHandoffState | null> => {
    try {
      const res = await fetch('/api/update/handoff', { cache: 'no-store' })
      if (res.status === 404) {
        setUpdateHandoff(null)
        return null
      }
      if (!res.ok) throw new Error(`update handoff returned ${res.status}`)
      const handoff = (await res.json()) as UpdateHandoffState
      setUpdateHandoff(handoff)
      return handoff
    } catch (e) {
      if (isUpdateHandoffBlocking(updateHandoffRef.current)) return updateHandoffRef.current
      setUpdateHandoff(null)
      return null
    }
  }

  const refreshUpdateHandoffAndReload = async () => {
    try {
      const handoff = await refreshUpdateHandoff()
      const seenHandoffId = window.localStorage.getItem(POST_UPDATE_HANDOFF_SEEN_KEY)
      const handoffVersion = handoffReloadVersion(APP_VERSION, handoff, seenHandoffId)
      if (handoffVersion) {
        if (reloadPendingRef.current) return
        reloadPendingRef.current = true
        if (handoff?.active && handoff.id) window.localStorage.setItem(POST_UPDATE_HANDOFF_SEEN_KEY, handoff.id)
        window.localStorage.setItem(POST_UPDATE_RELEASE_NOTES_KEY, handoffVersion)
        const ready = await waitForUpdateReloadReady(handoffVersion)
        if (ready.ready) {
          window.location.reload()
          return
        }
        reloadPendingRef.current = false
        setUpdateError(ready.message ?? `Dashboard update is not ready yet (${ready.reason ?? 'unknown'}).`)
        return
      }
      if (isUpdateHandoffBlocking(handoff)) {
        if (!reloadPendingRef.current) {
          reloadPendingRef.current = true
          window.location.assign(window.location.href)
        }
        return
      }

    } catch (e) {
      setUpdateError(e instanceof Error ? e.message : String(e))
    }
  }

  const refreshUpdateStatus = async () => {
    try {
      const res = await fetch('/api/update/status', { cache: 'no-store' })
      if (!res.ok) throw new Error(`update status returned ${res.status}`)
      const status = (await res.json()) as UpdateStatus
      setUpdateStatus(status)
      setUpdateError(null)
      notifyUpdateAvailable(status)
      const reloadVersion = postUpdateReloadVersion(APP_VERSION, status)
      if (reloadVersion) {
        if (reloadPendingRef.current) return
        reloadPendingRef.current = true
        window.localStorage.setItem(POST_UPDATE_RELEASE_NOTES_KEY, reloadVersion)
        const ready = await waitForUpdateReloadReady(reloadVersion)
        if (ready.ready) {
          window.location.reload()
          return
        }
        reloadPendingRef.current = false
        setUpdateError(ready.message ?? `Dashboard update is not ready yet (${ready.reason ?? 'unknown'}).`)
        return
      }
      openPostUpdateReleaseNotes(status.lastSuccessfulUpdate)
    } catch (e) {
      setUpdateError(e instanceof Error ? e.message : String(e))
    }
  }

  const copyUpdateCommand = async () => {
    try {
      await navigator.clipboard.writeText(updateCommand)
      setCommandCopied(true)
      window.setTimeout(() => setCommandCopied(false), 1400)
    } catch (e) {
      setUpdateError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    if (!handoffPollingEnabled) return undefined
    void refreshUpdateHandoffAndReload()
    const handoffTimer = window.setInterval(() => void refreshUpdateHandoffAndReload(), 1_000)
    return () => window.clearInterval(handoffTimer)
  }, [handoffPollingEnabled])

  useEffect(() => {
    if (!updatesEnabled) return undefined
    void refreshUpdateStatus()
    const t = window.setInterval(() => void refreshUpdateStatus(), updatePollMs)
    return () => window.clearInterval(t)
  }, [updatesEnabled, updatePollMs])

  useEffect(() => {
    openPostUpdateReleaseNotes()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <header className="app-header">
        <div className="head-titles">
          <div className="head-title">{title}</div>
          <div className="head-sub">{sub}</div>
        </div>
        <div className="head-tabs" />
        <div className="head-actions">
          {teamName && !localMode ? <span className="head-badge head-team">{teamName}</span> : null}
          {!localMode ? <span className={`role-badge ${roleClass} head-role`}>{roleLabel}</span> : null}
          {showLogout ? (
            <form action={logoutAction}>
              <Tooltip label={localMode ? 'Lock dashboard' : 'Sign out'}>
                <button
                  type="submit"
                  className="avatar"
                  aria-label={localMode ? 'Lock dashboard' : 'Sign out'}
                >
                  <Icon name={localMode ? 'lock' : 'logout'} size={17} />
                </button>
              </Tooltip>
            </form>
          ) : null}
          <Tooltip label="Documentation">
            <Link
              href={documentationHref}
              className="avatar header-info-button"
              aria-label="Open documentation"
            >
              <Icon name="menu_book" size={17} />
            </Link>
          </Tooltip>
          <Tooltip label={`Release notes ${APP_VERSION}`}>
            <button
              type="button"
              className="avatar header-info-button"
              aria-label="Open release notes"
              onClick={() => void openReleaseHistory()}
            >
              <Icon name="new_releases" size={17} />
            </button>
          </Tooltip>
        </div>
      </header>
      {passwordTemporary ? (
        <div className="temp-password-banner" role="status">
          Please update your temporary{' '}
          <button
            type="button"
            className="link"
            onClick={() => window.dispatchEvent(new CustomEvent('pm:open-profile'))}
          >
            password
          </button>
          .
        </div>
      ) : null}
      {handoffBlocking ? (
        <div className="update-handoff-overlay" role="alert" aria-live="assertive">
          <div className={`update-handoff-panel ${updateHandoff?.active ? updateHandoff.phase : ''}`}>
            <div className="update-handoff-kicker">Persistent Memory</div>
            <div className="update-handoff-title-row">
              <div className="update-handoff-spinner" aria-hidden="true" />
              <div className="update-handoff-title">{updateHandoffTitle(updateHandoff)}</div>
            </div>
            <div className="update-handoff-message">
              {updateHandoff?.active ? updateHandoff.message : 'Preparing update status.'}
            </div>
            {updateHandoff?.phase !== 'failed' ? (
              <div className="update-handoff-progress">
                <div className="update-handoff-progress-meta">
                  <span>Progress</span>
                  <strong>{handoffProgress}%</strong>
                </div>
                <div
                  className="update-handoff-progress-track"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={handoffProgress}
                >
                  <div
                    className="update-handoff-progress-fill"
                    style={{ width: `${handoffProgress}%`, minWidth: handoffProgress > 0 ? '4px' : 0 }}
                  />
                </div>
              </div>
            ) : null}
            <div className="update-handoff-grid">
              <div>
                <span>Phase</span>
                <strong>{updateHandoff?.phase ?? 'updating'}</strong>
              </div>
              <div>
                <span>Version</span>
                <strong>{updateHandoff?.active ? updateHandoff.targetVersion ?? updateHandoff.releaseNotesVersion ?? 'detecting' : 'detecting'}</strong>
              </div>
              <div>
                <span>Updated</span>
                <strong>{updateHandoff?.active ? updateHandoff.updatedAt ?? 'waiting' : 'waiting'}</strong>
              </div>
            </div>
            {updateHandoff?.active && updateHandoff.error ? (
              <div className="update-handoff-error">{updateHandoff.error}</div>
            ) : null}
          </div>
        </div>
      ) : null}
      {updatesEnabled && !handoffBlocking && updateStatus?.updateAvailable ? (
        <div className="update-toast" role="status" aria-live="polite">
          <div className="update-toast-main">
            <div className="update-toast-title">Update available</div>
            <div className="update-toast-sub">
              {updateToastSubtitle}
            </div>
          </div>
          <div className="update-toast-actions">
            <button type="button" className="secondary" onClick={() => setUpdateOpen(true)}>Details</button>
          </div>
        </div>
      ) : null}
      {releaseOpen ? (
        <Modal
          title={`Persistent Memory ${APP_VERSION}`}
          onClose={() => setReleaseOpen(false)}
          width={860}
          className="release-modal"
          bodyClassName="release-modal-body"
        >
          {releaseError ? (
            <div className="notice danger" style={{ marginBottom: 0 }}>Could not load release history: {releaseError}</div>
          ) : releaseText == null ? (
            <div className="muted">Loading release history...</div>
          ) : (
            <ReleaseHistoryCards releases={releases} fallback={releaseText} />
          )}
        </Modal>
      ) : null}
      {updateOpen ? (
        <Modal
          title="Update Persistent Memory"
          onClose={() => setUpdateOpen(false)}
          width={860}
          className="release-modal"
          bodyClassName="release-modal-body"
        >
          <div className="update-modal-head">
            <div>
              <div className="section-label">Current version</div>
              <div className="update-version">{updateStatus?.currentVersion ?? APP_VERSION}</div>
            </div>
            <div>
              <div className="section-label">Latest version</div>
              <div className="update-version">{updateStatus?.latestVersion ?? 'unknown'}</div>
            </div>
            {!updateTargetsReleaseBranch ? (
              <div>
                <div className="section-label">Branch</div>
                <div className="update-version">origin/{updateBranch}</div>
              </div>
            ) : null}
          </div>
          {updateError ? <div className="notice danger">{updateError}</div> : null}
          <div className="update-guidance">
            <div className="update-guidance-card">
              <div className="section-label">Update command</div>
              <p>Run the terminal updater from this repository. It uses your normal host Git credentials and snapshots local data before rebuilds.</p>
              <div className="update-command-row">
                <code>{updateCommand}</code>
                <button type="button" className="secondary" onClick={() => void copyUpdateCommand()}>{commandCopied ? 'Copied' : 'Copy'}</button>
              </div>
            </div>
          </div>
          {updateStatus?.releaseNotes ? <ReleaseHistoryCards releases={[updateStatus.releaseNotes as unknown as ReleaseHistoryItem]} /> : null}
          {updateStatus?.mcpRestartRequired || updateStatus?.releaseNotes?.mcpRestartRequired ? (
            <div className="notice warn">Restart Claude/Codex after the update so MCP changes are loaded.</div>
          ) : null}
        </Modal>
      ) : null}
    </>
  )
}

function ReleaseHistoryCards({ releases, fallback }: { releases: ReleaseHistoryItem[]; fallback?: string }) {
  if (releases.length === 0 && fallback) {
    return (
      <article className="release-doc">
        <pre>{fallback}</pre>
      </article>
    )
  }
  return (
    <div className="release-cards">
      {releases.map((release) => (
        <article key={`${release.version}-${release.date}`} className={`release-card${release.latest ? ' latest' : ''}`}>
          <div className="release-card-head">
            <div>
              <div className="release-card-title">{release.version}</div>
              <div className="release-card-date">{release.date}</div>
            </div>
            {release.latest ? <span className="release-latest-badge">Latest release</span> : null}
          </div>
          {release.services.length > 0 ? (
            <div className="release-services">
              {release.services.map((svc) => (
                <div className="release-service-row" key={`${release.version}-${svc.service}`}>
                  <span>{svc.service}</span>
                  <code>{svc.version}</code>
                  <em>{svc.change}</em>
                </div>
              ))}
            </div>
          ) : null}
          <pre>{release.body}</pre>
        </article>
      ))}
    </div>
  )
}
