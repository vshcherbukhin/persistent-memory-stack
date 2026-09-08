import source from './public-source.json' with { type: 'json' }
import { fetchPublishedReleaseMetadata, GitHubReleaseError } from '../../../scripts/github-releases.mjs'

/** One committed source of truth for public release checks and update scripts. */
export const publicUpdateSource: Readonly<typeof source> = Object.freeze(source)

export interface PublicUpdateMetadata {
  latestCommit: string
  latestVersion: string
  releaseHistory: string
  releaseTag: string
  releaseUrl: string
}

export { GitHubReleaseError as PublicUpdateSourceError }

export function isPublicUpdateRepository(remote: string): boolean {
  const repository = `${publicUpdateSource.owner}/${publicUpdateSource.repo}`.toLowerCase()
  const value = remote.toLowerCase()
  return [`https://github.com/${repository}`, `git@github.com:${repository}`, `ssh://git@github.com/${repository}`]
    .some(expected => value === expected || value === `${expected}.git`)
}

export async function fetchPublicUpdateMetadata(fetchImpl: typeof fetch = fetch, now: () => number = Date.now): Promise<PublicUpdateMetadata> {
  const release = await fetchPublishedReleaseMetadata({ fetchImpl, now })
  return {
    latestCommit: release.commit,
    latestVersion: release.version,
    releaseHistory: release.releaseHistory,
    releaseTag: release.tag,
    releaseUrl: release.url,
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
          nextCheckAt = Math.max(now() + backoff, error instanceof GitHubReleaseError ? error.retryAt : 0)
        }
        return cached
      })().finally(() => { pending = undefined })
      return pending
    },
  }
}

/** All runner instances in the process share one anonymous API request budget. */
export const publicUpdateMetadataCache = createPublicUpdateMetadataCache()
