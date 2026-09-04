import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const source = (path: string) => readFile(new URL(path, import.meta.url), 'utf8')

describe('runtime logging contract', () => {
  it('marks operator-visible Node service and worker failures with an explicit error severity', async () => {
    const [runner, dockerControl, gateway, documentation, worker, workerConfig, apiConfig, browserPush, modelSwitch, scheduled, seed] = await Promise.all([
      source('../../../../apps/update-runner/src/server.ts'),
      source('../../../../apps/docker-control/src/server.ts'),
      source('../../../../apps/dashboard-gateway/src/server.ts'),
      source('../../../../apps/documentation/src/server.mjs'),
      source('../../../../apps/worker/src/index.ts'),
      source('../../../../apps/worker/src/config.ts'),
      source('../../../../apps/api/src/config.ts'),
      source('../../../../apps/api/src/services/browser-push.ts'),
      source('../../../../apps/api/src/services/model-switch.ts'),
      source('../../../../apps/api/src/services/scheduled.ts'),
      source('../../../../layers/core/schema/seed.ts'),
    ])

    expect(runner).toContain('ERROR: [update-runner] request failed')
    expect(dockerControl).toContain('ERROR: [docker-control] request failed')
    expect(gateway).toContain('ERROR: [dashboard-gateway] request failed')
    expect(documentation).toContain('ERROR: [documentation] request failed')
    expect(worker).toContain('ERROR: [ingest] job')
    expect(worker).toContain('ERROR: [worker] fatal boot error')
    expect(workerConfig).toContain('ERROR: [worker config] Invalid environment')
    expect(apiConfig).toContain('ERROR: [config] Invalid environment')
    expect(browserPush).toContain('WARN: [browser-push] send failed')
    expect(modelSwitch).toContain('ERROR: [model-switch] failed')
    expect(scheduled).toContain('WARN: [workers] live scheduler/heartbeat read failed')
    expect(seed).toContain('ERROR: [seed] failed')
  })

  it('records Python sidecar operational failures without logging scanned content', async () => {
    const [dlp, graphiti] = await Promise.all([
      source('../../../../apps/dlp-service/main.py'),
      source('../../../../apps/graphiti-service/main.py'),
    ])

    expect(dlp).toContain('logger.exception("gitleaks scan failed")')
    expect(graphiti).toContain('logger.exception("graphiti add_episode failed")')
    expect(graphiti).toContain('logger.exception("graphiti search failed")')
  })
})
