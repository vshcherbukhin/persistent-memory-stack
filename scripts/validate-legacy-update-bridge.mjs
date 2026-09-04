import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const envFile = '.env.persistent-memory.example'
const commonArgs = ['compose', '--env-file', envFile, 'config', '--no-interpolate']

const rootConfig = execFileSync('docker', commonArgs, { cwd: root, encoding: 'utf8' })
const canonicalConfig = execFileSync(
  'docker',
  ['compose', '-f', 'deploy/compose/docker-compose.yml', '--env-file', envFile, 'config', '--no-interpolate'],
  { cwd: root, encoding: 'utf8' },
)

if (rootConfig !== canonicalConfig) {
  throw new Error('The legacy root Compose bridge does not resolve to the canonical deployment configuration.')
}

const bridge = readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8')
if (!bridge.includes('include:\n  - path: deploy/compose/docker-compose.yml\n')) {
  throw new Error('The legacy root Compose bridge must include the canonical deployment file.')
}

process.stdout.write('[OK] Validated the 4.0.24 Compose compatibility bridge.\n')
