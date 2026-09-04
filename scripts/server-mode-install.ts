#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

export type ServerInstallTopology = 'server-managed' | 'client-managed'
export type LegacyServerMode = 'mode-a' | 'mode-b'
export type ServerMode = ServerInstallTopology
export type EmbedProvider = 'ollama' | 'voyage' | 'openai'
export type ExtractionProvider = 'anthropic' | 'openai'
export type GraphBackend = 'falkordb' | 'neo4j'

export interface ServerModePorts {
  api: number
  dashboard: number
  qdrantRest: number
  qdrantGrpc: number
  falkordbRedis: number
  falkordbBrowser: number
  postgres: number
  redis: number
  graphiti: number
  minioApi: number
  minioConsole: number
  neo4jHttp: number
  neo4jBolt: number
}

export interface ServerModeDefaults {
  mode: ServerMode
  title: string
  projectName: string
  containerPrefix: string
  volumePrefix: string
  networkName: string
  envDir: string
  envFile: string
  composeOverrideFile: string
  embeddingMode: 'server' | 'client-bridge'
  ports: ServerModePorts
}

export interface ServerModeAnswers {
  bootstrapSuperuserEmail: string
  bootstrapSuperuserName: string
  hostBind: string
  publicApiUrl: string
  embedProvider: EmbedProvider
  embedModel: string
  embedDim: number
  ollamaUrl: string
  extractionProvider: ExtractionProvider
  extractionModel: string
  anthropicApiKey: string
  openaiApiKey: string
  voyageApiKey: string
  graphBackend: GraphBackend
  semaphoreLimit: number
}

export interface ServerModeSecrets {
  tokenPepper: string
  postgresPassword: string
  pmAppPassword: string
  minioRootPassword: string
  falkordbPassword: string
  qdrantApiKey: string
  dockerControlToken: string
  updateRunnerToken: string
  usageIngestToken: string
}

export interface PortAssignment {
  service: string
  host: string
  port: number
}

interface CliOptions {
  mode: ServerMode
  prepareOnly: boolean
  yes: boolean
}

const POSTGRES_USER = 'pmuser'
const POSTGRES_DB = 'persistent_memory'
const MINIO_ROOT_USER = 'pmadmin'

const SERVICE_NAMES = [
  'qdrant',
  'falkordb',
  'neo4j',
  'postgres',
  'redis',
  'minio',
  'graphiti',
  'dlp',
  'api',
  'docker-control',
  'update-runner',
  'worker',
  'documentation',
  'dashboard',
  'dashboard-gateway',
] as const

type ServiceName = typeof SERVICE_NAMES[number]

function normalizeServerMode(mode: ServerInstallTopology | LegacyServerMode): ServerMode {
  if (mode === 'mode-a') return 'server-managed'
  if (mode === 'mode-b') return 'client-managed'
  return mode
}

export function defaultsForServerMode(inputMode: ServerInstallTopology | LegacyServerMode): ServerModeDefaults {
  const mode = normalizeServerMode(inputMode)
  if (mode === 'client-managed') {
    return withProjectName({
      mode,
      title: 'Client-managed embeddings shared server',
      projectName: 'persistent-memory-client-managed',
      containerPrefix: 'persistent-memory-client-managed',
      volumePrefix: 'persistent_memory_client_managed',
      networkName: 'persistent_memory_client_managed_network',
      envDir: '.local/client-managed-embeddings',
      envFile: '.local/client-managed-embeddings/.env.persistent-memory',
      composeOverrideFile: '.local/client-managed-embeddings/docker-compose.override.yml',
      embeddingMode: 'client-bridge',
      ports: {
        api: 12090,
        dashboard: 12080,
        qdrantRest: 12333,
        qdrantGrpc: 12334,
        falkordbRedis: 12380,
        falkordbBrowser: 12100,
        postgres: 12433,
        redis: 12381,
        graphiti: 12110,
        minioApi: 12902,
        minioConsole: 12903,
        neo4jHttp: 12775,
        neo4jBolt: 12788,
      },
    }, 'persistent-memory-client-managed')
  }

  return withProjectName({
    mode,
    title: 'Server-managed embeddings shared server',
    projectName: 'persistent-memory-server-managed',
    containerPrefix: 'persistent-memory-server-managed',
    volumePrefix: 'persistent_memory_server_managed',
    networkName: 'persistent_memory_server_managed_network',
    envDir: '.local/server-managed-embeddings',
    envFile: '.local/server-managed-embeddings/.env.persistent-memory',
    composeOverrideFile: '.local/server-managed-embeddings/docker-compose.override.yml',
      embeddingMode: 'server',
      ports: {
        api: 22090,
        dashboard: 22080,
        qdrantRest: 22333,
        qdrantGrpc: 22334,
        falkordbRedis: 22380,
        falkordbBrowser: 22100,
        postgres: 22433,
        redis: 22381,
        graphiti: 22110,
        minioApi: 22902,
        minioConsole: 22903,
        neo4jHttp: 22775,
        neo4jBolt: 22788,
      },
    }, 'persistent-memory-server-managed')
}

export function buildNpmInstallArgs(): string[] {
  return ['install']
}

export function listServerModePortAssignments(defaults: ServerModeDefaults, host = '127.0.0.1'): PortAssignment[] {
  return [
    { service: 'dashboard', host, port: defaults.ports.dashboard },
    { service: 'api', host, port: defaults.ports.api },
    { service: 'qdrant-rest', host, port: defaults.ports.qdrantRest },
    { service: 'qdrant-grpc', host, port: defaults.ports.qdrantGrpc },
    { service: 'falkordb-redis', host, port: defaults.ports.falkordbRedis },
    { service: 'falkordb-browser', host, port: defaults.ports.falkordbBrowser },
    { service: 'postgres', host, port: defaults.ports.postgres },
    { service: 'redis', host, port: defaults.ports.redis },
    { service: 'graphiti', host, port: defaults.ports.graphiti },
    { service: 'minio-api', host, port: defaults.ports.minioApi },
    { service: 'minio-console', host, port: defaults.ports.minioConsole },
    { service: 'neo4j-http', host, port: defaults.ports.neo4jHttp },
    { service: 'neo4j-bolt', host, port: defaults.ports.neo4jBolt },
  ]
}

export function formatPortConflictMessage(conflicts: PortAssignment[]): string {
  const lines = conflicts.map((c) => `  - ${c.service} wants ${c.host}:${c.port}`)
  return [
    'One or more required host ports are already in use:',
    ...lines,
    '',
    'Choose different ports when the script asks "Customize host ports?", or stop the process/container using the port.',
    'To inspect one port: lsof -nP -iTCP:<port> -sTCP:LISTEN',
  ].join('\n')
}

export function withProjectName(defaults: ServerModeDefaults, projectName: string): ServerModeDefaults {
  const normalized = normalizeProjectName(projectName)
  const volumePrefix = normalized.replace(/-/g, '_')
  return {
    ...defaults,
    projectName: normalized,
    containerPrefix: normalized,
    volumePrefix,
    networkName: `${volumePrefix}_network`,
  }
}

export function buildInstallStepEnv(baseEnv: NodeJS.ProcessEnv, modeEnv: Record<string, string>, migrateUrl: string): NodeJS.ProcessEnv {
  return { ...baseEnv, ...modeEnv, DATABASE_MIGRATE_URL: migrateUrl }
}

export function buildComposeArgs(defaults: ServerModeDefaults): string[] {
  return [
    'compose',
    '--env-file',
    defaults.envFile,
    '-f',
    'deploy/compose/docker-compose.yml',
    '-f',
    defaults.composeOverrideFile,
    '-p',
    defaults.projectName,
  ]
}

export function hostRewriteMigrateUrl(url: string, defaults: ServerModeDefaults): string {
  return url.replace(`@${service(defaults, 'postgres')}:5432`, `@localhost:${defaults.ports.postgres}`)
}

export function renderServerModeEnv(defaults: ServerModeDefaults, answers: ServerModeAnswers, secrets: ServerModeSecrets): string {
  const databaseUrl = `postgresql://pm_app:${secrets.pmAppPassword}@${service(defaults, 'postgres')}:5432/${POSTGRES_DB}`
  const migrateUrl = `postgresql://${POSTGRES_USER}:${secrets.postgresPassword}@${service(defaults, 'postgres')}:5432/${POSTGRES_DB}`
  return [
    `# persistent-memory ${defaults.mode} shared-server env. Generated by scripts/server-mode-install.ts.`,
    '# Gitignored under .local/. Do not commit.',
    '',
    '# Secrets supplied by the operator or generated locally.',
    `ANTHROPIC_API_KEY=${cleanEnv(answers.anthropicApiKey)}`,
    `OPENAI_API_KEY=${cleanEnv(answers.openaiApiKey)}`,
    `VOYAGE_API_KEY=${cleanEnv(answers.voyageApiKey)}`,
    `TOKEN_PEPPER=${secrets.tokenPepper}`,
    `PM_HOST_BIND=${answers.hostBind}`,
    '',
    '# Operator-facing connection details.',
    `PM_SERVER_PUBLIC_API_URL=${answers.publicApiUrl}`,
    `PM_SERVER_API_HOST_PORT=${defaults.ports.api}`,
    `PM_SERVER_DASHBOARD_HOST_PORT=${defaults.ports.dashboard}`,
    `DOCKER_COMPOSE_PROJECT=${defaults.projectName}`,
    '',
    '# Bootstrap control-plane super-admin. The seed prints this user\'s token once.',
    `BOOTSTRAP_SUPERUSER_EMAIL=${cleanEnv(answers.bootstrapSuperuserEmail)}`,
    `BOOTSTRAP_SUPERUSER_NAME=${cleanEnv(answers.bootstrapSuperuserName)}`,
    '',
    '# Embeddings. client-managed uses client-bridge for memory vectors; Graphiti still uses these settings for graph nodes.',
    `OLLAMA_URL=${answers.ollamaUrl}`,
    `EMBED_PROVIDER=${answers.embedProvider}`,
    `EMBED_MODEL=${answers.embedModel}`,
    `EMBED_DIM=${answers.embedDim}`,
    `EMBEDDING_MODE=${defaults.embeddingMode}`,
    '',
    '# LLM extraction.',
    `EXTRACTION_PROVIDER=${answers.extractionProvider}`,
    `EXTRACTION_MODEL=${answers.extractionModel}`,
    '',
    '# Graph backend.',
    `GRAPH_BACKEND=${answers.graphBackend}`,
    `SEMAPHORE_LIMIT=${answers.semaphoreLimit}`,
    `FALKORDB_HOST=${service(defaults, 'falkordb')}`,
    'FALKORDB_PORT=6379',
    `FALKORDB_PASSWORD=${secrets.falkordbPassword}`,
    'FALKORDB_DATABASE=default_db',
    'NEO4J_AUTH=neo4j/persistentmemory',
    `NEO4J_URI=bolt://${service(defaults, 'neo4j')}:7687`,
    'NEO4J_USER=neo4j',
    'NEO4J_PASSWORD=persistentmemory',
    '',
    '# Qdrant.',
    `QDRANT_URL=http://${service(defaults, 'qdrant')}:6333`,
    `QDRANT_API_KEY=${secrets.qdrantApiKey}`,
    '',
    '# Postgres.',
    `POSTGRES_USER=${POSTGRES_USER}`,
    `POSTGRES_PASSWORD=${secrets.postgresPassword}`,
    `POSTGRES_DB=${POSTGRES_DB}`,
    `PM_APP_PASSWORD=${secrets.pmAppPassword}`,
    `DATABASE_URL=${databaseUrl}`,
    `DATABASE_MIGRATE_URL=${migrateUrl}`,
    '',
    '# Redis.',
    `REDIS_URL=redis://${service(defaults, 'redis')}:6379`,
    '',
    '# MinIO.',
    `MINIO_ROOT_USER=${MINIO_ROOT_USER}`,
    `MINIO_ROOT_PASSWORD=${secrets.minioRootPassword}`,
    `MINIO_ENDPOINT=http://${service(defaults, 'minio')}:9000`,
    'MINIO_REGION=us-east-1',
    '',
    '# Graphiti.',
    `GRAPHITI_URL=http://${service(defaults, 'graphiti')}:8100`,
    'GRAPHITI_TIMEOUT_MS=120000',
    '',
    '# API.',
    'API_PORT=8090',
    'DEPLOYMENT_MODE=server',
    'ARGON2_MEMORY_KIB=19456',
    'ARGON2_TIME_COST=2',
    'ARGON2_PARALLELISM=1',
    'LOCAL_TEAM_NAME=',
    'LOCAL_USER_EMAIL=',
    'LOCAL_USER_DISPLAY_NAME=',
    'LOCAL_USER_PASSWORD=',
    '',
    '# Server installs do not run an MCP container. Client machines use the local stream MCP service.',
    'PM_MCP_RUNTIME=stream',
    'PM_MCP_STREAM_URL=http://127.0.0.1:8091/mcp',
    '',
    '# Memory surfaces for the shared server stack.',
    'PM_PERSONAL_MEMORY_ENABLED=false',
    'PM_MEMORY_INSTALL_MODE=shared-only',
    'PM_DEFAULT_MEMORY_SURFACE=shared',
    `PM_PERSONAL_API_URL=${answers.publicApiUrl}`,
    'PM_SHARED_API_URL=',
    'PM_SHARED_USER_TOKEN=',
    '',
    '# Internal sidecar tokens.',
    `DOCKER_CONTROL_TOKEN=${secrets.dockerControlToken}`,
    `UPDATE_RUNNER_TOKEN=${secrets.updateRunnerToken}`,
    `USAGE_INGEST_TOKEN=${secrets.usageIngestToken}`,
    'DOCKER_GID=0',
    '',
    '# Dashboard update notifications stay off for shared/server installs.',
    'UPDATE_CHECK_PROVIDER=none',
    'UPDATE_BITBUCKET_URL=',
    'UPDATE_BITBUCKET_TOKEN=',
    'UPDATE_BITBUCKET_SCOPE=project',
    'UPDATE_BITBUCKET_PROJECT=',
    'UPDATE_BITBUCKET_USER=',
    'UPDATE_BITBUCKET_REPO=',
    'UPDATE_BITBUCKET_BRANCH=master',
    '',
    '# DLP / PII gate.',
    'PII_GATE_ENABLED=true',
    'PII_ENTITIES=',
    'PII_SCORE_THRESHOLD=0.5',
    'DLP_TIMEOUT_MS=4000',
    'PII_INGEST_GATE_ENABLED=true',
    'GITLEAKS_TIMEOUT_S=10',
    '',
    '# Worker and ingestion tuning.',
    'WORKER_CONCURRENCY=2',
    'WORKER_MEM_LIMIT=1g',
    'INGEST_MAX_FILE_BYTES=104857600',
    'CHUNK_MAX_TOKENS=512',
    'CHUNK_OVERLAP_TOKENS=64',
    '',
    '# Security-alert notifications.',
    'SMTP_HOST=',
    'SMTP_PORT=587',
    'SMTP_SECURE=false',
    'SMTP_USER=',
    'SMTP_PASS=',
    'ALERT_EMAIL_FROM=',
    '',
    '# Memory rerank.',
    'RERANK_ALPHA=1.0',
    'RERANK_BETA=0.3',
    'RERANK_GAMMA=0.2',
    'RERANK_HALFLIFE_DAYS=30',
    '',
  ].join('\n')
}

export function renderComposeOverride(defaults: ServerModeDefaults, answers: Pick<ServerModeAnswers, 'hostBind' | 'publicApiUrl'>): string {
  const p = defaults.ports
  const envFile = defaults.envFile
  const composeEnvFile = `../../${envFile}`
  return [
    '# Generated by scripts/server-mode-install.ts. Safe to delete only after stopping this mode stack.',
    `name: ${defaults.projectName}`,
    '',
    'services:',
    serviceBlock('qdrant', defaults, [
      '    ports: !override',
      `      - "${answers.hostBind}:${p.qdrantRest}:6333"`,
      `      - "${answers.hostBind}:${p.qdrantGrpc}:6334"`,
    ]),
    serviceBlock('falkordb', defaults, [
      '    ports: !override',
      `      - "${answers.hostBind}:${p.falkordbRedis}:6379"`,
      `      - "${answers.hostBind}:${p.falkordbBrowser}:3000"`,
    ]),
    serviceBlock('neo4j', defaults, [
      '    ports: !override',
      `      - "${answers.hostBind}:${p.neo4jHttp}:7474"`,
      `      - "${answers.hostBind}:${p.neo4jBolt}:7687"`,
    ]),
    serviceBlock('postgres', defaults, [
      '    ports: !override',
      `      - "${answers.hostBind}:${p.postgres}:5432"`,
    ]),
    serviceBlock('redis', defaults, [
      '    ports: !override',
      `      - "${answers.hostBind}:${p.redis}:6379"`,
    ]),
    serviceBlock('minio', defaults, [
      '    ports: !override',
      `      - "${answers.hostBind}:${p.minioApi}:9000"`,
      `      - "${answers.hostBind}:${p.minioConsole}:9001"`,
    ]),
    serviceBlock('graphiti', defaults, [
      '    ports: !override',
      `      - "${answers.hostBind}:${p.graphiti}:8100"`,
      '    environment:',
      '      FALKORDB_HOST: ${FALKORDB_HOST:-' + service(defaults, 'falkordb') + '}',
      `      NEO4J_URI: \${NEO4J_URI:-bolt://${service(defaults, 'neo4j')}:7687}`,
      `      GRAPHITI_URL: \${GRAPHITI_URL:-http://${service(defaults, 'graphiti')}:8100}`,
      `      API_URL: http://${service(defaults, 'api')}:8090`,
    ]),
    serviceBlock('dlp', defaults, []),
    serviceBlock('api', defaults, [
      '    ports: !override',
      `      - "${answers.hostBind}:${p.api}:8090"`,
      '    env_file: !override',
      `      - ${composeEnvFile}`,
      '    environment:',
      '      NODE_ENV: production',
      '      API_PORT: "8090"',
      '      DEPLOYMENT_MODE: ${DEPLOYMENT_MODE:-server}',
      `      DATABASE_URL: postgresql://pm_app:\${PM_APP_PASSWORD:-pmapp}@${service(defaults, 'postgres')}:5432/\${POSTGRES_DB:-persistent_memory}`,
      `      DATABASE_MIGRATE_URL: postgresql://\${POSTGRES_USER:-pmuser}:\${POSTGRES_PASSWORD:-pmpass}@${service(defaults, 'postgres')}:5432/\${POSTGRES_DB:-persistent_memory}`,
      `      REDIS_URL: redis://${service(defaults, 'redis')}:6379`,
      `      QDRANT_URL: http://${service(defaults, 'qdrant')}:6333`,
      '      QDRANT_API_KEY: ${QDRANT_API_KEY:?QDRANT_API_KEY must be set in the mode env file}',
      '      FALKORDB_PASSWORD: ${FALKORDB_PASSWORD:?FALKORDB_PASSWORD must be set in the mode env file}',
      `      GRAPHITI_URL: http://${service(defaults, 'graphiti')}:8100`,
      `      MINIO_ENDPOINT: http://${service(defaults, 'minio')}:9000`,
      '      MINIO_ROOT_USER: ${MINIO_ROOT_USER:-pmadmin}',
      '      MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD:-pmadminsecret}',
      '      EMBED_PROVIDER: ${EMBED_PROVIDER:-ollama}',
      '      EMBED_MODEL: ${EMBED_MODEL:-qwen3-embedding:4b}',
      '      EMBED_DIM: ${EMBED_DIM:-2560}',
      '      EMBEDDING_MODE: ${EMBEDDING_MODE:-server}',
      '      OLLAMA_URL: ${OLLAMA_URL:-http://host.docker.internal:11434}',
      '      GRAPH_BACKEND: ${GRAPH_BACKEND:-falkordb}',
      '      ARGON2_MEMORY_KIB: ${ARGON2_MEMORY_KIB:-19456}',
      '      ARGON2_TIME_COST: ${ARGON2_TIME_COST:-2}',
      '      ARGON2_PARALLELISM: ${ARGON2_PARALLELISM:-1}',
      `      DOCKER_CONTROL_URL: http://${service(defaults, 'docker-control')}:9090`,
      '      DOCKER_CONTROL_TOKEN: ${DOCKER_CONTROL_TOKEN:-}',
      `      UPDATE_RUNNER_URL: http://${service(defaults, 'update-runner')}:9092`,
      '      UPDATE_RUNNER_TOKEN: ${UPDATE_RUNNER_TOKEN:-}',
      '      USAGE_INGEST_TOKEN: ${USAGE_INGEST_TOKEN:-}',
      `      DLP_URL: http://${service(defaults, 'dlp')}:8200`,
      '      PII_GATE_ENABLED: ${PII_GATE_ENABLED:-true}',
      '      PII_ENTITIES: ${PII_ENTITIES:-}',
      '      PII_SCORE_THRESHOLD: ${PII_SCORE_THRESHOLD:-0.5}',
      '      DLP_TIMEOUT_MS: ${DLP_TIMEOUT_MS:-4000}',
    ]),
    serviceBlock('docker-control', defaults, [
      '    environment:',
      '      DOCKER_CONTROL_TOKEN: ${DOCKER_CONTROL_TOKEN:-}',
      `      DOCKER_COMPOSE_PROJECT: ${defaults.projectName}`,
      '      PORT: "9090"',
    ]),
    serviceBlock('update-runner', defaults, [
      '    environment:',
      '      UPDATE_RUNNER_TOKEN: ${UPDATE_RUNNER_TOKEN:-}',
      '      UPDATE_REPO_DIR: /workspace',
      `      UPDATE_BACKUP_ROOT: /workspace/${defaults.envDir}/update-backups`,
      '      UPDATE_BRANCH: ${UPDATE_BRANCH:-master}',
      '      COMPOSE_PARALLEL_LIMIT: ${COMPOSE_PARALLEL_LIMIT:-1}',
    ]),
    serviceBlock('worker', defaults, [
      '    env_file: !override',
      `      - ${composeEnvFile}`,
      '    environment:',
      '      NODE_ENV: production',
      '      DOCKER_CONTROL_TOKEN: ""',
      '      UPDATE_RUNNER_TOKEN: ""',
      '      USAGE_INGEST_TOKEN: ""',
      `      DATABASE_URL: postgresql://pm_app:\${PM_APP_PASSWORD:-pmapp}@${service(defaults, 'postgres')}:5432/\${POSTGRES_DB:-persistent_memory}`,
      `      DATABASE_MIGRATE_URL: postgresql://\${POSTGRES_USER:-pmuser}:\${POSTGRES_PASSWORD:-pmpass}@${service(defaults, 'postgres')}:5432/\${POSTGRES_DB:-persistent_memory}`,
      `      REDIS_URL: redis://${service(defaults, 'redis')}:6379`,
      `      QDRANT_URL: http://${service(defaults, 'qdrant')}:6333`,
      '      QDRANT_API_KEY: ${QDRANT_API_KEY:?QDRANT_API_KEY must be set in the mode env file}',
      `      GRAPHITI_URL: http://${service(defaults, 'graphiti')}:8100`,
      `      MINIO_ENDPOINT: http://${service(defaults, 'minio')}:9000`,
      '      MINIO_ROOT_USER: ${MINIO_ROOT_USER:-pmadmin}',
      '      MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD:-pmadminsecret}',
      '      EMBED_PROVIDER: ${EMBED_PROVIDER:-ollama}',
      '      EMBED_MODEL: ${EMBED_MODEL:-qwen3-embedding:4b}',
      '      EMBED_DIM: ${EMBED_DIM:-2560}',
      '      EMBEDDING_MODE: ${EMBEDDING_MODE:-server}',
      '      OLLAMA_URL: ${OLLAMA_URL:-http://host.docker.internal:11434}',
      '      GRAPH_BACKEND: ${GRAPH_BACKEND:-falkordb}',
      '      SEMAPHORE_LIMIT: ${SEMAPHORE_LIMIT:-10}',
      '      WORKER_CONCURRENCY: ${WORKER_CONCURRENCY:-2}',
      '      GRAPHITI_TIMEOUT_MS: ${GRAPHITI_TIMEOUT_MS:-120000}',
      '      CHUNK_MAX_TOKENS: ${CHUNK_MAX_TOKENS:-512}',
      '      CHUNK_OVERLAP_TOKENS: ${CHUNK_OVERLAP_TOKENS:-64}',
      '      MINIO_REGION: ${MINIO_REGION:-us-east-1}',
      '      ARGON2_MEMORY_KIB: ${ARGON2_MEMORY_KIB:-19456}',
      '      ARGON2_TIME_COST: ${ARGON2_TIME_COST:-2}',
      '      ARGON2_PARALLELISM: ${ARGON2_PARALLELISM:-1}',
      `      DLP_URL: http://${service(defaults, 'dlp')}:8200`,
      '      PII_ENTITIES: ${PII_ENTITIES:-}',
      '      PII_SCORE_THRESHOLD: ${PII_SCORE_THRESHOLD:-0.5}',
      '      DLP_TIMEOUT_MS: ${DLP_TIMEOUT_MS:-4000}',
      '      PII_INGEST_GATE_ENABLED: ${PII_INGEST_GATE_ENABLED:-true}',
    ]),
    serviceBlock('documentation', defaults, []),
    serviceBlock('dashboard', defaults, [
      '    build:',
      '      args:',
      `        NEXT_PUBLIC_API_URL: ${answers.publicApiUrl}`,
      '        DEPLOYMENT_MODE: ${DEPLOYMENT_MODE:-server}',
      '    ports: !override []',
      '    env_file: !override',
      `      - ${composeEnvFile}`,
      '    environment:',
      '      NODE_ENV: production',
      '      PORT: "3000"',
      '      HOSTNAME: "0.0.0.0"',
      `      NEXT_PUBLIC_API_URL: ${answers.publicApiUrl}`,
      `      API_URL: http://${service(defaults, 'api')}:8090`,
      `      DOCUMENTATION_BASE_URL: http://${service(defaults, 'documentation')}:8000`,
      '      DEPLOYMENT_MODE: ${DEPLOYMENT_MODE:-server}',
      '      EMBEDDING_MODE: ${EMBEDDING_MODE:-server}',
      '      GRAPH_BACKEND: ${GRAPH_BACKEND:-falkordb}',
      '      DOCKER_CONTROL_TOKEN: ""',
      '      UPDATE_RUNNER_TOKEN: ""',
      '      USAGE_INGEST_TOKEN: ""',
    ]),
    serviceBlock('dashboard-gateway', defaults, [
      '    ports: !override',
      `      - "${answers.hostBind}:${p.dashboard}:3200"`,
      '    environment:',
      '      NODE_ENV: production',
      '      PORT: "3200"',
      `      DASHBOARD_BASE_URL: http://${service(defaults, 'dashboard')}:3000`,
      '      HANDOFF_STATE_PATH: /run/persistent-memory/update-coordinator-state/dashboard-handoff.json',
      '      LEGACY_HANDOFF_STATE_PATH: /run/persistent-memory/update-state/dashboard-handoff.json',
    ]),
    '',
    'volumes:',
    volumeBlock(defaults, 'qdrant'),
    volumeBlock(defaults, 'falkordb'),
    volumeBlock(defaults, 'neo4j'),
    volumeBlock(defaults, 'postgres'),
    volumeBlock(defaults, 'redis'),
    volumeBlock(defaults, 'minio'),
    '',
    'networks:',
    '  persistent_memory_network:',
    '    driver: bridge',
    `    name: ${defaults.networkName}`,
    '',
  ].join('\n')
}

export function genServerModeSecrets(previous: Partial<Record<keyof ServerModeSecrets, string>> = {}): ServerModeSecrets {
  return {
    tokenPepper: previous.tokenPepper || randomSecret(32),
    postgresPassword: previous.postgresPassword || randomSecret(18, 'hex'),
    pmAppPassword: previous.pmAppPassword || randomSecret(18, 'hex'),
    minioRootPassword: previous.minioRootPassword || randomSecret(18, 'hex'),
    falkordbPassword: previous.falkordbPassword || randomSecret(18, 'hex'),
    qdrantApiKey: previous.qdrantApiKey || randomSecret(24),
    dockerControlToken: previous.dockerControlToken || randomSecret(24),
    updateRunnerToken: previous.updateRunnerToken || randomSecret(24),
    usageIngestToken: previous.usageIngestToken || randomSecret(24),
  }
}

function randomSecret(size: number, encoding: BufferEncoding = 'base64url'): string {
  return randomBytes(size).toString(encoding)
}

function service(defaults: ServerModeDefaults, name: ServiceName): string {
  return `${defaults.containerPrefix}-${name}`
}

function volumeBlock(defaults: ServerModeDefaults, name: 'qdrant' | 'falkordb' | 'neo4j' | 'postgres' | 'redis' | 'minio'): string {
  return [
    `  persistent_memory_${name}_data:`,
    `    name: ${defaults.volumePrefix}_${name}_data`,
  ].join('\n')
}

function serviceBlock(name: ServiceName, defaults: ServerModeDefaults, extra: string[]): string {
  return [
    `  ${name}:`,
    `    container_name: ${service(defaults, name)}`,
    ...extra,
  ].join('\n')
}

function hostUrlBase(hostBind: string, port: number): string {
  const host = hostBind === '0.0.0.0' ? 'localhost' : hostBind
  return `http://${host}:${port}`
}

function normalizeProjectName(input: string): string {
  const normalized = input.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(normalized)) {
    throw new Error(`Invalid Docker Compose project name: ${input}`)
  }
  return normalized
}

function cleanEnv(value: string | undefined): string {
  return (value ?? '').replace(/[\r\n]/g, '').trim()
}

function parseEnv(contents: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
    out[key] = value
  }
  return out
}

function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {}
  return parseEnv(readFileSync(path, 'utf8'))
}

function secretsFromEnv(env: Record<string, string>): Partial<Record<keyof ServerModeSecrets, string>> {
  return {
    tokenPepper: env.TOKEN_PEPPER,
    postgresPassword: env.POSTGRES_PASSWORD,
    pmAppPassword: env.PM_APP_PASSWORD,
    minioRootPassword: env.MINIO_ROOT_PASSWORD,
    falkordbPassword: env.FALKORDB_PASSWORD,
    qdrantApiKey: env.QDRANT_API_KEY,
    dockerControlToken: env.DOCKER_CONTROL_TOKEN,
    updateRunnerToken: env.UPDATE_RUNNER_TOKEN,
    usageIngestToken: env.USAGE_INGEST_TOKEN,
  }
}

async function collectAnswers(defaults: ServerModeDefaults, previous: Record<string, string>, yes: boolean): Promise<{ defaults: ServerModeDefaults; answers: ServerModeAnswers }> {
  const rl = yes ? null : createInterface({ input: process.stdin, output: process.stdout })
  try {
    const projectName = yes
      ? defaults.projectName
      : normalizeProjectName(await prompt(rl, 'Docker project/container group', defaults.projectName))
    const updatedDefaults = withProjectName(defaults, projectName)
    const ports = yes ? updatedDefaults.ports : await promptPorts(rl, updatedDefaults.ports)
    const finalDefaults = { ...updatedDefaults, ports }
    const hostBind = yes ? previous.PM_HOST_BIND || '127.0.0.1' : await promptChoice(rl, 'Host bind address', previous.PM_HOST_BIND || '127.0.0.1', ['127.0.0.1', '0.0.0.0'])
    const previousApiPort = numberOr(previous.PM_SERVER_API_HOST_PORT, finalDefaults.ports.api)
    const publicApiDefault = previous.PM_SERVER_PUBLIC_API_URL && previousApiPort === finalDefaults.ports.api
      ? previous.PM_SERVER_PUBLIC_API_URL
      : hostUrlBase(hostBind, finalDefaults.ports.api)
    const publicApiUrl = yes
      ? publicApiDefault
      : await prompt(rl, 'API URL client installers will use', publicApiDefault)
    const bootstrapSuperuserEmail = yes
      ? previous.BOOTSTRAP_SUPERUSER_EMAIL || 'superuser@persistent-memory.local'
      : await promptRequiredText(rl, 'Bootstrap super-admin email', previous.BOOTSTRAP_SUPERUSER_EMAIL || 'superuser@persistent-memory.local')
    const bootstrapSuperuserName = yes
      ? previous.BOOTSTRAP_SUPERUSER_NAME || 'Bootstrap Superuser'
      : await prompt(rl, 'Bootstrap super-admin display name', previous.BOOTSTRAP_SUPERUSER_NAME || 'Bootstrap Superuser')
    const embedProvider = yes
      ? asEmbedProvider(previous.EMBED_PROVIDER || 'ollama')
      : asEmbedProvider(await promptChoice(rl, 'Graph/embedding provider', previous.EMBED_PROVIDER || 'ollama', ['ollama', 'voyage', 'openai']))
    const embedModel = yes ? previous.EMBED_MODEL || 'qwen3-embedding:4b' : await prompt(rl, 'Embedding model', previous.EMBED_MODEL || 'qwen3-embedding:4b')
    const embedDim = yes ? numberOr(previous.EMBED_DIM, 2560) : await promptNumber(rl, 'Embedding dimension', numberOr(previous.EMBED_DIM, 2560))
    const ollamaUrl = yes ? previous.OLLAMA_URL || 'http://host.docker.internal:11434' : await prompt(rl, 'Ollama URL for containers', previous.OLLAMA_URL || 'http://host.docker.internal:11434')
    const extractionProvider = yes
      ? asExtractionProvider(previous.EXTRACTION_PROVIDER || 'anthropic')
      : asExtractionProvider(await promptChoice(rl, 'Extraction provider', previous.EXTRACTION_PROVIDER || 'anthropic', ['anthropic', 'openai']))
    const extractionModel = yes ? previous.EXTRACTION_MODEL || 'claude-haiku-4-5-20251001' : await prompt(rl, 'Extraction model', previous.EXTRACTION_MODEL || 'claude-haiku-4-5-20251001')
    const graphBackend = yes
      ? asGraphBackend(previous.GRAPH_BACKEND || 'falkordb')
      : asGraphBackend(await promptChoice(rl, 'Graph backend', previous.GRAPH_BACKEND || 'falkordb', ['falkordb', 'neo4j']))
    const semaphoreLimit = yes ? numberOr(previous.SEMAPHORE_LIMIT, 10) : await promptNumber(rl, 'Graphiti semaphore limit', numberOr(previous.SEMAPHORE_LIMIT, 10))
    const anthropicApiKey = extractionProvider === 'anthropic'
      ? yes ? previous.ANTHROPIC_API_KEY || '' : await promptRequired(rl, 'Anthropic API key', previous.ANTHROPIC_API_KEY || '')
      : previous.ANTHROPIC_API_KEY || ''
    const openaiApiKey = extractionProvider === 'openai' || embedProvider === 'openai'
      ? yes ? previous.OPENAI_API_KEY || '' : await promptRequired(rl, 'OpenAI API key', previous.OPENAI_API_KEY || '')
      : previous.OPENAI_API_KEY || ''
    const voyageApiKey = embedProvider === 'voyage'
      ? yes ? previous.VOYAGE_API_KEY || '' : await promptRequired(rl, 'Voyage API key', previous.VOYAGE_API_KEY || '')
      : previous.VOYAGE_API_KEY || ''

    return {
      defaults: finalDefaults,
      answers: {
        bootstrapSuperuserEmail,
        bootstrapSuperuserName,
        hostBind,
        publicApiUrl,
        embedProvider,
        embedModel,
        embedDim,
        ollamaUrl,
        extractionProvider,
        extractionModel,
        anthropicApiKey,
        openaiApiKey,
        voyageApiKey,
        graphBackend,
        semaphoreLimit,
      },
    }
  } finally {
    rl?.close()
  }
}

async function promptPorts(rl: ReturnType<typeof createInterface> | null, defaults: ServerModePorts): Promise<ServerModePorts> {
  if (!rl) return defaults
  const change = await promptChoice(rl, 'Customize host ports?', 'no', ['no', 'yes'])
  if (change !== 'yes') return defaults
  return {
    api: await promptNumber(rl, 'API host port', defaults.api),
    dashboard: await promptNumber(rl, 'Dashboard host port', defaults.dashboard),
    qdrantRest: await promptNumber(rl, 'Qdrant REST host port', defaults.qdrantRest),
    qdrantGrpc: await promptNumber(rl, 'Qdrant gRPC host port', defaults.qdrantGrpc),
    falkordbRedis: await promptNumber(rl, 'FalkorDB Redis host port', defaults.falkordbRedis),
    falkordbBrowser: await promptNumber(rl, 'FalkorDB Browser host port', defaults.falkordbBrowser),
    postgres: await promptNumber(rl, 'Postgres host port', defaults.postgres),
    redis: await promptNumber(rl, 'Redis host port', defaults.redis),
    graphiti: await promptNumber(rl, 'Graphiti host port', defaults.graphiti),
    minioApi: await promptNumber(rl, 'MinIO API host port', defaults.minioApi),
    minioConsole: await promptNumber(rl, 'MinIO Console host port', defaults.minioConsole),
    neo4jHttp: await promptNumber(rl, 'Neo4j HTTP host port', defaults.neo4jHttp),
    neo4jBolt: await promptNumber(rl, 'Neo4j Bolt host port', defaults.neo4jBolt),
  }
}

async function prompt(rl: ReturnType<typeof createInterface> | null, label: string, fallback: string): Promise<string> {
  if (!rl) return fallback
  const answer = await rl.question(`${label} [${fallback}]: `)
  return cleanEnv(answer || fallback)
}

async function promptRequired(rl: ReturnType<typeof createInterface> | null, label: string, fallback: string): Promise<string> {
  if (!rl && fallback) return fallback
  if (!rl) throw new Error(`${label} is required`)
  for (;;) {
    const answer = await prompt(rl, label, fallback ? maskSecret(fallback) : 'required')
    if (answer === maskSecret(fallback) && fallback) return fallback
    if (answer && answer !== 'required') return cleanEnv(answer)
    console.log(`${label} is required for the selected provider.`)
  }
}

async function promptRequiredText(rl: ReturnType<typeof createInterface> | null, label: string, fallback: string): Promise<string> {
  if (!rl) {
    if (fallback) return fallback
    throw new Error(`${label} is required`)
  }
  for (;;) {
    const answer = await prompt(rl, label, fallback || 'required')
    if (answer && answer !== 'required') return cleanEnv(answer)
    console.log(`${label} is required.`)
  }
}

async function promptChoice(rl: ReturnType<typeof createInterface> | null, label: string, fallback: string, choices: string[]): Promise<string> {
  if (!rl) return fallback
  for (;;) {
    const answer = await prompt(rl, `${label} (${choices.join('/')})`, fallback)
    if (choices.includes(answer)) return answer
    console.log(`Choose one of: ${choices.join(', ')}`)
  }
}

async function promptNumber(rl: ReturnType<typeof createInterface> | null, label: string, fallback: number): Promise<number> {
  if (!rl) return fallback
  for (;;) {
    const answer = await prompt(rl, label, String(fallback))
    const n = Number(answer)
    if (Number.isInteger(n) && n > 0 && n < 65536) return n
    console.log('Enter a valid TCP port or positive integer.')
  }
}

function numberOr(value: string | undefined, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function maskSecret(value: string): string {
  if (!value) return ''
  if (value.length <= 8) return '********'
  return `${value.slice(0, 4)}...${value.slice(-4)}`
}

function asEmbedProvider(value: string): EmbedProvider {
  if (value === 'ollama' || value === 'voyage' || value === 'openai') return value
  throw new Error(`Unsupported embedding provider: ${value}`)
}

function asExtractionProvider(value: string): ExtractionProvider {
  if (value === 'anthropic' || value === 'openai') return value
  throw new Error(`Unsupported extraction provider: ${value}`)
}

function asGraphBackend(value: string): GraphBackend {
  if (value === 'falkordb' || value === 'neo4j') return value
  throw new Error(`Unsupported graph backend: ${value}`)
}

function writeArtifacts(repoRoot: string, defaults: ServerModeDefaults, answers: ServerModeAnswers, secrets: ServerModeSecrets): void {
  const envDir = resolve(repoRoot, defaults.envDir)
  mkdirSync(envDir, { recursive: true })
  writeFileSync(resolve(repoRoot, defaults.envFile), renderServerModeEnv(defaults, answers, secrets), 'utf8')
  writeFileSync(resolve(repoRoot, defaults.composeOverrideFile), renderComposeOverride(defaults, answers), 'utf8')
}

async function runInstall(repoRoot: string, defaults: ServerModeDefaults, answers: ServerModeAnswers): Promise<void> {
  const composeArgs = buildComposeArgs(defaults)
  const env = { ...process.env, COMPOSE_PARALLEL_LIMIT: '1' }
  await run('npm', buildNpmInstallArgs(), { cwd: repoRoot, env })
  await run('npm', ['run', 'prisma:generate'], { cwd: repoRoot, env })
  if (answers.embedProvider === 'ollama') {
    await run('ollama', ['pull', answers.embedModel], { cwd: repoRoot, env })
  }
  await run('docker', [...composeArgs, 'up', '-d', '--build'], { cwd: repoRoot, env })
  await waitForHealthy(service(defaults, 'postgres'))

  const modeEnv = readEnvFile(resolve(repoRoot, defaults.envFile))
  const migrateUrl = hostRewriteMigrateUrl(modeEnv.DATABASE_MIGRATE_URL ?? '', defaults)
  if (!migrateUrl) throw new Error(`DATABASE_MIGRATE_URL is missing in ${defaults.envFile}`)
  const stepEnv = buildInstallStepEnv(env, modeEnv, migrateUrl)
  await run('npm', ['run', '--silent', 'migrate:deploy'], { cwd: resolve(repoRoot, 'layers/core/schema'), env: stepEnv })
  await applyRls(repoRoot, defaults, modeEnv)
  await run('npm', ['run', '--silent', 'seed'], { cwd: resolve(repoRoot, 'layers/core/schema'), env: stepEnv })
  await run('docker', [...composeArgs, 'up', '-d', '--force-recreate', '--no-deps', 'api', 'worker'], { cwd: repoRoot, env })
  await waitForHttp(`${hostUrlBase(answers.hostBind, defaults.ports.api)}/health`)
}

async function applyRls(repoRoot: string, defaults: ServerModeDefaults, env: Record<string, string>): Promise<void> {
  const rls = readFileSync(resolve(repoRoot, 'layers/core/schema/rls.sql'), 'utf8')
  await run('docker', [
    'exec',
    '-i',
    '-e',
    `PGPASSWORD=${env.POSTGRES_PASSWORD || 'pmpass'}`,
    '-e',
    `PGOPTIONS=-c pm.app_password=${env.PM_APP_PASSWORD || 'pmapp'}`,
    service(defaults, 'postgres'),
    'psql',
    '-U',
    env.POSTGRES_USER || POSTGRES_USER,
    '-d',
    env.POSTGRES_DB || POSTGRES_DB,
    '-v',
    'ON_ERROR_STOP=1',
  ], { cwd: repoRoot, input: rls })
}

function run(command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv; input?: string }): Promise<void> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: options.input ? ['pipe', 'inherit', 'inherit'] : 'inherit',
    })
    if (options.input && child.stdin) {
      child.stdin.write(options.input)
      child.stdin.end()
    }
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolveRun()
      else reject(new Error(`${command} ${args.join(' ')} exited with ${code}`))
    })
  })
}

async function assertPortsAvailable(assignments: PortAssignment[]): Promise<void> {
  const conflicts: PortAssignment[] = []
  for (const assignment of assignments) {
    if (!(await canBindPort(assignment.host, assignment.port))) conflicts.push(assignment)
  }
  if (conflicts.length > 0) throw new Error(formatPortConflictMessage(conflicts))
}

function canBindPort(host: string, port: number): Promise<boolean> {
  return new Promise((resolveBind) => {
    const server = createServer()
    server.once('error', (err: NodeJS.ErrnoException) => {
      // Codex/sandboxed shells can return EPERM for all bind probes. Only block
      // the installer for the real conflict signal; Docker will still perform its
      // own bind validation during compose-up.
      resolveBind(err.code !== 'EADDRINUSE')
    })
    server.once('listening', () => {
      server.close(() => resolveBind(true))
    })
    server.listen(port, host)
  })
}

function capture(command: string, args: string[]): Promise<string> {
  return new Promise((resolveCapture, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolveCapture(stdout)
      else reject(new Error(`${command} ${args.join(' ')} exited with ${code}: ${stderr}`))
    })
  })
}

async function waitForHealthy(container: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const status = (await capture('docker', ['inspect', '-f', '{{.State.Health.Status}}', container])).trim()
      if (status === 'healthy') return
    } catch {
      // Keep polling while compose creates the container.
    }
    await delay(2_000)
  }
  throw new Error(`${container} did not become healthy within ${timeoutMs / 1000}s`)
}

async function waitForHttp(url: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {
      // Keep polling.
    }
    await delay(2_000)
  }
  throw new Error(`${url} did not become healthy within ${timeoutMs / 1000}s`)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

function printSummary(defaults: ServerModeDefaults, answers: ServerModeAnswers): void {
  console.log('')
  console.log(defaults.title)
  console.log(`Docker project: ${defaults.projectName}`)
  console.log(`Env file:       ${defaults.envFile}`)
  console.log(`Compose file:   ${defaults.composeOverrideFile}`)
  console.log(`Dashboard:      ${hostUrlBase(answers.hostBind, defaults.ports.dashboard)}`)
  console.log(`API:            ${hostUrlBase(answers.hostBind, defaults.ports.api)}`)
  console.log(`Client API URL: ${answers.publicApiUrl}`)
  console.log(`Super-admin:    ${answers.bootstrapSuperuserEmail}`)
  console.log(`Embedding topology: ${defaults.mode}`)
  console.log('MCP:            not installed on the server; run client onboarding for MCP')
  console.log('')
}

async function main(argv: string[]): Promise<void> {
  const options = parseArgs(argv)
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const baseDefaults = defaultsForServerMode(options.mode)
  const previous = { ...process.env, ...readEnvFile(resolve(repoRoot, baseDefaults.envFile)) } as Record<string, string>

  console.log('')
  console.log(`Persistent Memory ${baseDefaults.title}`)
  console.log('This script creates an isolated server-side Docker project and does not remove volumes or env files.')
  console.log('')

  const collected = await collectAnswers(baseDefaults, previous, options.yes)
  const secrets = genServerModeSecrets(secretsFromEnv(previous))
  await assertPortsAvailable(listServerModePortAssignments(collected.defaults, collected.answers.hostBind))
  writeArtifacts(repoRoot, collected.defaults, collected.answers, secrets)
  printSummary(collected.defaults, collected.answers)

  if (options.prepareOnly) {
    console.log('Prepared files only. Run the script again without --prepare-only to build/start/migrate/seed.')
    return
  }

  if (!options.yes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    try {
      const proceed = await promptChoice(rl, 'Build, start, migrate, apply RLS, and seed now?', 'no', ['no', 'yes'])
      if (proceed !== 'yes') {
        console.log('Stopped before starting Docker. Generated files are ready for review.')
        return
      }
    } finally {
      rl.close()
    }
  }

  await runInstall(repoRoot, collected.defaults, collected.answers)
  console.log('')
  console.log('Server install complete.')
  console.log(`Dashboard:       ${hostUrlBase(collected.answers.hostBind, collected.defaults.ports.dashboard)}`)
  console.log(`API for client setup: ${collected.answers.publicApiUrl}`)
  if (options.mode === 'client-managed') {
    console.log('Client validation: connect Shared Memories from the local dashboard; the client side should reuse or install a compatible embedding model.')
  } else {
    console.log('Client validation: connect Shared Memories from the local dashboard; the server manages shared-memory embeddings.')
  }
}

function parseArgs(argv: string[]): CliOptions {
  const rawMode = argv.find((arg) => arg === 'server-managed' || arg === 'client-managed' || arg === 'mode-a' || arg === 'mode-b') as ServerInstallTopology | LegacyServerMode | undefined
  const modeArg = rawMode ? normalizeServerMode(rawMode) : undefined
  if (argv.includes('--help') || argv.includes('-h') || !modeArg) {
    printHelp()
    process.exit(modeArg ? 0 : 1)
  }
  return {
    mode: modeArg,
    prepareOnly: argv.includes('--prepare-only'),
    yes: argv.includes('--yes'),
  }
}

function printHelp(): void {
  console.log(`Usage:
  bash deploy/scripts/install-server-client-managed.sh [--prepare-only] [--yes]
  bash deploy/scripts/install-server-server-managed.sh [--prepare-only] [--yes]

What it does:
  - Prompts for server deployment settings and provider keys.
  - Generates a topology-specific env file and compose override under .local/.
  - Starts an isolated Docker Compose project only after confirmation.
  - Runs npm install, Prisma generate/migrate, RLS, seed, and API health verification.

It never removes containers, volumes, or env files.`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
