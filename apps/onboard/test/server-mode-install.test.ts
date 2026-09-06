import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import type { Server } from 'node:net'
import {
  canBindPort,
  buildInstallStepEnv,
  buildComposeArgs,
  buildNpmInstallArgs,
  defaultsForServerMode,
  formatPortConflictMessage,
  hostRewriteMigrateUrl,
  listServerModePortAssignments,
  renderComposeOverride,
  renderServerModeEnv,
  type ServerModeAnswers,
  type ServerModeSecrets,
} from '../../../scripts/server-mode-install.ts'

const answers: ServerModeAnswers = {
  bootstrapSuperuserEmail: 'owner@example.test',
  bootstrapSuperuserName: 'Owner Admin',
  hostBind: '127.0.0.1',
  publicApiUrl: 'http://localhost:12090',
  embedProvider: 'ollama',
  embedModel: 'qwen3-embedding:4b',
  embedDim: 2560,
  ollamaUrl: 'http://host.docker.internal:11434',
  extractionProvider: 'anthropic',
  extractionModel: 'claude-haiku-4-5-20251001',
  anthropicApiKey: 'sk-ant-test',
  openaiApiKey: '',
  voyageApiKey: '',
  graphBackend: 'falkordb',
  semaphoreLimit: 10,
}

const secrets: ServerModeSecrets = {
  tokenPepper: 'PEPPER',
  postgresPassword: 'PGPASS',
  pmAppPassword: 'APPROLEPASS',
  minioRootPassword: 'MINIOPASS',
  falkordbPassword: 'FALKORPASS',
  qdrantApiKey: 'QDRANTKEY',
  dockerControlToken: 'DOCKERCONTROL',
  updateRunnerToken: 'UPDATERUNNER',
  usageIngestToken: 'USAGEINGEST',
}

describe('server mode installer rendering', () => {
  it.each(['EADDRINUSE', 'EACCES', 'EPERM'])('rejects ports when the host bind probe returns %s', async (code) => {
    const server = Object.assign(new EventEmitter(), {
      listen: () => server.emit('error', Object.assign(new Error(code), { code })),
    })
    await expect(canBindPort('127.0.0.1', 12090, () => server as unknown as Server)).resolves.toBe(false)
  })
  it('uses isolated Docker-safe defaults for client-managed and server-managed servers', () => {
    const clientManaged = defaultsForServerMode('client-managed')
    const serverManaged = defaultsForServerMode('server-managed')

    expect(clientManaged.projectName).toBe('persistent-memory-client-managed')
    expect(clientManaged.containerPrefix).toBe('persistent-memory-client-managed')
    expect(clientManaged.volumePrefix).toBe('persistent_memory_client_managed')
    expect(clientManaged.embeddingMode).toBe('client-bridge')
    expect(clientManaged.envDir).toBe('.local/client-managed-embeddings')
    expect(clientManaged.ports).toMatchObject({ api: 12090, dashboard: 12080, postgres: 12433 })

    expect(serverManaged.projectName).toBe('persistent-memory-server-managed')
    expect(serverManaged.embeddingMode).toBe('server')
    expect(serverManaged.envDir).toBe('.local/server-managed-embeddings')
    expect(serverManaged.ports).toMatchObject({ api: 22090, dashboard: 22080, postgres: 22433 })
  })

  it('preserves mode-a/mode-b as installer aliases', () => {
    expect(defaultsForServerMode('mode-b')).toMatchObject(defaultsForServerMode('client-managed'))
    expect(defaultsForServerMode('mode-a')).toMatchObject(defaultsForServerMode('server-managed'))
  })

  it('renders client-managed as a shared server with client-bridge embedding and no personal surface', () => {
    const clientManaged = defaultsForServerMode('client-managed')
    const env = renderServerModeEnv(clientManaged, answers, secrets)

    expect(env).toContain('DEPLOYMENT_MODE=server')
    expect(env).toContain('BOOTSTRAP_SUPERUSER_EMAIL=owner@example.test')
    expect(env).toContain('BOOTSTRAP_SUPERUSER_NAME=Owner Admin')
    expect(env).toContain('EMBEDDING_MODE=client-bridge')
    expect(env).toContain('PM_MCP_RUNTIME=stream')
    expect(env).toContain('PM_MCP_STREAM_URL=http://127.0.0.1:8091/mcp')
    expect(env).toContain('PM_PERSONAL_MEMORY_ENABLED=false')
    expect(env).toContain('PM_MEMORY_INSTALL_MODE=shared-only')
    expect(env).toContain('PM_DEFAULT_MEMORY_SURFACE=shared')
    expect(env).toContain('PM_SERVER_DASHBOARD_HOST_PORT=12080')
    expect(env).not.toContain('PM_SERVER_ADMIN_HOST_PORT')
    expect(env).toContain('PM_SHARED_USER_TOKEN=')
    expect(env).toContain('DATABASE_URL=postgresql://pm_app:APPROLEPASS@persistent-memory-client-managed-postgres:5432/persistent_memory')
    expect(env).toContain('DATABASE_MIGRATE_URL=postgresql://pmuser:PGPASS@persistent-memory-client-managed-postgres:5432/persistent_memory')
    expect(env).toContain('QDRANT_URL=http://persistent-memory-client-managed-qdrant:6333')
    expect(env).toContain('GRAPHITI_URL=http://persistent-memory-client-managed-graphiti:8100')
    expect(env).toContain('MINIO_ENDPOINT=http://persistent-memory-client-managed-minio:9000')
  })

  it('renders a compose override that isolates names, ports, volumes, and internal URLs', () => {
    const clientManaged = defaultsForServerMode('client-managed')
    const override = renderComposeOverride(clientManaged, answers)

    expect(override).toContain('name: persistent-memory-client-managed')
    expect(override).toContain('container_name: persistent-memory-client-managed-api')
    expect(override).toContain('container_name: persistent-memory-client-managed-dashboard')
    expect(override).toContain('container_name: persistent-memory-client-managed-documentation')
    expect(override).toContain('container_name: persistent-memory-client-managed-dashboard-gateway')
    expect(override).not.toMatch(/^  admin:/m)
    expect(override).toContain('"127.0.0.1:12090:8090"')
    expect(override).toContain('"127.0.0.1:12080:3200"')
    expect(override).not.toContain('"127.0.0.1:12080:3000"')
    expect(override).toContain('DATABASE_URL: postgresql://pm_app:${PM_APP_PASSWORD:-pmapp}@persistent-memory-client-managed-postgres:5432/${POSTGRES_DB:-persistent_memory}')
    expect(override).toContain('env_file: !override')
    expect(override).toContain('- ../../.local/client-managed-embeddings/.env.persistent-memory')
    expect(override).not.toContain('- .local/client-managed-embeddings/.env.persistent-memory')
    expect(override).toContain('DOCKER_CONTROL_URL: http://persistent-memory-client-managed-docker-control:9090')
    expect(override).toContain('API_URL: http://persistent-memory-client-managed-api:8090')
    expect(override).toContain('DOCUMENTATION_BASE_URL: http://persistent-memory-client-managed-documentation:8000')
    expect(override).toContain('DASHBOARD_BASE_URL: http://persistent-memory-client-managed-dashboard:3000')
    expect(override).toContain('HANDOFF_STATE_PATH: /run/persistent-memory/update-coordinator-state/dashboard-handoff.json')
    expect(override).toContain('LEGACY_HANDOFF_STATE_PATH: /run/persistent-memory/update-state/dashboard-handoff.json')
    expect(override).toContain('DOCKER_COMPOSE_PROJECT: persistent-memory-client-managed')
    expect(override).not.toContain('container_name: persistent-memory-client-managed-mcp')
    expect(override).not.toContain('12091:8091')
    expect(override).toContain('name: persistent_memory_client_managed_postgres_data')
    expect(override).toContain('name: persistent_memory_client_managed_network')
  })

  it('builds compose args from the generated env/override and rewrites migrate URL to the host port', () => {
    const clientManaged = defaultsForServerMode('client-managed')

    expect(buildComposeArgs(clientManaged)).toEqual([
      'compose',
      '--env-file',
      '.local/client-managed-embeddings/.env.persistent-memory',
      '-f',
      'deploy/compose/docker-compose.yml',
      '-f',
      '.local/client-managed-embeddings/docker-compose.override.yml',
      '-p',
      'persistent-memory-client-managed',
    ])
    expect(hostRewriteMigrateUrl(
      'postgresql://pmuser:PGPASS@persistent-memory-client-managed-postgres:5432/persistent_memory',
      clientManaged,
    )).toBe('postgresql://pmuser:PGPASS@localhost:12433/persistent_memory')
  })

  it('keeps npm audit/funding output visible and prepares a readable port-conflict message', () => {
    expect(buildNpmInstallArgs()).toEqual(['install'])
    expect(listServerModePortAssignments(defaultsForServerMode('client-managed')).map((p) => p.port)).not.toContain(18100)
    expect(listServerModePortAssignments(defaultsForServerMode('client-managed')).map((p) => p.service)).not.toContain('mcp')
    expect(formatPortConflictMessage([
      { service: 'graphiti', host: '127.0.0.1', port: 18100 },
    ])).toContain('graphiti wants 127.0.0.1:18100')
  })

  it('passes mode env into host-side seed/migrate steps so tokens and settings match the running server', () => {
    const env = buildInstallStepEnv(
      { PATH: '/bin', TOKEN_PEPPER: 'wrong-global' },
      {
        TOKEN_PEPPER: 'mode-pepper',
        EMBEDDING_MODE: 'client-bridge',
        DATABASE_MIGRATE_URL: 'postgresql://pmuser:PGPASS@persistent-memory-client-managed-postgres:5432/persistent_memory',
      },
      'postgresql://pmuser:PGPASS@localhost:12433/persistent_memory',
    )

    expect(env.TOKEN_PEPPER).toBe('mode-pepper')
    expect(env.EMBEDDING_MODE).toBe('client-bridge')
    expect(env.DATABASE_MIGRATE_URL).toBe('postgresql://pmuser:PGPASS@localhost:12433/persistent_memory')
  })
})
