import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { hostCommand } from '../../onboard/server/host.ts'

const roots: string[] = []
const source = (await readFile(new URL('../../../deploy/scripts/update.sh', import.meta.url), 'utf8')).replaceAll('\r\n', '\n')
function functionSource(name: string): string {
  const match = source.match(new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}$`, 'm'))
  if (!match) throw new Error(`Missing update function: ${name}`)
  return match[0]
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    expect(dirname(root)).toBe(resolve(tmpdir()))
    await rm(root, { recursive: true, force: true })
  }
})

describe('required updater completion gates', () => {
  it.each(['restart', 'verification', 'missing-verifier', 'registration', 'dashboard', 'marker-write', 'package-read', 'package-version', 'none'])(
    'executes the actual completion path with failure=%s', async failure => {
      const root = await mkdtemp(join(tmpdir(), 'pm update completion '))
      roots.push(root)
      await mkdir(join(root, 'deploy/scripts'), { recursive: true })
      await mkdir(join(root, 'scripts'))
      await mkdir(join(root, 'layers/update-ops/update-flow'), { recursive: true })
      await mkdir(join(root, 'state'))
      await writeFile(join(root, 'package.json'), JSON.stringify({ version: '2.0.4' }))
      if (failure === 'package-read') await rm(join(root, 'package.json'))
      if (failure === 'package-version') await writeFile(join(root, 'package.json'), '{}')
      await writeFile(join(root, 'layers/update-ops/update-flow/public-source.json'), JSON.stringify({ releaseLine: 'public-v1' }))
      await writeFile(join(root, 'scripts/docker-image-lifecycle.mjs'), `export { atomicJson } from ${JSON.stringify(new URL('../../../scripts/docker-image-lifecycle.mjs', import.meta.url).href)};`)
      const marker = join(root, 'state/last-successful-update.json')
      const before = JSON.stringify({ version: '2.0.3', id: 'previous-success' })
      await writeFile(marker, before)
      if (failure !== 'missing-verifier') await writeFile(join(root, 'deploy/scripts/verify-install.sh'), '#!/bin/bash\necho "verification ran"\n[ "$FIXTURE_FAILURE" != verification ]\n')
      const tail = source.slice(source.indexOf('# ── 7. Restart runtime services'))
      expect(tail).toContain('mark_update_complete')
      const script = join(root, 'completion.sh')
      await writeFile(script, `#!/bin/bash
set -Eeuo pipefail
REPO_ROOT="$FIXTURE_ROOT"; SCRIPT_REPO_ROOT="$REPO_ROOT"; DEPLOYED_STATE_DIR="$REPO_ROOT/state"
MCP_RUNTIME=stream; VERSIONED_WORKTREE=1; UPDATE_BRANCH_OVERRIDE=''; HANDOFF_DONE=0; HANDOFF_PHASE=verifying; HANDOFF_FAILURE_DETAIL=''
COMPOSE=(compose_fixture)
compose_fixture() { if [ "$FIXTURE_FAILURE" = restart ]; then echo 'synthetic restart detail' >&2; return 9; fi; }
dashboard_handoff_write() { printf '%s\\n' "$1" >> "$REPO_ROOT/events"; }
stop_progress_probe() { :; }; release_coordinator_reservation() { :; }
ok() { echo "[OK] $1"; }; warn() { echo "[WARN] $1"; }; section() { echo "$1"; }
refresh_agent_artifacts() { [ "$FIXTURE_FAILURE" != registration ]; }
wait_for_dashboard_ready() { [ "$FIXTURE_FAILURE" != dashboard ]; }
${['fail', 'dashboard_handoff_record_error', 'dashboard_handoff_fail_on_exit', 'mark_update_complete'].map(functionSource).join('\n')}
trap dashboard_handoff_record_error ERR
trap dashboard_handoff_fail_on_exit EXIT
${tail}`)
      const invocation = hostCommand('bash', [script])
      const env: NodeJS.ProcessEnv = { ...invocation.env, FIXTURE_ROOT: root.replaceAll('\\', '/'), FIXTURE_FAILURE: failure }
      if (failure === 'marker-write') {
        const preload = join(root, 'partial-write.mjs')
        await writeFile(preload, `import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
          const write = fs.writeFileSync;
          fs.writeFileSync = (file, data, ...args) => {
            if (String(file).includes('last-successful-update.json.') && String(file).endsWith('.tmp')) {
              write(file, String(data).slice(0, 5), ...args);
              write(process.env.FIXTURE_ROOT + '/partial-write-ran', 'yes');
              throw Object.assign(new Error('synthetic disk full after partial temporary write'), {code:'ENOSPC'});
            }
            return write(file, data, ...args);
          }; syncBuiltinESMExports();`)
        Object.assign(env, { NODE_OPTIONS: `${env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(preload).href}`.trim() })
      }
      const result = spawnSync(invocation.command, invocation.args, { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 15_000 })
      expect(result.error).toBeUndefined()
      const output = result.stdout + result.stderr
      const events = (await readFile(join(root, 'events'), 'utf8')).trim().split('\n')
      if (failure === 'none') {
        expect(result.status, output).toBe(0)
        expect(output).toContain('Update complete')
        expect(events.at(-1)).toBe('complete')
        expect(JSON.parse(await readFile(marker, 'utf8'))).toMatchObject({ version: '2.0.4', releaseLine: 'public-v1' })
      } else {
        expect(result.status, output).not.toBe(0)
        expect(output).not.toContain('Update complete')
        expect(events.at(-1)).toBe('failed')
        expect(events).not.toContain('complete')
        expect(await readFile(marker, 'utf8')).toBe(before)
        if (failure === 'restart') expect(output).toContain('synthetic restart detail')
        if (failure === 'verification') expect(output).toContain('Required installation verification failed')
        if (failure === 'missing-verifier') expect(output).toContain('verification script is missing or unreadable')
        if (failure === 'marker-write') {
          expect(await readFile(join(root, 'partial-write-ran'), 'utf8')).toBe('yes')
          expect(await readdir(join(root, 'state'))).toEqual(['last-successful-update.json'])
        }
      }
    }, 20_000,
  )

  it('propagates a failed graph preservation check while stopping its optional progress probe', async () => {
    const invocation = hostCommand('bash', ['-c', `set -u
COMPOSE=(compose_fixture); HANDOFF_RUN_ID=fixture
compose_fixture() { return 42; }
run_progress_probe() { :; }
stop_progress_probe() { echo 'probe stopped'; }
${functionSource('run_graph_v2_migration_with_probe')}
run_graph_v2_migration_with_probe
exit $?`])
    const result = spawnSync(invocation.command, invocation.args, { env: invocation.env, encoding: 'utf8', windowsHide: true, timeout: 10_000 })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(42)
    expect(result.stdout).toContain('probe stopped')
  })
})
