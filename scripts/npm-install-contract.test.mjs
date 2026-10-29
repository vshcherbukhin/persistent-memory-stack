import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { findGitBash } from './host-runtime.mjs'

const root = resolve(import.meta.dirname, '..')
const scratch = join(root, '.local', 'tmp')
mkdirSync(scratch, { recursive: true })
const bash = process.platform === 'win32' ? findGitBash() : 'bash'
const shellPath = path => process.platform === 'win32' ? path.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`) : path

for (const inline of [false, true]) test(`${inline ? 'dashboard image' : 'shared'} dependency retry preserves terminal failure and succeeds only after npm succeeds`, () => {
  const fixture = mkdtempSync(join(scratch, 'npm-retry-'))
  try {
    const bin = join(fixture, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'npm'), '#!/bin/sh\nif [ "$1" = ci ]; then\n n=0; [ ! -f "$COUNT_FILE" ] || n=$(cat "$COUNT_FILE"); n=$((n+1)); echo "$n" > "$COUNT_FILE"; [ "$n" -lt "$SUCCEED_AT" ] && exit 42; fi\nexit 0\n', { mode: 0o755 })
    writeFileSync(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    let script = join(root, 'deploy/scripts/npm-ci-with-retry.sh')
    if (inline) {
      const dockerfile = readFileSync(join(root, 'apps/dashboard/Dockerfile'), 'utf8').replaceAll('\r\n', '\n')
      const start = dockerfile.indexOf('RUN npm config set fetch-retries')
      const end = dockerfile.indexOf('\n\n', start)
      assert.ok(start >= 0 && end > start)
      script = join(fixture, 'inline.sh')
      writeFileSync(script, '#!/bin/sh\nset -eu\n' + dockerfile.slice(start + 4, end).replace(/\\\r?\n/g, '') + '\n')
    }
    for (const [successAt, expected, attempts] of [[99, 42, 4], [3, 0, 3]]) {
      const count = join(fixture, `count-${successAt}`)
      const result = spawnSync(bash, ['-c', 'PATH="$1:$PATH"; export PATH; exec sh "$2"', 'retry-test', shellPath(bin), shellPath(script)], {
        cwd: root, encoding: 'utf8', windowsHide: true, timeout: 15_000,
        env: { ...process.env, COUNT_FILE: shellPath(count), SUCCEED_AT: String(successAt), NPM_CI_ATTEMPTS: '4', NPM_CI_RETRY_DELAY_SECONDS: '0' },
      })
      assert.equal(result.status, expected, result.stderr)
      assert.equal(Number(readFileSync(count, 'utf8').trim()), attempts)
    }
  } finally {
    assert.ok(resolve(fixture).startsWith(resolve(scratch) + '\\') || resolve(fixture).startsWith(resolve(scratch) + '/'))
    rmSync(fixture, { recursive: true, force: true })
  }
})
