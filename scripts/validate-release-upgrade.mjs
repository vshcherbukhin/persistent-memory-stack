import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const contractUrl = new URL('../release/upgrade.json', import.meta.url)
const packageUrl = new URL('../package.json', import.meta.url)
const validatorUrl = new URL(
  '../apps/update-runner/dist/layers/update-ops/release-versioning/upgrade-contract.js',
  import.meta.url,
)

const { validateUpgradeContract } = await import(validatorUrl.href)

function readJsonAtRevision(revision, path) {
  return JSON.parse(execFileSync('git', ['show', `${revision}:${path}`], { encoding: 'utf8' }))
}

const currentContract = JSON.parse(readFileSync(contractUrl, 'utf8'))
const currentPackage = JSON.parse(readFileSync(packageUrl, 'utf8'))
const trustedReleaseRef = 'origin/master'
const revisions = execFileSync(
  'git',
  ['log', '--format=%H', trustedReleaseRef, '--', 'release/upgrade.json'],
  { encoding: 'utf8' },
).trim().split('\n').filter(Boolean)

const contracts = new Map()
for (const revision of revisions) {
  const contract = readJsonAtRevision(revision, 'release/upgrade.json')
  const packageJson = readJsonAtRevision(revision, 'package.json')
  if (typeof contract.release === 'string' && !contracts.has(contract.release)) {
    contracts.set(contract.release, { contract, packageVersion: packageJson.version })
  }
}
contracts.set(currentContract.release, { contract: currentContract, packageVersion: currentPackage.version })

const availableReleases = new Set(contracts.keys())
for (const { contract, packageVersion } of contracts.values()) {
  validateUpgradeContract(contract, { packageVersion, availableReleases })
}

process.stdout.write(`[OK] Validated ${contracts.size} release upgrade contract(s), including ${currentContract.release}.\n`)
