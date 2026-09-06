import source from './public-source.json' with { type: 'json' }

/** One committed source of truth for public release checks and update scripts. */
export const publicUpdateSource: Readonly<typeof source> = Object.freeze(source)

export interface PublicUpdateMetadata {
  latestCommit: string
  latestVersion: string
  releaseHistory: string
}

export class PublicUpdateSourceError extends Error {
  readonly retryAt: number

  constructor(message: string, retryAt = 0) {
    super(message)
    this.name = 'PublicUpdateSourceError'
    this.retryAt = retryAt
  }
}

export function isPublicUpdateRepository(remote: string): boolean {
  const repository = `${publicUpdateSource.owner}/${publicUpdateSource.repo}`.toLowerCase()
  const value = remote.toLowerCase()
  return [`https://github.com/${repository}`, `git@github.com:${repository}`, `ssh://git@github.com/${repository}`]
    .some(expected => value === expected || value === `${expected}.git`)
}

function retryDeadline(response: Response, now: number): number {
  if (response.status !== 403 && response.status !== 429) return 0
  const retryAfter = response.headers.get('retry-after')
  const seconds = retryAfter && /^\d+$/u.test(retryAfter) ? Number(retryAfter) : NaN
  const retryDate = retryAfter && !Number.isFinite(seconds) ? Date.parse(retryAfter) : NaN
  const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000
  // GitHub requires at least one minute for secondary limits without headers.
  const candidates = [now + 60_000]
  if (Number.isFinite(seconds)) candidates.push(now + seconds * 1000)
  if (Number.isFinite(retryDate)) candidates.push(retryDate)
  if (response.headers.get('x-ratelimit-remaining') === '0' && Number.isFinite(reset)) candidates.push(reset)
  return Math.max(...candidates)
}

async function request(path: string, raw: boolean, fetchImpl: typeof fetch, signal: AbortSignal, now: () => number): Promise<string> {
  const url = `https://api.github.com/repos/${publicUpdateSource.owner}/${publicUpdateSource.repo}/${path}`
  try {
    const response = await fetchImpl(url, {
      headers: {
        accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
        'x-github-api-version': '2026-03-10',
        'user-agent': 'persistent-memory-update-check',
      },
      redirect: 'error', signal,
    })
    if (!response.ok) throw new PublicUpdateSourceError(`Public update source returned HTTP ${response.status}.`, retryDeadline(response, now()))
    return await response.text()
  } catch (error) {
    if (error instanceof PublicUpdateSourceError) throw error
    // Remote response bodies and network exceptions are never surfaced or logged.
    throw new PublicUpdateSourceError('Public update source is temporarily unavailable.')
  }
}

export async function fetchPublicUpdateMetadata(fetchImpl: typeof fetch = fetch, now: () => number = Date.now): Promise<PublicUpdateMetadata> {
  // One deadline covers branch, immutable files, and response bodies.
  const signal = AbortSignal.timeout(12_000)
  try {
    const branch = JSON.parse(await request(`branches/${encodeURIComponent(publicUpdateSource.branch)}`, false, fetchImpl, signal, now)) as { commit?: { sha?: unknown } }
    const latestCommit = branch?.commit?.sha
    if (typeof latestCommit !== 'string' || !/^[a-f\d]{40}$/iu.test(latestCommit)) throw new Error('Invalid commit')
    const ref = new URLSearchParams({ ref: latestCommit }).toString()
    const pkg = JSON.parse(await request(`contents/package.json?${ref}`, true, fetchImpl, signal, now)) as { version?: unknown; persistentMemoryReleaseLine?: unknown }
    if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg) || typeof pkg.version !== 'string'
      || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(pkg.version)) throw new Error('Invalid package version')
    if (pkg.persistentMemoryReleaseLine !== publicUpdateSource.releaseLine) {
      throw new PublicUpdateSourceError('The public release line is not available on the release branch yet.')
    }
    const releaseHistory = await request(`contents/release-history.md?${ref}`, true, fetchImpl, signal, now)
    return { latestCommit, latestVersion: pkg.version, releaseHistory }
  } catch (error) {
    if (error instanceof PublicUpdateSourceError) throw error
    throw new PublicUpdateSourceError('Public update source returned invalid release metadata.')
  }
}

export interface PublicUpdateMetadataCache {
  read(): Promise<PublicUpdateMetadata | null>
}

/** In-memory only: polling never writes configuration or starts an update. */
export function createPublicUpdateMetadataCache(options: { fetchImpl?: typeof fetch; now?: () => number } = {}): PublicUpdateMetadataCache {
  const now = options.now ?? Date.now
  const fetchImpl: typeof fetch = options.fetchImpl ?? ((...args) => fetch(...args))
  let cached: PublicUpdateMetadata | null = null
  let nextCheckAt = 0
  let failures = 0
  let pending: Promise<PublicUpdateMetadata | null> | undefined
  return {
    read(): Promise<PublicUpdateMetadata | null> {
      if (pending) return pending
      if (now() < nextCheckAt) return Promise.resolve(cached)
      pending = (async () => {
        try {
          cached = await fetchPublicUpdateMetadata(fetchImpl, now)
          failures = 0
          nextCheckAt = now() + 15 * 60_000
        } catch (error) {
          failures = Math.min(failures + 1, 5)
          const backoff = Math.min(60_000 * 2 ** (failures - 1), 15 * 60_000)
          nextCheckAt = Math.max(now() + backoff, error instanceof PublicUpdateSourceError ? error.retryAt : 0)
        }
        return cached
      })().finally(() => { pending = undefined })
      return pending
    },
  }
}

/** All runner instances in the process share one anonymous API request budget. */
export const publicUpdateMetadataCache = createPublicUpdateMetadataCache()
