import { execFile } from 'node:child_process'
import { access, constants, existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import { hostCommand } from './host.js'
import { parseComposeVersion, parseDockerInfo, parseNodeVersion } from './prereq.js'
import { REQUIRED_ENVIRONMENT_CHECKS, type EnvironmentProbe, type EnvironmentSnapshot } from '../shared/environment.js'

type CommandResult = { code: number; stdout: string }
export interface EnvironmentIO {
  capture(command: string, args: string[]): Promise<CommandResult>
  writable(path: string): Promise<boolean>
  canBind(host: string, port: number): Promise<boolean>
  reachable(url: string): Promise<boolean>
}
export interface EnvironmentOptions {
  root: string
  env?: Record<string, string>
  platform?: NodeJS.Platform
  nodeVersion?: string
  envFilePresent?: boolean
  io?: Partial<EnvironmentIO>
}

const good = (detail: string): EnvironmentProbe => ({ ok: true, detail })
const bad = (detail: string): EnvironmentProbe => ({ ok: false, detail })
const normalizedPath = (path: string, platform: string) => platform === 'win32' ? path.replaceAll('\\', '/').toLowerCase().replace(/\/$/, '') : path.replace(/\/$/, '')
async function bounded<T>(operation: Promise<T>, fallback: T, milliseconds = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([operation, new Promise<T>((done) => { timer = setTimeout(() => done(fallback), milliseconds) })])
  } catch { return fallback } finally { if (timer) clearTimeout(timer) }
}

export const BUILD_NETWORK_ENDPOINTS = [
  'https://registry.npmjs.org/-/ping',
  'https://registry-1.docker.io/v2/',
  'https://pypi.org/simple/',
  'https://github.com/',
  'https://proxy.golang.org/',
  'https://sum.golang.org/',
] as const

function defaultIO(env: Record<string, string>): EnvironmentIO {
  return {
    capture: (command, args) => new Promise((done) => {
      try {
        const child = hostCommand(command, args, { env: { ...process.env, ...env } })
        execFile(child.command, child.args, { env: child.env, timeout: 10_000, maxBuffer: 256 * 1024, windowsHide: true, encoding: 'utf8' }, (error, stdout) => {
          done({ code: error ? 1 : 0, stdout: error ? '' : stdout })
        })
      } catch { done({ code: 1, stdout: '' }) }
    }),
    writable: (path) => new Promise((done) => access(path, constants.W_OK, (error) => done(!error))),
    canBind: (host, port) => new Promise((done) => {
      const server = createServer((socket) => socket.destroy())
      const timer = setTimeout(() => { server.close(() => {}); done(false) }, 2_000)
      server.once('error', () => { clearTimeout(timer); done(false) })
      server.listen({ host, port, exclusive: true }, () => server.close(() => { clearTimeout(timer); done(true) }))
    }),
    reachable: async (url) => {
      try {
        const response = await fetch(url, { method: 'HEAD', redirect: 'error', signal: AbortSignal.timeout(5_000) })
        return response.ok || (url === BUILD_NETWORK_ENDPOINTS[1] && response.status === 401)
      } catch { return false }
    },
  }
}

interface PortAssignment { service: string; port: number }
export function environmentPorts(env: Record<string, string>): PortAssignment[] {
  const specs: Array<[string, string, number]> = [
    ['qdrant', 'PM_QDRANT_HTTP_PORT', 7333], ['qdrant', 'PM_QDRANT_GRPC_PORT', 7334],
    ['falkordb', 'PM_FALKORDB_PORT', 6380], ['falkordb', 'PM_FALKORDB_BROWSER_PORT', 3100],
    ['postgres', 'PM_POSTGRES_PORT', 5433], ['redis', 'PM_REDIS_PORT', 6381],
    ['minio', 'PM_MINIO_API_PORT', 9002], ['minio', 'PM_MINIO_CONSOLE_PORT', 9003],
    ['graphiti', 'PM_GRAPHITI_PORT', 8100], ['api', 'PM_API_PORT', 8090],
    ['mcp', 'PM_MCP_PORT', 8091], ['dashboard-gateway', 'PM_DASHBOARD_PORT', 3200],
  ]
  if (env.GRAPH_BACKEND === 'neo4j') specs.push(['neo4j', 'PM_NEO4J_HTTP_PORT', 7475], ['neo4j', 'PM_NEO4J_BOLT_PORT', 7688])
  const assignments = specs.map(([service, key, fallback]) => {
    const raw = env[key] ?? String(fallback)
    if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 65535) throw new Error(`${key} must be a port from 1 to 65535.`)
    return { service, port: Number(raw) }
  })
  if (new Set(assignments.map((assignment) => assignment.port)).size !== assignments.length) throw new Error('Two installation services use the same host port. Correct the saved configuration before installing.')
  return assignments
}

interface ContainerPorts { name: string; labels: Record<string, string>; ports: Record<string, Array<{ HostIp: string; HostPort: string }> | null> }
export async function checkEnvironmentPorts(root: string, env: Record<string, string>, platform: NodeJS.Platform, io: EnvironmentIO): Promise<EnvironmentProbe> {
  let assignments: PortAssignment[]
  try { assignments = environmentPorts(env) } catch (error) { return bad((error as Error).message) }
  const prefix = env.PM_CONTAINER_PREFIX ?? 'persistent-memory'
  const project = env.COMPOSE_PROJECT_NAME ?? 'persistent-memory'
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$/.test(prefix) || !/^[a-z0-9][a-z0-9_-]{0,100}$/.test(project)) return bad('The saved Docker namespace is invalid. Correct it before installing.')
  const host = env.PM_HOST_BIND ?? '127.0.0.1'
  if (!['127.0.0.1', '0.0.0.0', '::1'].includes(host)) return bad('The configured host bind address could not be checked safely. Use an explicit local interface address.')
  const listed = await bounded(io.capture('docker', ['ps', '-q']), { code: 1, stdout: '' })
  if (listed.code !== 0) return bad('Docker port ownership could not be checked. Start the local Linux engine and check again.')
  const ids = listed.stdout.trim().split(/\s+/).filter(Boolean)
  if (ids.some((id) => !/^[a-f0-9]{12,64}$/i.test(id))) return bad('Docker returned an unrecognized container inventory. No occupied port can be approved.')
  let containers: ContainerPorts[] = []
  if (ids.length) {
    const inspected = await bounded(io.capture('docker', ['inspect', '--format', '{"name":{{json .Name}},"labels":{{json .Config.Labels}},"ports":{{json .NetworkSettings.Ports}}}', ...ids]), { code: 1, stdout: '' })
    try {
      if (inspected.code !== 0) throw new Error()
      containers = inspected.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => {
        const item = JSON.parse(line) as ContainerPorts
        // Unrelated containers may have no labels or published ports. They
        // cannot establish ownership, but must not block freely bindable ports.
        return { ...item, labels: item.labels ?? {}, ports: item.ports ?? {} }
      })
      if (containers.length !== ids.length || containers.some((item) => !item.name || typeof item.labels !== 'object' || typeof item.ports !== 'object')) throw new Error()
    } catch { return bad('Docker port ownership could not be verified. No occupied port can be approved.') }
  }
  const expectedConfig = normalizedPath(join(resolve(root), 'deploy', 'compose', 'docker-compose.yml'), platform)
  const conflicts: number[] = []
  const available = await Promise.all(assignments.map((assignment) => bounded(io.canBind(host, assignment.port), false, 2_500)))
  for (const [index, assignment] of assignments.entries()) {
    if (available[index]) continue
    const owned = containers.some((item) => item.name === `/${prefix}-${assignment.service}` &&
      item.labels['com.docker.compose.project'] === project && item.labels['com.docker.compose.service'] === assignment.service &&
      (item.labels['com.docker.compose.project.config_files'] ?? '').split(',').some((file) => normalizedPath(file, platform) === expectedConfig) &&
      Object.values(item.ports).flatMap((bindings) => bindings ?? []).some((binding) => Number(binding.HostPort) === assignment.port &&
        (binding.HostIp === host || (host === '127.0.0.1' && binding.HostIp === '0.0.0.0'))))
    if (!owned) conflicts.push(assignment.port)
  }
  return conflicts.length ? bad(`Host port${conflicts.length > 1 ? 's' : ''} ${conflicts.join(', ')} are occupied or unavailable without verified ownership by this checkout. Resolve the conflict; setup will not stop or remap another service.`)
    : good('Required host ports are available or positively owned by this checkout.')
}

/** Fresh bounded read-only probes; never installs, starts, pulls or sends provider content. */
export async function readEnvironment(options: EnvironmentOptions): Promise<EnvironmentSnapshot> {
  const env = options.env ?? {}
  const io = { ...defaultIO(env), ...options.io }
  const platform = options.platform ?? process.platform
  const envPath = join(options.root, '.env.persistent-memory')
  const envPresent = options.envFilePresent ?? existsSync(envPath)
  const capture = async (command: string, args: string[]) => {
    try { return await bounded(io.capture(command, args), { code: 1, stdout: '' }) } catch { return { code: 1, stdout: '' } }
  }
  const [npm, git, bash, dockerCli, dockerInfo, dockerContext, compose, buildx, rootWrite, network] = await Promise.all([
    capture('npm', ['--version']), capture('git', ['--version']),
    capture('bash', ['--noprofile', '--norc', '-c', 'printf "%s\\n" "$BASH_VERSION"; uname -s; command -v curl']),
    capture('docker', ['--version']), capture('docker', ['info', '--format', '{{.OSType}}']),
    capture('docker', ['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}']),
    capture('docker', ['compose', 'version']), capture('docker', ['buildx', 'version']),
    Promise.all([bounded(io.writable(options.root), false), envPresent ? bounded(io.writable(envPath), false) : Promise.resolve(true)]).then((results) => results.every(Boolean)),
    Promise.all(BUILD_NETWORK_ENDPOINTS.map((url) => bounded(io.reachable(url), false, 6_000))).then((results) => results.every(Boolean)),
  ])
  const dockerInstalled = dockerCli.code === 0 && /^Docker version\s+\d/i.test(dockerCli.stdout.trim())
  const docker = parseDockerInfo(dockerInfo.stdout, dockerInfo.code)
  const effectiveEnv = { ...process.env, ...env }
  // Match Docker CLI precedence: an explicit context overrides DOCKER_HOST.
  let endpoint = effectiveEnv.DOCKER_CONTEXT ? undefined : effectiveEnv.DOCKER_HOST
  if (!endpoint && dockerContext.code === 0) { try { endpoint = JSON.parse(dockerContext.stdout) as string } catch { /* fail closed below */ } }
  const localDocker = typeof endpoint === 'string' && /^(unix:\/\/\/|npipe:\/{4}\.\/pipe\/)/i.test(endpoint)
  const shell = bash.stdout.trim().split(/\r?\n/)
  const realm = shell[1] ?? ''
  const shellOk = bash.code === 0 && /^\d+\.\d+/.test(shell[0] ?? '') && !!shell[2]?.trim() &&
    (platform === 'win32' ? /^(MINGW|MSYS)/.test(realm) : platform === 'darwin' ? realm === 'Darwin' : platform === 'linux' && realm === 'Linux')
  const checks: EnvironmentSnapshot['checks'] = {
    node: parseNodeVersion(options.nodeVersion ?? process.version),
    npm: npm.code === 0 && /^(10|11)\.\d+\.\d+$/.test(npm.stdout.trim()) ? good(`npm ${npm.stdout.trim()}.`) : bad('npm 10.x or 11.x is required. Install the supported Node runtime with npm, then restart setup.'),
    git: git.code === 0 && /^git version \d+\.\d+/i.test(git.stdout.trim()) ? good('Git is available.') : bad('Git was not found. Install Git (Git for Windows on Windows), then restart setup.'),
    bash: shellOk ? good(platform === 'win32' ? 'Git for Windows Bash and curl are available (MSYS/MINGW).' : 'Native Bash and curl are available.') : bad(platform === 'win32' ? 'Working Git for Windows Bash with curl is required; the WSL launcher is not supported.' : 'Working native Bash and curl are required. Install both with your operating system package manager.'),
    docker: { ...(dockerInstalled ? !localDocker ? bad('Select a local Docker Desktop or local Engine context. Remote Docker endpoints cannot use this machine’s installation files and ports.') : docker : bad('Docker CLI was not found. Install Docker Desktop or Docker Engine.')), installed: dockerInstalled, running: docker.ok },
    compose: parseComposeVersion(compose.stdout, compose.code),
    buildx: buildx.code === 0 && /\bv\d+\.\d+\.\d+/.test(buildx.stdout) ? good('Docker Buildx is available.') : bad('Docker Buildx is required for application image builds. Repair or update Docker Desktop/the Buildx plugin.'),
    composeConfig: good('The saved Compose configuration will be validated immediately before installation.'),
    rootWrite: rootWrite ? good('Installation directory and saved configuration permit writes.') : bad('The installation directory or saved configuration is not writable. Correct its permissions before installing.'),
    ports: bad('Required host ports have not yet been checked.'),
    network: network ? good('Build-required package and official source registries are reachable.') : bad('Build-required package or source registries are unreachable. Check internet access, proxy and firewall settings, then check again.'),
  }
  checks.ports = await checkEnvironmentPorts(options.root, env, platform, { ...io, capture }).catch(() => bad('Host port availability or ownership could not be verified. Check again before installing.'))
  if (envPresent) {
    const args = ['compose', '-f', join(options.root, 'deploy/compose/docker-compose.yml'), '--env-file', envPath,
      ...(env.GRAPH_BACKEND === 'neo4j' ? ['--profile', 'neo4j'] : []), 'config', '--quiet']
    const configured = await capture('docker', args)
    checks.composeConfig = configured.code === 0 ? good('Saved Compose configuration validates for this installation.')
      : bad('Saved Compose configuration does not validate. Review the saved configuration and supported Compose version before installing.')
  }
  return { capturedAt: new Date().toISOString(), ok: REQUIRED_ENVIRONMENT_CHECKS.every((key) => checks[key].ok), checks }
}
