/**
 * docker-control — the security gate + verb-bounded HTTP router.
 *
 *   • authOk  — constant-time shared-secret check. Fails CLOSED when no token is
 *               configured, so this can never become an open socket proxy.
 *   • route   — dispatches ONLY: GET /services, GET /services/:s/logs,
 *               POST /services/:s/{start|stop|restart}, POST /services/:s/terminate.
 *               Anything else is 400/404/405
 *               and never reaches the socket. `terminate` is intentionally
 *               separate: it only stops an exact, project-labeled MCP stdio
 *               container id/name, not a Compose service label.
 *
 * No host port is published for this service (deploy/compose/docker-compose.yml) — it is only
 * reachable on the internal compose network, and even there the token is required.
 */
import http from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { DockerError, makeDockerOps, type DockerOps, type ServiceAction } from './docker.js'

const ACTIONS = new Set<ServiceAction>(['start', 'stop', 'restart'])
const TAIL_DEFAULT = 200
const TAIL_MAX = 2000

/** Constant-time `Authorization: Bearer <token>` check. Empty token ⇒ always false. */
export function authOk(header: string | undefined, token: string): boolean {
  if (!token) return false
  const expected = Buffer.from(`Bearer ${token}`)
  const got = Buffer.from(header ?? '')
  return got.length === expected.length && timingSafeEqual(got, expected)
}

export interface RouteResult {
  status: number
  body: unknown
}

/** Pure dispatch over the bounded verb set. Throws DockerError on socket failure. */
export async function route(
  method: string,
  pathname: string,
  query: URLSearchParams,
  ops: DockerOps,
): Promise<RouteResult> {
  const segs = pathname.split('/').filter(Boolean)
  if (segs[0] !== 'services') return { status: 404, body: { error: 'not_found' } }

  // GET /services
  if (segs.length === 1) {
    if (method !== 'GET') return { status: 405, body: { error: 'method_not_allowed' } }
    return { status: 200, body: { services: await ops.listServices() } }
  }

  // /services/:service/:verb
  if (segs.length === 3) {
    let service: string
    try {
      service = decodeURIComponent(segs[1]!)
    } catch {
      // Malformed %-escape — reject cleanly before touching the socket (don't
      // fall through to the createServer 500 branch that echoes the error).
      return { status: 400, body: { error: 'bad_request' } }
    }
    const verb = segs[2]!
    if (verb === 'logs') {
      if (method !== 'GET') return { status: 405, body: { error: 'method_not_allowed' } }
      const raw = Number.parseInt(query.get('tail') ?? '', 10)
      const tail = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), TAIL_MAX) : TAIL_DEFAULT
      return { status: 200, body: { service, logs: await ops.serviceLogs(service, tail) } }
    }
    if (verb === 'terminate') {
      if (method !== 'POST') return { status: 405, body: { error: 'method_not_allowed' } }
      return { status: 200, body: await ops.terminateMcpService(service) }
    }
    if (ACTIONS.has(verb as ServiceAction)) {
      if (method !== 'POST') return { status: 405, body: { error: 'method_not_allowed' } }
      return { status: 200, body: await ops.actOnService(service, verb as ServiceAction) }
    }
    // Unknown verb — reject before it can reach the socket.
    return { status: 400, body: { error: 'bad_action' } }
  }

  return { status: 404, body: { error: 'not_found' } }
}

export interface ServerDeps {
  token: string
  ops: DockerOps
}

export function createServer(deps: ServerDeps): http.Server {
  return http.createServer((req, res) => {
    const send = (status: number, obj: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(obj))
    }
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://docker-control')
      // Liveness probe — no auth, no info leak (used by the compose healthcheck).
      if (url.pathname === '/health' && req.method === 'GET') return send(200, { ok: true })
      if (!authOk(req.headers.authorization, deps.token)) return send(401, { error: 'unauthorized' })
      try {
        const r = await route(req.method ?? 'GET', url.pathname, url.searchParams, deps.ops)
        send(r.status, r.body)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.error(`ERROR: [docker-control] request failed ${req.method ?? 'GET'} ${url.pathname}: ${message}`)
        if (err instanceof DockerError) return send(503, { error: err.code, message: err.message })
        send(500, { error: 'internal', message })
      }
    })()
  })
}

/** Read config from the environment and start listening (the container entrypoint). */
export function start(): http.Server {
  const token = process.env.DOCKER_CONTROL_TOKEN ?? ''
  const port = Number.parseInt(process.env.PORT ?? '9090', 10)
  const ops = makeDockerOps({
    socketPath: process.env.DOCKER_SOCKET ?? '/var/run/docker.sock',
    project: process.env.DOCKER_COMPOSE_PROJECT ?? 'persistent-memory',
  })
  if (!token) {
    // Fail-closed: the gate rejects every request until a token is set.
    console.warn('WARN: [docker-control] DOCKER_CONTROL_TOKEN is empty — all requests will be rejected (401).')
  }
  const server = createServer({ token, ops })
  server.listen(port, '0.0.0.0', () => console.info(`INFO: [docker-control] listening on :${port} (project ${process.env.DOCKER_COMPOSE_PROJECT ?? 'persistent-memory'})`))
  return server
}
