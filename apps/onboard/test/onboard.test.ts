/**
 * Unit matrix for the onboarding installer's pure logic (no Docker, no Node-stack).
 * Covers env generation + secret auto-gen, prereq parsers, ollama model match,
 * and the install step list + host-URL rewrite + token capture.
 */
import { describe, it, expect } from 'vitest'
import { execFileSync as nodeExecFileSync, type ExecFileSyncOptions } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { genSecrets, renderEnv, maskEnv, validateEnvForDeploy, type Answers } from '../server/env.ts'
import {
  parseDockerInfo,
  parseComposeVersion,
  parseNodeVersion,
  parseOllamaTags,
  hasModel,
  buildPrereqInstallPlan,
  homebrewManualInstallCommands,
} from '../server/prereq.ts'
import { buildSteps, hostRewriteUrl, extractToken, parseVerifySummary } from '../server/steps.ts'
import { prereqsBlocked, modelPresence, extractionNextBlocked } from '../web/src/flow.ts'
import { planRegistration } from '../server/register.ts'
import { testExtractionConnection } from '../server/extraction-test.ts'
import { hostCommand } from '../server/host.ts'
import { parseEnvFile } from '../server/install.ts'

function execFileSync(command: string, args: string[], options: Omit<ExecFileSyncOptions, 'encoding'> & { encoding?: 'utf8' } = {}): string {
  const resolved = hostCommand(command, command === 'bash' ? args.map((arg) => /^[a-z]:[\\/]/i.test(arg) ? arg.replaceAll('\\', '/') : arg) : args, { env: options.env ?? process.env })
  return nodeExecFileSync(resolved.command, resolved.args, { ...options, env: resolved.env, encoding: 'utf8', windowsHide: true })
}

const answers: Answers = {
  embeddingMode: 'server',
  embedProvider: 'ollama',
  embedModel: 'qwen3-embedding:4b',
  embedDim: 2560,
  extractionProvider: 'anthropic',
  extractionModel: 'claude-haiku-4-5-20251001',
  anthropicApiKey: 'sk-ant-xxx',
  graphBackend: 'falkordb',
}
const testSecrets = {
  tokenPepper: 'PEP',
  postgresPassword: 'PGPW',
  pmAppPassword: 'APPPW',
  minioRootPassword: 'MINIOPW',
  falkordbPassword: 'FALKORPW',
  qdrantApiKey: 'QDRANTKEY',
  dockerControlToken: 'DCTOK',
  updateRunnerToken: 'UPTOK',
  usageIngestToken: 'USTOK',
}

describe('genSecrets', () => {
  it('generates secrets for a fresh install, non-empty and distinct each call', () => {
    const a = genSecrets()
    expect(a.tokenPepper.length).toBeGreaterThan(20)
    expect(a.postgresPassword.length).toBeGreaterThan(20)
    expect(a.pmAppPassword.length).toBeGreaterThan(20)
    expect(a.minioRootPassword.length).toBeGreaterThan(20)
    expect(a.dockerControlToken.length).toBeGreaterThan(20)
    expect(a.usageIngestToken.length).toBeGreaterThan(20)
    const b = genSecrets()
    expect(a.tokenPepper).not.toBe(b.tokenPepper)
    expect(a.dockerControlToken).not.toBe(b.dockerControlToken)
  })
})

describe('local dashboard URL', () => {
  it('uses the passwordless localhost dashboard URL and does not prompt for sudo before the wizard opens', () => {
    const script = readFileSync(new URL('../../../deploy/scripts/onboard.sh', import.meta.url), 'utf8')
    const server = readFileSync(new URL('../server/index.ts', import.meta.url), 'utf8')
    const app = readFileSync(new URL('../web/src/App.tsx', import.meta.url), 'utf8')

    expect(script).toContain('DASHBOARD_URL="${DASHBOARD_URL:-${ADMIN_URL:-http://localhost:${DASHBOARD_PORT}}}"')
    expect(script).toContain('DASHBOARD_URL="$DASHBOARD_URL" ADMIN_URL="$DASHBOARD_URL"')
    expect(script).not.toContain('ensure_dashboard_host')
    expect(script).not.toContain('sudo tee -a /etc/hosts')
    expect(server).toContain("const DEFAULT_DASHBOARD_URL = 'http://localhost:3200'")
    expect(server).toContain('const dashboardUrl = process.env.DASHBOARD_URL ?? process.env.ADMIN_URL ?? DEFAULT_DASHBOARD_URL')
    expect(server).not.toContain('/api/dashboard-url')
    expect(server).not.toContain('register-managed')
    expect(app).toContain("const LOCAL_DASHBOARD_URL = 'http://localhost:3200'")
    expect(app).toContain("getJSON<{ dashboardUrl: string }>('/api/finish')")
    expect(app).not.toContain('Dashboard URL')
    expect(app).not.toContain('/api/dashboard-url')
  })
})

describe('project Docker image tags', () => {
  it('uses latest tags for project-built images in teammate installs', () => {
    const compose = readFileSync(new URL('../../../deploy/compose/docker-compose.yml', import.meta.url), 'utf8')
    const projectImages = [
      'graphiti',
      'dlp',
      'api',
      'docker-control',
      'update-runner',
      'mcp',
      'worker',
      'dashboard',
      'documentation',
    ]

    for (const image of projectImages) {
      expect(compose).toContain(`image: \${PM_IMAGE_PREFIX:-persistent-memory}-${image}:latest`)
      expect(compose).not.toContain(`image: \${PM_IMAGE_PREFIX:-persistent-memory}-${image}:dev`)
    }
  })
})

describe('renderEnv', () => {
  const env = renderEnv(answers, testSecrets)

  it('DATABASE_URL password == PM_APP_PASSWORD (the load-bearing invariant)', () => {
    expect(env).toContain('PM_APP_PASSWORD=APPPW')
    expect(env).toContain('DATABASE_URL=postgresql://pm_app:APPPW@persistent-memory-postgres:5432/persistent_memory')
  })
  it('DATABASE_MIGRATE_URL password == POSTGRES_PASSWORD', () => {
    expect(env).toContain('POSTGRES_PASSWORD=PGPW')
    expect(env).toContain('DATABASE_MIGRATE_URL=postgresql://pmuser:PGPW@persistent-memory-postgres:5432/persistent_memory')
  })
  it('routes the anthropic key + embedding mode/model/dim', () => {
    expect(env).toContain('ANTHROPIC_API_KEY=sk-ant-xxx')
    expect(env).toContain('EMBEDDING_MODE=server')
    expect(env).toContain('EMBED_MODEL=qwen3-embedding:4b')
    expect(env).toContain('EMBED_DIM=2560')
    expect(env).toContain('TOKEN_PEPPER=PEP')
    expect(env).toContain('FALKORDB_PASSWORD=FALKORPW')
    expect(env).toContain('QDRANT_API_KEY=QDRANTKEY')
    expect(env).toContain('DOCKER_CONTROL_TOKEN=DCTOK')
    expect(env).toContain('UPDATE_RUNNER_TOKEN=UPTOK')
    expect(env).toContain('USAGE_INGEST_TOKEN=USTOK')
  })
  it('does not stringify missing embedding pin values as undefined', () => {
    const missingPin = renderEnv({
      ...answers,
      embedModel: undefined as unknown as string,
      embedDim: undefined as unknown as number,
    }, testSecrets)

    expect(missingPin).toContain('EMBED_MODEL=')
    expect(missingPin).toContain('EMBED_DIM=')
    expect(missingPin).not.toContain('EMBED_MODEL=undefined')
    expect(missingPin).not.toContain('EMBED_DIM=undefined')
  })
  it('needs no update credentials or source configuration for a fresh installation', () => {
    const env = renderEnv(answers, testSecrets)
    expect(env).not.toContain('UPDATE_CHECK_PROVIDER=')
    expect(env).not.toContain('UPDATE_GITHUB_')
    expect(env).not.toContain('PM_SSH_DIR=')
    expect(validateEnvForDeploy(parseEnvFile(env))).toEqual([])
  })
  it('enables Memory Graph in fresh wizard environments', () => {
    expect(parseEnvFile(env).PM_MEMORY_GRAPH_UI_ENABLED).toBe('true')
  })
  it.each([
    ['true', 'true'],
    ['false', 'false'],
    ['"false"', 'false'],
    ["'false'", 'false'],
    ['false # disabled by operator', 'false'],
    ['"false" # disabled by operator', 'false'],
    ["'false' # disabled by operator", 'false'],
  ])('preserves the saved Memory Graph flag across environment regeneration (%s)', (stored, enabled) => {
    const saved = parseEnvFile(`PM_MEMORY_GRAPH_UI_ENABLED=${stored}\n`)
    const regenerated = parseEnvFile(renderEnv(answers, testSecrets, saved))
    const roundTrip = parseEnvFile(renderEnv(answers, testSecrets, regenerated))

    expect(regenerated.PM_MEMORY_GRAPH_UI_ENABLED).toBe(enabled)
    expect(roundTrip.PM_MEMORY_GRAPH_UI_ENABLED).toBe(enabled)
    expect(validateEnvForDeploy(roundTrip)).toEqual([])
  })
  it('passes saved server environment flags into regeneration without adding wizard settings', () => {
    const server = readFileSync(new URL('../server/index.ts', import.meta.url), 'utf8')
    const envRoute = readFileSync(new URL('../server/env-route.ts', import.meta.url), 'utf8')
    expect(server).toContain('registerEnvWriteRoute(app, ENV_PATH)')
    expect(envRoute).toContain('const env = renderEnv(a, secrets, oldEnv)')
  })
  it('renders personal-memory isolation settings for full-local installs', () => {
    const isolatedEnv = renderEnv({
      ...answers,
      deploymentMode: 'local',
      userPasswordConfiguredAt: '2026-02-03T04:05:06.000Z',
      personalMemoryEnabled: true,
      memoryInstallMode: 'personal-only',
      defaultMemorySurface: 'personal',
    }, testSecrets)

    expect(isolatedEnv).toContain('PM_PERSONAL_MEMORY_ENABLED=true')
    expect(isolatedEnv).toContain('PM_MEMORY_INSTALL_MODE=personal-only')
    expect(isolatedEnv).toContain('PM_DEFAULT_MEMORY_SURFACE=personal')
    expect(isolatedEnv).toContain('PM_PERSONAL_API_URL=http://localhost:8090')
    expect(isolatedEnv).toContain('PM_SHARED_API_URL=')
    expect(isolatedEnv).toContain('LOCAL_USER_PASSWORD_CONFIGURED_AT=2026-02-03T04:05:06.000Z')
  })
  it('renders personal + shared routing settings for remote installs with isolated personal memory', () => {
    const routedEnv = renderEnv({
      ...answers,
      personalMemoryEnabled: true,
      memoryInstallMode: 'personal-and-shared',
      defaultMemorySurface: 'personal',
      sharedApiUrl: 'https://memory.example.test',
      sharedUserToken: 'tid.secret',
    }, testSecrets)

    expect(routedEnv).toContain('PM_PERSONAL_MEMORY_ENABLED=true')
    expect(routedEnv).toContain('PM_MEMORY_INSTALL_MODE=personal-and-shared')
    expect(routedEnv).toContain('PM_DEFAULT_MEMORY_SURFACE=personal')
    expect(routedEnv).toContain('PM_PERSONAL_API_URL=http://localhost:8090')
    expect(routedEnv).toContain('PM_SHARED_API_URL=https://memory.example.test')
    expect(routedEnv).toContain('PM_SHARED_USER_TOKEN=tid.secret')
  })
  it('rewrites loopback shared API URLs for the Docker stream MCP service', () => {
    const routedEnv = renderEnv({
      ...answers,
      mcpRuntime: 'stream',
      personalMemoryEnabled: true,
      memoryInstallMode: 'personal-and-shared',
      defaultMemorySurface: 'personal',
      sharedApiUrl: 'http://127.0.0.1:12090',
      sharedUserToken: 'tid.secret',
    }, testSecrets)

    expect(routedEnv).toContain('PM_SHARED_API_URL=http://host.docker.internal:12090')
    expect(routedEnv).toContain('PM_SHARED_USER_TOKEN=tid.secret')
  })
  it('includes every required key the stack reads', () => {
    for (const key of ['QDRANT_URL', 'REDIS_URL', 'MINIO_ENDPOINT', 'GRAPHITI_URL', 'API_PORT', 'SEMAPHORE_LIMIT']) {
      expect(env).toContain(`${key}=`)
    }
  })
})

describe('maskEnv', () => {
  it('masks secret values but keeps non-secret lines', () => {
    const env = renderEnv(answers, {
      tokenPepper: 'abcdefghij',
      postgresPassword: 'p',
      pmAppPassword: 'q',
      minioRootPassword: 'r',
      falkordbPassword: 'falkorsecrettok12',
      qdrantApiKey: 'qdrantsecrettok12',
      dockerControlToken: 'topsecrettoken12',
      updateRunnerToken: 'updatesecrettok12',
      usageIngestToken: 'usagesecrettok12',
    })
    const masked = maskEnv(env)
    expect(masked).not.toContain('TOKEN_PEPPER=abcdefghij')
    expect(masked).not.toContain('FALKORDB_PASSWORD=falkorsecrettok12')
    expect(masked).not.toContain('QDRANT_API_KEY=qdrantsecrettok12')
    expect(masked).not.toContain('DOCKER_CONTROL_TOKEN=topsecrettoken12')
    expect(masked).not.toContain('UPDATE_RUNNER_TOKEN=updatesecrettok12')
    expect(masked).toContain('EMBED_MODEL=qwen3-embedding:4b')
  })
})

describe('validateEnvForDeploy', () => {
  const validEnv = renderEnv(answers, testSecrets)
  const parse = (raw: string): Record<string, string> => Object.fromEntries(
    raw.split(/\r?\n/).map((line) => {
      const i = line.indexOf('=')
      return i > 0 ? [line.slice(0, i), line.slice(i + 1)] : null
    }).filter((x): x is [string, string] => x != null),
  )

  it('accepts a rendered full-local env with generated secrets', () => {
    expect(validateEnvForDeploy(parse(validEnv))).toEqual([])
  })

  it('blocks deploys when mandatory or provider-specific values are blank', () => {
    const broken = parse(validEnv)
    broken.ANTHROPIC_API_KEY = ''
    broken.QDRANT_API_KEY = ''
    broken.DATABASE_MIGRATE_URL = ''
    expect(validateEnvForDeploy(broken).map((i) => i.key)).toEqual(expect.arrayContaining([
      'DATABASE_MIGRATE_URL',
      'QDRANT_API_KEY',
      'ANTHROPIC_API_KEY',
    ]))
  })


})

describe('prereq parsers', () => {
  it('parseDockerInfo: running vs not', () => {
    expect(parseDockerInfo('linux', 0).ok).toBe(true)
    expect(parseDockerInfo('Cannot connect to the Docker daemon', 1).ok).toBe(false)
  })
  it('parseComposeVersion: v2 ok, v1 rejected', () => {
    expect(parseComposeVersion('Docker Compose version v2.32.1', 0).ok).toBe(true)
    expect(parseComposeVersion('docker-compose version 1.29.2', 0).ok).toBe(false)
  })
  it('parseNodeVersion: 22.12+ ok', () => {
    expect(parseNodeVersion('v25.6.1').ok).toBe(true)
    expect(parseNodeVersion('v18.0.0').ok).toBe(false)
  })
  it('parseOllamaTags + hasModel', () => {
    const models = parseOllamaTags({ models: [{ name: 'qwen3-embedding:0.6b' }, { name: 'llama3.2:3b' }] })
    expect(models).toHaveLength(2)
    expect(hasModel(models, 'qwen3-embedding:0.6b')).toBe(true)
    expect(hasModel(models, 'nomic-embed-text')).toBe(false)
  })
  it('hasModel matches a bare name against ":latest"', () => {
    expect(hasModel([{ name: 'foo:latest' }], 'foo')).toBe(true)
  })
  it('all installer aliases block on missing Ollama because the personal stack is always installed', () => {
    const p = {
      node: { ok: true, detail: 'Node v25.6.1.' },
      docker: { ok: true, detail: 'Docker daemon is running.' },
      compose: { ok: true, detail: 'Docker Compose v2.32.1.' },
      ollama: { ok: false, detail: 'Ollama not reachable.' },
    }
    expect(prereqsBlocked('full', p)).toBe(true)
    expect(prereqsBlocked('engine', p)).toBe(true)
    expect(prereqsBlocked('mcp', p)).toBe(true)
    expect(prereqsBlocked('mcp', p, { personalMemoryEnabled: true })).toBe(true)
  })
  it('embedding model presence labels installed vs will-be-installed', () => {
    expect(modelPresence(['qwen3-embedding:4b'], 'qwen3-embedding:4b')).toBe('installed')
    expect(modelPresence(['qwen3-embedding:0.6b:latest'], 'qwen3-embedding:4b')).toBe('will-be-installed')
  })
  it('extraction next gate requires an API key plus a passed fact extraction test', () => {
    expect(extractionNextBlocked({ apiKeyAvailable: false, testPassed: false })).toBe(true)
    expect(extractionNextBlocked({ apiKeyAvailable: true, testPassed: false })).toBe(true)
    expect(extractionNextBlocked({ apiKeyAvailable: true, testPassed: true })).toBe(false)
  })
  it('extraction test probe uses the provider authentication accepted by runtime extraction', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const verdict = JSON.stringify({
      outcome: 'accept',
      facts: ['component_fact_extraction_probe validates the selected extraction model and key.'],
      restructured_content: '',
      reason: '',
      missing: [],
      suggestion: null,
      confidence: 0.92,
    })
    const fakeFetch = (async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} })
      const body = String(url).includes('anthropic.com')
        ? { content: [{ type: 'text', text: verdict }] }
        : { choices: [{ message: { content: verdict } }] }
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch

    await testExtractionConnection({
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      apiKey: 'sk-ant-api03-standard',
    }, fakeFetch)
    expect(calls[0]?.url).toBe('https://api.anthropic.com/v1/messages')
    expect(calls[0]?.init.headers).toMatchObject({
      'x-api-key': 'sk-ant-api03-standard',
      'anthropic-version': '2023-06-01',
    })

    await testExtractionConnection({
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      apiKey: 'sk-ant-oat01-token',
    }, fakeFetch)
    expect(calls[1]?.init.headers).toMatchObject({
      authorization: 'Bearer sk-ant-oat01-token',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'oauth-2025-04-20',
    })
    expect(calls[1]?.init.headers).not.toHaveProperty('x-api-key')

    await testExtractionConnection({
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: 'sk-openai',
    }, fakeFetch)
    expect(calls[2]?.url).toBe('https://api.openai.com/v1/chat/completions')
    expect(calls[2]?.init.headers).toMatchObject({ authorization: 'Bearer sk-openai' })
  })
  it('macOS missing Homebrew is a manual prerequisite before brew-backed tools', () => {
    const manual = homebrewManualInstallCommands('arm64')
    expect(manual.installCommand).toBe('/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"')
    expect(manual.pathCommand).toBe('echo \'eval "$(/opt/homebrew/bin/brew shellenv)"\' >> ~/.zprofile')
    expect(manual.activateCommand).toBe('eval "$(/opt/homebrew/bin/brew shellenv)"')

    expect(() => buildPrereqInstallPlan('ollama', {
      platform: 'darwin',
      brewPath: null,
      hasDocker: false,
      hasCompose: false,
      hasOllama: false,
    })).toThrow(/Install Homebrew manually/)
  })
  it('compose repair reinstalls Docker Desktop even when docker itself is present', () => {
    const plan = buildPrereqInstallPlan('compose', {
      platform: 'darwin',
      brewPath: '/opt/homebrew/bin/brew',
      hasDocker: true,
      hasCompose: false,
      hasOllama: true,
    })
    expect(plan.map((s) => s.id)).toEqual(['install-docker', 'start-docker'])
  })
  it('node repair installs and links Node 24 through Homebrew', () => {
    const plan = buildPrereqInstallPlan('node', {
      platform: 'darwin',
      brewPath: '/opt/homebrew/bin/brew',
      hasDocker: true,
      hasCompose: true,
      hasOllama: true,
    })
    expect(plan.map((s) => s.id)).toEqual(['install-node', 'link-node'])
    expect(plan[0]?.cmd).toEqual(['/opt/homebrew/bin/brew', 'install', 'node@24'])
    expect(plan[1]?.cmd).toEqual(['/opt/homebrew/bin/brew', 'link', '--overwrite', '--force', 'node@24'])
  })
})

describe('shell env helper', () => {
  it('reads .env values with shell metacharacters without executing them', () => {
    const root = fileURLToPath(new URL('../../..', import.meta.url))
    const dir = mkdtempSync(join(tmpdir(), 'pm-env-'))
    const envFile = join(dir, '.env.persistent-memory')
    writeFileSync(envFile, [
      'ANTHROPIC_API_KEY=sk-ant&d_FiAJEtNXk4lKxFpGUg-95SPpAAA',
      'PM_APP_PASSWORD=pa ss"word',
      '',
    ].join('\n'))

    const readEnv = (key: string) => execFileSync('bash', [
      '-c',
      'set -euo pipefail; source "$1"; pm_env_get "$2" fallback "$3"',
      'bash',
      join(root, 'deploy/scripts/lib/env.sh'),
      key,
      envFile,
    ], { encoding: 'utf8' }).trimEnd()

    try {
      expect(readEnv('ANTHROPIC_API_KEY')).toBe('sk-ant&d_FiAJEtNXk4lKxFpGUg-95SPpAAA')
      expect(readEnv('PM_APP_PASSWORD')).toBe('pa ss"word')
      expect(readEnv('MISSING')).toBe('fallback')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('backfills missing template keys without overwriting local values and validates required deploy env', () => {
    const root = fileURLToPath(new URL('../../..', import.meta.url))
    const dir = mkdtempSync(join(tmpdir(), 'pm-env-'))
    const envFile = join(dir, '.env.persistent-memory')
    const templateFile = join(dir, '.env.persistent-memory.example')
    writeFileSync(templateFile, [
      'KEEP=template',
      'NEW_VALUE=from-template',
      'EMPTY_OPTIONAL=',
      '',
    ].join('\n'))
    writeFileSync(envFile, 'KEEP=local\n')

    const helper = join(root, 'deploy/scripts/lib/env.sh')
    execFileSync('bash', [
      '-c',
      'set -euo pipefail; source "$1"; pm_env_backfill_missing_from_template "$2" "$3"',
      'bash',
      helper,
      envFile,
      templateFile,
    ])
    const out = execFileSync('bash', [
      '-c',
      'set -euo pipefail; source "$1"; pm_env_get KEEP missing "$2"; pm_env_get NEW_VALUE missing "$2"; pm_env_get EMPTY_OPTIONAL fallback "$2"',
      'bash',
      helper,
      envFile,
    ], { encoding: 'utf8' }).split(/\r?\n/).slice(0, 3)
    try {
      expect(out).toEqual(['local', 'from-template', ''])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('install steps', () => {
  it('rebuilds a complete agent refresh bundle when a stale dist folder is partial', async () => {
    const root = fileURLToPath(new URL('../../..', import.meta.url))
    const dist = join(root, 'apps/onboard/dist')
    const sourceTemplate = join(root, 'apps/onboard/templates/persistent-memory-rule.md')
    const compiledTemplate = join(dist, 'apps/onboard/templates/persistent-memory-rule.md')
    const sourcePrompt = join(root, 'prompts/fact-extraction.md')
    const compiledPrompt = join(dist, 'prompts/fact-extraction.md')
    const compiledServer = join(dist, 'apps/onboard/server')
    const agentUpdate = join(compiledServer, 'agent-update.js')
    const register = join(compiledServer, 'register.js')
    const rule = join(compiledServer, 'rule.js')

    rmSync(dist, { recursive: true, force: true })
    execFileSync('npm', ['run', 'build:server', '--prefix', 'apps/onboard'], { cwd: root })

    expect(readFileSync(compiledTemplate, 'utf8')).toBe(readFileSync(sourceTemplate, 'utf8'))
    expect(readFileSync(compiledPrompt, 'utf8')).toBe(readFileSync(sourcePrompt, 'utf8'))
    expect(readFileSync(agentUpdate, 'utf8')).toContain("from './register.js'")
    expect(readFileSync(register, 'utf8')).toContain('export')
    expect(readFileSync(rule, 'utf8')).toContain('export')

    rmSync(register)
    expect(() => readFileSync(register, 'utf8')).toThrow()

    execFileSync('npm', ['run', 'build:server', '--prefix', 'apps/onboard'], { cwd: root })
    expect(readFileSync(register, 'utf8')).toContain('export')
    await expect(import(`${pathToFileURL(agentUpdate).href}?rebuilt=${Date.now()}`)).resolves.toBeDefined()

    const compiledExtraction = await import(`${pathToFileURL(join(compiledServer, 'extraction-test.js')).href}?rebuilt=${Date.now()}`) as {
      testExtractionConnection: typeof testExtractionConnection
    }
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fakeFetch = (async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} })
      const verdict = { outcome: 'accept', facts: ['The compiled extraction probe works.'], restructured_content: '', reason: '', missing: [] }
      return new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(verdict) }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch
    const result = await compiledExtraction.testExtractionConnection({
      provider: 'anthropic', model: 'mock-extraction-model', apiKey: 'placeholder-test-key',
    }, fakeFetch)
    expect(result).toMatchObject({ ok: true, outcome: 'accept' })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/messages')
    expect(JSON.parse(String(calls[0]!.init.body)).system).toBe(readFileSync(sourcePrompt, 'utf8'))
  }, 15_000)

  it('root setup refreshes agent artifacts so older update scripts carry prompt/rule migrations after pull', () => {
    const root = fileURLToPath(new URL('../../..', import.meta.url))
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    expect(pkg.scripts.setup).toBe('node scripts/setup.mjs')
    expect(readFileSync(join(root, 'scripts/setup.mjs'), 'utf8')).toContain('apps/onboard/dist/apps/onboard/server/agent-update.js')
  })

  it('update-persistent-memory refreshes installed agent artifacts after pulling the new rule template', () => {
    const root = fileURLToPath(new URL('../../..', import.meta.url))
    const script = readFileSync(join(root, 'deploy/scripts/update.sh'), 'utf8')

    expect(script).toContain('refresh_agent_artifacts()')
    expect(script).toContain('npm run --silent build:server --prefix "$onboard_dir"')
    expect(script).toContain('dist/apps/onboard/server/register.js')
    expect(script).toContain('dist/apps/onboard/server/rule.js')
    expect(script).toContain('dist/apps/onboard/templates/persistent-memory-rule.md')
    expect(script).toContain('node "$REPO_ROOT/apps/onboard/dist/apps/onboard/server/agent-update.js"')
    expect(script).toMatch(/refresh_agent_artifacts\s*\n\s*wait_for_dashboard_ready/)
  })

  it('exposes a user-facing full uninstall command with export-before-wipe safeguards', () => {
    const root = fileURLToPath(new URL('../../..', import.meta.url))
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    const scriptPath = join(root, 'deploy/scripts/uninstall.sh')
    const script = readFileSync(scriptPath, 'utf8')

    expect(pkg.scripts['uninstall-persistent-memory']).toBe('node scripts/host-lifecycle.mjs uninstall')
    expect(execFileSync('bash', ['-n', scriptPath], { encoding: 'utf8' })).toBe('')
    expect(script).toContain('pm.memory-export/1')
    expect(script).toContain('pm.secure-memory-export/1')
    expect(script).toContain('PBKDF2-SHA256')
    expect(script).toContain('AES-GCM')
    expect(script).toContain('210000')
    expect(script).toContain('SELECT count(*) FROM public.memory')
    expect(script).toContain('docker compose')
    expect(script).toContain('down --remove-orphans --volumes --rmi all')
    expect(script).toContain('docker image rm -f')
    expect(script).toContain('persistent-memory-')
    expect(script).toContain('rm -f \"$ENV_RUNTIME\"')
    expect(script).toContain('POSTGRES_STATE_MISSING=1')
    expect(script).toContain('No memory database found; skipping export prompt.')
    expect(script).not.toContain('mapfile')
    expect(script).not.toContain("'teamId', m.team_id::text")
    expect(script).not.toContain("'teamName'")
    expect(script).not.toContain("'teamId', NULL")
  })

  it('cleans unchanged installer-owned agent artifacts in a disposable fake home without touching sibling config', () => {
    const root = fileURLToPath(new URL('../../..', import.meta.url))
    const home = mkdtempSync(join(tmpdir(), 'persistent-memory-uninstall-home-'))
    const claudeConfig = join(home, '.claude.json')
    const codexConfig = join(home, '.codex', 'config.toml')
    const claudeRule = join(home, '.claude', 'rules', 'persistent-memory.md')
    const claudeMemory = join(home, '.claude', 'CLAUDE.md')
    const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
    try {
      mkdirSync(join(home, '.codex'), { recursive: true })
      mkdirSync(join(home, '.claude', 'rules'), { recursive: true })
      writeFileSync(claudeConfig, JSON.stringify({ mcpServers: { unrelated: { url: 'https://example.test' }, 'persistent-memory': { url: 'http://127.0.0.1:8091/mcp' } }, projects: { '/existing-project': { mcpServers: { 'persistent-memory': { url: 'https://existing.example.test/mcp' } } } } }, null, 2))
      writeFileSync(codexConfig, '[mcp_servers.unrelated]\nurl = "https://example.test"\n\n[mcp_servers.persistent-memory]\nurl = "http://127.0.0.1:8091/mcp"\n')
      writeFileSync(claudeRule, '# Persistent Memory rule\n')
      writeFileSync(claudeMemory, '# Local instructions\n\n## Persistent Memory Usage (MANDATORY)\n\n- Detailed protocol: @rules/persistent-memory.md\n\n## Keep this\n\nUnrelated Markdown section.\n')
      const artifacts = [
        { path: claudeConfig, artifactType: 'mcp-registration', scope: 'global', digest: digest(claudeConfig) },
        { path: codexConfig, artifactType: 'mcp-registration', scope: 'global', digest: digest(codexConfig) },
        { path: claudeRule, artifactType: 'memory-rule', scope: 'global', digest: digest(claudeRule) },
        { path: claudeMemory, artifactType: 'memory-reference', scope: 'global', digest: digest(claudeMemory) },
      ]
      mkdirSync(join(home, '.persistent-memory'), { recursive: true })
      writeFileSync(join(home, '.persistent-memory', 'installer-ownership.json'), JSON.stringify({ version: 1, artifacts }))

      const output = execFileSync('bash', ['deploy/scripts/uninstall.sh', '--agent-cleanup-only'], {
        cwd: root,
        env: { ...process.env, HOME: home },
        encoding: 'utf8',
      })

      expect(output).toContain('Removed installer-owned agent artifact')
      expect(output).toContain('Created timestamped backup')
      const cleanedClaude = JSON.parse(readFileSync(claudeConfig, 'utf8'))
      expect(cleanedClaude.mcpServers).toEqual({ unrelated: { url: 'https://example.test' } })
      expect(cleanedClaude.projects['/existing-project'].mcpServers['persistent-memory']).toEqual({ url: 'https://existing.example.test/mcp' })
      expect(readFileSync(codexConfig, 'utf8')).toContain('[mcp_servers.unrelated]')
      expect(readFileSync(codexConfig, 'utf8')).not.toContain('persistent-memory')
      expect(() => readFileSync(claudeRule, 'utf8')).toThrow()
      expect(readFileSync(claudeMemory, 'utf8')).toContain('Unrelated Markdown section.')
      expect(readFileSync(claudeMemory, 'utf8')).not.toContain('Persistent Memory Usage (MANDATORY)')
      expect(() => readFileSync(join(home, '.persistent-memory', 'installer-ownership.json'), 'utf8')).toThrow()
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('hostRewriteUrl points the migrate URL at the host port', () => {
    expect(hostRewriteUrl('postgresql://pmuser:x@persistent-memory-postgres:5432/persistent_memory')).toBe(
      'postgresql://pmuser:x@localhost:5433/persistent_memory',
    )
  })
  it('buildSteps (full flow) yields the proven ordered commands + register/rule, host-rewritten DB URL', () => {
    const steps = buildSteps({ flow: 'full', env: { DATABASE_MIGRATE_URL: 'postgresql://pmuser:x@persistent-memory-postgres:5432/persistent_memory', PM_APP_PASSWORD: 'APPPW', EMBED_PROVIDER: 'ollama', EMBED_MODEL: 'qwen3-embedding:4b' } })
    expect(steps.map((s) => s.id)).toEqual(['deps', 'pull-model', 'compose-up', 'wait-postgres', 'prisma-migrate', 'rls', 'seed', 'restart-app', 'wait-mcp', 'verify', 'register', 'write-rule'])
    // The deps step makes the single `npm run install-persistent-memory` self-contained:
    // it installs the workspace + generates the Prisma client the host-side seed needs.
    expect(steps.find((s) => s.id === 'deps')!.cmd).toEqual(['npm', 'run', 'setup'])
    expect(steps.find((s) => s.id === 'pull-model')!.kind).toBe('ollama-model')
    const migrate = steps.find((s) => s.id === 'prisma-migrate')!
    expect(migrate.cwd).toBe('layers/core/schema')
    expect(migrate.envOverride!.DATABASE_MIGRATE_URL).toContain('localhost:5433')
    const rls = steps.find((s) => s.id === 'rls')!
    expect(rls.cmd).toEqual(['bash', 'deploy/scripts/apply-rls.sh'])
    expect(rls.cwd).toBe('')
    expect(rls.envOverride!.PM_APP_PASSWORD).toBe('APPPW')
    const seed = steps.find((s) => s.id === 'seed')!
    expect(seed.cwd).toBe('layers/core/schema')
    expect(seed.captureToken).toBe(true)
    expect(steps.find((s) => s.id === 'wait-postgres')!.kind).toBe('wait')
    expect(steps.find((s) => s.id === 'wait-mcp')!.kind).toBe('wait')
    expect(steps.find((s) => s.id === 'wait-mcp')!.cmd).toEqual(['docker', 'inspect', '-f', '{{.State.Health.Status}}', 'persistent-memory-mcp'])
    const composeUp = steps.find((s) => s.id === 'compose-up')!
    expect(composeUp.cmd).toEqual(['docker', 'compose', '-f', 'deploy/compose/docker-compose.yml', '--env-file', '.env.persistent-memory', 'up', '-d', '--build'])
    expect(composeUp.envOverride?.COMPOSE_PROFILES).toBe('mcp-stream')
    expect(composeUp.envOverride?.COMPOSE_PARALLEL_LIMIT).toBe('1')
    expect(steps.find((s) => s.id === 'restart-app')!.cmd).toEqual([
      'docker',
      'compose',
      '-f',
      'deploy/compose/docker-compose.yml',
      '--env-file',
      '.env.persistent-memory',
      'up',
      '-d',
      '--force-recreate',
      '--no-deps',
      'api',
      'worker',
    ])
  })
  it('legacy command-runtime input still installs stream MCP and never builds the old local command launcher', () => {
    const steps = buildSteps({ flow: 'full', mcpRuntime: 'node', env: { DATABASE_MIGRATE_URL: 'postgresql://pmuser:x@persistent-memory-postgres:5432/persistent_memory', PM_APP_PASSWORD: 'APPPW' } })
    expect(steps.map((s) => s.id)).not.toContain('build-mcp-node')
    expect(steps.find((s) => s.id === 'compose-up')!.envOverride?.COMPOSE_PROFILES).toBe('mcp-stream')
    expect(steps.find((s) => s.id === 'compose-up')!.envOverride?.COMPOSE_PARALLEL_LIMIT).toBe('1')
    expect(steps.slice(-2).map((s) => s.id)).toEqual(['register', 'write-rule'])
  })
  it('local mode initializes settings without minting a bootstrap token', () => {
    const steps = buildSteps({ flow: 'full', env: { DATABASE_MIGRATE_URL: 'postgresql://pmuser:x@persistent-memory-postgres:5432/persistent_memory', PM_APP_PASSWORD: 'APPPW', DEPLOYMENT_MODE: 'local' } })
    const seed = steps.find((s) => s.id === 'seed')!
    expect(seed.captureToken).toBeFalsy()
    expect(seed.name).toBe('Initialize local system settings')
  })
  it('legacy client flow installs the local personal stack before MCP registration', () => {
    const steps = buildSteps({
      flow: 'mcp',
      personalMemoryEnabled: true,
      mcpRuntime: 'node',
      env: {
        DATABASE_MIGRATE_URL: 'postgresql://pmuser:x@persistent-memory-postgres:5432/persistent_memory',
        PM_APP_PASSWORD: 'APPPW',
        DEPLOYMENT_MODE: 'local',
        EMBED_PROVIDER: 'ollama',
        EMBED_MODEL: 'qwen3-embedding:4b',
      },
    })
    expect(steps.map((s) => s.id)).toEqual([
      'deps',
      'pull-model',
      'compose-up',
      'wait-postgres',
      'prisma-migrate',
      'rls',
      'seed',
      'restart-app',
      'wait-mcp',
      'verify',
      'register',
      'write-rule',
    ])
    expect(steps.find((s) => s.id === 'compose-up')?.envOverride?.COMPOSE_PROFILES).toBe('mcp-stream')
    expect(steps.find((s) => s.id === 'seed')?.captureToken).toBeFalsy()
  })
  it('client flow with isolated personal memory can start the shared stream MCP service', () => {
    const steps = buildSteps({
      flow: 'engine',
      personalMemoryEnabled: true,
      mcpRuntime: 'stream',
      env: {
        DATABASE_MIGRATE_URL: 'postgresql://pmuser:x@persistent-memory-postgres:5432/persistent_memory',
        PM_APP_PASSWORD: 'APPPW',
        DEPLOYMENT_MODE: 'local',
        EMBED_PROVIDER: 'ollama',
        EMBED_MODEL: 'qwen3-embedding:4b',
      },
    })
    expect(steps.map((s) => s.id)).not.toContain('build-mcp-node')
    expect(steps.find((s) => s.id === 'compose-up')?.envOverride?.COMPOSE_PROFILES).toBe('mcp-stream')
  })
  it('shared connection step happens after local personal stack verification', () => {
    const steps = buildSteps({
      flow: 'engine',
      mcpRuntime: 'stream',
      env: {
        DATABASE_MIGRATE_URL: 'postgresql://pmuser:x@persistent-memory-postgres:5432/persistent_memory',
        PM_APP_PASSWORD: 'APPPW',
        DEPLOYMENT_MODE: 'local',
        EMBED_PROVIDER: 'ollama',
        EMBED_MODEL: 'qwen3-embedding:4b',
      },
      memoryInstallMode: 'personal-and-shared',
      pullModel: 'qwen3-embedding:4b',
      streamApiUrl: 'http://127.0.0.1:12090',
      streamToken: 'tid.secret',
      streamOllamaUrl: 'http://localhost:11434',
    })
    expect(steps.map((s) => s.id)).toEqual([
      'deps',
      'pull-model',
      'compose-up',
      'wait-postgres',
      'prisma-migrate',
      'rls',
      'seed',
      'restart-app',
      'wait-mcp',
      'verify',
      'pull-shared-model',
      'shared-connect',
      'register',
      'write-rule',
    ])
    expect(steps.findIndex((s) => s.id === 'verify')).toBeLessThan(steps.findIndex((s) => s.id === 'shared-connect'))
    expect(steps.find((s) => s.id === 'shared-connect')?.kind).toBe('fn')
  })
  it('extractToken matches the seed banner, "already present", or neither', () => {
    expect(extractToken('  Token: abc123.secretvalue\n')).toEqual({ token: 'abc123.secretvalue' })
    expect(extractToken('[seed] Superuser already present (1). Skipping.')).toEqual({ already: true })
    expect(extractToken('some unrelated banner line')).toBeNull()
  })
  it.each(['\n', '\r\n'])('parseVerifySummary reads the final numeric totals with %j newlines', (newline) => {
    const output = [
      ...Array.from({ length: 38 }, (_, i) => `  PASS  Check ${i + 1}`),
      '  PASS  Qdrant /readyz OK',
      '',
      '  Verification Results',
      '  PASS: 39',
      '  FAIL: 0',
      '  WARN: 0',
      '  All checks passed!',
    ].join(newline)
    expect(parseVerifySummary(output)).toEqual({ pass: 39, fail: 0, warn: 0 })
    expect(parseVerifySummary(output.slice(output.indexOf('  Verification Results'))))
      .toEqual({ pass: 39, fail: 0, warn: 0 })
  })
  it('parseVerifySummary counts only check prefixes when numeric totals are absent', () => {
    const output = [
      '  PASS  Docker running',
      '  PASS  Qdrant /readyz OK',
      '  WARN  Ollama model missing',
      '  FAIL  API unreachable',
      'Diagnostic mentions PASS, FAIL, ERROR and WARN without being a check.',
    ].join('\n')
    expect(parseVerifySummary(output)).toEqual({ pass: 2, fail: 1, warn: 1 })
  })
})

describe('planRegistration (apps + scope → exact config writes)', () => {
  const home = '/home/u'
  it('global stream: Claude → ~/.claude.json only; Codex CLI/Desktop → shared ~/.codex', () => {
    const plan = planRegistration({ apps: { claudeCli: true, claudeDesktop: true, codexCli: true, codexDesktop: true }, level: 'global', projectPaths: [], home, mcpRuntime: 'stream' })
    expect(plan.writes.find((w) => w.kind === 'claude' && w.path === join(home, '.claude.json'))).toMatchObject({ level: 'global', clientName: 'claude-code' })
    expect(plan.writes.some((w) => w.path.endsWith('claude_desktop_config.json'))).toBe(false)
    expect(plan.writes.find((w) => w.kind === 'codex' && w.path === join(home, '.codex', 'config.toml'))).toMatchObject({ clientName: 'codex' })
  })
  it('global legacy node input does not write Claude Desktop standalone stdio config', () => {
    const plan = planRegistration({ apps: { claudeCli: true, claudeDesktop: true, codexCli: false, codexDesktop: false }, level: 'global', projectPaths: [], home, mcpRuntime: 'node' })
    expect(plan.writes.find((w) => w.kind === 'claude' && w.path === join(home, '.claude.json'))).toMatchObject({ level: 'global', clientName: 'claude-code' })
    expect(plan.writes.some((w) => w.path.endsWith('claude_desktop_config.json'))).toBe(false)
  })
  it('project: Desktop folder sessions use ~/.claude.json projects.<path>; Codex writes per-folder; standalone chat is SKIPPED', () => {
    const plan = planRegistration({ apps: { claudeCli: false, claudeDesktop: true, codexCli: false, codexDesktop: true }, level: 'project', projectPaths: ['/a', '/b'], home, mcpRuntime: 'stream' })
    const cj = plan.writes.find((w) => w.kind === 'claude' && w.path === join(home, '.claude.json'))
    expect(cj?.level).toBe('project')
    expect(cj?.projectPaths).toEqual(['/a', '/b'])
    expect(plan.writes.some((w) => w.path.endsWith('claude_desktop_config.json'))).toBe(false) // global-only surface, skipped under project scope
    expect(plan.writes.filter((w) => w.kind === 'codex').map((w) => w.path)).toEqual([join('/a', '.codex', 'config.toml'), join('/b', '.codex', 'config.toml')])
    expect(plan.writes.filter((w) => w.kind === 'codex').map((w) => w.clientName)).toEqual(['codex-desktop', 'codex-desktop'])
  })
  it('project with no usable folders fails instead of writing global configuration', () => {
    expect(() => planRegistration({ apps: { claudeCli: true, claudeDesktop: false, codexCli: true, codexDesktop: false }, level: 'project', projectPaths: ['  '], home, mcpRuntime: 'stream' })).toThrow(/folder/i)
  })
  it('no selected agent apps → no writes', () => {
    const plan = planRegistration({ apps: { claudeCli: false, claudeDesktop: false, codexCli: false, codexDesktop: false }, level: 'global', projectPaths: [], home, mcpRuntime: 'stream' })
    expect(plan.writes).toHaveLength(0)
  })
})
