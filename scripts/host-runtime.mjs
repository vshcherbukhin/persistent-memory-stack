import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, win32 } from 'node:path'

export function supportedNode(version = process.versions.node) {
  const [major, minor] = version.replace(/^v/, '').split('.').map(Number)
  return major >= 24 || (major === 22 && minor >= 12)
}

export function npmInvocation(args, { env = process.env, execPath = process.execPath, exists = existsSync } = {}) {
  const candidates = [env.npm_execpath, join(dirname(execPath), 'node_modules/npm/bin/npm-cli.js'), join(dirname(execPath), '../lib/node_modules/npm/bin/npm-cli.js')]
  const cli = candidates.find(path => path && /npm-cli\.js$/i.test(path) && exists(path))
  if (!cli) throw new Error('Cannot locate npm-cli.js. Install Node with npm, then run this command through npm.')
  return { command: execPath, args: [cli, ...args] }
}

export function gitBashCandidates(env = process.env) {
  const roots = [env.ProgramW6432, env.ProgramFiles, env['ProgramFiles(x86)']].filter(Boolean)
  return [env.PM_GIT_BASH, ...roots.map(root => win32.join(root, 'Git/bin/bash.exe')),
    env.LOCALAPPDATA && win32.join(env.LOCALAPPDATA, 'Programs/Git/bin/bash.exe')].filter(Boolean)
}

export function findGitBash(env = process.env, exists = existsSync, probe = spawnSync) {
  for (const candidate of gitBashCandidates(env)) {
    if (!win32.isAbsolute(candidate) || !exists(candidate)) continue
    const result = probe(candidate, ['--noprofile', '--norc', '-c', 'uname -s'], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
    if (result.status === 0 && /^(MINGW|MSYS)/.test(result.stdout?.trim())) return candidate
  }
  throw new Error('Git for Windows Bash is required. Install Git for Windows or set PM_GIT_BASH to its full bin/bash.exe path. The WSL bash.exe launcher is not supported.')
}

export function hostEnvironment({ platform = process.platform, env = process.env, bash, home = homedir() } = {}) {
  if (platform !== 'win32') return { ...env }
  if (!bash) throw new Error('A validated Git for Windows Bash path is required.')
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH'
  const result = { ...env }
  // Windows environment keys are case insensitive; never pass both Path and PATH.
  for (const key of Object.keys(result)) if (key.toLowerCase() === 'path') delete result[key]
  const gitRoot = win32.resolve(win32.dirname(bash), /[\\/]usr[\\/]bin[\\/]bash\.exe$/i.test(bash) ? '../..' : '..')
  result.PATH = [win32.join(gitRoot, 'bin'), win32.join(gitRoot, 'usr/bin'), env[pathKey] ?? '',
    env.LOCALAPPDATA && win32.join(env.LOCALAPPDATA, 'Programs/Ollama'),
    env.ProgramFiles && win32.join(env.ProgramFiles, 'Docker/Docker/resources/bin'),
  ].filter(Boolean).join(';')
  result.HOME = (env.HOME && /^(?:[a-z]:[\\/]|\\\\)/i.test(env.HOME) ? env.HOME : home).replaceAll('\\', '/')
  result.PM_GIT_BASH = bash
  result.MSYS_NO_PATHCONV = '1'
  result.MSYS2_ARG_CONV_EXCL = '*'
  return result
}

export function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', windowsHide: true, ...options })
    child.once('error', reject)
    child.once('exit', (code, signal) => code === 0 ? resolveRun() : reject(new Error(`${command} failed (${signal ?? code ?? 'unknown exit'}).`)))
  })
}

export function runNpm(args, options = {}) {
  const invocation = npmInvocation(args, { env: options.env ?? process.env })
  return run(invocation.command, invocation.args, options)
}
