import { spawn, spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findGitBash, hostEnvironment, run, runNpm, supportedNode } from './host-runtime.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const commands = { update: 'update.sh', uninstall: 'uninstall.sh', start: 'start.sh', stop: 'stop.sh', verify: 'verify-install.sh' }

export function assertShellLineEndings(directory = join(root, 'deploy/scripts')) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) assertShellLineEndings(path)
    else if (entry.name.endsWith('.sh') && readFileSync(path, 'utf8').includes('\r')) {
      throw new Error(`Bash script has CRLF line endings: ${path}. Re-check out shell files with LF using the repository .gitattributes; preserve local edits.`)
    }
  }
}

function capture(command, args, env) {
  const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 15000 })
  if (result.error || result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed. ${result.error?.message ?? result.stderr?.trim() ?? ''}`)
  return result.stdout.trim()
}

export async function preflight(env, bash) {
  assertShellLineEndings()
  console.log(`PASS Node ${process.versions.node}`)
  console.log(`PASS ${capture('git', ['--version'], env)}`)
  capture(bash, ['--version'], env)
  console.log(`PASS Bash: ${bash}`)
  const engine = capture('docker', ['info', '--format', '{{.OSType}}'], env)
  if (engine !== 'linux') throw new Error('Docker must use Linux containers. Select the Linux engine in Docker Desktop (WSL 2 backend on Windows).')
  console.log('PASS Docker Linux engine is running')
  console.log(`PASS ${capture('docker', ['compose', 'version'], env)}`)
  try { capture('ollama', ['--version'], env) } catch {
    throw new Error('Ollama was not found. Run npm run install-persistent-memory and choose Install on the Ollama prerequisite card; the wizard can install it for you.')
  }
  const url = (env.OLLAMA_URL ?? 'http://localhost:11434').replace('host.docker.internal', 'localhost')
  let ollamaReady = false
  try {
    const response = await fetch(`${url.replace(/\/$/, '')}/api/tags`, { signal: AbortSignal.timeout(5000) })
    ollamaReady = response.ok && Array.isArray((await response.json()).models)
  } catch { /* The diagnostic below also covers a stopped or unreachable API. */ }
  if (!ollamaReady) throw new Error(`Ollama is not ready at ${url}. Run npm run install-persistent-memory and choose Start on the Ollama prerequisite card, or start the host Ollama app, then retry.`)
  console.log(`PASS Ollama is reachable at ${url}`)
  console.log('Host checks passed. No installation or configuration writes performed.')
}

export function checkPort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('ONBOARD_PORT must be an integer between 1 and 65535.')
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', error => reject(new Error(`Installer port ${port} is unavailable (${error.code}). Inspect the listener and resolve the port conflict before retrying.`)))
    server.listen(port, '127.0.0.1', () => server.close(resolvePort))
  })
}

async function onboard(env) {
  const port = Number(env.ONBOARD_PORT ?? 4319)
  await checkPort(port)
  const appDir = join(root, 'apps/onboard')
  await runNpm(['ci', '--no-audit', '--no-fund'], { cwd: appDir, env })
  await runNpm(['run', 'build'], { cwd: appDir, env })
  await checkPort(port)
  const url = `http://127.0.0.1:${port}`
  const dashboardUrl = env.DASHBOARD_URL ?? env.ADMIN_URL ?? `http://localhost:${env.PM_DASHBOARD_PORT ?? 3200}`
  const child = spawn(process.execPath, [join(appDir, 'dist/apps/onboard/server/index.js')], {
    cwd: root, env: { ...env, PM_ROOT: root, ONBOARD_PORT: String(port), DASHBOARD_URL: dashboardUrl, ADMIN_URL: dashboardUrl },
    stdio: 'inherit', windowsHide: true,
  })
  let finished = false
  const completion = new Promise((resolveChild, reject) => {
    child.once('error', error => { finished = true; reject(error) })
    child.once('exit', code => { finished = true; code === 0 ? resolveChild() : reject(new Error(`Installer exited (${code}).`)) })
  })
  // Observe early failures while polling; the original completion is still awaited below.
  completion.catch(() => {})
  const stop = () => { if (!finished) child.kill() }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    let ready = false
    for (let attempt = 0; attempt < 50 && !finished; attempt++) {
      ready = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(500) }).then(r => r.ok).catch(() => false)
      if (ready) break
      await new Promise(resolveWait => setTimeout(resolveWait, 300))
    }
    if (!ready && !finished) { stop(); throw new Error('Installer did not become ready in time.') }
    if (ready) {
      console.log(`Open ${url} in your browser. Keep this terminal open until installation completes.`)
      // URL is generated solely from the validated numeric port, never shell input.
      const browser = process.platform === 'win32'
        ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Start-Process '${url}'`], { windowsHide: true, stdio: 'ignore' })
        : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore' })
      browser.on('error', () => {})
      browser.unref()
    }
    await completion
  } finally {
    stop()
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
  }
}

export async function main([action, ...args] = process.argv.slice(2)) {
  if (args.includes('--help') || args.includes('-h') || action === '--help') {
    console.log('Persistent Memory host commands: check, install, start, stop, verify, update, uninstall.\nRun npm run <action>-persistent-memory (or npm run check:host).\nWindows: native Node 22.12+, Git for Windows Bash, Docker Desktop Linux engine, and Ollama.\nThe uninstall command retains its interactive export and deletion confirmations.')
    return
  }
  if (!['install', 'check', ...Object.keys(commands)].includes(action)) throw new Error(`Unknown host command: ${action}`)
  if (!supportedNode()) throw new Error('Node 22.12+ is required. Node 24 LTS is recommended.')
  const bash = process.platform === 'win32' ? findGitBash() : 'bash'
  const env = hostEnvironment({ bash })
  if (action === 'check') return preflight(env, bash)
  assertShellLineEndings()
  if (action === 'install') return onboard(env)
  await run(bash, ['deploy/scripts/' + commands[action], ...args], { cwd: root, env })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
