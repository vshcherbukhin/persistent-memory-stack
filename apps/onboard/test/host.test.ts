import { describe, expect, it } from 'vitest'
import { appProbePaths, readApps } from '../server/detect.ts'
import { gitBashPath, hostCommand, hostEnvironment, presenceCommand } from '../server/host.ts'
import { buildPrereqInstallPlan, prereqInstallCapabilities, parseDockerInfo, parseNodeVersion } from '../server/prereq.ts'

describe('native Windows host execution', () => {
  const execPath = 'C:\\Program Files\\nodejs\\node.exe'
  const cli = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js'
  it('runs npm through Node with literal arguments and secrets, without a command shell', () => {
    const args = ['run', 'setup', '--', 'C:\\My projects\\one & two']
    const plan = hostCommand('npm', args, { platform: 'win32', execPath, env: { TOKEN: 'literal & value' }, exists: (path) => path === cli })
    expect(plan.command).toBe(execPath)
    expect(plan.args).toEqual([cli, ...args])
    expect(plan.env.TOKEN).toBe('literal & value')
  })
  it('resolves a custom npm installation inherited from npm run', () => {
    const npm = 'D:\\tools\\npm\\bin\\npm-cli.js'
    expect(hostCommand('npm', ['--version'], { platform: 'win32', execPath, env: { npm_execpath: npm }, exists: (path) => path === npm }).args).toEqual([npm, '--version'])
  })
  it('never falls back to the System32 WSL bash alias', () => {
    expect(gitBashPath({ platform: 'win32', env: { PM_GIT_BASH: 'C:\\Windows\\System32\\bash.exe', PATH: 'C:\\Windows\\System32' }, exists: (path) => path === 'C:\\Windows\\System32\\bash.exe' })).toBeNull()
    expect(() => hostCommand('bash', ['verify.sh'], { platform: 'win32', env: {}, exists: () => false })).toThrow('Git for Windows')
  })
  it('finds Git in a custom PATH and protects Docker container arguments from MSYS rewriting', () => {
    const bash = 'D:\\tools\\Git\\bin\\bash.exe'
    const command = hostCommand('bash', ['deploy/scripts/verify-install.sh'], { platform: 'win32', env: { Path: 'D:\\tools\\Git\\cmd' }, exists: (path) => path === bash })
    expect(command.command).toBe(bash)
    expect(command.env.MSYS2_ARG_CONV_EXCL).toBe('*')
  })
  it('normalizes inherited MSYS host paths and folds Windows Path casing without losing tools', () => {
    const env = hostEnvironment({ platform: 'win32', execPath, env: { HOME: '/c/Users/A Person', PM_ROOT: '/d/projects/Memory Stack', Path: 'C:\\tools', LOCALAPPDATA: 'C:\\Users\\A Person\\AppData\\Local' } })
    expect(env.HOME).toBe('c:\\Users\\A Person')
    expect(env.PM_ROOT).toBe('d:\\projects\\Memory Stack')
    expect(env.Path).toBeUndefined()
    expect(env.PATH).toContain('C:\\tools')
    expect(env.PATH).toContain('Programs\\Ollama')
  })
  it('preserves macOS command and environment semantics', () => {
    expect(hostCommand('npm', ['run', 'setup'], { platform: 'darwin', env: { PATH: '/opt/homebrew/bin:/usr/bin' } })).toEqual({ command: 'npm', args: ['run', 'setup'], env: { PATH: '/opt/homebrew/bin:/usr/bin' } })
    expect(presenceCommand('ollama', 'darwin')).toEqual({ command: 'which', args: ['ollama'] })
    expect(presenceCommand('ollama', 'win32')).toEqual({ command: 'where.exe', args: ['ollama'] })
  })
})

describe('platform prerequisites and app paths', () => {
  it('accepts only an identified Linux Docker engine', () => {
    expect(parseDockerInfo('linux\r\n', 0).ok).toBe(true)
    expect(parseDockerInfo('windows', 0)).toMatchObject({ ok: false, detail: expect.stringContaining('Linux containers') })
    expect(parseDockerInfo('', 0).ok).toBe(false)
    expect(parseDockerInfo('linux', 1).ok).toBe(false)
  })
  it('enforces the toolchain Node version floor', () => {
    expect(parseNodeVersion('v22.12.0').ok).toBe(true)
    expect(parseNodeVersion('v24.0.0').ok).toBe(true)
    expect(parseNodeVersion('v22.11.0').ok).toBe(false)
    expect(parseNodeVersion('v20.20.0').ok).toBe(false)
    expect(parseNodeVersion('v23.11.0').ok).toBe(false)
  })
  it('keeps Windows Docker manual while providing an official Ollama installation action', () => {
    expect(() => buildPrereqInstallPlan('docker', { platform: 'win32', brewPath: null, hasDocker: false, hasOllama: false })).toThrow('Docker Desktop for Windows')
    const host = { platform: 'win32', root: 'C:\\Memory Project', brewPath: null, hasDocker: true, hasOllama: false }
    expect(buildPrereqInstallPlan('ollama', host)).toEqual([{
      id: 'install-ollama', name: 'Download, verify, and install Ollama',
      cmd: ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
        'C:\\Memory Project\\deploy\\scripts\\install-ollama-windows.ps1', '-Action', 'Install'],
    }])
    expect(buildPrereqInstallPlan('ollama', { ...host, hasOllama: true })[0]).toMatchObject({ id: 'start-ollama', cmd: expect.arrayContaining(['-Action', 'Start']) })
  })
  it('advertises installation support per prerequisite and preserves macOS actions', () => {
    expect(prereqInstallCapabilities('win32')).toEqual({ homebrew: false, node: false, docker: false, compose: false, ollama: true })
    expect(prereqInstallCapabilities('darwin')).toEqual({ homebrew: false, node: true, docker: true, compose: true, ollama: true })
    expect(Object.values(prereqInstallCapabilities('linux')).some(Boolean)).toBe(false)
  })
  it('uses roaming/local Windows application data independently of the test host', () => {
    const options = { platform: 'win32' as const, env: { APPDATA: 'D:\\Roaming', LOCALAPPDATA: 'D:\\Local' } }
    const paths = appProbePaths('C:\\Users\\A Person', options)
    expect(paths.claudeDesktopCfg).toBe('D:\\Roaming\\Claude\\claude_desktop_config.json')
    expect(paths.codexToml).toBe('C:\\Users\\A Person\\.codex\\config.toml')
    expect(readApps('C:\\Users\\A Person', options, (path) => path === 'D:\\Local\\Microsoft\\WindowsApps\\Codex.exe').codexDesktop).toBe(true)
  })
  it('finds the versioned Windows Codex executable without treating an empty install directory as an installed app', () => {
    const options = { platform: 'win32' as const, env: { LOCALAPPDATA: 'D:\\Local' } }
    const executable = 'D:\\Local\\OpenAI\\Codex\\bin\\build-123\\codex.exe'
    const dirs = (path: string) => path === 'D:\\Local\\OpenAI\\Codex\\bin' ? ['build-123'] : []
    const apps = readApps('C:\\Users\\Person', options, (path) => path === executable, dirs)
    expect(apps.codexDesktop).toBe(true)
    expect(apps.paths.codexApp).toBe(executable)
    expect(readApps('C:\\Users\\Person', options, () => false, dirs).codexDesktop).toBe(false)
  })
  it('preserves UNC paths for native children', () => {
    const env = hostEnvironment({ platform: 'win32', env: { PM_ROOT: '//server/share/Memory Stack' } })
    expect(env.PM_ROOT).toBe('\\\\server\\share\\Memory Stack')
  })
  it('preserves macOS app bundle detection and never probes cwd for an unsupported desktop', () => {
    expect(appProbePaths('/Users/person', { platform: 'darwin', env: {} }).claudeApp).toBe('/Applications/Claude.app')
    const probes: string[] = []
    const apps = readApps('/home/person', { platform: 'linux', env: {} }, (path) => { probes.push(path); return false })
    expect(apps.codexDesktop).toBe(false)
    expect(probes).not.toContain('')
    expect(probes.every((path) => path.startsWith('/'))).toBe(true)
  })
})
