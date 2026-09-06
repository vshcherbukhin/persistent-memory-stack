#!/usr/bin/env node
/**
 * persistent-memory-mcp — Streamable HTTP MCP server.
 *
 * Boot sequence:
 *   1. loadConfig()       — validate API_URL/env shape; token may be absent until
 *                           GET /config proves deploymentMode=local.
 *   2. new ApiClient      — holds the optional Bearer token; never logs it.
 *   3. resolveRuntime()   — GET /config → effective {mode, pin}; build the client-managed
 *                           local embedder (NOT trusting the MCP's own env).
 *   4. requireToken...    — server deployments still require PM_USER_TOKEN.
 *   5. registerAllTools() — the tools onto the McpServer.
 *   6. Start the Streamable HTTP transport.
 *
 * Graceful shutdown on SIGINT/SIGTERM closes the MCP session registry row and
 * transport cleanly.
 *
 * stdout is SACRED: every diagnostic goes through log.ts → stderr.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import {
  ApiClient,
  idleSessionIds,
  loadConfig,
  log,
  missingMcpSessionResponse,
  registerAllTools,
  startMcpSession,
  withMcpRequestContext,
  type IdleTrackedSession,
  type McpRequestContext,
  type McpSessionHandle,
  type Runtime,
} from '@pm/mcp-runtime'
import { resolveStartupContext } from './startup.ts'

const SERVER_INSTRUCTIONS = [
  'Persistent Memory is a mandatory project-memory system.',
  'For every non-trivial task, first call recall_context with the task query and project/repo name.',
  'recall_context returns closest memories plus graph facts, entity expansions, timeline entries, and contradictions; do not rely on search_memories alone.',
  'Use add_memory/update_memory/delete_memory immediately when the user correction or current evidence changes durable knowledge.',
].join(' ')

function createMcpServer(api: ApiClient, runtime: Runtime): McpServer {
  const server = new McpServer({
    name: 'persistent-memory-mcp-server',
    version: '1.0.0',
  }, {
    instructions: SERVER_INSTRUCTIONS,
  })
  registerAllTools(server, { api, runtime })
  return server
}

function bodyClientName(body: unknown): string | null {
  const req = Array.isArray(body) ? body.find((item) => isInitializeRequest(item)) : body
  if (!isInitializeRequest(req)) return null
  const clientInfo = req.params?.clientInfo
  if (!clientInfo?.name) return null
  return clientInfo.version ? `${clientInfo.name} ${clientInfo.version}` : clientInfo.name
}

function isInitializeBody(body: unknown): boolean {
  return Array.isArray(body) ? body.some((item) => isInitializeRequest(item)) : isInitializeRequest(body)
}

function rpcRequestSummary(body: unknown): Pick<McpRequestContext, 'mcpRpcMethod' | 'mcpToolName'> {
  const requests = Array.isArray(body) ? body : [body]
  const methods = new Set<string>()
  const toolNames = new Set<string>()
  for (const request of requests) {
    if (!request || typeof request !== 'object') continue
    const row = request as Record<string, unknown>
    if (typeof row.method === 'string') methods.add(row.method)
    const params = row.params
    if (params && typeof params === 'object') {
      const name = (params as Record<string, unknown>).name
      if (typeof name === 'string') toolNames.add(name)
    }
  }
  return {
    mcpRpcMethod: [...methods].join(', ') || undefined,
    mcpToolName: [...toolNames].join(', ') || undefined,
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  if (chunks.length === 0) return undefined
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? JSON.parse(text) : undefined
}

async function runHttp(api: ApiClient, runtime: Runtime, host: string, port: number): Promise<void> {
  interface TransportEntry extends IdleTrackedSession {
    transport: StreamableHTTPServerTransport
    server: McpServer
    session: McpSessionHandle | null
    connected: boolean
    registrySessionId: string
    transportSessionId: string
    clientName: string
  }

  const transports = new Map<string, TransportEntry>()
  const idleTimeoutSeconds = runtime.mcpSessionIdleTimeoutSeconds

  async function closeSession(sessionId: string): Promise<void> {
    const current = transports.get(sessionId)
    if (!current) return
    transports.delete(sessionId)
    await current.session?.close()
    await current.server.close()
    await current.transport.close()
  }

  async function pruneIdleSessions(nowMs = Date.now()): Promise<void> {
    await Promise.all(idleSessionIds(transports, idleTimeoutSeconds, nowMs).map((id) => closeSession(id)))
  }

  const pruneTimer = idleTimeoutSeconds > 0
    ? setInterval(() => void pruneIdleSessions(), Math.max(10_000, Math.min(60_000, Math.floor((idleTimeoutSeconds * 1000) / 4))))
    : null
  pruneTimer?.unref()

  const http = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      if (req.url === '/health' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
        return
      }
      if (req.url === '/clients' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ clients: [...transports.keys()] }))
        return
      }
      if (req.url !== '/mcp' || !['GET', 'POST', 'DELETE'].includes(req.method ?? '')) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'not_found' }))
        return
      }

      const sessionId = req.headers['mcp-session-id']?.toString()
      const existing = sessionId ? transports.get(sessionId) : undefined
      const parsedBody = req.method === 'POST' ? await readJsonBody(req) : undefined
      const clientName = bodyClientName(parsedBody) ?? 'stream-client'
      const isInit = req.method === 'POST' && isInitializeBody(parsedBody)
      const requestAt = Date.now()
      const rpcSummary = req.method === 'POST' ? rpcRequestSummary(parsedBody) : {}

      if (existing && idleSessionIds(new Map([[sessionId!, existing]]), idleTimeoutSeconds, requestAt).length > 0) {
        await closeSession(sessionId!)
        const response = missingMcpSessionResponse(true)
        res.writeHead(response.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(response.body))
        return
      }

      if (!existing && !isInit) {
        const response = missingMcpSessionResponse(Boolean(sessionId))
        res.writeHead(response.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(response.body))
        return
      }

      if (existing) existing.lastRequestAt = requestAt

      const current = existing ?? (() => {
        const pendingId = randomUUID()
        const server = createMcpServer(api, runtime)
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => pendingId,
          onsessioninitialized: (id) => {
            const entry = transports.get(pendingId)
            if (!entry) return
            transports.delete(pendingId)
            entry.transportSessionId = id
            entry.registrySessionId = `stream-${id}`
            transports.set(id, entry)
            void startMcpSession({
              api,
              id: `stream-${id}`,
              clientName,
              connectionType: 'stream',
              terminateSupported: false,
              getLastActivityAt: () => new Date(entry.lastRequestAt),
            }).then((session) => {
              const active = transports.get(id)
              if (active) active.session = session
            })
          },
          onsessionclosed: (id) => {
            void closeSession(id)
          },
        })
        const entry = {
          transport,
          server,
          session: null,
          connected: false,
          lastRequestAt: requestAt,
          registrySessionId: `stream-${pendingId}`,
          transportSessionId: pendingId,
          clientName,
        }
        transports.set(pendingId, entry)
        return entry
      })()

      if (!current.connected) {
        await current.server.connect(current.transport)
        current.connected = true
      }
      const startedAt = Date.now()
      await withMcpRequestContext({
        mcpSessionId: current.registrySessionId,
        mcpTransportSessionId: current.transportSessionId,
        mcpClientName: current.clientName,
        ...rpcSummary,
      }, async () => {
        await current.transport.handleRequest(req, res, parsedBody)
      })
      log.info('mcp request', {
        mcpSessionId: current.registrySessionId,
        mcpTransportSessionId: current.transportSessionId,
        mcpClientName: current.clientName,
        ...rpcSummary,
        method: req.method,
        path: req.url,
        status: res.statusCode,
        durationMs: Date.now() - startedAt,
      })
    })().catch((err: unknown) => {
      log.error('http transport request failed', { err: err instanceof Error ? err.message : String(err) })
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'internal_error' }))
      }
    })
  })

  const shutdown = (sig: string): void => {
    log.info('shutting down http transport', { signal: sig })
    if (pruneTimer) clearInterval(pruneTimer)
    http.close(() => {
      void Promise.all([...transports.keys()].map(closeSession)).finally(() => process.exit(0))
    })
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  http.listen(port, host, () => {
    log.info('persistent-memory-mcp listening over streamable http', {
      host,
      port,
      mode: runtime.mode,
      pinModel: runtime.pin.modelId,
      pinDim: runtime.pin.dim,
      idleTimeoutSeconds,
    })
  })
}

async function main(): Promise<void> {
  const cfg = loadConfig() // exits 1 on a missing required var
  const { api, runtime } = await resolveStartupContext(cfg) // GET /config; builds client-managed bridge(s)

  await runHttp(api, runtime, cfg.PM_MCP_HTTP_HOST, cfg.PM_MCP_HTTP_PORT)
}

main().catch((err: unknown) => {
  log.error('fatal startup error', { err: err instanceof Error ? err : String(err) })
  process.exit(1)
})
