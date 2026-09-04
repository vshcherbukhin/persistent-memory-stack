/** Shared dependency bundle handed to every tool registrar. */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ApiClient } from '../api-client.ts'
import type { Runtime } from '../runtime.ts'

export interface ToolCtx {
  api: ApiClient
  runtime: Runtime
}

export type RegisterFn = (server: McpServer, ctx: ToolCtx) => void
