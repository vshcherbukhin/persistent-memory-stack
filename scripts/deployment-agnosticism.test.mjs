import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const repoRoot = fileURLToPath(new URL('../', import.meta.url))

// Keep deployment-, employer-, and author-specific examples out of tracked source.
// Fragments are joined so the guard does not match its own denylist definitions.
const deniedPatterns = [
  ['cen', 'tro\\.net'].join(''),
  ['basis', '\\.atlassian\\.net'].join(''),
  ['basis', '-ui-tests'].join(''),
  ['\\bB', 'QA\\b'].join(''),
  ['\\bG', 'BO\\b'].join(''),
  ['Programmatic', ' Guaranteed'].join(''),
  ['P', 'D', 'SP'].join(''),
  ['\\bD', 'S', 'P\\b'].join(''),
  ['Avo', 'qado'].join(''),
  ['v\\.shcher', 'bukhin'].join(''),
  ['Basis', 'Logo'].join(''),
  ['Basis', '[- ]dark'].join(''),
  ['Basis', ' brand'].join(''),
  ['basis', '-platform'].join(''),
]

test('tracked source remains deployment agnostic', () => {
  const pattern = deniedPatterns.join('|')
  const contentScan = spawnSync('git', ['grep', '-nI', '-i', '-E', pattern, '--', '.'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
  assert.equal(contentScan.status, 1, contentScan.stdout || contentScan.stderr)

  const fileList = spawnSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' })
  assert.equal(fileList.status, 0, fileList.stderr)
  const filenamePattern = new RegExp(pattern, 'i')
  const deniedFilenames = fileList.stdout.split('\n').filter((name) => name && filenamePattern.test(name))
  assert.deepEqual(deniedFilenames, [])
})
