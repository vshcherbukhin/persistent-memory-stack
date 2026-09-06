import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const contractUrl = new URL('../release/upgrade.json', import.meta.url)
const packageUrl = new URL('../package.json', import.meta.url)
const validatorUrl = new URL(
  '../apps/update-runner/dist/layers/update-ops/release-versioning/upgrade-contract.js',
  import.meta.url,
)

const { validateReleaseLineContracts } = await import(validatorUrl.href)
const repoRoot = resolve(fileURLToPath(new URL('../', import.meta.url)))
const releaseSource = JSON.parse(readFileSync(new URL('../layers/update-ops/update-flow/public-source.json', import.meta.url), 'utf8'))
const git = (args) => execFileSync('git', ['-c', `safe.directory=${repoRoot.replace(/\\/g, '/')}`, ...args], { cwd: repoRoot, encoding: 'utf8', windowsHide: true })

function readJsonAtRevision(revision, path) {
  return JSON.parse(git(['show', `${revision}:${path}`]))
}

const currentContract = JSON.parse(readFileSync(contractUrl, 'utf8'))
const currentPackage = JSON.parse(readFileSync(packageUrl, 'utf8'))
if (currentPackage.persistentMemoryReleaseLine !== releaseSource.releaseLine) {
  throw new Error('The package release line does not match the public source manifest.')
}
const trustedReleaseRef = 'origin/master'
const revisions = git(['log', '--format=%H', trustedReleaseRef, '--', 'release/upgrade.json']).trim().split('\n').filter(Boolean)

const records = [{ contract: currentContract, packageJson: currentPackage }]
for (const revision of revisions) {
  const packageJson = readJsonAtRevision(revision, 'package.json')
  if (packageJson.persistentMemoryReleaseLine !== releaseSource.releaseLine) continue
  records.push({ contract: readJsonAtRevision(revision, 'release/upgrade.json'), packageJson })
}
const contracts = validateReleaseLineContracts(records, releaseSource.releaseLine)

process.stdout.write(`[OK] Validated ${contracts.size} ${releaseSource.releaseLine} release upgrade contract(s), including ${currentContract.release}.\n`)
