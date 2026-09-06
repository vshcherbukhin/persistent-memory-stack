import { spawnSync } from 'node:child_process'
export function pythonInvocation(args, env = process.env) {
  const candidates = env.PM_PYTHON ? [[env.PM_PYTHON, []]] : process.platform === 'win32' ? [['py', ['-3']], ['python', []], ['python3', []]] : [['python3', []], ['python', []]]
  for (const [command, prefix] of candidates) {
    const probe = spawnSync(command, [...prefix, '-c', 'import sys; print(sys.version_info.major)'], { env, encoding: 'utf8', windowsHide: true, timeout: 5000 })
    if (probe.status === 0 && probe.stdout.trim() === '3') return { command, args: [...prefix, ...args] }
  }
  throw new Error('Python 3 is required for documentation and Python tests. Install it or set PM_PYTHON to its executable path.')
}
