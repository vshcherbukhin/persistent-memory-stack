import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const manifest = new URL('../layers/update-ops/update-flow/public-source.json', import.meta.url)

export function readPublicUpdateSource(path = manifest) {
  const source = JSON.parse(readFileSync(path, 'utf8'))
  if (!source || typeof source !== 'object'
    || !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/iu.test(source.owner ?? '')
    || !/^[a-z\d_.-]+$/iu.test(source.repo ?? '') || ['.', '..'].includes(source.repo)
    || source.branch !== 'master' || typeof source.releaseLine !== 'string' || !/^[a-z][a-z0-9-]*$/u.test(source.releaseLine)) throw new Error('The public update source manifest is invalid.')
  return { owner: source.owner, repo: source.repo, branch: source.branch, releaseLine: source.releaseLine }
}

export function isPublicUpdateOrigin(remote, source = readPublicUpdateSource()) {
  let url = String(remote).trim().toLowerCase()
  if (url.startsWith('git@github.com:')) url = 'https://github.com/' + url.slice('git@github.com:'.length)
  else if (url.startsWith('ssh://git@github.com/')) url = 'https://github.com/' + url.slice('ssh://git@github.com/'.length)
  const expected = `https://github.com/${source.owner}/${source.repo}`.toLowerCase()
  return url === expected || url === expected + '.git'
}

export function assertPublicUpdateOrigin(root, { source = readPublicUpdateSource(), readOrigin } = {}) {
  let remote = ''
  try {
    remote = readOrigin ? readOrigin(root) : execFileSync('git', ['-c', `safe.directory=${root}`, '-C', root, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch { /* Do not relay Git output or credential-bearing URLs. */ }
  if (!isPublicUpdateOrigin(remote, source)) {
    throw new Error('This checkout origin does not match the built-in public update repository. Review the trusted checkout before updating.')
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] !== 'check' || !process.argv[3]) throw new Error('Usage: public-update-source.mjs check <checkout>')
    assertPublicUpdateOrigin(process.argv[3])
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
