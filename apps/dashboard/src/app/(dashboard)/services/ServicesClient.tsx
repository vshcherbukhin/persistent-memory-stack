'use client'

/**
 * The interactive Services monitor. Lists the stack's containers (state + health),
 * lets a superuser start/stop stack services, and tails service/session logs on demand.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import type { DashboardCapabilityHealth, McpClientStatus, ServiceStatus } from '@/lib/types'
import { filterMcpServiceLogs, filterMcpSessionLogs } from '@/lib/logFormat'
import { LogOutput } from '@/components/LogOutput'
import { Icon } from '@/components/ui/Icon'
import { Modal } from '@/components/ui/Modal'
import { StatusToggle } from '@/components/ui/StatusToggle'
import { Tooltip } from '@/components/ui/Tooltip'
import { formatMcpTerminateCountdown, formatMcpTerminateTime, formatSeenAgo } from '@/lib/mcpSessionFormat'
import { serviceIsActive, serviceStatusKind, type ServiceStatusKind } from '@/lib/serviceStatus'
import { listServicesAction, serviceLogsAction, serviceControlAction } from './actions'

type LogTarget = {
  ref: string
  title: string
  mode: 'raw' | 'mcp-service' | 'mcp-session'
  sessionId?: string
}

type PendingServiceControl = {
  action: 'start' | 'stop'
  dependents: ServiceStatus[]
  extraWarnings: string[]
  service: ServiceStatus
}

const SERVICE_DEPENDENCIES: Record<string, string[]> = {
  graphiti: ['falkordb'],
  api: ['postgres', 'qdrant', 'redis', 'minio', 'graphiti', 'dlp', 'docker-control'],
  worker: ['postgres', 'qdrant', 'redis', 'minio', 'graphiti', 'dlp'],
  mcp: ['api'],
  dashboard: ['api', 'documentation'],
  documentation: [],
  'dashboard-gateway': ['dashboard'],
  'update-runner': ['postgres', 'qdrant', 'redis', 'minio'],
}

const SERVICE_IMPACT_COPY: Record<string, string> = {
  dashboard: 'The dashboard application is served by this service.',
  documentation: 'The embedded PM Management documentation is served by this service.',
  api: 'Dashboard actions, MCP requests, memory operations, settings, and service controls call the API.',
  dlp: 'Memory writes and scheduled security scans depend on DLP checks.',
  'docker-control': 'The Services page uses this sidecar for service list, logs, start, and stop actions.',
  falkordb: 'Graphiti graph storage and memory graph features depend on FalkorDB.',
  graphiti: 'Memory graph sync, graph rebuilds, and graph queries depend on Graphiti.',
  mcp: 'Connected agents use the stream MCP service for memory tools.',
  minio: 'Document and evidence storage depend on MinIO.',
  postgres: 'Users, memories, settings, workers, and control-plane state depend on Postgres.',
  qdrant: 'Vector search and embedding storage depend on Qdrant.',
  redis: 'Queues, worker liveness, scheduled jobs, and cache-backed flows depend on Redis.',
  'update-runner': 'Dashboard update checks and update execution depend on this sidecar.',
  worker: 'Document ingestion, embedding backfill, graph repair, and scheduled jobs depend on the worker.',
}

const SELF_STOP_WARNINGS: Record<string, string[]> = {
  api: [
    'Stopping the API interrupts dashboard server actions, MCP calls, and service controls until it is started again.',
  ],
  dashboard: [
    'Stopping dashboard takes down the management UI. If it stays stopped, you may need the terminal to start it again.',
  ],
  documentation: [
    'Stopping documentation makes the stack documentation site unavailable until the service is started again.',
  ],
  'dashboard-gateway': [
    'Stopping dashboard-gateway removes the 127.0.0.1:3200 dashboard entrypoint until it is started again.',
  ],
  'docker-control': [
    'Stopping docker-control disables this Services page control path, including the ability to start docker-control back from the dashboard.',
  ],
}

const MODEL_CAPABILITY_SERVICE_IDS = new Set(['fact-extraction', 'embeddings'])
// Prototype d-services lists the stores (and the control sidecar) apart from application containers.
const DATA_SERVICE_IDS = new Set(['postgres', 'qdrant', 'redis', 'minio', 'falkordb', 'neo4j', 'docker-control'])

/** Row dot tone — colour is repeated by the status badge, so it never carries meaning alone. */
function statusDotTone(kind: ServiceStatusKind): 'ok' | 'warn' | 'bad' | 'idle' {
  const value: string = kind
  if (value === 'running' || value === 'healthy') return 'ok'
  if (value === 'stopped' || value === 'starting') return 'warn'
  if (value === 'error') return 'bad'
  return 'idle'
}

function isModelCapabilityService(service: ServiceStatus): boolean {
  return MODEL_CAPABILITY_SERVICE_IDS.has(service.service)
}

function serviceStatusDescription(service: ServiceStatus): string | null {
  if (service.service === 'fact-extraction') {
    return 'Status updates after the latest request or a manual Fact extraction test in System Settings.'
  }
  if (service.service === 'embeddings') {
    return 'Status updates after the latest embedding request, backfill, or a manual Embeddings test in System Settings.'
  }
  if (service.service === 'ollama (host)') {
    return 'Host reachability is checked by the Ollama probe. Docker logs are not available.'
  }
  return null
}

function prepareLogs(raw: string, target: LogTarget): string {
  if (target.mode === 'mcp-service') return filterMcpServiceLogs(raw)
  if (target.mode === 'mcp-session') return filterMcpSessionLogs(raw, target.sessionId ?? '')
  return raw
}

export function ServicesClient({
  initial,
  initialClients,
  initialCapabilityHealth,
  initialError,
  canControl,
  canViewCredentials,
}: {
  initial: ServiceStatus[]
  initialClients: McpClientStatus[]
  initialCapabilityHealth?: DashboardCapabilityHealth
  initialError?: string
  canControl: boolean
  canViewCredentials: boolean
}) {
  const [services, setServices] = useState<ServiceStatus[]>(initial)
  const [mcpClients, setMcpClients] = useState<McpClientStatus[]>(initialClients)
  const [capabilityHealth, setCapabilityHealth] = useState<DashboardCapabilityHealth | undefined>(initialCapabilityHealth)
  const [error, setError] = useState<string | null>(initialError ?? null)
  const [busy, setBusy] = useState<string | null>(null) // "service:action" in flight
  const busyRef = useRef<string | null>(null)
  const [logsFor, setLogsFor] = useState<LogTarget | null>(null)
  const [logs, setLogs] = useState<string>('')
  const [credentialsFor, setCredentialsFor] = useState<ServiceStatus | null>(null)
  const [pendingControl, setPendingControl] = useState<PendingServiceControl | null>(null)
  const [copiedCredential, setCopiedCredential] = useState<string | null>(null)
  const [nowMs, setNowMs] = useState(Date.now())
  const inFlight = useRef(false)
  const pathname = usePathname()
  const router = useRouter()
  const searchParams = useSearchParams()
  const activeTab: 'application' | 'mcp' = searchParams.get('tab') === 'mcp' ? 'mcp' : 'application'

  const selectServiceTab = (tab: 'application' | 'mcp') => {
    const params = new URLSearchParams(searchParams.toString())
    if (tab === 'application') params.delete('tab')
    else params.set('tab', tab)
    const query = params.toString()
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
  }

  const setBusyState = (key: string | null) => {
    busyRef.current = key
    setBusy(key)
  }

  const refresh = useCallback(async (force = false) => {
    if (!force && busyRef.current) return
    if (inFlight.current) return
    inFlight.current = true
    try {
      const r = await listServicesAction()
      setServices(r.services)
      setMcpClients(r.mcpClients)
      setCapabilityHealth(r.capabilityHealth)
      setError(r.error ?? null)
    } finally {
      inFlight.current = false
    }
  }, [])

  useEffect(() => {
    const id = window.setInterval(() => void refresh(), 10_000)
    return () => window.clearInterval(id)
  }, [refresh])

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1_000)
    return () => window.clearInterval(id)
  }, [])

  const control = async (service: ServiceStatus, action: 'start' | 'stop' | 'restart') => {
    setBusyState(`${service.service}:${action}`)
    setError(null)
    const r = await serviceControlAction(service.service, action)
    if (r.error) {
      setError(r.error)
      setBusyState(null)
      return
    }
    await new Promise((resolve) => window.setTimeout(resolve, 800))
    await refresh(true)
    setBusyState(null)
  }

  const dependentsFor = (service: ServiceStatus): ServiceStatus[] => {
    return stackServices.filter((candidate) => (SERVICE_DEPENDENCIES[candidate.service] ?? []).includes(service.service))
  }

  const dependencyWarningsFor = (service: ServiceStatus): string[] => {
    const byService = new Map(stackServices.map((row) => [row.service, row]))
    return (SERVICE_DEPENDENCIES[service.service] ?? [])
      .map((dependency) => byService.get(dependency))
      .filter((dependency): dependency is ServiceStatus => dependency != null && serviceStatusKind(dependency) !== 'running')
      .map((dependency) => (
        `${service.service} may not function correctly because ${dependency.service} is ${serviceStatusKind(dependency)} (${formatServiceDetail(dependency)}).`
      ))
  }

  const serviceStopWarnings = (service: ServiceStatus): string[] => SELF_STOP_WARNINGS[service.service] ?? []

  const requestControl = (service: ServiceStatus, action: 'start' | 'stop' | 'restart') => {
    if (action === 'stop') {
      const dependents = dependentsFor(service)
      const extraWarnings = serviceStopWarnings(service)
      if (dependents.length > 0 || extraWarnings.length > 0) {
        setPendingControl({ action, dependents, extraWarnings, service })
        return
      }
    }
    void control(service, action)
  }

  const loadLogs = useCallback(async (target: LogTarget) => {
    const r = await serviceLogsAction(target.ref, 300)
    const raw = r.error ? `Error: ${r.error}` : r.logs
    setLogs(prepareLogs(raw, target) || (target.mode === 'mcp-session' ? 'No session communication yet.' : '(no output)'))
  }, [])

  useEffect(() => {
    if (!logsFor) return
    const id = window.setInterval(() => void loadLogs(logsFor), 4_000)
    return () => window.clearInterval(id)
  }, [logsFor, loadLogs])

  const showLogs = async (target: LogTarget) => {
    setLogsFor(target)
    setLogs('Loading…')
    await loadLogs(target)
  }

  const formatServiceDetail = (s: ServiceStatus): string => {
    if (isModelCapabilityService(s)) {
      return s.configuredModel ? `Selected model · ${s.configuredModel}` : 'Selected model unavailable'
    }
    const cleaned = (s.status || s.state)
      .replace(/\s*\(not a container\)\s*/gi, ' ')
      .replace(/\s*\((?:healthy|unhealthy|health:\s*starting)\)\s*/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    const modelDiagnostic = s.service === 'ollama (host)' ? '' : s.configuredModel
      ? ` · ${s.configuredModel}${s.configuredModelState ? ` (${s.configuredModelState})` : ''}`
      : ''
    return `${cleaned || s.state}${modelDiagnostic}`
  }

  const publicHref = (url: string): string => {
    try {
      const u = new URL(url)
      if (typeof window !== 'undefined' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) {
        u.hostname = window.location.hostname
      }
      return u.toString()
    } catch {
      return url
    }
  }

  const isMcpService = (s: ServiceStatus) => s.mcpSession === true
  const serviceLabel = (s: ServiceStatus): string => {
    if (s.service === 'fact-extraction') return 'Fact extraction'
    if (s.service === 'embeddings') return 'Embeddings'
    return s.service
  }
  const mcpServices = services.filter(isMcpService)
  const modelCapabilityServices = services.filter(isModelCapabilityService)
  const stackServices = services.filter((s) => !isMcpService(s) && !isModelCapabilityService(s))
  const streamMcpService = stackServices.find((s) => s.service === 'mcp' && s.id)
  const mcpClientLogRef = (client: McpClientStatus): string | null => {
    if (client.connectionType === 'stream') return streamMcpService?.id ?? null
    return null
  }
  const applicationServices = stackServices.filter((s) => !DATA_SERVICE_IDS.has(s.service))
  const dataServices = stackServices.filter((s) => DATA_SERVICE_IDS.has(s.service))
  const runningCount = stackServices.filter((s) => serviceIsActive(s)).length

  // The 503/degraded notice is driven from the existing error state.
  const degraded = error != null && /docker_unavailable|socket|docker_control|503/i.test(error)

  const isSecretCredential = (label: string) => /password|secret|token|key/i.test(label)
  const copyCredential = async (label: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopiedCredential(label)
      setTimeout(() => setCopiedCredential((current) => (current === label ? null : current)), 1600)
    } catch {
      setCopiedCredential(null)
    }
  }

  // Prototype d-services: Service · Status · Details · Actions.
  const cols = 'minmax(0, 1.1fr) 188px minmax(0, 1.4fr) 196px'
  const modelCapabilityCols = 'minmax(210px, 1fr) 140px minmax(245px, 1fr) minmax(300px, 1.5fr)'
  const renderServiceTable = (
    rows: ServiceStatus[],
    emptyText: string,
    { activityColumnLabel = 'Actions', columns = cols }: { activityColumnLabel?: string; columns?: string } = {},
  ) => (
    <div className="gt table-scroll">
      <div className="gt-head" style={{ gridTemplateColumns: columns }}>
        <div>Service</div>
        <div>Status</div>
        <div>Details</div>
        <div className={activityColumnLabel === 'Actions' ? 'gt-head-actions' : undefined}>{activityColumnLabel}</div>
      </div>
      <div className="gt-scroll-body">
        {rows.map((s) => {
          const controllable = canControl && s.id !== '' && s.controllable
          const hasCredentials = canViewCredentials && !!s.credentials?.length
          const statusKind = serviceStatusKind(s)
          const active = serviceIsActive(s)
          const toggleAction: 'start' | 'stop' = active ? 'stop' : 'start'
          const toggleBusy = busy === `${s.service}:start` || busy === `${s.service}:stop`
          const dependencyWarnings = dependencyWarningsFor(s)
          const logsUnavailable = s.logsAvailable === false || !s.id
          const statusDescription = serviceStatusDescription(s)
          return (
            <div className="gt-row" key={`${s.service}:${s.id || s.name}`} style={{ gridTemplateColumns: columns }}>
              <div className="service-cell">
                <i className={`dot ${statusDotTone(statusKind)}`} aria-hidden="true" />
                <div className="service-cell-text">
                  <div className="service-title-row">
                    <div style={{ minWidth: 0 }}>
                      {s.ui ? (
                        <Tooltip label={`Open ${s.ui.label}`}>
                          <a className="svc-name-link cell-strong" href={publicHref(s.ui.url)} target="_blank" rel="noreferrer">
                            {s.service}
                          </a>
                        </Tooltip>
                      ) : (
                        <span className="cell-strong">{serviceLabel(s)}</span>
                      )}
                    </div>
                    <div className="service-title-actions">
                      {dependencyWarnings.length > 0 ? (
                        <Tooltip label={dependencyWarnings.join(' ')}>
                          <span className="service-impact-indicator" tabIndex={0} aria-label={dependencyWarnings.join(' ')}>
                            <Icon name="priority_high" size={16} />
                          </span>
                        </Tooltip>
                      ) : null}
                      {hasCredentials ? (
                        <Tooltip label="Show credentials">
                          <button
                            type="button"
                            className="svc-credential-button"
                            aria-label={`Show ${s.service} credentials`}
                            onClick={() => {
                              setCopiedCredential(null)
                              setCredentialsFor(s)
                            }}
                          >
                            <Icon name="key" size={15} />
                          </button>
                        </Tooltip>
                      ) : null}
                    </div>
                  </div>
                  <div className="cell-mono service-image">{s.name}</div>
                </div>
              </div>
              <div>
                <div className="service-status-cell">
                  <div>
                    {toggleBusy ? (
                      <span className="worker-status-progress" aria-label={`${toggleAction === 'stop' ? 'Stopping' : 'Starting'} ${s.service}`}>
                        <span />
                      </span>
                    ) : (
                      <span className={`worker-status-badge ${statusKind}`}>
                        {statusKind}
                      </span>
                    )}
                  </div>
                  {controllable ? (
                    <>
                      <span className="status-toggle-dot" aria-hidden="true" />
                      <Tooltip label={`${toggleAction === 'stop' ? 'Stop' : 'Start'} ${s.service}`}>
                        <StatusToggle
                          checked={active}
                          ariaLabel={`${toggleAction === 'stop' ? 'Stop' : 'Start'} ${s.service}`}
                          disabled={busy !== null}
                          onClick={() => requestControl(s, toggleAction)}
                        />
                      </Tooltip>
                    </>
                  ) : null}
                </div>
              </div>
              <div className="service-runtime-detail">
                <div>{formatServiceDetail(s)}</div>
                {!s.controllable ? <div>read-only</div> : null}
              </div>
              <div>
                {statusDescription && activityColumnLabel !== 'Actions' ? (
                  <div className="service-status-description">{statusDescription}</div>
                ) : (
                  <div className="row-actions">
                    {controllable && active ? (
                      <button
                        type="button"
                        className="btn sm secondary"
                        aria-label={`Restart ${s.service}`}
                        disabled={busy !== null}
                        onClick={() => requestControl(s, 'restart')}
                      >
                        <Icon name={busy === `${s.service}:restart` ? 'hourglass_top' : 'refresh'} size={12} /> Restart
                      </button>
                    ) : null}
                    {logsUnavailable ? (
                      <Tooltip label={statusDescription ?? 'This row has no container logs.'}>
                        <span className="service-log-unavailable" tabIndex={0}>{s.id ? 'Logs unavailable' : 'Host-managed'}</span>
                      </Tooltip>
                    ) : (
                      <button
                        type="button"
                        className="btn sm ghost service-log-cell"
                        onClick={() => void showLogs({
                          ref: s.id,
                          title: `${serviceLabel(s)} · ${s.name}`,
                          mode: s.service === 'mcp' ? 'mcp-service' : 'raw',
                        })}
                      >
                        <Icon name="terminal" size={12} /> Logs
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          )
        })}
        {rows.length === 0 && !error ? <div className="gt-empty">{emptyText}</div> : null}
      </div>
    </div>
  )

  // Prototype d-services-mcp: who is connected, how, and when the session ends.
  const mcpCols = 'minmax(0, 1fr) 190px 130px 170px 110px'
  const renderMcpClients = () => (
    <div className="gt table-scroll mcp-sessions-table">
      <div className="gt-head" style={{ gridTemplateColumns: mcpCols }}>
        <div>Client</div>
        <div>Connection</div>
        <div>Last seen</div>
        <div>Terminates at</div>
        <div>Logs</div>
      </div>
      <div className="gt-scroll-body">
        {mcpClients.map((client) => {
          const logRef = mcpClientLogRef(client)
          return (
            <div className="gt-row" key={client.id} style={{ gridTemplateColumns: mcpCols }}>
              <div className="service-cell">
                <i className={`dot ${client.connectionType === 'stream' ? 'ok live' : 'warn'}`} aria-hidden="true" />
                <div className="service-cell-text">
                  <span className="cell-strong">{client.clientName}</span>
                  <span className="cell-mono service-image">{client.id}</span>
                </div>
              </div>
              <div className="cell-mono mcp-connection-cell">
                {client.connectionType === 'stream' ? 'streamable-http' : 'legacy local stdio'}
              </div>
              <div className="mcp-time-cell cell-mono">{formatSeenAgo(client.lastSeenAt, nowMs)}</div>
              <div className="mcp-time-cell">
                <div className="cell-mono">{formatMcpTerminateCountdown(client.terminatesAt, nowMs)}</div>
                {client.terminatesAt ? (
                  <div className="note">{formatMcpTerminateTime(client.terminatesAt)}</div>
                ) : null}
              </div>
              <div className="row-actions">
                <button
                  type="button"
                  className="btn sm ghost service-log-cell"
                  disabled={!logRef}
                  onClick={() => logRef ? void showLogs({
                    ref: logRef,
                    title: `${client.clientName} · MCP session`,
                    mode: 'mcp-session',
                    sessionId: client.id,
                  }) : undefined}
                >
                  <Icon name="terminal" size={12} /> View
                </button>
              </div>
            </div>
          )
        })}

        {mcpServices.map((s) => (
          <div className="gt-row" key={`${s.service}:${s.id || s.name}`} style={{ gridTemplateColumns: mcpCols }}>
            <div className="service-cell">
              <i className="dot warn" aria-hidden="true" />
              <div className="service-cell-text">
                <span className="cell-strong">{s.service}</span>
                <span className="cell-mono service-image">{s.name}</span>
              </div>
            </div>
            <div className="cell-mono mcp-connection-cell">legacy docker stdio</div>
            <div className="mcp-time-cell cell-mono">{formatServiceDetail(s)}</div>
            <div className="mcp-time-cell cell-mono">not managed</div>
            <div className="row-actions">
              <button
                type="button"
                className="btn sm ghost service-log-cell"
                disabled={!s.id}
                onClick={() => void showLogs({ ref: s.id, title: `${s.service} · ${s.name}`, mode: 'raw' })}
              >
                <Icon name="terminal" size={12} /> View
              </button>
            </div>
          </div>
        ))}

        {mcpClients.length === 0 && mcpServices.length === 0 && !error ? <div className="gt-empty">No MCP clients connected.</div> : null}
      </div>
    </div>
  )

  const logSubject = logsFor ? services.find((s) => s.id === logsFor.ref) ?? null : null
  const logStatusKind = logSubject ? serviceStatusKind(logSubject) : 'running'
  const serviceViewSwitcher = (
    <div className="service-view-switcher" role="tablist" aria-label="Services views">
      <button
        type="button"
        role="tab"
        aria-selected={activeTab === 'application'}
        className={`service-view-button${activeTab === 'application' ? ' active' : ''}`}
        onClick={() => selectServiceTab('application')}
      >
        <Icon name="dns" size={15} /> Services
      </button>
      <span className="service-view-separator" aria-hidden="true" />
      <button
        type="button"
        role="tab"
        aria-selected={activeTab === 'mcp'}
        className={`service-view-button${activeTab === 'mcp' ? ' active' : ''}`}
        onClick={() => selectServiceTab('mcp')}
      >
        <Icon name="hub" size={15} /> MCP sessions
      </button>
    </div>
  )

  return (
    <div className="page-fill services-page">
      {/* Prototype d-services: the view switch leads a flush toolbar; tables sit in their own inset. */}
      <div className="memory-toolbar services-toolbar">
        {serviceViewSwitcher}
        <span className="memory-toolbar-note">
          {activeTab === 'application'
            ? `${runningCount} of ${stackServices.length} running${canControl ? '' : ' · start and stop are superuser-only'}`
            : `${mcpClients.length + mcpServices.length} active client${mcpClients.length + mcpServices.length === 1 ? '' : 's'}`}
        </span>
      </div>
      <div className="services-body">
        {error ? (
          degraded ? (
            <div className="notice with-icon fault" role="alert">
              <span className="n-ic"><Icon name="error_outline" size={16} /></span>
              <span className="n-body">
                <span className="notice-title">Docker control sidecar unavailable</span>
                The <code className="code-inline">docker-control</code> sidecar is not answering, so service state cannot be read
                and start/stop actions are disabled. The services themselves keep running — state below is <b>unknown</b>, not stopped.
                <span className="notice-detail">
                  Check the Docker socket is mounted and <code className="code-inline">DOCKER_CONTROL_TOKEN</code> is set (on native Linux,
                  set <code className="code-inline">DOCKER_GID</code> to the host docker-group gid), then try{' '}
                  <code className="code-inline">npm run start-persistent-memory</code> from the repository directory.
                </span>
                <span className="notice-detail mono">{error}</span>
              </span>
            </div>
          ) : (
            <div className="notice with-icon danger" role="alert">
              <span className="n-ic"><Icon name="error_outline" size={16} /></span>
              <span className="n-body">{error}</span>
            </div>
          )
        ) : null}

        {activeTab === 'application' ? (
          <div className="services-section-stack" role="tabpanel">
            <section className="services-section">
              <div className="section-label">Application services</div>
              {renderServiceTable(applicationServices, 'No application services found.')}
            </section>
            <section className="services-section">
              <div className="section-label">Data services</div>
              {renderServiceTable(dataServices, 'No data services found.')}
            </section>
            <section className="services-section services-section-capabilities" aria-label="Model capabilities">
              <div className="section-label">Model capabilities</div>
              {renderServiceTable(modelCapabilityServices, 'No model capabilities found.', { activityColumnLabel: 'Status updates', columns: modelCapabilityCols })}
            </section>
          </div>
        ) : (
          <section className="services-section" role="tabpanel">
            <div className="notice with-icon accent">
              <span className="n-ic"><Icon name="info" size={16} /></span>
              <span className="n-body">
                Stream MCP is the only runtime. Idle sessions end automatically after the timeout set in System Settings; each row
                shows when its session will close.
              </span>
            </div>
            {renderMcpClients()}
          </section>
        )}

        {degraded ? (
          <div className="btn-row">
            <button type="button" className="btn primary" disabled={busy !== null} onClick={() => void refresh(true)}>
              <Icon name="refresh" size={15} /> Retry connection
            </button>
          </div>
        ) : null}
      </div>

      {logsFor ? (
        <Modal
          title={`Logs — ${logsFor.title}`}
          onClose={() => setLogsFor(null)}
          width={780}
          className="worker-log-modal service-log-modal"
          bodyClassName="worker-log-modal-body"
        >
          <div className="worker-log-live-row">
            <span className={`worker-status-badge ${logStatusKind}`}>{logStatusKind}</span>
            <span>{logSubject ? formatServiceDetail(logSubject) : 'live container logs'}</span>
          </div>
          <LogOutput text={logs} variant="terminal" showTimeToggle />
        </Modal>
      ) : null}

      {pendingControl ? (
        <Modal
          title={`Stop ${pendingControl.service.service}?`}
          onClose={() => setPendingControl(null)}
          width={560}
          className="service-impact-modal"
          footer={
            <>
              <button type="button" className="secondary" onClick={() => setPendingControl(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="danger"
                disabled={busy !== null}
                onClick={() => {
                  const next = pendingControl
                  setPendingControl(null)
                  void control(next.service, next.action)
                }}
              >
                Stop service
              </button>
            </>
          }
        >
          <div className="service-impact-copy">
            <div className="notice warn">
              Stopping <strong>{pendingControl.service.service}</strong> can affect other parts of the local stack.
            </div>
            {pendingControl.dependents.length > 0 ? (
              <div className="service-impact-list">
                {pendingControl.dependents.map((dependent) => (
                  <div className="service-impact-row" key={dependent.service}>
                    <span className="service-impact-indicator" aria-hidden="true">
                      <Icon name="priority_high" size={15} />
                    </span>
                    <div>
                      <strong>{dependent.service}</strong>
                      <span>{SERVICE_IMPACT_COPY[dependent.service] ?? 'This service depends on the selected service.'}</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
            {pendingControl.extraWarnings.length > 0 ? (
              <div className="service-impact-list">
                {pendingControl.extraWarnings.map((warning) => (
                  <div className="service-impact-row" key={warning}>
                    <span className="service-impact-indicator" aria-hidden="true">
                      <Icon name="priority_high" size={15} />
                    </span>
                    <div><span>{warning}</span></div>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </Modal>
      ) : null}

      {credentialsFor?.credentials?.length ? (
        <Modal
          title={`${credentialsFor.service} credentials`}
          onClose={() => setCredentialsFor(null)}
          width={520}
          className="credentials-modal"
          footer={<button type="button" onClick={() => setCredentialsFor(null)}>Done</button>}
        >
          <div className="credential-list">
            {credentialsFor.credentials.map((credential) => {
              const secret = isSecretCredential(credential.label)
              return (
                <label className="credential-field" key={credential.label}>
                  <span>{credential.label}</span>
                  <div className="credential-input-row">
                    <input
                      className="ui-input"
                      type={secret ? 'password' : 'text'}
                      value={credential.value}
                      readOnly
                      aria-readonly="true"
                    />
                    {secret ? (
                      <Tooltip label={`Copy ${credential.label}`}>
                        <button
                          type="button"
                          className="credential-copy-button"
                          aria-label={`Copy ${credential.label}`}
                          onClick={() => void copyCredential(credential.label, credential.value)}
                        >
                          <Icon name={copiedCredential === credential.label ? 'check' : 'content_copy'} size={16} />
                        </button>
                      </Tooltip>
                    ) : null}
                  </div>
                </label>
              )
            })}
          </div>
        </Modal>
      ) : null}
    </div>
  )
}
