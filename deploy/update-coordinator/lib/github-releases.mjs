import source from './public-source.json' with { type: 'json' }
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const versionPattern = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u
const commitPattern = /^[a-f\d]{40}$/iu
const repository = `${source.owner}/${source.repo}`
const apiRoot = `https://api.github.com/repos/${repository}/`
const releaseRoot = `https://github.com/${repository}/releases/tag/`

export class GitHubReleaseError extends Error {
  constructor(message, retryAt = 0) {
    super(message)
    this.name = 'GitHubReleaseError'
    this.retryAt = retryAt
  }
}

function invalidMetadata() {
  return new GitHubReleaseError('Public update source returned invalid release metadata.')
}

function retryDeadline(response, now) {
  if (response.status !== 403 && response.status !== 429) return 0
  const retryAfter = response.headers.get('retry-after')
  const seconds = retryAfter && /^\d+$/u.test(retryAfter) ? Number(retryAfter) : NaN
  const retryDate = retryAfter && !Number.isFinite(seconds) ? Date.parse(retryAfter) : NaN
  const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000
  const candidates = [now + 60_000]
  if (Number.isFinite(seconds)) candidates.push(now + seconds * 1000)
  if (Number.isFinite(retryDate)) candidates.push(retryDate)
  if (response.headers.get('x-ratelimit-remaining') === '0' && Number.isFinite(reset)) candidates.push(reset)
  return Math.max(...candidates)
}

function requester({ fetchImpl = fetch, signal, now = Date.now } = {}) {
  // One total deadline includes release selection, tag peeling, files and bodies.
  const deadline = AbortSignal.timeout(12_000)
  const requestSignal = signal ? AbortSignal.any([deadline, signal]) : deadline
  return async (path, raw = false) => {
    try {
      const response = await fetchImpl(`${apiRoot}${path}`, {
        headers: {
          accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
          'x-github-api-version': '2026-03-10',
          'user-agent': 'persistent-memory-update-check',
        },
        redirect: 'error', signal: requestSignal,
      })
      if (!response.ok) throw new GitHubReleaseError(`Public update source returned HTTP ${response.status}.`, retryDeadline(response, now()))
      const text = await response.text()
      if (raw) return text
      try { return JSON.parse(text) } catch { throw invalidMetadata() }
    } catch (error) {
      if (error instanceof GitHubReleaseError) throw error
      // Do not expose provider response bodies, credential-bearing URLs or network errors.
      throw new GitHubReleaseError('Public update source is temporarily unavailable.')
    }
  }
}

function publishedRelease(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.draft !== false || value.prerelease !== false
    || typeof value.published_at !== 'string' || !Number.isFinite(Date.parse(value.published_at))
    || typeof value.tag_name !== 'string' || !value.tag_name.startsWith('v')) throw invalidMetadata()
  const version = value.tag_name.slice(1)
  if (!versionPattern.test(version)) throw invalidMetadata()
  const url = `${releaseRoot}${encodeURIComponent(value.tag_name)}`
  if (value.html_url !== url) throw invalidMetadata()
  return { tag: value.tag_name, version, url }
}

async function resolveTagCommit(tag, request) {
  const ref = await request(`git/ref/tags/${encodeURIComponent(tag)}`)
  if (ref?.ref !== `refs/tags/${tag}`) throw invalidMetadata()
  let object = ref.object
  const seen = new Set()
  // Lightweight refs point at commits; annotated tags must be peeled to commits.
  for (let depth = 0; depth < 8; depth++) {
    if (!object || typeof object.sha !== 'string' || !commitPattern.test(object.sha)) throw invalidMetadata()
    if (object.type === 'commit') return object.sha.toLowerCase()
    if (object.type !== 'tag' || seen.has(object.sha)) throw invalidMetadata()
    seen.add(object.sha)
    const annotated = await request(`git/tags/${object.sha}`)
    if (annotated?.sha !== object.sha) throw invalidMetadata()
    object = annotated.object
  }
  throw invalidMetadata()
}

/** Select only a published stable GitHub Release and verify its immutable content. */
export async function fetchPublishedReleaseMetadata(options = {}) {
  if (options.version !== undefined && (typeof options.version !== 'string' || !versionPattern.test(options.version))) throw invalidMetadata()
  const request = requester(options)
  const path = options.version === undefined ? 'releases/latest' : `releases/tags/v${options.version}`
  const release = publishedRelease(await request(path))
  if (options.version !== undefined && release.version !== options.version) throw invalidMetadata()
  // target_commitish can name a moving branch; it is deliberately never used.
  const commit = await resolveTagCommit(release.tag, request)
  const ref = new URLSearchParams({ ref: commit }).toString()
  let pkg
  try { pkg = JSON.parse(await request(`contents/package.json?${ref}`, true)) } catch (error) {
    if (error instanceof GitHubReleaseError) throw error
    throw invalidMetadata()
  }
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg) || pkg.version !== release.version) throw invalidMetadata()
  if (pkg.persistentMemoryReleaseLine !== source.releaseLine) {
    throw new GitHubReleaseError('The public release line is not available in the published release.')
  }
  const releaseHistory = await request(`contents/release-history.md?${ref}`, true)
  const heading = /^##\s+([^\r\n]+)$/mu.exec(releaseHistory)?.[1]?.trim()
  const headingVersion = /^(\d+\.\d+\.\d+)\s+-\s+\d{4}-\d{2}-\d{2}$/u.exec(heading ?? '')?.[1]
  if (!releaseHistory.includes(`<!-- persistent-memory-release-line: ${source.releaseLine} -->`) || headingVersion !== release.version) throw invalidMetadata()
  return { ...release, commit, releaseHistory }
}

export async function fetchPublishedRelease(options = {}) {
  const { releaseHistory: _history, ...release } = await fetchPublishedReleaseMetadata(options)
  return release
}

/** Discovery only; resolve selected versions with fetchPublishedRelease before use. */
export async function listPublishedReleases(options = {}) {
  const request = requester(options)
  const releases = []
  const versions = new Set()
  for (let page = 1; page <= 10; page++) {
    const response = await request(`releases?per_page=100&page=${page}`)
    if (!Array.isArray(response)) throw invalidMetadata()
    for (const candidate of response) {
      if (candidate?.draft === true || candidate?.prerelease === true) continue
      const release = publishedRelease(candidate)
      if (versions.has(release.version)) throw invalidMetadata()
      versions.add(release.version)
      releases.push(release)
    }
    if (response.length < 100) {
      if (!releases.length) throw new GitHubReleaseError('No stable published release is available.')
      return releases
    }
  }
  throw new GitHubReleaseError('Public release discovery exceeded its bounded page limit.')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2)
    const result = args.length === 0 ? await fetchPublishedRelease()
      : args.length === 1 && args[0] === '--list' ? await listPublishedReleases()
        : args.length === 2 && args[0] === '--version' ? await fetchPublishedRelease({ version: args[1] })
          : (() => { throw new Error('Usage: github-releases.mjs [--version <semver> | --list]') })()
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
