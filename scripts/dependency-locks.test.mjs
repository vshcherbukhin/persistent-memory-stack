import test from 'node:test'
import assert from 'node:assert/strict'
import { npmLockIssues, pythonInputIssues } from './verify-dependency-locks.mjs'
const manifest = { name: 'fixture', dependencies: { library: '1.2.3' } }
const tree = () => ({ lockfileVersion: 3, packages: { '': { dependencies: { library: '1.2.3' } }, 'node_modules/library': { version: '1.2.3', resolved: 'https://registry.npmjs.org/library/-/library-1.2.3.tgz', integrity: 'sha512-YWJjZA==' } } })
test('Python inputs cannot silently disagree with the installed lock, including extras and model URLs', () => {
  const lock = 'library-name==1.2.3 \\\n    --hash=sha256:abc\nmodel @ https://example.test/model-1.whl \\\n    --hash=sha256:def\n'
  assert.deepEqual(pythonInputIssues('# Direct inputs\nLibrary_Name[extra]==1.2.3\nmodel @ https://example.test/model-1.whl', lock), [])
  for (const input of ['library-name==1.2.4', 'library-name>=1.2', 'model @ https://example.test/model-2.whl']) assert.match(pythonInputIssues(input, lock).join('\n'), /disagree/)
})
test('accepts frozen registry tree and rejects drift, moving versions and missing integrity', () => {
  assert.deepEqual(npmLockIssues([{ path: '', manifest }], tree()), [])
  assert.match(npmLockIssues([{ path: '', manifest: { ...manifest, dependencies: { library: '^1.2.3' } } }], tree()).join('\n'), /exact stable version/)
  const missingHash = tree(); delete missingHash.packages['node_modules/library'].integrity
  assert.match(npmLockIssues([{ path: '', manifest }], missingHash).join('\n'), /integrity/)
  const drift = tree(); drift.packages[''].dependencies.library = '1.2.4'
  assert.match(npmLockIssues([{ path: '', manifest }], drift).join('\n'), /disagree/)
  const untrusted = tree(); untrusted.packages['node_modules/library'].resolved = 'http://example.test/library.tgz'
  assert.match(npmLockIssues([{ path: '', manifest }], untrusted).join('\n'), /registry URL/)
})
