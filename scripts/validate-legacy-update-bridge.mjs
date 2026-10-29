import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'

const root = new URL('../', import.meta.url)
const envFile = '.env.persistent-memory.example'
// Compare the resolved public example, as installation does. Compose 2.x can
// reject unexpanded ${VAR:-default}:target bind syntax with --no-interpolate.
const commonArgs = ['compose', '--env-file', envFile, 'config', '--format', 'json']
// Generated install credentials are intentionally blank in the public example.
// Use process-only synthetic values; never load the installed secret file.
const options = { cwd: root, encoding: 'utf8', env: {
  ...process.env,
  ...parseEnv(readFileSync(new URL('../.env.persistent-memory.example', import.meta.url), 'utf8')),
  QDRANT_API_KEY: 'synthetic-release-validation-qdrant',
  FALKORDB_PASSWORD: 'synthetic-release-validation-falkor',
} }

const rootConfig = execFileSync('docker', commonArgs, options)
const canonicalConfig = execFileSync(
  'docker',
  ['compose', '-f', 'deploy/compose/docker-compose.yml', '--env-file', envFile, 'config', '--format', 'json'],
  options,
)

if (rootConfig !== canonicalConfig) {
  throw new Error('The legacy root Compose bridge does not resolve to the canonical deployment configuration.')
}

const bridge = readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
if (!bridge.includes('include:\n  - path: deploy/compose/docker-compose.yml\n')) {
  throw new Error('The legacy root Compose bridge must include the canonical deployment file.')
}

process.stdout.write('[OK] Validated the root Compose compatibility entry point.\n')
