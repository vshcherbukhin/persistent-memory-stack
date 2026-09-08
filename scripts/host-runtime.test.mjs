import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { assertSupportedNode, findGitBash, hostEnvironment, npmInvocation, runNpm, supportedNode } from './host-runtime.mjs'
import { runSetup } from './setup.mjs'
import { assertShellLineEndings, checkPort } from './host-lifecycle.mjs'

test('host Node policy permits validated LTS lines, not all future dependency-compatible majors', () => {
  for (const version of ['18.20.0', '20.19.0', '22.11.0', '23.1.0', '25.0.0', '26.8.1', '28.0.0', '24', '24.1', '24.0.0-rc.1', '24.0.0 extra']) assert.equal(supportedNode(version), false, version)
  for (const version of ['22.12.0', '22.20.0', '24.0.0', '24.14.1', 'v24.14.1']) assert.equal(supportedNode(version), true, version)
  assert.throws(() => assertSupportedNode('26.8.1'), /Node 24 LTS.*restart the installer/)
})

test('direct setup rejects an unsupported runtime before snapshot or dependency work', async () => {
  let calls = 0
  const run = async () => { calls++ }
  await assert.rejects(runSetup({ nodeVersion: '26.8.1', runCommand: run, runNpmCommand: run, log: () => {} }), /outside this application's supported host versions/)
  assert.equal(calls, 0)
})

test('setup identifies each failed substep and stops without echoing private error details', async () => {
  for (let failAt = 0; failAt < 8; failAt++) {
    const lines = []
    let calls = 0
    const cause = new Error('private fixture value should not appear in the summary')
    const run = async () => { if (calls++ === failAt) throw cause }
    await assert.rejects(runSetup({ nodeVersion: '24.14.1', runCommand: run, runNpmCommand: run, log: line => lines.push(line) }), error => {
      assert.equal(error.cause, cause)
      assert.equal(error.message.includes('private fixture value'), false)
      assert.equal(error.message, `Setup failed during: ${lines.at(-1).replace(/^\[setup \d+\/8\] /, '')}. Review the command output immediately above this message for the underlying error.`)
      return true
    })
    assert.equal(calls, failAt + 1)
    assert.equal(lines.length, failAt + 1)
  }
})

test('setup preserves the ordered commands and custom coordinator location', async () => {
  const commands = []
  const run = async (command, args) => { commands.push([command, args]) }
  const npm = async args => { commands.push(['npm', args]) }
  await runSetup({ nodeVersion: '22.12.0', env: { PM_COORDINATOR_INSTALL_ROOT: '/custom coordinator' }, runCommand: run, runNpmCommand: npm, log: () => {} })
  assert.deepEqual(commands.map(([cmd, args]) => cmd === 'npm' ? args : args[0]), [
    'scripts/pre-update-snapshot.mjs', ['install'], ['run', 'prisma:generate'], ['run', 'build:update-coordinator'],
    'scripts/install-update-coordinator.mjs', ['ci', '--prefix', 'apps/onboard'], ['run', 'build:server', '--prefix', 'apps/onboard'],
    'apps/onboard/dist/apps/onboard/server/agent-update.js',
  ])
  assert.equal(commands[4][1].at(-1), '/custom coordinator')
})

test('npm argv is forwarded literally via Node, without cmd shell interpretation', () => {
  const cli = 'C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js'
  const args = ['--prefix', 'C:/work/with spaces & symbols', 'run', 'build']
  const invocation = npmInvocation(args, { env: { npm_execpath: cli }, execPath: 'C:/Program Files/nodejs/node.exe', exists: () => true })
  assert.deepEqual(invocation, { command: 'C:/Program Files/nodejs/node.exe', args: [cli, ...args] })
})

test('Windows shell lookup rejects WSL and honors a validated Git Bash override', () => {
  const bad = 'C:\\Windows\\System32\\bash.exe'
  const good = 'C:\\Tools\\Git\\bin\\bash.exe'
  const probe = path => ({ status: 0, stdout: path === good ? 'MINGW64_NT-10.0\n' : 'Linux\n' })
  assert.throws(() => findGitBash({ PM_GIT_BASH: bad }, () => true, probe), /Git for Windows/)
  assert.equal(findGitBash({ PM_GIT_BASH: good }, () => true, probe), good)
})

test('Windows env keeps native home, single PATH, and literal Docker container paths', () => {
  const env = hostEnvironment({ platform: 'win32', bash: 'C:\\Tools\\Git\\usr\\bin\\bash.exe', home: 'C:\\Users\\Jane Doe', env: { Path: 'C:\\Node;C:\\Docker', HOME: '/c/Users/old' } })
  assert.equal(env.HOME, 'C:/Users/Jane Doe')
  assert.equal(env.Path, undefined)
  assert.match(env.PATH, /^C:\\Tools\\Git\\bin;C:\\Tools\\Git\\usr\\bin;/)
  assert.equal(env.MSYS_NO_PATHCONV, '1')
  assert.equal(env.MSYS2_ARG_CONV_EXCL, '*')
})

test('POSIX lifecycle children use the validated interpreter before another Node on PATH', () => {
  for (const platform of ['darwin', 'linux']) {
    const execPath = '/opt/node@24/bin/node'
    const env = { PATH: '/opt/node@26/bin:/bin:/opt/node@24/bin', HOME: '/Users/alice', CUSTOM: 'preserved' }
    const actual = hostEnvironment({ platform, env, execPath })
    assert.deepEqual(actual, { ...env, PATH: '/opt/node@24/bin:/opt/node@26/bin:/bin' })
    assert.deepEqual(hostEnvironment({ platform, env: actual, execPath }), actual)
    assert.equal(env.PATH, '/opt/node@26/bin:/bin:/opt/node@24/bin', 'the caller environment is not mutated')
    assert.equal(hostEnvironment({ platform, env: {}, execPath }).PATH, '/opt/node@24/bin')
  }
})

test('direct npm execution pins both npm-cli and its lifecycle child PATH', async () => {
  const execPath = '/opt/node@24/bin/node'
  const cli = '/opt/node@26/lib/node_modules/npm/bin/npm-cli.js'
  const env = { PATH: '/opt/node@26/bin:/bin', npm_execpath: cli, CUSTOM: 'preserved' }
  const calls = []
  await runNpm(['run', 'prisma:generate'], { cwd: '/project', env }, {
    platform: 'darwin', execPath, exists: path => path === cli,
    runCommand: async (...args) => { calls.push(args) },
  })
  assert.deepEqual(calls, [[execPath, [cli, 'run', 'prisma:generate'], {
    cwd: '/project', env: { ...env, PATH: '/opt/node@24/bin:/opt/node@26/bin:/bin' },
  }]])
  assert.equal(env.PATH, '/opt/node@26/bin:/bin')
})

test('native Windows npm execution preserves the validated host environment', async () => {
  const execPath = 'C:/Node/node.exe'
  const cli = 'C:/Node/node_modules/npm/bin/npm-cli.js'
  const env = hostEnvironment({ platform: 'win32', bash: 'C:\\Tools\\Git\\bin\\bash.exe', env: { Path: 'C:\\Node;C:\\Docker', npm_execpath: cli }, home: 'C:\\Users\\alice' })
  const calls = []
  await runNpm(['run', 'build'], { env }, {
    platform: 'win32', execPath, exists: path => path === cli,
    runCommand: async (...args) => { calls.push(args) },
  })
  assert.deepEqual(calls, [[execPath, [cli, 'run', 'build'], { env }]])
})

test('CRLF shell checkout fails clearly without modifying files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pm-lf-'))
  try {
    writeFileSync(join(directory, 'safe.sh'), '#!/bin/bash\necho ok\n')
    assert.doesNotThrow(() => assertShellLineEndings(directory))
    writeFileSync(join(directory, 'bad.sh'), '#!/bin/bash\r\necho bad\r\n')
    assert.throws(() => assertShellLineEndings(directory), /CRLF/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('installer reports occupied port without touching the listener', async () => {
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const port = server.address().port
    await assert.rejects(checkPort(port), /port conflict/)
    assert.equal(server.listening, true)
  } finally { await new Promise(resolve => server.close(resolve)) }
})

test('native npm resolution runs successfully on the current host', () => {
  const invocation = npmInvocation(['--version'])
  const result = spawnSync(invocation.command, invocation.args, { encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /^\d+\.\d+\.\d+/)
})

test('Windows Git Bash retains quoted arguments and the native host home', { skip: process.platform !== 'win32' }, () => {
  const bash = findGitBash()
  const env = hostEnvironment({ bash })
  const result = spawnSync(bash, ['--noprofile', '--norc', '-c', 'printf "%s\\n" "$1" "$2"; cygpath -am "$HOME"', 'bash', 'space & literal $x', '/workspace/data'], { encoding: 'utf8', env, windowsHide: true })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(result.stdout.trim().split(/\r?\n/), ['space & literal $x', '/workspace/data', env.HOME])
})

for (const probe of [
  { name: 'Ollama', fn: 'http_ok', key: '', url: 'http://localhost:11434/api/tags' },
  { name: 'authenticated Qdrant', fn: 'qdrant_http_ok', key: 'fixture key & literal', url: 'http://localhost:7333/readyz' },
  { name: 'Qdrant without a key', fn: 'qdrant_http_ok', key: '', url: 'http://localhost:7333/readyz' },
]) {
  test(`install verifier ${probe.name} discards output portably and preserves curl failures`, () => {
    const source = readFileSync(new URL('../deploy/scripts/verify-install.sh', import.meta.url), 'utf8').replaceAll('\r\n', '\n')
    const start = source.indexOf('http_ok() {')
    const end = source.indexOf('\n# Host-facing ports', start)
    assert.ok(start >= 0 && end > start, 'extract only the actual HTTP probe functions, never the installer or cleanup')
    const functions = source.slice(start, end)
    const bash = process.platform === 'win32' ? findGitBash() : 'bash'
    // Model native curl's literal /dev/null write failure under disabled MSYS
    // conversion. All response bodies stay in stdout; no real HTTP is issued.
    const fixture = `${functions}
curl() {
  local header='' url='' fail_flag=0 timeout_flag=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -sf) fail_flag=1 ;;
      --max-time) [ "$2" = 5 ] || return 90; timeout_flag=1; shift ;;
      -H) header="$2"; shift ;;
      -o|--output) return 23 ;;
      *) url="$1" ;;
    esac
    shift
  done
  [ "$fail_flag" = 1 ] && [ "$timeout_flag" = 1 ] || return 91
  [ "$header" = "$EXPECTED_HEADER" ] && [ "$url" = "$PROBE_URL" ] || return 92
  printf '%s\\n' '{"models":[{"name":"fixture-model"}]}'
  return "$CURL_EXIT_CODE"
}
"$PROBE_FUNCTION" "$PROBE_URL"
`
    for (const code of [0, 22, 7]) {
      const result = spawnSync(bash, ['--noprofile', '--norc', '-c', fixture], {
        env: { ...hostEnvironment({ bash }), MSYS_NO_PATHCONV: '1', MSYS2_ARG_CONV_EXCL: '*', QDRANT_API_KEY: probe.key,
          EXPECTED_HEADER: probe.key ? `api-key: ${probe.key}` : '', PROBE_FUNCTION: probe.fn, PROBE_URL: probe.url, CURL_EXIT_CODE: String(code) },
        encoding: 'utf8', windowsHide: true,
      })
      assert.equal(result.status, code, `curl exit ${code}: ${result.stderr}`)
      assert.equal(result.stdout, '', 'the body must be discarded by Bash')
    }
  })
}
