import http from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import {
  createUpdateRunner,
  type UpdateLogState,
  type UpdateStatus,
} from './update.js'
import { publicUpdateSource } from '../../../layers/update-ops/update-flow/github.js'

export interface UpdateRunnerOps {
  status(): Promise<UpdateStatus>
  start(): Promise<{ ok: boolean }>
  logs(): Promise<UpdateLogState>
}

export interface RouteResult {
  status: number
  body: unknown
}

export function authOk(header: string | undefined, token: string): boolean {
  if (!token) return false
  const expected = Buffer.from(`Bearer ${token}`)
  const got = Buffer.from(header ?? '')
  return got.length === expected.length && timingSafeEqual(got, expected)
}

export async function route(
  method: string,
  pathname: string,
  _query: URLSearchParams,
  ops: UpdateRunnerOps,
): Promise<RouteResult> {
  if (pathname === '/status') {
    if (method !== 'GET') return { status: 405, body: { error: 'method_not_allowed' } }
    return { status: 200, body: await ops.status() }
  }
  if (pathname === '/start') {
    if (method !== 'POST') return { status: 405, body: { error: 'method_not_allowed' } }
    return { status: 202, body: await ops.start() }
  }
  if (pathname === '/logs') {
    if (method !== 'GET') return { status: 405, body: { error: 'method_not_allowed' } }
    return { status: 200, body: await ops.logs() }
  }
  return { status: 404, body: { error: 'not_found' } }
}

export interface ServerDeps {
  token: string
  ops: UpdateRunnerOps
}

export function createServer(deps: ServerDeps): http.Server {
  return http.createServer((req, res) => {
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://update-runner')
      if (url.pathname === '/health' && req.method === 'GET') return send(200, { ok: true })
      if (!authOk(req.headers.authorization, deps.token)) return send(401, { error: 'unauthorized' })
      try {
        const result = await route(req.method ?? 'GET', url.pathname, url.searchParams, deps.ops)
        send(result.status, result.body)
      } catch (err) {
        const requestId = randomUUID()
        const status = 500
        const error = 'internal'
        const message = 'The update runner could not complete the request.'
        const details = 'Check the update-runner service logs with the request id and try again.'
        console.error(`ERROR: [update-runner] request failed ${req.method ?? 'GET'} ${url.pathname} requestId=${requestId} code=${error} message=${message}`)
        send(status, { error, message, details, requestId })
      }
    })()
  })
}

export function start(): http.Server {
  const repoDir = process.env.UPDATE_REPO_DIR ?? '/workspace'
  const backupRoot = process.env.UPDATE_BACKUP_ROOT ?? `${repoDir}/.local/update-backups`
  const branch = process.env.UPDATE_BRANCH ?? publicUpdateSource.branch
  const token = process.env.UPDATE_RUNNER_TOKEN ?? ''
  const port = Number.parseInt(process.env.PORT ?? '9092', 10)
  const ops = createUpdateRunner({ repoDir, backupRoot, branch })
  if (!token) {
    console.warn('WARN: [update-runner] UPDATE_RUNNER_TOKEN is empty — all requests will be rejected (401).')
  }
  const server = createServer({ token, ops })
  server.listen(port, '0.0.0.0', () => {
    console.info(`INFO: [update-runner] listening on :${port} (repo ${repoDir}, branch ${branch})`)
  })
  return server
}
