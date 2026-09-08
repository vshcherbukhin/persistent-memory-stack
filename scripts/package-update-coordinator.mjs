import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const coordinatorSource = resolve(repoRoot, 'apps/update-coordinator/dist/apps/update-coordinator/src/index.js')
const contractSource = resolve(repoRoot, 'apps/update-runner/dist/layers/update-ops/release-versioning/upgrade-contract.js')
const coordinatorTarget = resolve(repoRoot, 'deploy/update-coordinator/coordinator.mjs')
const contractTarget = resolve(repoRoot, 'deploy/update-coordinator/lib/upgrade-contract.mjs')

mkdirSync(dirname(contractTarget), { recursive: true })
copyFileSync(coordinatorSource, coordinatorTarget)
copyFileSync(contractSource, contractTarget)
const releaseLibrary = readFileSync(resolve(repoRoot, 'scripts/github-releases.mjs'), 'utf8')
writeFileSync(resolve(dirname(contractTarget), 'github-releases.mjs'), releaseLibrary.replaceAll('../layers/update-ops/update-flow/public-source.json', './public-source.json'))
copyFileSync(resolve(repoRoot, 'layers/update-ops/update-flow/public-source.json'), resolve(dirname(contractTarget), 'public-source.json'))
