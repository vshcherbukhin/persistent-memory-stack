import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const source = (path: string) => readFile(new URL(path, import.meta.url), 'utf8')

describe('compile-first runtime policy', () => {
  it('runs every first-party Node service from emitted JavaScript', async () => {
    const [compose, rootPackage, gatewayDockerfile, dockerControlDockerfile, updateRunnerDockerfile, gatewayPackage, dockerControlPackage, updateRunnerPackage, dashboardPackage, onboardPackage, onboardLauncher, serverModeLaunchers] = await Promise.all([
      source('../../../deploy/compose/docker-compose.yml'),
      source('../../../package.json'),
      source('../../dashboard-gateway/Dockerfile'),
      source('../../docker-control/Dockerfile'),
      source('../../update-runner/Dockerfile'),
      source('../../dashboard-gateway/package.json'),
      source('../../docker-control/package.json'),
      source('../../update-runner/package.json'),
      source('../../dashboard/package.json'),
      source('../../onboard/package.json'),
      source('../../../deploy/scripts/onboard.sh'),
      Promise.all([
        source('../../../deploy/scripts/install-server-client-managed.sh'),
        source('../../../deploy/scripts/install-server-server-managed.sh'),
        source('../../../deploy/scripts/install-server-mode-a.sh'),
        source('../../../deploy/scripts/install-server-mode-b.sh'),
      ]),
    ])

    expect(compose).toContain('context: ../..\n      dockerfile: apps/dashboard-gateway/Dockerfile')
    for (const dockerfile of [gatewayDockerfile, dockerControlDockerfile, updateRunnerDockerfile]) {
      expect(dockerfile).toContain(' AS build')
      expect(dockerfile).not.toContain('--experimental-strip-types')
      expect(dockerfile).toContain('CMD ["node", "dist/')
      expect(dockerfile).toContain('COPY apps/')
      expect(dockerfile).toContain('package.json ./package.json')
    }
    expect(updateRunnerDockerfile).toContain('npm ci --omit=dev --workspace persistent-memory-update-runner')
    expect(updateRunnerDockerfile).toContain('COPY --from=runtime-deps /app/node_modules ./node_modules')
    for (const pkg of [gatewayPackage, dockerControlPackage, updateRunnerPackage, onboardPackage]) {
      expect(pkg).toContain('"build"')
      expect(pkg).not.toContain('node --experimental-strip-types')
    }
    expect(dashboardPackage).toContain('"build": "tsc --noEmit && next build"')
    expect(onboardLauncher).toContain('node "$ONBOARD_DIR/dist/apps/onboard/server/index.js"')
    expect(rootPackage).toContain('"build:server-mode-install": "tsc -p tsconfig.server-mode-install.json"')
    expect(rootPackage).toContain('"typecheck:server-mode-install": "tsc --noEmit -p tsconfig.server-mode-install.json"')
    for (const launcher of serverModeLaunchers) {
      expect(launcher).toContain('npm run build:server-mode-install --prefix "$REPO_ROOT"')
      expect(launcher).toContain('node "$REPO_ROOT/dist/scripts/server-mode-install.js"')
      expect(launcher).not.toContain('server-mode-install.ts')
    }
  })

  it('keeps warning logs on the warning stream', async () => {
    const [dockerControl, updateRunner] = await Promise.all([
      source('../../docker-control/src/server.ts'),
      source('../../update-runner/src/server.ts'),
    ])

    expect(dockerControl).toContain("console.warn('WARN: [docker-control]")
    expect(updateRunner).toContain("console.warn('WARN: [update-runner]")
  })
})
