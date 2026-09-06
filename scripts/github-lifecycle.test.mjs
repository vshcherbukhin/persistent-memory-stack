import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { findGitBash, hostEnvironment } from './host-runtime.mjs'
import { assertPublicUpdateOrigin, isPublicUpdateOrigin, readPublicUpdateSource } from './public-update-source.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = readPublicUpdateSource()
const repoPath = `${source.owner}/${source.repo}`

test('lifecycle reads the shared public master source manifest', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'layers/update-ops/update-flow/public-source.json'), 'utf8'))
  assert.deepEqual(source, manifest)
  assert.equal(source.branch, 'master')
})

test('public source accepts matching HTTPS and normal GitHub SSH origins only', () => {
  for (const url of [`https://github.com/${repoPath}`, `https://github.com/${repoPath}.git`, `https://GITHUB.COM/${repoPath.toUpperCase()}.git`, `git@github.com:${repoPath}.git`, `ssh://git@github.com/${repoPath}.git`]) {
    assert.equal(isPublicUpdateOrigin(url), true, url)
    assert.doesNotThrow(() => assertPublicUpdateOrigin('/fixture', { readOrigin: () => url }))
  }
  for (const url of [`https://github.com/other-team/${source.repo}.git`, `git@github.com:${source.owner}/other-repo.git`, `http://github.com/${repoPath}`, `https://user@github.com/${repoPath}.git`, `https://github.com.evil.test/${repoPath}.git`, `ssh://git@github.com:2222/${repoPath}.git`, `https://github.com/${repoPath}.git?redirect=other`, '']) {
    assert.equal(isPublicUpdateOrigin(url), false, url)
    assert.throws(() => assertPublicUpdateOrigin('/fixture', { readOrigin: () => url }), /does not match/)
  }
  assert.throws(() => assertPublicUpdateOrigin('/fixture', { readOrigin: () => { throw new Error('sensitive fixture'); } }), error => !error.message.includes('sensitive fixture'))
})

test('source preflight precedes coordinator reservation and snapshot work', () => {
  const lifecycle = readFileSync(join(root, 'deploy/scripts/update.sh'), 'utf8')
  const preflight = lifecycle.indexOf('pm_assert_public_update_origin "$SOURCE_REPO_ROOT"')
  assert.ok(preflight > 0 && preflight < lifecycle.indexOf('reserve_coordinator_before_source_resolution()'))
})

test('operator branch fetch remains literal and non-interactive without source credentials', () => {
  const bash = process.platform === 'win32' ? findGitBash() : 'bash'
  const helper = join(root, 'deploy/scripts/lib/public-update-source.sh').replaceAll('\\', '/')
  for (const branch of ['master', 'dev', 'feature/my-change']) {
    const result = spawnSync(bash, ['--noprofile', '--norc', '-c', `. "$TEST_HELPER"
git() { test "$GIT_TERMINAL_PROMPT" = 0 || return 90; printf '%s\\n' "$@"; }
pm_git_fetch_origin_branch "$TEST_BRANCH"
`], { env: { ...hostEnvironment({ bash }), TEST_HELPER: helper, TEST_BRANCH: branch }, encoding: 'utf8', windowsHide: true })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(result.stdout.trim().split(/\r?\n/), ['fetch', '--quiet', '--no-recurse-submodules', 'origin', branch])
  }
})
