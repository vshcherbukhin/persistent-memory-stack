import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import source from '../layers/update-ops/update-flow/public-source.json' with { type: 'json' }

const root = fileURLToPath(new URL('../', import.meta.url))
const stableVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u
const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function releaseUrl(version) {
  if (typeof version !== 'string' || !stableVersion.test(version)) throw new Error('Release notes require a stable major.minor.patch version.')
  return `https://github.com/${source.owner}/${source.repo}/releases/tag/v${version}`
}

function visibleMarkdown(body) {
  const withoutComments = body.replace(/<!--[\s\S]*?(?:-->|$)/gu, '')
    .replace(/<(pre|code)\b[^>]*>[\s\S]*?<\/\1>/giu, '')
  let fence = null
  const lines = withoutComments.split('\n').map(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line)
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null
      return ''
    }
    if (marker) { fence = marker[1]; return '' }
    return /^(?: {4}|\t)/u.test(line) ? '' : line
  })
  return lines.join('\n').replace(/(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/gu, '')
}

/** Validate each product entry independently so an older link cannot satisfy a new release. */
export function validateReleaseNotes(markdown, expectedVersion) {
  const text = markdown.replace(/\r\n/gu, '\n')
  const headings = [...text.matchAll(/^##\s+([^\n]+)$/gmu)]
  const entries = headings.map((heading, index) => {
    const version = /^((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))\s+-\s+\d{4}-\d{2}-\d{2}\s*$/u.exec(heading[1])?.[1]
    if (!version) throw new Error('Release notes contain an invalid product release heading.')
    const rawBody = text.slice(heading.index + heading[0].length, headings[index + 1]?.index ?? text.length)
    const body = rawBody.trim()
    const url = releaseUrl(version)
    const link = new RegExp(`(?<![!\\\\])\\[[^\\]\\n]+\\]\\(${escapeRegExp(url)}\\)`, 'u')
    if (!link.test(visibleMarkdown(rawBody))) throw new Error(`Release ${version} notes must link to ${url}.`)
    return { version, body, url }
  })
  if (!entries.length) throw new Error('Release notes contain no product release entries.')
  if (new Set(entries.map(entry => entry.version)).size !== entries.length) throw new Error('Release notes contain duplicate product versions.')
  if (expectedVersion !== undefined && entries[0].version !== expectedVersion) throw new Error(`The newest release notes must match package version ${expectedVersion}.`)
  return entries
}

export function extractReleaseNotes(markdown, version) {
  releaseUrl(version)
  const release = validateReleaseNotes(markdown).find(entry => entry.version === version)
  if (!release) throw new Error(`No release notes exist for ${version}.`)
  return `${release.body}\n`
}

export function validateReleaseNoteFiles(repoRoot = root) {
  const history = readFileSync(resolve(repoRoot, 'release-history.md'), 'utf8').replace(/\r\n/gu, '\n')
  const mirror = readFileSync(resolve(repoRoot, 'apps/dashboard/public/release-history.md'), 'utf8').replace(/\r\n/gu, '\n')
  const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'))
  if (history !== mirror) throw new Error('Dashboard release notes must exactly mirror release-history.md.')
  const docsHistory = readFileSync(resolve(repoRoot, 'documentation/release-history.md'), 'utf8')
  const docsPackage = JSON.parse(readFileSync(resolve(repoRoot, 'apps/documentation/package.json'), 'utf8'))
  // Documentation has its own service version and body; validate, do not mirror it.
  validateReleaseNotes(docsHistory, docsPackage.version)
  return validateReleaseNotes(history, pkg.version)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2)
    if (args.length === 1 && args[0] === '--check') {
      console.log(`[OK] Validated ${validateReleaseNoteFiles().length} release-note entries and their GitHub links.`)
    } else if (args.length === 1) {
      validateReleaseNoteFiles()
      process.stdout.write(extractReleaseNotes(readFileSync(resolve(root, 'release-history.md'), 'utf8'), args[0]))
    } else throw new Error('Usage: release-notes.mjs --check | <semver>')
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
