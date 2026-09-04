/**
 * docker-control — the ONLY process that touches the Docker socket.
 *
 * Talks the Docker Engine API directly over the UNIX socket (no docker CLI in the
 * image). Every operation is filtered to THIS compose project (label
 * com.docker.compose.project) so it can NEVER see or touch unrelated containers,
 * and only ever issues list / logs / start / stop / restart — there is no code
 * path here that can create a container, run exec, or mount the host. That verb
 * boundary + the project filter are half the security model; the shared-secret
 * gate in server.ts is the other half.
 */
import http from 'node:http'
import { memoryContainerFilters, parseContainers, demuxDockerLog, type ServiceInfo } from './parse.js'

export type ServiceAction = 'start' | 'stop' | 'restart'

export interface DockerOps {
  listServices(): Promise<ServiceInfo[]>
  serviceLogs(service: string, tail: number): Promise<string>
  actOnService(service: string, action: ServiceAction): Promise<{ ok: boolean }>
  terminateMcpService(service: string): Promise<{ ok: boolean }>
}

/** Raised when the daemon is unreachable or returns an unexpected status. */
export class DockerError extends Error {
  readonly code = 'docker_unavailable' as const
  constructor(message: string) {
    super(message)
    this.name = 'DockerError'
  }
}

export interface DockerOpsConfig {
  socketPath: string
  project: string
}

export function matchesServiceRef(row: ServiceInfo, ref: string, requireControllable = false): boolean {
  if (requireControllable && !row.controllable) return false
  return row.service === ref || row.name === ref || row.id === ref || row.id.startsWith(ref)
}

function matchesExactContainerRef(row: ServiceInfo, ref: string): boolean {
  return row.name === ref || row.id === ref || row.id.startsWith(ref)
}

export function makeDockerOps(cfg: DockerOpsConfig): DockerOps {
  function request(method: string, path: string): Promise<{ status: number; buf: Buffer }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { socketPath: cfg.socketPath, path, method, headers: { Host: 'docker', Accept: 'application/json' } },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('end', () => resolve({ status: res.statusCode ?? 0, buf: Buffer.concat(chunks) }))
        },
      )
      req.on('error', (err) => reject(new DockerError(`Docker socket unreachable: ${err.message}`)))
      req.end()
    })
  }

  async function listServices(): Promise<ServiceInfo[]> {
    const { status, buf } = await request('GET', `/containers/json?all=true&filters=${memoryContainerFilters(cfg.project)}`)
    if (status !== 200) throw new DockerError(`Docker list returned ${status}.`)
    return parseContainers(JSON.parse(buf.toString('utf8')))
  }

  // Resolve a service name → its container id, but ONLY within this project
  // (listServices is already project-filtered) — so an attacker can't pass an
  // arbitrary container name and have us act on it. Mutations require a
  // controllable runtime Compose service; logs may read MCP client rows too.
  async function resolveId(service: string, requireControllable = false): Promise<string | null> {
    const svc = await listServices()
    return svc.find((s) => matchesServiceRef(s, service, requireControllable))?.id ?? null
  }

  async function resolveMcpId(service: string): Promise<string | null> {
    const matches = (await listServices()).filter((s) => s.mcpSession && matchesExactContainerRef(s, service))
    if (matches.length === 1) return matches[0]!.id
    if (matches.length > 1) throw new DockerError(`Ambiguous MCP container reference "${service}".`)
    return null
  }

  return {
    listServices,
    async serviceLogs(service, tail) {
      const id = await resolveId(service)
      if (!id) throw new DockerError(`No container for service "${service}".`)
      const { status, buf } = await request(
        'GET',
        `/containers/${id}/logs?stdout=true&stderr=true&timestamps=true&tail=${tail}`,
      )
      if (status !== 200) throw new DockerError(`Docker logs returned ${status}.`)
      return demuxDockerLog(buf)
    },
    async actOnService(service, action) {
      const id = await resolveId(service, true)
      if (!id) throw new DockerError(`No controllable stack service "${service}".`)
      const { status } = await request('POST', `/containers/${id}/${action}`)
      // 204 = done; 304 = already in the desired state — both are success.
      if (status === 204 || status === 304) return { ok: true }
      throw new DockerError(`Docker ${action} returned ${status}.`)
    },
    async terminateMcpService(service) {
      const id = await resolveMcpId(service)
      if (!id) throw new DockerError(`No exact MCP session container "${service}".`)
      const { status } = await request('POST', `/containers/${id}/stop?t=2`)
      // Docker-run MCP containers use --rm, so stopping them removes the stale row.
      if (status === 204 || status === 304) return { ok: true }
      throw new DockerError(`Docker terminate returned ${status}.`)
    },
  }
}
