import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const artifact = resolve(repoRoot, 'deploy/update-coordinator/coordinator.mjs')
const result = spawnSync(process.execPath, [artifact, '--install', ...process.argv.slice(2)], { encoding: 'utf8' })
if (result.error) throw result.error
if (result.stdout) process.stdout.write(result.stdout)
if (result.stderr) process.stderr.write(result.stderr)
process.exitCode = result.status ?? 1
