import { readFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createDocumentationServer } from './server.mjs'

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = resolve(APP_DIR, '../..')
const COMPOSE_FILE = resolve(REPO_ROOT, 'deploy/compose/docker-compose.yml')
const ENV_FILE = resolve(REPO_ROOT, '.env.persistent-memory')
const SITE_DIR = resolve(REPO_ROOT, '.local/generated-docs/site')
const VERSION = JSON.parse(readFileSync(resolve(APP_DIR, 'package.json'), 'utf8')).version

export const COMPOSE_DOCUMENTATION_URL = 'http://localhost:3200/docs/index.html'
export const LOCAL_DOCUMENTATION_URL = `http://127.0.0.1:${process.env.DOCUMENTATION_PORT ?? '8000'}/index.html`

export function isDocumentationServiceRunning(run = spawnSync) {
  const result = run('docker', [
    'compose',
    '-f', COMPOSE_FILE,
    '--env-file', ENV_FILE,
    'ps',
    '--status', 'running',
    '--services',
    'documentation',
  ], { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  if (result.status !== 0) return false
  return String(result.stdout ?? '').split(/\r?\n/).includes('documentation')
}

export async function isComposeDocumentationAvailable({
  isServiceRunning = isDocumentationServiceRunning,
  probe = fetch,
} = {}) {
  if (!isServiceRunning()) return false
  try {
    const response = await probe(COMPOSE_DOCUMENTATION_URL, { method: 'HEAD', redirect: 'follow' })
    return response.ok
  } catch {
    return false
  }
}

function buildDocumentation() {
  const result = spawnSync('npm', ['run', 'docs:build'], { cwd: REPO_ROOT, stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`Documentation build failed with exit code ${result.status ?? 'unknown'}`)
}

async function startLocalDocumentation() {
  const port = Number.parseInt(process.env.DOCUMENTATION_PORT ?? '8000', 10)
  const server = createDocumentationServer({ siteDir: SITE_DIR, version: VERSION })
  await new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject)
      resolveListen()
    })
  })
  console.error(`[documentation] local fallback listening at ${LOCAL_DOCUMENTATION_URL}`)
  return server
}

function openDocumentationUrl(url) {
  const command = process.platform === 'darwin'
    ? ['open', [url]]
    : process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]]
  const child = spawn(command[0], command[1], { detached: true, stdio: 'ignore' })
  child.unref()
}

export async function launchDocumentation({
  isComposeAvailable = isComposeDocumentationAvailable,
  build = buildDocumentation,
  startLocal = startLocalDocumentation,
  openUrl = openDocumentationUrl,
} = {}) {
  if (await isComposeAvailable()) {
    await openUrl(COMPOSE_DOCUMENTATION_URL)
    return { mode: 'docker', url: COMPOSE_DOCUMENTATION_URL }
  }

  await build()
  await startLocal()
  await openUrl(LOCAL_DOCUMENTATION_URL)
  return { mode: 'local', url: LOCAL_DOCUMENTATION_URL }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  launchDocumentation().then(({ mode, url }) => {
    console.error(`[documentation] ${mode === 'docker' ? 'opened running Compose service' : 'started local Node fallback'}: ${url}`)
  }).catch((error) => {
    console.error(`[documentation] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
