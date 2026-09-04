import { randomUUID } from 'node:crypto'
import type { ApiClient } from './api-client.ts'
import { log } from './log.ts'
import { withoutMcpRequestContext } from './request-context.ts'

export interface McpSessionHandle {
  id: string
  close(): Promise<void>
}

export interface StartMcpSessionOptions {
  api: ApiClient
  clientName: string
  connectionType: 'stream' | 'stdio'
  terminateSupported?: boolean
  id?: string
  exitOnTerminate?: boolean
  getLastActivityAt?: () => Date
}

const HEARTBEAT_MS = 10_000

export async function startMcpSession(opts: StartMcpSessionOptions): Promise<McpSessionHandle> {
  const id = opts.id ?? `${opts.connectionType}-${randomUUID()}`
  const clientName = opts.clientName.trim() || 'unknown-client'
  let closed = false

  const register = async (): Promise<void> => {
    await withoutMcpRequestContext(() => opts.api.registerMcpSession({
      id,
      clientName,
      connectionType: opts.connectionType,
      pid: opts.connectionType === 'stdio' ? process.pid : undefined,
      terminateSupported: opts.terminateSupported ?? opts.connectionType === 'stdio',
      lastActivityAt: opts.getLastActivityAt?.().toISOString(),
    }))
  }

  await register().catch((err: unknown) => {
    log.warn('mcp session register failed', { err: err instanceof Error ? err.message : String(err) })
  })

  const beat = async (): Promise<void> => {
    if (closed) return
    try {
      const lastActivityAt = opts.getLastActivityAt?.().toISOString()
      const res = lastActivityAt
        ? await withoutMcpRequestContext(() => opts.api.heartbeatMcpSession(id, { lastActivityAt }))
        : await withoutMcpRequestContext(() => opts.api.heartbeatMcpSession(id))
      if (res.registered === false) {
        await register()
      }
      if (res.terminate && opts.exitOnTerminate) {
        log.info('mcp session terminate requested', { id, clientName })
        process.exit(0)
      }
    } catch (err) {
      log.warn('mcp session heartbeat failed', { err: err instanceof Error ? err.message : String(err) })
    }
  }

  const timer = setInterval(() => void beat(), HEARTBEAT_MS)
  timer.unref()

  return {
    id,
    async close() {
      if (closed) return
      closed = true
      clearInterval(timer)
      await withoutMcpRequestContext(() => opts.api.closeMcpSession(id)).catch((err: unknown) => {
        log.warn('mcp session close failed', { err: err instanceof Error ? err.message : String(err) })
      })
    },
  }
}
