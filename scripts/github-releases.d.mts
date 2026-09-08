export interface PublishedRelease {
  tag: string
  version: string
  commit: string
  url: string
}
export interface GitHubReleaseOptions {
  version?: string
  fetchImpl?: typeof fetch
  signal?: AbortSignal
  now?: () => number
}
export class GitHubReleaseError extends Error {
  readonly retryAt: number
  constructor(message: string, retryAt?: number)
}
export function fetchPublishedRelease(options?: GitHubReleaseOptions): Promise<PublishedRelease>
export function fetchPublishedReleaseMetadata(options?: GitHubReleaseOptions): Promise<PublishedRelease & { releaseHistory: string }>
export function listPublishedReleases(options?: Omit<GitHubReleaseOptions, 'version'>): Promise<Array<Omit<PublishedRelease, 'commit'>>>
