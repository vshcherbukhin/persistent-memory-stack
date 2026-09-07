import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { preflight } from './host-lifecycle.mjs'

function fixture(t, body) {
  const directory = mkdtempSync(join(tmpdir(), 'pm preflight é '))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  mkdirSync(join(directory, 'deploy/scripts'), { recursive: true })
  writeFileSync(join(directory, 'deploy/scripts/check.sh'), '#!/bin/bash\n')
  if (body !== undefined) writeFileSync(join(directory, '.env.persistent-memory'), body)
  const calls = []
  const captureCommand = (command, args) => { calls.push([command, args]); return command === 'docker' && args[0] === 'info' ? 'linux' : 'fixture version' }
  return { directory, calls, captureCommand }
}

for (const [name, body] of [['fresh selection', undefined], ['OpenAI', 'EMBED_PROVIDER=openai\n'], ['Voyage', 'EMBED_PROVIDER=voyage\n']]) {
  test(`${name} host preflight never requires or contacts Ollama`, async t => {
    const f = fixture(t, body)
    await preflight({}, 'fixture-bash', { ...f, fetchImpl: async () => { throw new Error('Ollama must not be contacted') } })
    assert.equal(f.calls.some(([command]) => command === 'ollama'), false)
  })
}
test('saved Ollama selection checks CLI and its configured host URL', async t => {
  const f = fixture(t, 'EMBED_PROVIDER=ollama\nOLLAMA_URL=http://host.docker.internal:11500\n')
  let requested
  await preflight({}, 'fixture-bash', { ...f, fetchImpl: async url => { requested = url; return { ok: true, json: async () => ({ models: [] }) } } })
  assert.ok(f.calls.some(([command]) => command === 'ollama'))
  assert.equal(requested, 'http://localhost:11500/api/tags')
})
test('a selected but stopped Ollama produces actionable failure', async t => {
  const f = fixture(t, 'EMBED_PROVIDER=ollama\n')
  await assert.rejects(preflight({}, 'fixture-bash', { ...f, fetchImpl: async () => { throw new Error('offline') } }), /choose Start/)
})
