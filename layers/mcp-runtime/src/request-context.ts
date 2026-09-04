import { AsyncLocalStorage } from 'node:async_hooks'

export interface McpRequestContext {
  mcpSessionId?: string
  mcpTransportSessionId?: string
  mcpClientName?: string
  mcpRpcMethod?: string
  mcpToolName?: string
}

const storage = new AsyncLocalStorage<McpRequestContext>()

export function currentMcpRequestContext(): McpRequestContext | undefined {
  return storage.getStore()
}

export function withMcpRequestContext<T>(ctx: McpRequestContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(ctx, fn)
}

export function withoutMcpRequestContext<T>(fn: () => Promise<T>): Promise<T> {
  return storage.run({}, fn)
}
