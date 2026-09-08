import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { extractReleaseNotes, releaseUrl, validateReleaseNoteFiles, validateReleaseNotes } from './release-notes.mjs'

const entry = (version, link = releaseUrl(version)) => `## ${version} - 2026-09-07\n\n[GitHub release v${version}](${link})\n\nChanges for ${version}.\n`
const notes = `# Release History\n\n${entry('1.1.0')}\n${entry('1.0.0')}`

test('validates links inside every matching release entry', () => {
  assert.deepEqual(validateReleaseNotes(notes, '1.1.0').map(({ version }) => version), ['1.1.0', '1.0.0'])
  assert.equal(validateReleaseNotes(notes.replaceAll('\n', '\r\n')).length, 2)
})

test('rejects missing, cross-version, repository-index and unrelated links', () => {
  for (const url of ['', releaseUrl('1.0.0'), 'https://github.com/vshcherbukhin/persistent-memory-stack/releases', 'https://github.com/other/repo/releases/tag/v1.1.0']) {
    assert.throws(() => validateReleaseNotes(entry('1.1.0', url) + entry('1.0.0')), /Release 1.1.0 notes must link/)
  }
  assert.throws(() => validateReleaseNotes(entry('1.1.0') + entry('1.0.0', '')), /Release 1.0.0 notes must link/)
})

test('requires a clickable Markdown link rather than an unlinked mention', () => {
  assert.throws(() => validateReleaseNotes(`## 1.1.0 - 2026-09-07\n\n${releaseUrl('1.1.0')}\n`), /must link/)
})

test('ignores images, escaped links, comments and literal code when requiring a clickable link', () => {
  const link = `[GitHub release](${releaseUrl('1.1.0')})`
  for (const body of [
    `!${link}`, `\\${link}`, `<!-- ${link} -->`, `<!--\n${link}\n-->`,
    '`' + link + '`', '``' + link + '``', '```markdown\n' + link + '\n```',
    '~~~markdown\n' + link + '\n~~~', '````\n```\n' + link + '\n````',
    `    ${link}`, `\t${link}`, `<code>${link}</code>`, `<pre>${link}</pre>`,
  ]) {
    assert.throws(() => validateReleaseNotes(`## 1.1.0 - 2026-09-07\n\n${body}\n`), /must link/, body)
    assert.equal(validateReleaseNotes(`## 1.1.0 - 2026-09-07\n\n${body}\n\n${link}\n`).length, 1)
  }
})

test('rejects missing/duplicate versions and an out-of-sync top version', () => {
  assert.throws(() => validateReleaseNotes('# Release History'), /no product release entries/)
  assert.throws(() => validateReleaseNotes(entry('1.1.0') + entry('1.1.0')), /duplicate product versions/)
  assert.throws(() => validateReleaseNotes(notes, '1.2.0'), /newest release notes must match/)
})

test('extracts one complete release body with its GitHub link for publication', () => {
  const body = extractReleaseNotes(notes, '1.0.0')
  assert.ok(body.includes(`[GitHub release v1.0.0](${releaseUrl('1.0.0')})`))
  assert.ok(body.includes('Changes for 1.0.0.'))
  assert.equal(body.includes('1.1.0'), false)
  assert.throws(() => extractReleaseNotes(notes, '1.2.0'), /No release notes exist/)
})

test('checked-out product notes and dashboard mirror pass publication validation', () => {
  const entries = validateReleaseNoteFiles()
  const product = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(entries[0].version, product.version)
  const result = spawnSync(process.execPath, ['scripts/release-notes.mjs', product.version], { cwd: new URL('../', import.meta.url), encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0, result.stderr)
  assert.ok(result.stdout.includes(releaseUrl(product.version)))
})

test('validates independent documentation release notes against their own package version', () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'pm-release-notes-'))
  try {
    for (const path of ['apps/dashboard/public', 'apps/documentation', 'documentation']) mkdirSync(join(fixtureRoot, path), { recursive: true })
    writeFileSync(join(fixtureRoot, 'package.json'), JSON.stringify({ version: '1.1.0' }))
    writeFileSync(join(fixtureRoot, 'apps/documentation/package.json'), JSON.stringify({ version: '1.0.0' }))
    writeFileSync(join(fixtureRoot, 'release-history.md'), notes)
    writeFileSync(join(fixtureRoot, 'apps/dashboard/public/release-history.md'), notes)
    const docsPath = join(fixtureRoot, 'documentation/release-history.md')
    writeFileSync(docsPath, entry('1.0.0') + '\nDocumentation-only changes.\n')
    assert.doesNotThrow(() => validateReleaseNoteFiles(fixtureRoot))
    writeFileSync(docsPath, entry('1.0.0', ''))
    assert.throws(() => validateReleaseNoteFiles(fixtureRoot), /Release 1.0.0 notes must link/)
    writeFileSync(docsPath, entry('1.1.0'))
    assert.throws(() => validateReleaseNoteFiles(fixtureRoot), /newest release notes must match package version 1.0.0/)
  } finally {
    const owned = relative(tmpdir(), fixtureRoot)
    assert.ok(owned && !owned.startsWith('..') && !isAbsolute(owned))
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
})
