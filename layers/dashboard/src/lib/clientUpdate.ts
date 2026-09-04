export const POST_UPDATE_RELEASE_NOTES_KEY = 'pm:post-update-release-notes-version'
export const POST_UPDATE_RELEASE_NOTES_SEEN_KEY = 'pm:post-update-release-notes-seen-id'
export const POST_UPDATE_RELEASE_NOTES_SHOWN_VERSION_KEY = 'pm:post-update-release-notes-shown-version'
export const POST_UPDATE_HANDOFF_SEEN_KEY = 'pm:update-handoff-seen-id'

type DeployedUpdateStatus = {
  currentVersion?: string | null
  lastSuccessfulUpdate?: PostUpdateMarker | null
}

type PostUpdateMarker = {
  id?: string | null
  version?: string | null
}

type UpdatePollingStatus = {
  updateAvailable?: boolean | null
  running?: boolean | null
}

export type UpdateHandoffPhase = 'idle' | 'updating' | 'rebuilding-dashboard' | 'verifying' | 'complete' | 'failed'

export type UpdateHandoffState =
  | { active: false; phase: 'idle' }
  | {
    active: true
    phase: Exclude<UpdateHandoffPhase, 'idle'>
    id?: string | null
    message?: string | null
    targetVersion?: string | null
    releaseNotesVersion?: string | null
    updatedAt?: string | null
    progress?: number | null
    error?: string | null
    compatibility?: boolean | null
  }

export type UpdateReloadReadyResult =
  | { ready: true }
  | { ready: false; reason?: string; message?: string }

function numericParts(version: string): number[] {
  return version
    .split('.')
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0))
}

export function compareSemver(a: string, b: string): number {
  const left = numericParts(a)
  const right = numericParts(b)
  const len = Math.max(left.length, right.length, 3)
  for (let i = 0; i < len; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

export function shouldReloadForDeployedVersion(loadedVersion: string, deployedVersion: string | null | undefined): boolean {
  return Boolean(deployedVersion && compareSemver(deployedVersion, loadedVersion) > 0)
}

export function postUpdateReloadVersion(loadedVersion: string, status: DeployedUpdateStatus): string | null {
  const candidates = [status.currentVersion, status.lastSuccessfulUpdate?.version]
    .filter((version): version is string => Boolean(version))
    .sort(compareSemver)
    .reverse()
  return candidates.find((version) => compareSemver(version, loadedVersion) > 0) ?? null
}

export function updateStatusPollMs(status: UpdatePollingStatus | null | undefined): number {
  return status?.updateAvailable || status?.running ? 2_000 : 10_000
}

export function shouldPollUpdateHandoff(localMode: boolean): boolean {
  return localMode
}

function quoteShellArg(value: string): string {
  return /^[A-Za-z0-9._/-]+$/u.test(value)
    ? value
    : `'${value.replace(/'/gu, "'\\''")}'`
}

export function updateCommandForBranch(branch: string | null | undefined): string {
  const cleanBranch = branch?.trim()
  if (!cleanBranch || cleanBranch === 'master') return 'npm run update-persistent-memory'
  if (cleanBranch === 'dev') return 'npm run update-persistent-memory -- --dev'
  return `npm run update-persistent-memory -- --branch ${quoteShellArg(cleanBranch)}`
}

export function isUpdateHandoffBlocking(state: UpdateHandoffState | null | undefined): boolean {
  return Boolean(
    state?.active
      && ['updating', 'rebuilding-dashboard', 'verifying', 'failed'].includes(state.phase),
  )
}

export function updateHandoffProgress(state: UpdateHandoffState | null | undefined): number {
  if (state?.active && typeof state.progress === 'number' && Number.isFinite(state.progress)) {
    return Math.max(0, Math.min(100, Math.round(state.progress)))
  }
  switch (state?.active ? state.phase : 'idle') {
    case 'updating':
      return 25
    case 'rebuilding-dashboard':
      return 50
    case 'verifying':
      return 82
    case 'complete':
      return 96
    case 'failed':
      return 100
    default:
      return 5
  }
}

export function updateHandoffTitle(state: UpdateHandoffState | null | undefined): string {
  if (state?.active && state.compatibility) return 'Live update view unavailable'
  if (state?.active && state.phase === 'failed') return 'Update needs attention'
  const version = state?.active ? state.targetVersion || state.releaseNotesVersion : null
  return version
    ? `Updating Persistent Memory to the latest release ${version}`
    : 'Updating Persistent Memory to the latest release'
}

export function handoffReloadVersion(
  loadedVersion: string,
  state: UpdateHandoffState | null | undefined,
  seenHandoffId?: string | null,
): string | null {
  if (!state?.active || state.phase !== 'complete') return null
  const version = state.releaseNotesVersion || state.targetVersion
  if (version && compareSemver(version, loadedVersion) > 0) return version
  if (state.id && state.id !== seenHandoffId) return version || loadedVersion
  return null
}

export async function waitForUpdateReloadReady(
  targetVersion: string,
  opts: { attempts?: number; delayMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<UpdateReloadReadyResult> {
  const attempts = opts.attempts ?? 90
  const delayMs = opts.delayMs ?? 1_000
  const fetcher = opts.fetchImpl ?? fetch
  const delay = () => new Promise((resolve) => globalThis.setTimeout(resolve, delayMs))

  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetcher(`/api/update/reload-ready?version=${encodeURIComponent(targetVersion)}`, { cache: 'no-store' })
      const body = await res.json().catch(() => null) as UpdateReloadReadyResult | null
      if (res.ok && body?.ready) return { ready: true }
      if (i === attempts - 1) {
        return body && !body.ready ? body : { ready: false, reason: `reload_ready_${res.status}` }
      }
    } catch (err) {
      if (i === attempts - 1) {
        return { ready: false, reason: 'reload_ready_unreachable', message: err instanceof Error ? err.message : String(err) }
      }
    }
    await delay()
  }

  return { ready: false, reason: 'reload_ready_timeout' }
}

export function shouldOpenPostUpdateReleaseNotes(
  loadedVersion: string,
  pendingVersion: string | null | undefined,
): boolean {
  return Boolean(pendingVersion && compareSemver(loadedVersion, pendingVersion) >= 0)
}

export function shouldOpenPostUpdateMarkerReleaseNotes(
  loadedVersion: string,
  marker: PostUpdateMarker | null | undefined,
  seenMarkerId: string | null | undefined,
): boolean {
  return Boolean(
    marker?.id
      && marker.version
      && marker.id !== seenMarkerId
      && compareSemver(loadedVersion, marker.version) >= 0,
  )
}

export function shouldSkipPostUpdateMarkerAfterShownVersion(
  shownVersion: string | null | undefined,
  marker: PostUpdateMarker | null | undefined,
): boolean {
  return Boolean(
    shownVersion
      && marker?.version
      && compareSemver(shownVersion, marker.version) >= 0,
  )
}
