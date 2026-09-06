/** Native host commands. Windows never resolves `bash` through the WSL alias or
 * launches npm.cmd through a shell; arguments and credentials stay in argv/env. */
import { existsSync } from 'node:fs'
import { win32 } from 'node:path'

export interface HostOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  execPath?: string
  exists?: (path: string) => boolean
}

export function nativeWindowsPath(value: string): string {
  return value.replace(/^\/([a-z])\//i, '$1:/').replaceAll('/', '\\')
}

export function hostEnvironment(options: HostOptions = {}): NodeJS.ProcessEnv {
  const env = { ...(options.env ?? process.env) }
  if ((options.platform ?? process.platform) !== 'win32') return env
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path')
  const currentPath = pathKey ? env[pathKey] ?? '' : ''
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key]
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'PM_ROOT', 'PM_GIT_BASH', 'npm_execpath']) {
    if (env[key]) env[key] = nativeWindowsPath(env[key]!)
  }
  const programFiles = env.ProgramFiles || env.PROGRAMFILES || 'C:\\Program Files'
  const local = env.LOCALAPPDATA
  env.PATH = [
    win32.dirname(options.execPath ?? process.execPath),
    ...currentPath.split(';').filter(Boolean),
    win32.join(programFiles, 'Docker', 'Docker', 'resources', 'bin'),
    ...(local ? [win32.join(local, 'Programs', 'Ollama')] : []),
  ].join(';')
  return env
}

export function gitBashPath(options: HostOptions = {}): string | null {
  if ((options.platform ?? process.platform) !== 'win32') return 'bash'
  const env = hostEnvironment(options)
  const exists = options.exists ?? existsSync
  const roots = [
    env.ProgramFiles || env.PROGRAMFILES || 'C:\\Program Files',
    env['ProgramFiles(x86)'],
    env.LOCALAPPDATA ? win32.join(env.LOCALAPPDATA, 'Programs') : undefined,
  ].filter((value): value is string => !!value)
  const fromPath = (env.PATH ?? '').split(';').flatMap((path) => {
    const root = /[\\/]Git[\\/](?:cmd|bin|usr[\\/]bin)[\\/]?$/i.exec(path)
    return root ? [path.slice(0, root.index) + '\\Git'] : []
  })
  const candidates = [
    env.PM_GIT_BASH,
    ...[...roots.map((root) => win32.join(root, 'Git')), ...fromPath]
      .flatMap((root) => [win32.join(root, 'bin', 'bash.exe'), win32.join(root, 'usr', 'bin', 'bash.exe')]),
  ]
  return candidates.find((path): path is string => !!path && win32.isAbsolute(path)
    && !/[\\/]Windows[\\/](?:System32|SysWOW64)[\\/]/i.test(path) && exists(path)) ?? null
}

export function hostCommand(cmd: string, args: string[], options: HostOptions = {}): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  const platform = options.platform ?? process.platform
  const env = hostEnvironment(options)
  if (platform !== 'win32') return { command: cmd, args, env }
  const execPath = options.execPath ?? process.execPath
  if (cmd === 'node') return { command: execPath, args, env }
  if (cmd === 'npm' || cmd === 'npx') {
    const exists = options.exists ?? existsSync
    const name = `${cmd}-cli.js`
    const candidates = [
      ...(env.npm_execpath ? [win32.join(win32.dirname(env.npm_execpath), name)] : []),
      win32.join(win32.dirname(execPath), 'node_modules', 'npm', 'bin', name),
      ...(env.APPDATA ? [win32.join(env.APPDATA, 'npm', 'node_modules', 'npm', 'bin', name)] : []),
    ]
    const cli = candidates.find((path) => exists(path))
    if (!cli) throw new Error('npm CLI was not found. Install Node.js 22.12+ with npm, then reopen PowerShell and restart the installer.')
    return { command: execPath, args: [cli, ...args], env }
  }
  if (cmd === 'bash') {
    const bash = gitBashPath(options)
    if (!bash) throw new Error('Git for Windows Bash was not found. Install Git for Windows, then reopen PowerShell and restart the installer. For a custom location, set PM_GIT_BASH to its bash.exe path.')
    // Docker arguments (including container paths) must not be rewritten by MSYS.
    env.MSYS_NO_PATHCONV = '1'
    env.MSYS2_ARG_CONV_EXCL = '*'
    return { command: bash, args, env }
  }
  return { command: cmd, args, env }
}

export function presenceCommand(command: string, platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
  return platform === 'win32'
    ? { command: 'where.exe', args: [command] }
    : { command: 'which', args: [command] }
}
