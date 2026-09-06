import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = fileURLToPath(new URL('../', import.meta.url))
const json = path => JSON.parse(readFileSync(join(root, path), 'utf8'))
const product = json('package.json')
const source = json('layers/update-ops/update-flow/public-source.json')
const lifecycle = readFileSync(join(root, 'deploy/scripts/update.sh'), 'utf8')

test('first-party package versions match their lock metadata and visible constants', () => {
  for (const lockPath of ['package-lock.json', 'apps/dashboard/package-lock.json', 'apps/onboard/package-lock.json', 'apps/documentation/package-lock.json']) {
    const lock = json(lockPath)
    assert.equal(lock.version, json(join(dirname(lockPath), 'package.json')).version)
    for (const [location, metadata] of Object.entries(lock.packages)) {
      if (!location.includes('node_modules') && metadata.version) {
        assert.equal(metadata.version, json(join(dirname(lockPath), location, 'package.json')).version, `${lockPath}:${location}`)
      }
    }
  }
  assert.equal(json('apps/dashboard/package.json').version, product.version)
  assert.ok(readFileSync(join(root, 'apps/dashboard/src/lib/version.ts'), 'utf8').includes(`'${product.version}'`))
  assert.ok(readFileSync(join(root, 'apps/mcp/src/index.ts'), 'utf8').includes(`version: '${json('apps/mcp/package.json').version}'`))
  assert.ok(readFileSync(join(root, 'apps/documentation/Dockerfile'), 'utf8').includes(`DOCUMENTATION_VERSION=${json('apps/documentation/package.json').version}`))
  assert.equal(product.persistentMemoryReleaseLine, source.releaseLine)
})

test('terminal release lookup excludes untagged and foreign release lines', () => {
  const script = /release_at_commit\(\) \{[\s\S]*?node -e '([\s\S]*?)'\n\}/u.exec(lifecycle)?.[1]
  assert.ok(script)
  for (const [pkg, expected] of [
    [{ version: '4.0.37' }, ''],
    [{ version: '4.0.37', persistentMemoryReleaseLine: 'internal' }, ''],
    [{ version: '1.0.0', persistentMemoryReleaseLine: source.releaseLine }, '1.0.0'],
    [{ version: 'bad', persistentMemoryReleaseLine: source.releaseLine }, ''],
  ]) {
    const result = spawnSync(process.execPath, ['-e', script], { input: JSON.stringify(pkg), env: { ...process.env, PM_PUBLIC_SOURCE_FILE: join(root, 'layers/update-ops/update-flow/public-source.json') }, encoding: 'utf8', windowsHide: true })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, expected)
  }
  assert.ok(lifecycle.indexOf('if [ -z "$HANDOFF_TARGET_VERSION_OVERRIDE" ]') < lifecycle.indexOf('    switch_to_update_branch_if_needed "$current_branch"'))
})

test('terminal state writers mark new handoff and successful update artifacts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pm public release '))
  try {
    for (const [scriptPath, functionName, env, output] of [
      ['deploy/scripts/update.sh', 'dashboard_handoff_write', { HANDOFF_FILE: join(directory, 'handoff.json'), HANDOFF_PHASE_VALUE: 'complete', HANDOFF_ID: 'fixture', HANDOFF_TARGET_VERSION: product.version }, 'handoff.json'],
      ['deploy/scripts/update.sh', 'mark_update_complete', { MARKER_FILE: join(directory, 'marker.json'), MARKER_ID: 'fixture', MARKER_VERSION: product.version }, 'marker.json'],
      ['deploy/scripts/dev-redeploy.sh', 'dashboard_handoff_write', { HANDOFF_FILE: join(directory, 'redeploy.json'), HANDOFF_PHASE_VALUE: 'complete', HANDOFF_ID: 'fixture', HANDOFF_TARGET_VERSION: product.version }, 'redeploy.json'],
    ]) {
      const shellSource = readFileSync(join(root, scriptPath), 'utf8')
      const start = shellSource.indexOf(functionName + '() {')
      const body = shellSource.slice(start)
      assert.match(body, /PM_PUBLIC_SOURCE_FILE="\$(?:SCRIPT_REPO_ROOT|REPO_ROOT)\/layers\/update-ops\/update-flow\/public-source\.json"/)
      const script = /node -e '([\s\S]*?)\n'/u.exec(body)?.[1]
      assert.ok(script)
      const result = spawnSync(process.execPath, ['-e', script], { env: { ...process.env, ...env, PM_PUBLIC_SOURCE_FILE: join(root, 'layers/update-ops/update-flow/public-source.json') }, encoding: 'utf8', windowsHide: true })
      assert.equal(result.status, 0, result.stderr)
      assert.equal(JSON.parse(readFileSync(join(directory, output), 'utf8')).releaseLine, source.releaseLine)
    }
  } finally {
    const owned = relative(tmpdir(), directory)
    assert.ok(owned && !owned.startsWith('..'))
    rmSync(directory, { recursive: true, force: true })
  }
})

test('new release report requires explicit evidence instead of reusing prior measurements', () => {
  const result = spawnSync(process.execPath, ['scripts/generate-system-health-report.mjs'], { cwd: root, encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Supply --evidence/)
})
