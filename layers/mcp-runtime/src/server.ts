/** Registers all 25 tools onto the McpServer. */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ToolCtx } from './tools/context.ts'
import { registerIdentityTools } from './tools/identity.ts'
import { registerMemoryTools } from './tools/memories.ts'
import { registerGraphTools } from './tools/graph.ts'
import { registerDocumentTools } from './tools/documents.ts'
import { registerInvestigationTools } from './tools/investigations.ts'

export function registerAllTools(server: McpServer, ctx: ToolCtx): void {
  registerIdentityTools(server, ctx) // whoami, list_readable_teams, list_projects
  registerMemoryTools(server, ctx) // recall/add/search/.../list_entities (10)
  registerGraphTools(server, ctx) // search_graph/get_entity/get_timeline/get_contradictions (4)
  registerDocumentTools(server, ctx) // ingest/status/search/get (4)
  registerInvestigationTools(server, ctx) // create/get/link (3)
}
