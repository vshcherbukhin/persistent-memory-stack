import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { findGitBash, hostEnvironment } from './host-runtime.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, 'deploy/scripts/start.sh'), 'utf8')
const bash = process.platform === 'win32' ? findGitBash() : 'bash'

test('start.sh remains valid Bash with LF endings', () => {
  assert.equal(source.includes('\r'), false)
  const result = spawnSync(bash, ['--noprofile', '--norc', '-n', join(root, 'deploy/scripts/start.sh')], { encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0, result.stderr)
})

test('starting a cloud embedding stack makes no Ollama HTTP or process calls', () => {
  // Execute only the host readiness block with inert commands, never Compose.
  const begin = source.indexOf('if [ "$EMBED_PROVIDER" = "ollama" ]; then')
  const end = source.indexOf('"${COMPOSE[@]}" up -d', begin)
  assert.ok(begin > 0 && end > begin)
  const block = source.slice(begin, end)
  for (const provider of ['openai', 'voyage']) {
    const result = spawnSync(bash, ['--noprofile', '--norc', '-c', `
set -e
curl() { echo UNEXPECTED_OLLAMA_HTTP >&2; return 95; }
ollama() { echo UNEXPECTED_OLLAMA_PROCESS >&2; return 95; }
brew() { echo UNEXPECTED_BREW >&2; return 95; }
${block}`], { env: { ...hostEnvironment({ bash }), EMBED_PROVIDER: provider, EMBED_MODEL: 'synthetic-cloud-model', OLLAMA_HOST_URL: 'http://invalid.example' }, encoding: 'utf8', windowsHide: true })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stderr, '')
    assert.match(result.stdout, /host Ollama is not required/)
  }
})
