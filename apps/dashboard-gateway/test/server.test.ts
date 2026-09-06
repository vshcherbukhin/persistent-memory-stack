import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createUpdateHtml,
  readHandoffState,
  route,
  sanitizeProxyResponseHeaders,
  shouldServeUpdateShell,
  type GatewayResponse,
  type ProxyRequest,
} from '../src/server.ts'

const tmpRoots: string[] = []

async function tempStatePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pm-gateway-'))
  tmpRoots.push(dir)
  return join(dir, 'dashboard-handoff.json')
}

async function tempStateFile(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pm-gateway-state-'))
  tmpRoots.push(dir)
  return join(dir, name)
}

afterEach(async () => {
  await Promise.all(tmpRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('dashboard handoff state', () => {
  it.each(['updating', 'failed', 'complete'])('ignores pre-public %s state without deleting the saved file', async (phase) => {
    const statePath = await tempStatePath()
    for (const releaseLine of [undefined, 'internal']) {
      const saved = JSON.stringify({ releaseLine, id: 'before-public-release', source: 'update-script', phase,
        message: 'Old development state.', targetVersion: '4.0.37',
        startedAt: '2026-09-04T10:00:00Z', updatedAt: '2026-09-04T10:01:00Z' })
      await writeFile(statePath, saved)
      await expect(readHandoffState(statePath)).resolves.toEqual({ active: false, phase: 'idle' })
      const result = await route({ method: 'GET', url: '/', headers: { accept: 'text/html' } }, {
        statePath, dashboardBaseUrl: 'http://dashboard:3000',
        proxy: async () => ({ status: 200, headers: {}, body: 'Public dashboard' }),
      })
      expect(result.body).toBe('Public dashboard')
      expect(await readFile(statePath, 'utf8')).toBe(saved)
    }
  })

  it('passes public release identity through the handoff API and uses matching browser keys', async () => {
    const statePath = await tempStatePath()
    await writeFile(statePath, JSON.stringify({ releaseLine: 'public-v1', id: 'public-update', source: 'update-script', phase: 'complete',
      message: 'Update complete.', targetVersion: '1.0.0', releaseNotesVersion: '1.0.0',
      startedAt: '2026-09-06T10:00:00Z', updatedAt: '2026-09-06T10:01:00Z' }))
    const result = await route({ method: 'GET', url: '/api/update/handoff', headers: {} }, {
      statePath, dashboardBaseUrl: 'http://dashboard:3000', proxy: vi.fn(),
    })
    expect(JSON.parse(result.body as string)).toMatchObject({ releaseLine: 'public-v1', active: true, targetVersion: '1.0.0' })
    const html = createUpdateHtml(await readHandoffState(statePath))
    const client = await import('../../../layers/dashboard/src/lib/clientUpdate.ts')
    for (const key of [client.POST_UPDATE_RELEASE_NOTES_KEY, client.POST_UPDATE_HANDOFF_SEEN_KEY]) {
      expect(html).toContain(key)
    }
  })

  it('retains a valid read-only progress probe and drops malformed probe payloads', async () => {
    const statePath = await tempStatePath()
    await writeFile(statePath, JSON.stringify({ releaseLine: 'public-v1',
      id: 'probe-run', source: 'update-script', phase: 'verifying', message: 'Graph migration running.',
      startedAt: '2026-07-16T00:00:00Z', updatedAt: '2026-07-16T00:01:00Z',
      probe: { message: 'Graph migration: 295 / 329 complete — 34 remaining.', completed: 295, total: 329, remaining: 34, checkedAt: '2026-07-16T00:01:00Z' },
    }))

    await expect(readHandoffState(statePath)).resolves.toMatchObject({
      probe: { completed: 295, total: 329, remaining: 34 },
    })

    await writeFile(statePath, JSON.stringify({ releaseLine: 'public-v1',
      id: 'bad-probe', source: 'update-script', phase: 'verifying', message: 'Graph migration running.',
      startedAt: '2026-07-16T00:00:00Z', updatedAt: '2026-07-16T00:01:00Z',
      probe: { message: 'bad', completed: 2, total: 3, remaining: 0, checkedAt: '2026-07-16T00:01:00Z' },
    }))

    await expect(readHandoffState(statePath)).resolves.not.toHaveProperty('probe')
  })

  it('uses coordinator handoff state by default in the production image and retains the legacy fallback', async () => {
    const dockerfile = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8')
    expect(dockerfile).toContain('HANDOFF_STATE_PATH=/run/persistent-memory/update-coordinator-state/dashboard-handoff.json')
    expect(dockerfile).toContain('LEGACY_HANDOFF_STATE_PATH=/run/persistent-memory/update-state/dashboard-handoff.json')
  })

  it('uses the coordinator state as canonical while retaining one legacy-state read fallback', async () => {
    const coordinatorStatePath = await tempStateFile('coordinator-handoff.json')
    const legacyStatePath = await tempStateFile('legacy-handoff.json')
    await writeFile(legacyStatePath, JSON.stringify({ releaseLine: 'public-v1',
      id: 'legacy-run', source: 'update-script', phase: 'updating', message: 'Legacy update.',
      startedAt: '2026-07-06T10:00:00Z', updatedAt: '2026-07-06T10:00:01Z',
    }))

    await expect(readHandoffState(coordinatorStatePath, legacyStatePath)).resolves.toMatchObject({ id: 'legacy-run' })

    await writeFile(coordinatorStatePath, JSON.stringify({ releaseLine: 'public-v1',
      protocolVersion: 1, id: 'coordinator-run', source: 'update-coordinator', phase: 'verifying', message: 'Coordinator update.',
      startedAt: '2026-07-06T10:00:00Z', updatedAt: '2026-07-06T10:00:02Z',
    }))
    await expect(readHandoffState(coordinatorStatePath, legacyStatePath)).resolves.toMatchObject({ id: 'coordinator-run' })
  })

  it('prefers a newer legacy start event over a completed coordinator event, then returns to coordinator state', async () => {
    const coordinatorStatePath = await tempStateFile('coordinator-handoff.json')
    const legacyStatePath = await tempStateFile('legacy-handoff.json')
    await writeFile(coordinatorStatePath, JSON.stringify({ releaseLine: 'public-v1',
      protocolVersion: 1, id: 'previous-run', source: 'update-coordinator', phase: 'complete', message: 'Previous update finished.',
      startedAt: '2026-07-06T10:00:00Z', updatedAt: '2026-07-06T10:10:00Z', finishedAt: '2026-07-06T10:10:00Z',
    }))
    await writeFile(legacyStatePath, JSON.stringify({ releaseLine: 'public-v1',
      id: 'new-run', source: 'update-script', phase: 'updating', message: 'New update is starting.',
      startedAt: '2026-07-06T11:00:00Z', updatedAt: '2026-07-06T11:00:01Z',
    }))
    await expect(readHandoffState(coordinatorStatePath, legacyStatePath)).resolves.toMatchObject({ id: 'new-run' })

    await writeFile(coordinatorStatePath, JSON.stringify({ releaseLine: 'public-v1',
      protocolVersion: 1, id: 'new-run', source: 'update-coordinator', phase: 'verifying', message: 'Coordinator is verifying.',
      startedAt: '2026-07-06T11:00:00Z', updatedAt: '2026-07-06T11:00:02Z',
    }))
    await expect(readHandoffState(coordinatorStatePath, legacyStatePath)).resolves.toMatchObject({ id: 'new-run', source: 'update-coordinator' })

    await writeFile(coordinatorStatePath, JSON.stringify({ releaseLine: 'public-v1',
      protocolVersion: 1, id: 'new-run', source: 'update-coordinator', phase: 'complete', message: 'Coordinator finished.',
      startedAt: '2026-07-06T11:00:00Z', updatedAt: '2026-07-06T11:10:00Z', finishedAt: '2026-07-06T11:10:00Z',
    }))
    await expect(readHandoffState(coordinatorStatePath, legacyStatePath)).resolves.toMatchObject({ id: 'new-run', phase: 'complete' })
  })

  it('keeps the coordinator state canonical for one active run even if the launcher file is written later', async () => {
    const coordinatorStatePath = await tempStateFile('coordinator-handoff.json')
    const legacyStatePath = await tempStateFile('legacy-handoff.json')
    await writeFile(coordinatorStatePath, JSON.stringify({ releaseLine: 'public-v1',
      protocolVersion: 1, id: 'same-run', source: 'update-coordinator', phase: 'rebuilding-dashboard', message: 'Building images.',
      startedAt: '2026-07-14T08:31:24Z', updatedAt: '2026-07-14T08:32:10Z', progress: 55,
    }))
    await writeFile(legacyStatePath, JSON.stringify({ releaseLine: 'public-v1',
      id: 'same-run', source: 'update-script', phase: 'updating', message: 'Pulling updates.',
      startedAt: '2026-07-14T08:31:24Z', updatedAt: '2026-07-14T08:32:11Z', progress: 18,
    }))

    await expect(readHandoffState(coordinatorStatePath, legacyStatePath)).resolves.toMatchObject({
      source: 'update-coordinator', progress: 55,
    })
  })

  it('keeps browser progress monotonic for a run across gateway reloads', () => {
    const html = createUpdateHtml({ releaseLine: 'public-v1',
      active: true,
      id: 'same-run',
      source: 'update-coordinator',
      phase: 'rebuilding-dashboard',
      message: 'Building images.',
      startedAt: '2026-07-14T08:31:24Z',
      updatedAt: '2026-07-14T08:32:10Z',
      progress: 55,
    })

    expect(html).toContain("const progressStorageKey = 'pm:public-v1:update-handoff-progress'")
    expect(html).toContain('displayedProgress = Math.max(displayedProgress, candidate)')
    expect(html).toContain('sessionStorage.setItem(progressStorageKey')
  })

  it('chooses the newest active event when a stale coordinator run conflicts with a fresh legacy launcher', async () => {
    const coordinatorStatePath = await tempStateFile('coordinator-handoff.json')
    const legacyStatePath = await tempStateFile('legacy-handoff.json')
    await writeFile(coordinatorStatePath, JSON.stringify({ releaseLine: 'public-v1',
      protocolVersion: 1, id: 'stale-run', source: 'update-coordinator', phase: 'failed', message: 'Old update failed.',
      startedAt: '2026-07-06T10:00:00Z', updatedAt: '2026-07-06T10:10:00Z',
    }))
    await writeFile(legacyStatePath, JSON.stringify({ releaseLine: 'public-v1',
      id: 'fresh-run', source: 'update-script', phase: 'updating', message: 'New update is starting.',
      startedAt: '2026-07-06T11:00:00Z', updatedAt: '2026-07-06T11:00:01Z',
    }))

    await expect(readHandoffState(coordinatorStatePath, legacyStatePath)).resolves.toMatchObject({ id: 'fresh-run' })
  })

  it('serves a non-blocking compatibility page for an unknown future handoff protocol', async () => {
    const statePath = await tempStatePath()
    await writeFile(statePath, JSON.stringify({ releaseLine: 'public-v1', protocolVersion: 2, id: 'future', phase: 'updating' }))

    const result = await route({
      method: 'GET',
      url: '/overview',
      headers: { accept: 'text/html' },
    }, {
      statePath,
      dashboardBaseUrl: 'http://dashboard:3000',
      proxy: vi.fn(),
    })

    expect(result.status).toBe(200)
    expect(result.body).toContain('Live update view is unavailable for this dashboard version')
  })

  it('treats every explicit non-v1 protocol value as an advisory compatibility event', async () => {
    const statePath = await tempStatePath()
    await writeFile(statePath, JSON.stringify({ releaseLine: 'public-v1', protocolVersion: '1', id: 'invalid-version', phase: 'updating' }))

    await expect(readHandoffState(statePath)).resolves.toMatchObject({
      active: true,
      compatibility: true,
      id: 'invalid-version',
    })
  })

  it('returns idle when the handoff file is missing or invalid', async () => {
    const statePath = await tempStatePath()

    await expect(readHandoffState(statePath)).resolves.toEqual({ phase: 'idle', active: false })
    await writeFile(statePath, '{"phase": "updating"}\n')
    await expect(readHandoffState(statePath)).resolves.toEqual({ phase: 'idle', active: false })
  })

  it('parses active and complete states without exposing unknown fields', async () => {
    const statePath = await tempStatePath()
    await writeFile(statePath, JSON.stringify({ releaseLine: 'public-v1',
      id: 'run-1',
      source: 'update-script',
      phase: 'rebuilding-dashboard',
      message: 'Dashboard is restarting.',
      startedAt: '2026-07-06T10:00:00Z',
      updatedAt: '2026-07-06T10:01:00Z',
      targetVersion: '4.0.6',
      releaseNotesVersion: '4.0.6',
      progress: 42,
      secret: 'must-not-leak',
    }))

    await expect(readHandoffState(statePath)).resolves.toEqual({
      active: true,
      releaseLine: 'public-v1',
      id: 'run-1',
      source: 'update-script',
      phase: 'rebuilding-dashboard',
      message: 'Dashboard is restarting.',
      startedAt: '2026-07-06T10:00:00Z',
      updatedAt: '2026-07-06T10:01:00Z',
      targetVersion: '4.0.6',
      releaseNotesVersion: '4.0.6',
      progress: 42,
    })
  })

  it('accepts bounded build activity while ignoring malformed activity data', async () => {
    const statePath = await tempStatePath()
    await writeFile(statePath, JSON.stringify({ releaseLine: 'public-v1',
      id: 'build-run',
      source: 'update-coordinator',
      phase: 'rebuilding-dashboard',
      message: 'Building application images.',
      startedAt: '2026-07-06T10:00:00Z',
      updatedAt: '2026-07-06T10:01:00Z',
      activity: {
        phase: 'build', status: 'running', service: 'application images',
        detail: 'Docker build is active. Follow the terminal for the complete live build log.', sequence: 4,
        updatedAt: '2026-07-06T10:01:00Z',
      },
    }))

    await expect(readHandoffState(statePath)).resolves.toMatchObject({
      activity: { phase: 'build', status: 'running', service: 'application images', sequence: 4 },
    })

    await writeFile(statePath, JSON.stringify({ releaseLine: 'public-v1',
      id: 'bad-build-run', source: 'update-coordinator', phase: 'rebuilding-dashboard', message: 'Building.',
      startedAt: '2026-07-06T10:00:00Z', updatedAt: '2026-07-06T10:01:00Z',
      activity: { phase: 'build', status: 'running', detail: 'x'.repeat(900), sequence: -1 },
    }))
    await expect(readHandoffState(statePath)).resolves.not.toHaveProperty('activity')
  })
})

describe('gateway routing', () => {
  it('serves handoff JSON from the stable API path', async () => {
    const statePath = await tempStatePath()
    await writeFile(statePath, JSON.stringify({ releaseLine: 'public-v1',
      id: 'run-2',
      source: 'update-script',
      phase: 'verifying',
      message: 'Verifying the install.',
      startedAt: '2026-07-06T10:00:00Z',
      updatedAt: '2026-07-06T10:02:00Z',
    }))

    const proxied = vi.fn()
    const result = await route({
      method: 'GET',
      url: '/api/update/handoff',
      headers: {},
    }, {
      statePath,
      dashboardBaseUrl: 'http://dashboard:3000',
      proxy: proxied,
    })

    expect(result.status).toBe(200)
    expect(result.headers['content-type']).toBe('application/json')
    expect(typeof result.body).toBe('string')
    expect(JSON.parse(result.body as string)).toMatchObject({ phase: 'verifying', active: true })
    expect(proxied).not.toHaveBeenCalled()
  })

  it('serves the update shell for browser navigations while active and proxies assets/API', async () => {
    const statePath = await tempStatePath()
    await writeFile(statePath, JSON.stringify({ releaseLine: 'public-v1',
      id: 'run-3',
      source: 'update-script',
      phase: 'updating',
      message: 'Updating Persistent Memory.',
      startedAt: '2026-07-06T10:00:00Z',
      updatedAt: '2026-07-06T10:00:30Z',
    }))
    const proxied = vi.fn(async (_req: ProxyRequest) => ({
      status: 204,
      headers: {},
      body: '',
    }))

    const page = await route({
      method: 'GET',
      url: '/memories?space=personal',
      headers: { accept: 'text/html,application/xhtml+xml' },
    }, { statePath, dashboardBaseUrl: 'http://dashboard:3000', proxy: proxied })
    const asset = await route({
      method: 'GET',
      url: '/_next/static/chunk.js',
      headers: { accept: '*/*' },
    }, { statePath, dashboardBaseUrl: 'http://dashboard:3000', proxy: proxied })

    expect(page.status).toBe(200)
    expect(page.body).toContain('Updating Persistent Memory to the latest release')
    expect(asset.status).toBe(204)
    expect(proxied).toHaveBeenCalledTimes(1)
  })

  it('proxies normal requests when there is no active update', async () => {
    const statePath = await tempStatePath()
    const proxied = vi.fn(async (req: ProxyRequest) => ({
      status: 200,
      headers: { 'x-target-url': req.targetUrl },
      body: 'dashboard ok',
    }))

    const result = await route({
      method: 'GET',
      url: '/usage?space=personal',
      headers: { accept: 'text/html', 'accept-encoding': 'gzip, deflate, br' },
    }, { statePath, dashboardBaseUrl: 'http://dashboard:3000', proxy: proxied })

    expect(result.status).toBe(200)
    expect(result.headers['x-target-url']).toBe('http://dashboard:3000/usage?space=personal')
    expect(result.body).toBe('dashboard ok')
    expect(proxied).toHaveBeenCalledWith(expect.objectContaining({
      headers: expect.not.objectContaining({ 'accept-encoding': expect.anything() }),
    }))
  })

  it('keeps complete state active only for the handoff API, not page navigations', async () => {
    const statePath = await tempStatePath()
    await writeFile(statePath, JSON.stringify({ releaseLine: 'public-v1',
      id: 'run-4',
      source: 'update-script',
      phase: 'complete',
      message: 'Update complete.',
      startedAt: '2026-07-06T10:00:00Z',
      updatedAt: '2026-07-06T10:03:00Z',
      finishedAt: '2026-07-06T10:03:00Z',
      releaseNotesVersion: '4.0.6',
    }))

    const state = await readHandoffState(statePath)
    expect(shouldServeUpdateShell(state)).toBe(false)
    expect(createUpdateHtml(state)).toContain('Update complete.')
  })

  it('keeps the update shell on complete navigations until the dashboard is ready', async () => {
    const statePath = await tempStatePath()
    await writeFile(statePath, JSON.stringify({ releaseLine: 'public-v1',
      id: 'run-5',
      source: 'update-script',
      phase: 'complete',
      message: 'Update complete. Waiting for dashboard.',
      startedAt: '2026-07-06T10:00:00Z',
      updatedAt: '2026-07-06T10:03:00Z',
      finishedAt: '2026-07-06T10:03:00Z',
      releaseNotesVersion: '4.0.8',
    }))
    const proxied = vi.fn(async (req: ProxyRequest) => (
      req.targetUrl.endsWith('/api/health')
        ? { status: 503, headers: {}, body: 'not ready' }
        : { status: 200, headers: {}, body: 'dashboard page' }
    ))

    const result = await route({
      method: 'GET',
      url: '/?space=personal',
      headers: { accept: 'text/html' },
    }, { statePath, dashboardBaseUrl: 'http://dashboard:3000', proxy: proxied })

    expect(result.status).toBe(200)
    expect(result.body).toContain('Updating Persistent Memory to the latest release 4.0.8')
    expect(result.body).toContain('Waiting for the refreshed dashboard to accept traffic')
    expect(proxied).toHaveBeenCalledTimes(1)
  })

  it('proxies complete navigations once the dashboard readiness check passes', async () => {
    const statePath = await tempStatePath()
    await writeFile(statePath, JSON.stringify({ releaseLine: 'public-v1',
      id: 'run-6',
      source: 'update-script',
      phase: 'complete',
      message: 'Update complete.',
      startedAt: '2026-07-06T10:00:00Z',
      updatedAt: '2026-07-06T10:03:00Z',
      finishedAt: '2026-07-06T10:03:00Z',
      releaseNotesVersion: '4.0.8',
    }))
    const proxied = vi.fn(async (req: ProxyRequest): Promise<GatewayResponse> => (
      req.targetUrl.endsWith('/api/health')
        ? { status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' }
        : { status: 200, headers: {}, body: 'dashboard page' }
    ))

    const result = await route({
      method: 'GET',
      url: '/?space=personal',
      headers: { accept: 'text/html' },
    }, { statePath, dashboardBaseUrl: 'http://dashboard:3000', proxy: proxied })

    expect(result.status).toBe(200)
    expect(result.body).toBe('dashboard page')
    expect(proxied).toHaveBeenCalledTimes(2)
  })

  it('reports dashboard readiness through a stable gateway endpoint', async () => {
    const statePath = await tempStatePath()
    const proxied = vi.fn(async (_req: ProxyRequest) => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: '{"ok":true}',
    }))

    const result = await route({
      method: 'GET',
      url: '/api/update/dashboard-ready',
      headers: {},
    }, { statePath, dashboardBaseUrl: 'http://dashboard:3000', proxy: proxied })

    expect(result.status).toBe(200)
    expect(JSON.parse(result.body as string)).toEqual({ ready: true })
    expect(proxied).toHaveBeenCalledWith(expect.objectContaining({
      targetUrl: 'http://dashboard:3000/api/health',
    }))
  })

  it('renders visible progress and spinner in the update shell', () => {
    const html = createUpdateHtml({ releaseLine: 'public-v1',
      active: true,
      id: 'run-7',
      source: 'update-script',
      phase: 'verifying',
      message: 'Running final checks.',
      startedAt: '2026-07-06T10:00:00Z',
      updatedAt: '2026-07-06T10:03:00Z',
      progress: 88,
    })

    expect(html).toContain('update-handoff-spinner')
    expect(html).toContain('class="update-handoff-title"')
    expect(html).toContain('class="update-handoff-grid"')
    expect(html).toContain('<div><span>Phase</span><strong id="phase">verifying</strong></div>')
    expect(html).toContain('font-size: 18px')
    expect(html).toContain('role="progressbar"')
    expect(html).toContain('background: linear-gradient(90deg, #37B360 0%, #50E68A 100%)')
    expect(html).toContain('box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .18)')
    expect(html).toContain('min-width: 4px')
    expect(html).toContain('/api/update/dashboard-ready')
    expect(html).toContain("const handoffSeenKey = 'pm:public-v1:update-handoff-seen-id'")
    expect(html).toContain('localStorage.setItem(handoffSeenKey, state.id)')
    expect(html).toContain('Updating Persistent Memory to the latest release')
    expect(html).not.toContain('class="status"')
  })

  it('renders optional probe progress separately from the overall percentage', () => {
    const html = createUpdateHtml({ releaseLine: 'public-v1',
      active: true,
      id: 'probe-render',
      source: 'update-script',
      phase: 'verifying',
      message: 'Rebuilding graph partitions.',
      startedAt: '2026-07-16T00:00:00Z',
      updatedAt: '2026-07-16T00:01:00Z',
      progress: 87,
      probe: { message: 'Graph migration: 295 / 329 complete — 34 remaining.', completed: 295, total: 329, remaining: 34, checkedAt: '2026-07-16T00:01:00Z' },
    })

    expect(html).toContain('id="probe"')
    expect(html).toContain('Graph migration: 295 / 329 complete — 34 remaining.')
    expect(html).toContain('probe.hidden = !state.probe')
  })

  it('keeps the last overall percentage visible while a build is active', () => {
    const html = createUpdateHtml({ releaseLine: 'public-v1',
      active: true,
      id: 'build-run',
      source: 'update-coordinator',
      phase: 'rebuilding-dashboard',
      message: 'Building application images.',
      startedAt: '2026-07-06T10:00:00Z',
      updatedAt: '2026-07-06T10:01:00Z',
      progress: 60,
      activity: {
        phase: 'build', status: 'running', service: 'application images',
        detail: 'Docker build is active. Follow the terminal for the complete live build log.', sequence: 4,
        updatedAt: '2026-07-06T10:01:00Z',
      },
    })

    expect(html).toContain('aria-valuenow="60"')
    expect(html).toContain('>60%</strong>')
    expect(html).toContain('class="update-handoff-progress-track"')
    expect(html).toContain('Building application images')
    expect(html).not.toContain('Active</strong>')
    expect(html).not.toContain('update-handoff-progress-track indeterminate')
  })

  it('replaces progress with the safe failure detail when an update fails', () => {
    const html = createUpdateHtml({ releaseLine: 'public-v1',
      active: true,
      id: 'failed-run',
      source: 'update-script',
      phase: 'failed',
      message: 'Update stopped. Review the error below, then use the terminal for full details.',
      error: 'Database migration failed with exit code 1.',
      startedAt: '2026-07-06T10:00:00Z',
      updatedAt: '2026-07-06T10:01:00Z',
      progress: 74,
    })

    expect(html).toContain('<section class="update-handoff-progress" id="progress-section" aria-label="Update progress" hidden>')
    expect(html).toContain('errorRow.hidden = !state.error')
    expect(html).toContain("progressSection.hidden = state.phase === 'failed';")
    expect(html).toContain('Database migration failed with exit code 1.')
  })

  it('uses dashboard handoff state for local dashboard redeploys', async () => {
    const script = await readFile(new URL('../../../deploy/scripts/dev-redeploy.sh', import.meta.url), 'utf8')

    expect(script).toContain('dashboard_handoff_write "rebuilding-dashboard"')
    expect(script).toContain('wait_for_dashboard_ready')
    expect(script).toContain('dashboard_handoff_write "complete" "Dashboard redeploy is complete. Reloading the dashboard."')
    expect(script).not.toContain('state.releaseNotesVersion = version')
  })

  it('redeploys an isolated dashboard source through the live gateway handoff', async () => {
    const script = await readFile(new URL('../../../deploy/scripts/dev-redeploy.sh', import.meta.url), 'utf8')

    expect(script).toContain('PM_DASHBOARD_SOURCE_ROOT')
    expect(script).toContain('PM_RUNTIME_ROOT')
    expect(script).toContain('mkdir -p "$RUNTIME_ROOT/.local/backups"')
    expect(script).toContain('resolve_dashboard_service')
    expect(script).toContain('"${COMPOSE[@]}" build "$DASHBOARD_SERVICE"')
    expect(script).toContain('"${COMPOSE[@]}" up -d --no-deps --force-recreate "$DASHBOARD_SERVICE"')
    expect(script).not.toContain('up -d --no-deps --force-recreate "$DASHBOARD_SERVICE" dashboard-gateway')
  })

  it('keeps the terminal updater from recreating the gateway while it owns port 3200', async () => {
    const script = await readFile(new URL('../../../deploy/scripts/update.sh', import.meta.url), 'utf8')

    expect(script).toContain('compose_update_services_excluding_gateway')
    expect(script).toContain('[ "$service" = "dashboard-gateway" ] && continue')
    expect(script).toContain('compose_build_with_handoff "dashboard gateway" "46" "52" dashboard-gateway')
    expect(script).toContain('"${COMPOSE[@]}" up -d --no-deps dashboard-gateway')
    expect(script).toContain('wait_for_gateway_ready')
    expect(script).toContain('"${COMPOSE[@]}" up -d --no-build "${UPDATE_RECREATE_SERVICES[@]}"')
    expect(script).not.toContain('"${COMPOSE[@]}" up -d --build "${UPDATE_RECREATE_SERVICES[@]}"')
  })

  it('compiles gateway TypeScript before its production image starts JavaScript', async () => {
    const dockerfile = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8')

    expect(dockerfile).toContain('FROM node:22-alpine AS build')
    expect(dockerfile).toContain('RUN npm run build -w persistent-memory-dashboard-gateway')
    expect(dockerfile).toContain('CMD ["node", "dist/index.js"]')
  })

  it('does not forward decoded compression headers from dashboard responses', () => {
    const headers = sanitizeProxyResponseHeaders(new Headers({
      'content-type': 'text/plain',
      'content-encoding': 'gzip',
      'content-length': '123',
      'transfer-encoding': 'chunked',
    }))

    expect(headers['content-type']).toBe('text/plain')
    expect(headers['content-encoding']).toBeUndefined()
    expect(headers['content-length']).toBeUndefined()
    expect(headers['transfer-encoding']).toBeUndefined()
  })
})
