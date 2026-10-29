/** Community startup has one personal API; retired connector settings are inert. */
import { ApiClient, requireTokenForServerMode, resolveRuntime, type McpConfig, type Runtime } from '@pm/mcp-runtime'
export interface StartupContext { api: ApiClient; runtime: Runtime }
export async function resolveStartupContext(cfg: McpConfig): Promise<StartupContext> {
  if (cfg.PM_MEMORY_INSTALL_MODE === 'shared-only') throw new Error('Shared-only operation is retired. Configure the local personal stack and its loopback API before restarting this MCP.')
  const apiUrl = cfg.PM_PERSONAL_API_URL ?? cfg.API_URL
  const endpoint = new URL(apiUrl)
  const prefix = typeof cfg.PM_CONTAINER_PREFIX === 'string' ? cfg.PM_CONTAINER_PREFIX : 'persistent-memory'
  const localHosts = ['localhost', '127.0.0.1', '[::1]', 'host.docker.internal', `${prefix}-api`]
  if (!localHosts.includes(endpoint.hostname) || endpoint.username || endpoint.password) throw new Error('Community MCP requires the local personal API (loopback or the configured local Docker API service). Retired remote/shared endpoints are never contacted.')
  const api = new ApiClient({ ...cfg, API_URL: apiUrl,
    PM_USER_TOKEN: cfg.PM_PERSONAL_USER_TOKEN ?? cfg.PM_USER_TOKEN })
  const runtime = await resolveRuntime(api, cfg)
  if (runtime.deploymentMode !== 'local') requireTokenForServerMode({ ...cfg, PM_USER_TOKEN: cfg.PM_PERSONAL_USER_TOKEN ?? cfg.PM_USER_TOKEN })
  return { api, runtime }
}
