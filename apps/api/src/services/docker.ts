/**
 * persistent-memory-api — client for the local service monitor.
 *
 * The api holds NO Docker socket. It calls the `docker-control` sidecar (the only
 * container with the socket) over the internal compose network, presenting the
 * shared-secret bearer (DOCKER_CONTROL_TOKEN). The sidecar enforces the verb
 * boundary + project scope; the /dashboard/services routes enforce RBAC (read =
 * any authenticated user, mutate = superuser). Any failure (no token, unreachable, non-2xx) →
 * DockerUnavailableError → 503, and the UI degrades gracefully.
 *
 * The host Ollama reachability row is a plain fetch (no socket, no sidecar).
 * Service UI links and optional login credentials are API-side metadata; the
 * socket-holding sidecar never sees or returns credentials.
 */
import { config } from '../config.ts'
import { modelDependencyHealth, type ModelDependencyProvider } from './model-dependency-health.ts'

export interface ServiceInfo {
  service: string
  name: string
  id: string
  state: string
  status: string
  health: 'healthy' | 'unhealthy' | 'starting' | null
  controllable: boolean
  /** Logical/non-container capabilities never expose a Docker log action. */
  logsAvailable?: boolean
  configuredModel?: string
  configuredModelState?: 'present' | 'missing' | 'not_configured'
  mcpSession?: boolean
  ui?: ServiceUi
  credentials?: ServiceCredential[]
}

export interface ServiceUi {
  label: string
  url: string
}

export interface ServiceCredential {
  label: string
  value: string
}

export type ServiceAction = 'start' | 'stop' | 'restart'
export interface ListServicesOptions {
  includeCredentials?: boolean
}

export class DockerUnavailableError extends Error {
  readonly statusCode = 503 as const
  readonly code = 'docker_unavailable' as const
  constructor(message: string) {
    super(message)
    this.name = 'DockerUnavailableError'
  }
}

const SERVICE_UI: Record<string, ServiceUi> = {
  qdrant: { label: 'Dashboard', url: 'http://localhost:7333/dashboard' },
  falkordb: { label: 'Browser', url: 'http://localhost:3100' },
  neo4j: { label: 'Browser', url: 'http://localhost:7475/browser' },
  minio: { label: 'Console', url: 'http://localhost:9003' },
  graphiti: { label: 'Docs', url: 'http://localhost:8100/docs' },
}

function parseNeo4jCredentials(): ServiceCredential[] | undefined {
  const raw = process.env.NEO4J_AUTH ?? 'neo4j/persistentmemory'
  if (raw.toLowerCase() === 'none') return undefined
  const slash = raw.indexOf('/')
  if (slash <= 0 || slash === raw.length - 1) return undefined
  return [
    { label: 'User', value: raw.slice(0, slash) },
    { label: 'Password', value: raw.slice(slash + 1) },
  ]
}

function serviceCredentials(service: string): ServiceCredential[] | undefined {
  if (service === 'qdrant' && config.QDRANT_API_KEY) {
    return [{ label: 'API key', value: config.QDRANT_API_KEY }]
  }
  if (service === 'falkordb' && config.FALKORDB_PASSWORD) {
    return [
      { label: 'User', value: 'default' },
      { label: 'Password', value: config.FALKORDB_PASSWORD },
    ]
  }
  if (service === 'minio') {
    return [
      { label: 'User', value: config.MINIO_ROOT_USER },
      { label: 'Password', value: config.MINIO_ROOT_PASSWORD },
    ]
  }
  if (service === 'neo4j') return parseNeo4jCredentials()
  return undefined
}

function enrichServiceInfo(row: ServiceInfo, options: ListServicesOptions): ServiceInfo {
  const enriched: ServiceInfo = { ...row }
  const ui = SERVICE_UI[row.service]
  if (ui) enriched.ui = ui
  if (options.includeCredentials) {
    const credentials = serviceCredentials(row.service)
    if (credentials && credentials.length > 0) enriched.credentials = credentials
  }
  return enriched
}

/** One call to the docker-control sidecar. Maps every failure → DockerUnavailableError. */
async function call(method: string, path: string): Promise<unknown> {
  if (!config.DOCKER_CONTROL_TOKEN) {
    throw new DockerUnavailableError('Service control disabled — DOCKER_CONTROL_TOKEN is not set.')
  }
  let res: Response
  try {
    res = await fetch(`${config.DOCKER_CONTROL_URL}${path}`, {
      method,
      headers: { authorization: `Bearer ${config.DOCKER_CONTROL_TOKEN}` },
      signal: AbortSignal.timeout(15_000),
    })
  } catch (err) {
    throw new DockerUnavailableError(
      `docker-control unreachable: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  if (!res.ok) {
    throw new DockerUnavailableError(`docker-control returned ${res.status}.`)
  }
  return res.json()
}

export async function listServices(options: ListServicesOptions = {}): Promise<ServiceInfo[]> {
  const body = (await call('GET', '/services')) as { services: ServiceInfo[] }
  return body.services.map((service) => enrichServiceInfo(service, options))
}

export async function serviceLogs(service: string, tail = 200): Promise<string> {
  const body = (await call('GET', `/services/${encodeURIComponent(service)}/logs?tail=${tail}`)) as {
    logs: string
  }
  return body.logs
}

export async function actOnService(service: string, action: ServiceAction): Promise<{ ok: boolean }> {
  return (await call('POST', `/services/${encodeURIComponent(service)}/${action}`)) as { ok: boolean }
}

export async function terminateMcpService(service: string): Promise<{ ok: boolean }> {
  return (await call('POST', `/services/${encodeURIComponent(service)}/terminate`)) as { ok: boolean }
}

type OllamaProbeTarget = { model?: string; provider?: ModelDependencyProvider }

function sameOllamaModel(left: string, right: string): boolean {
  return left.replace(/:latest$/, '') === right.replace(/:latest$/, '')
}

async function recordOllamaSuccess(model?: string): Promise<void> {
  try {
    await modelDependencyHealth.recordSuccess({
      capability: 'ollama_host',
      observerScope: 'host',
      ...(model ? { provider: 'ollama', model } : {}),
      observedAt: new Date(),
    })
  } catch {
    // The host probe stays useful if diagnostic telemetry cannot persist.
  }
}

async function recordOllamaFailure(
  code: 'ollama_host_unavailable' | 'ollama_model_unavailable',
  model?: string,
): Promise<void> {
  try {
    await modelDependencyHealth.recordFailure({
      capability: 'ollama_host',
      observerScope: 'host',
      ...(model ? { provider: 'ollama', model } : {}),
      failure: { code, state: 'unhealthy' },
      observedAt: new Date(),
    })
  } catch {
    // An unavailable health table must not mask the real host state.
  }
}

/**
 * Host Ollama probe (it is NOT a container). `/api/tags` proves reachability and,
 * when the active embedding provider is Ollama, proves the configured model is
 * actually present. It always states that no Docker logs exist for this host row.
 */
export async function ollamaInfo(target: OllamaProbeTarget = {}): Promise<ServiceInfo> {
  const configuredModel = target.provider === 'ollama' ? target.model : undefined
  const base: ServiceInfo = {
    service: 'ollama (host)',
    name: 'host Ollama',
    id: '',
    state: 'unknown',
    status: 'host-managed',
    health: null,
    controllable: false,
    logsAvailable: false,
    ...(configuredModel ? { configuredModel } : { configuredModelState: 'not_configured' }),
  }
  try {
    const r = await fetch(`${config.OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) })
    if (!r.ok) {
      await recordOllamaFailure('ollama_host_unavailable', configuredModel)
      return { ...base, state: 'unreachable', health: 'unhealthy' }
    }
    const body = await r.json().catch(() => null) as unknown
    if (!body || typeof body !== 'object' || !Array.isArray((body as { models?: unknown }).models)) {
      await recordOllamaFailure('ollama_host_unavailable', configuredModel)
      return { ...base, state: 'unreachable', health: 'unhealthy' }
    }
    const names = ((body as { models: Array<{ name?: string; model?: string }> }).models)
      .flatMap((entry) => [entry.name, entry.model])
      .filter((name): name is string => typeof name === 'string')
    const modelPresent = !configuredModel || names.some((name) => sameOllamaModel(name, configuredModel))
    if (!modelPresent) {
      await recordOllamaFailure('ollama_model_unavailable', configuredModel)
      return {
        ...base,
        state: 'reachable',
        status: 'configured model missing',
        health: 'unhealthy',
        configuredModelState: 'missing',
      }
    }
    await recordOllamaSuccess(configuredModel)
    return {
      ...base,
      state: 'reachable',
      health: 'healthy',
      ...(configuredModel ? { configuredModelState: 'present' } : {}),
    }
  } catch {
    await recordOllamaFailure('ollama_host_unavailable', configuredModel)
    return { ...base, state: 'unreachable', health: 'unhealthy' }
  }
}
