import { copyFileSync, mkdirSync } from 'node:fs'
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
