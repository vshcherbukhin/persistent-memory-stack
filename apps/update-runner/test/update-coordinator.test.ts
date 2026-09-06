import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  acquireCoordinatorLock,
  clearHandoffForNoopRun,
  coordinatorReleaseLineFor,
  coordinatorReleaseWorktree,
  deployedStatePathFor,
  executeCoordinatorPlan,
  handoffStateDirFor,
  installCoordinator,
  loadTrustedUpgradeContracts,
  planLegacyBridge,
  planCoordinatorBootstrap,
  publishCoordinatorFailureForRun,
  resolveDeployedVersion,
  type CoordinatorInstallation,
} from '../../../apps/update-coordinator/src/index.ts'

const tempRoots: string[] = []
const releaseLine = 'public-v1'
const contractModuleUrl = new URL('../../../layers/update-ops/release-versioning/upgrade-contract.ts', import.meta.url).href

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pm-update-coordinator-'))
  tempRoots.push(root)
  return root
}

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(tempRoots.splice(0).map(async (root) => {
    const { rm } = await import('node:fs/promises')
    await rm(root, { recursive: true, force: true })
  }))
})

async function installFixture(): Promise<{ root: string; installation: CoordinatorInstallation }> {
  const root = await tempRoot()
  const repoRoot = join(root, 'checkout')
  const artifactDir = join(root, 'artifact')
  await mkdir(join(repoRoot, '.local', 'update-state'), { recursive: true })
  await mkdir(join(artifactDir, 'lib'), { recursive: true })
  await writeFile(join(artifactDir, 'coordinator.mjs'), 'export {}\n')
  await writeFile(join(artifactDir, 'lib', 'upgrade-contract.mjs'), 'export {}\n')

  const installation = await installCoordinator({
    repoRoot,
    artifactDir,
    coordinatorBaseDir: join(root, 'coordinator-home'),
  })
  return { root, installation }
}

describe('update coordinator bootstrap', () => {
  it('snapshots once, resumes at the first unfinished hop, and persists each verified hop', async () => {
    const { installation } = await installFixture()
    const calls: string[] = []

    await expect(executeCoordinatorPlan({
      coordinatorHome: installation.installationHome,
      plan: {
        protocolVersion: 1,
        sourceVersion: '4.0.25',
        targetVersion: '4.0.28',
        path: ['4.0.26', '4.0.28'],
        plannedAt: '2026-07-14T00:00:00.000Z',
      },
      snapshot: async () => { calls.push('snapshot') },
      runHop: async (release) => { calls.push(release) },
    })).resolves.toMatchObject({ status: 'complete', completedHops: ['4.0.26', '4.0.28'] })

    await expect(executeCoordinatorPlan({
      coordinatorHome: installation.installationHome,
      plan: {
        protocolVersion: 1,
        sourceVersion: '4.0.25',
        targetVersion: '4.0.28',
        path: ['4.0.26', '4.0.28'],
        plannedAt: '2026-07-14T00:00:00.000Z',
      },
      snapshot: async () => { calls.push('snapshot-again') },
      runHop: async (release) => { calls.push(`rerun-${release}`) },
    })).resolves.toMatchObject({ status: 'complete', completedHops: ['4.0.26', '4.0.28'] })

    expect(calls).toEqual(['snapshot', '4.0.26', '4.0.28'])
    await expect(readFile(join(installation.installationHome, 'state', 'hop-progress.json'), 'utf8')).resolves.toContain('"status": "complete"')
  })

  it('returns the dashboard on a completed no-op and reruns a same-version update for a newer commit', async () => {
    const { root, installation } = await installFixture()
    const calls: string[] = []
    const stateDir = join(root, 'runtime-state')
    await mkdir(stateDir, { recursive: true })
    const handoffPath = join(stateDir, 'dashboard-handoff.json')
    await writeFile(handoffPath, JSON.stringify({
      id: 'no-op-run',
      releaseLine: 'public-v1',
      source: 'update-script',
      phase: 'updating',
      message: 'Pulling updates.',
      startedAt: '2026-07-14T00:00:00.000Z',
      updatedAt: '2026-07-14T00:00:00.000Z',
    }))
    const plan = {
      protocolVersion: 1 as const,
      sourceVersion: '4.0.28',
      targetVersion: '4.0.28',
      path: ['4.0.28'],
      targetRevision: 'commit-a',
      plannedAt: '2026-07-14T00:00:00.000Z',
    }

    await executeCoordinatorPlan({
      coordinatorHome: installation.installationHome,
      plan,
      snapshot: async () => { calls.push('snapshot-a') },
      runHop: async () => { calls.push('commit-a') },
    })
    await executeCoordinatorPlan({
      coordinatorHome: installation.installationHome,
      plan,
      snapshot: async () => { calls.push('unexpected-snapshot') },
      runHop: async () => { calls.push('unexpected-hop') },
      onNoop: async () => {
        const cleared = await clearHandoffForNoopRun({ handoffPath, runId: 'no-op-run' })
        expect(cleared).toBe(true)
      },
    })

    expect(JSON.parse(await readFile(handoffPath, 'utf8'))).toMatchObject({ id: 'no-op-run', releaseLine: 'public-v1', phase: 'idle' })
    await executeCoordinatorPlan({
      coordinatorHome: installation.installationHome,
      plan: { ...plan, targetRevision: 'commit-b' },
      snapshot: async () => { calls.push('snapshot-b') },
      runHop: async () => { calls.push('commit-b') },
    })

    expect(calls).toEqual(['snapshot-a', 'commit-a', 'snapshot-b', 'commit-b'])
  })

  it('turns the matching launcher handoff into a safe coordinator failure', async () => {
    const root = await tempRoot()
    const handoffPath = join(root, 'dashboard-handoff.json')
    await writeFile(handoffPath, JSON.stringify({
      id: 'coordinator-run',
      releaseLine: 'public-v1',
      source: 'update-script',
      phase: 'updating',
      message: 'Pulling updates.',
      startedAt: '2026-07-14T00:00:00.000Z',
      updatedAt: '2026-07-14T00:00:00.000Z',
      targetVersion: '4.0.28',
    }))

    await expect(publishCoordinatorFailureForRun({ handoffPath, runId: 'coordinator-run' })).resolves.toBe(true)
    await expect(readFile(handoffPath, 'utf8')).resolves.toContain('"phase": "failed"')
    await expect(readFile(handoffPath, 'utf8')).resolves.toContain('"releaseLine": "public-v1"')
    await expect(readFile(handoffPath, 'utf8')).resolves.toContain('Update coordinator stopped before the lifecycle could start.')
  })

  it('retains recovery state at the failed hop without taking a second snapshot', async () => {
    const { installation } = await installFixture()
    let snapshots = 0

    await expect(executeCoordinatorPlan({
      coordinatorHome: installation.installationHome,
      plan: {
        protocolVersion: 1,
        sourceVersion: '4.0.25',
        targetVersion: '4.0.28',
        path: ['4.0.26', '4.0.28'],
        plannedAt: '2026-07-14T00:00:00.000Z',
      },
      snapshot: async () => { snapshots += 1 },
      runHop: async (release) => {
        if (release === '4.0.28') throw new Error('intentional hop failure')
      },
    })).rejects.toThrow('intentional hop failure')

    await expect(readFile(join(installation.installationHome, 'state', 'hop-progress.json'), 'utf8')).resolves.toContain('"failedHop": "4.0.28"')
    expect(snapshots).toBe(1)
  })

  it('retries an unfinished failed dev release after its target revision changes without taking a second snapshot', async () => {
    const { installation } = await installFixture()
    const calls: string[] = []
    let snapshots = 0
    const plan = {
      protocolVersion: 1 as const,
      sourceVersion: '4.0.29',
      targetVersion: '4.0.30',
      path: ['4.0.30'],
      targetRevision: 'commit-a',
      plannedAt: '2026-07-16T00:00:00.000Z',
    }

    await expect(executeCoordinatorPlan({
      coordinatorHome: installation.installationHome,
      plan,
      snapshot: async () => { snapshots += 1 },
      runHop: async () => {
        calls.push('commit-a')
        throw new Error('intentional dev build failure')
      },
    })).rejects.toThrow('intentional dev build failure')

    await expect(executeCoordinatorPlan({
      coordinatorHome: installation.installationHome,
      plan: { ...plan, targetVersion: '4.0.31', path: ['4.0.31'] },
      snapshot: async () => { snapshots += 1 },
      runHop: async () => { calls.push('unexpected-hop') },
    })).rejects.toThrow('different update plan')

    await expect(executeCoordinatorPlan({
      coordinatorHome: installation.installationHome,
      plan: { ...plan, targetRevision: 'commit-b' },
      snapshot: async () => { snapshots += 1 },
      runHop: async () => { calls.push('commit-b') },
    })).resolves.toMatchObject({
      status: 'complete',
      targetRevision: 'commit-b',
      completedHops: ['4.0.30'],
    })

    expect(snapshots).toBe(1)
    expect(calls).toEqual(['commit-a', 'commit-b'])
  })

  it('fails closed when durable recovery state is malformed instead of replaying completed hops', async () => {
    const { installation } = await installFixture()
    const progressPath = join(installation.installationHome, 'state', 'hop-progress.json')
    await writeFile(progressPath, JSON.stringify({
      protocolVersion: 1,
      sourceVersion: '4.0.25',
      targetVersion: '4.0.28',
      path: ['4.0.26', '4.0.28'],
      status: 'running',
      completedHops: '4.0.26',
      updatedAt: '2026-07-14T00:00:00.000Z',
    }))

    await expect(executeCoordinatorPlan({
      coordinatorHome: installation.installationHome,
      plan: {
        protocolVersion: 1,
        sourceVersion: '4.0.25',
        targetVersion: '4.0.28',
        path: ['4.0.26', '4.0.28'],
        plannedAt: '2026-07-14T00:00:00.000Z',
      },
      snapshot: async () => { throw new Error('must not snapshot') },
      runHop: async () => { throw new Error('must not replay') },
    })).rejects.toThrow('Coordinator recovery state is invalid')
  })

  it('fails closed when an interrupted snapshot has no durable completion checkpoint', async () => {
    const { installation } = await installFixture()
    const progressPath = join(installation.installationHome, 'state', 'hop-progress.json')
    await writeFile(progressPath, JSON.stringify({
      protocolVersion: 1,
      sourceVersion: '4.0.25',
      targetVersion: '4.0.28',
      path: ['4.0.28'],
      status: 'running',
      snapshotStatus: 'running',
      completedHops: [],
      updatedAt: '2026-07-14T00:00:00.000Z',
    }))

    await expect(executeCoordinatorPlan({
      coordinatorHome: installation.installationHome,
      plan: { protocolVersion: 1, sourceVersion: '4.0.25', targetVersion: '4.0.28', path: ['4.0.28'], plannedAt: '2026-07-14T00:00:00.000Z' },
      snapshot: async () => { throw new Error('must not snapshot') },
      runHop: async () => { throw new Error('must not run') },
    })).rejects.toThrow('snapshot outcome is unknown')
  })

  it('fails closed when snapshot status claims completion without a checkpoint timestamp', async () => {
    const { installation } = await installFixture()
    const progressPath = join(installation.installationHome, 'state', 'hop-progress.json')
    await writeFile(progressPath, JSON.stringify({
      protocolVersion: 1,
      sourceVersion: '4.0.25',
      targetVersion: '4.0.28',
      path: ['4.0.28'],
      status: 'running',
      snapshotStatus: 'complete',
      completedHops: [],
      updatedAt: '2026-07-14T00:00:00.000Z',
    }))

    await expect(executeCoordinatorPlan({
      coordinatorHome: installation.installationHome,
      plan: { protocolVersion: 1, sourceVersion: '4.0.25', targetVersion: '4.0.28', path: ['4.0.28'], plannedAt: '2026-07-14T00:00:00.000Z' },
      snapshot: async () => { throw new Error('must not snapshot') },
      runHop: async () => { throw new Error('must not run') },
    })).rejects.toThrow('Snapshot status and checkpoint disagree')
  })

  it('fails closed when a complete recovery state skips an earlier required bridge hop', async () => {
    const { installation } = await installFixture()
    const progressPath = join(installation.installationHome, 'state', 'hop-progress.json')
    await writeFile(progressPath, JSON.stringify({
      protocolVersion: 1,
      sourceVersion: '4.0.25',
      targetVersion: '4.0.28',
      path: ['4.0.26', '4.0.28'],
      status: 'complete',
      snapshotAt: '2026-07-14T00:00:00.000Z',
      snapshotStatus: 'complete',
      completedHops: ['4.0.28'],
      updatedAt: '2026-07-14T00:00:00.000Z',
      completedAt: '2026-07-14T00:00:00.000Z',
    }))

    await expect(executeCoordinatorPlan({
      coordinatorHome: installation.installationHome,
      plan: { protocolVersion: 1, sourceVersion: '4.0.25', targetVersion: '4.0.28', path: ['4.0.26', '4.0.28'], plannedAt: '2026-07-14T00:00:00.000Z' },
      snapshot: async () => { throw new Error('must not snapshot') },
      runHop: async () => { throw new Error('must not run') },
    })).rejects.toThrow('Completed hops must be an ordered prefix')
  })

  it('reads the deployed-release marker from the updater handoff directory when operators relocate it', () => {
    const root = resolve('fixture-checkout')
    const relocated = join(tmpdir(), 'pm-relocated-state')
    expect(deployedStatePathFor(root)).toBe(join(root, '.local', 'update-state', 'last-successful-update.json'))
    expect(deployedStatePathFor(root, relocated)).toBe(join(relocated, 'last-successful-update.json'))
  })

  it('keeps an exact legacy release available through a coordinator-managed one-hop bridge', async () => {
    const { root, installation } = await installFixture()
    const repoRoot = join(root, 'checkout')
    const statePath = join(repoRoot, '.local', 'update-state', 'last-successful-update.json')
    await writeFile(join(repoRoot, 'package.json'), JSON.stringify({ version: '4.0.27', persistentMemoryReleaseLine: 'fixture-line' }))
    await writeFile(statePath, JSON.stringify({ version: '4.0.25', releaseLine: 'fixture-line' }))

    await expect(planLegacyBridge({
      coordinatorHome: installation.installationHome,
      releaseLine: 'fixture-line',
      deployedStatePath: statePath,
      liveReleaseHistoryUrl: 'http://127.0.0.1:9/release-history.md',
      packagePath: join(repoRoot, 'package.json'),
    })).resolves.toMatchObject({ sourceVersion: '4.0.25', targetVersion: '4.0.27', path: ['4.0.27'] })
  })

  it('uses the legacy target handoff mount while bridging a gateway that predates coordinator state', () => {
    const legacyRoot = join(tmpdir(), 'release-4.0.27')
    const modernRoot = join(tmpdir(), 'release-4.0.28')
    const coordinatorRoot = join(tmpdir(), 'coordinator')
    expect(handoffStateDirFor(legacyRoot, coordinatorRoot, true)).toBe(join(legacyRoot, '.local', 'update-state'))
    expect(handoffStateDirFor(modernRoot, coordinatorRoot, false)).toBe(join(coordinatorRoot, 'state'))
  })

  // The contract assertion deliberately emits both coordinator artifacts. Allow
  // a cold TypeScript build instead of using Vitest's unit-test default.
  it('ships an emitted coordinator bootstrap artifact with its shared contract library', async () => {
    const { npmInvocation } = await import(new URL('../../../scripts/host-runtime.mjs', import.meta.url).href) as {
      npmInvocation: (args: string[]) => { command: string; args: string[] }
    }
    const invocation = npmInvocation(['run', 'build:update-coordinator'])
    execFileSync(invocation.command, invocation.args, {
      cwd: new URL('../../../', import.meta.url),
      stdio: 'pipe',
      windowsHide: true,
    })

    const artifact = new URL('../../../deploy/update-coordinator/coordinator.mjs', import.meta.url)
    const contractLibrary = new URL('../../../deploy/update-coordinator/lib/upgrade-contract.mjs', import.meta.url)
    const builtCoordinator = new URL('../../update-coordinator/dist/apps/update-coordinator/src/index.js', import.meta.url)
    const builtContract = new URL('../../update-runner/dist/layers/update-ops/release-versioning/upgrade-contract.js', import.meta.url)

    expect(existsSync(artifact)).toBe(true)
    expect(existsSync(contractLibrary)).toBe(true)
    await expect(readFile(artifact, 'utf8')).resolves.toBe(await readFile(builtCoordinator, 'utf8'))
    await expect(readFile(contractLibrary, 'utf8')).resolves.toBe(await readFile(builtContract, 'utf8'))
  }, 20_000)

  it('installs the emitted artifact for the initiating checkout without using a worktree path', async () => {
    const root = await tempRoot()
    const repoRoot = join(root, 'initiating-checkout')
    const baseDir = join(root, 'coordinator-home')
    const installer = new URL('../../../scripts/install-update-coordinator.mjs', import.meta.url)
    await mkdir(repoRoot, { recursive: true })

    const home = execFileSync(process.execPath, [
      fileURLToPath(installer),
      '--root', repoRoot,
      '--base-dir', baseDir,
      '--print-home',
    ], { encoding: 'utf8', windowsHide: true }).trim()

    expect(home.startsWith(repoRoot)).toBe(false)
    await expect(readFile(join(home, 'coordinator.mjs'), 'utf8')).resolves.not.toHaveLength(0)
  })

  it('installs a private coordinator home outside the checkout and worktrees', async () => {
    const { root, installation } = await installFixture()

    expect(dirname(installation.home)).toBe(join(root, 'coordinator-home', installation.installationId, 'bundles'))
    expect(basename(installation.home)).toMatch(/^[a-f0-9]{24}$/u)
    expect(installation.installationHome).toBe(join(root, 'coordinator-home', installation.installationId))
    expect(installation.home.startsWith(join(root, 'checkout'))).toBe(false)
    expect(await readFile(join(installation.home, 'coordinator.mjs'), 'utf8')).toBe('export {}\n')
    // Windows chmod controls the owner read/write bits; profile ACLs supply the
    // access boundary. POSIX hosts also enforce the requested group/other bits.
    const permissionMask = process.platform === 'win32' ? 0o600 : 0o777
    expect((await stat(installation.home)).mode & permissionMask).toBe(0o700 & permissionMask)
    expect((await stat(join(installation.installationHome, 'bundles'))).mode & permissionMask).toBe(0o700 & permissionMask)
    expect((await stat(join(installation.installationHome, 'installation.json'))).mode & permissionMask).toBe(0o600)
  })

  it('keeps a running coordinator bundle immutable when a second launcher installs a newer artifact', async () => {
    const { root, installation: first } = await installFixture()
    const artifactDir = join(root, 'artifact')
    const lock = await acquireCoordinatorLock(first.installationHome)
    await writeFile(join(artifactDir, 'coordinator.mjs'), 'export const revision = 2\n')

    const second = await installCoordinator({
      repoRoot: join(root, 'checkout'),
      artifactDir,
      coordinatorBaseDir: join(root, 'coordinator-home'),
    })

    expect(second.home).not.toBe(first.home)
    expect(await readFile(join(first.home, 'coordinator.mjs'), 'utf8')).toBe('export {}\n')
    await expect(acquireCoordinatorLock(second.installationHome)).rejects.toThrow('already running')
    await lock.release()
  })

  it('anchors an exact-release worktree installation to its initiating checkout', async () => {
    const root = await tempRoot()
    const initiatingRoot = join(root, 'checkout')
    const worktree = join(initiatingRoot, '.local', 'release-worktrees', 'persistent-memory-4.0.28-example')
    const artifactDir = join(root, 'artifact')
    await mkdir(worktree, { recursive: true })
    await mkdir(join(artifactDir, 'lib'), { recursive: true })
    await writeFile(join(artifactDir, 'coordinator.mjs'), 'export {}\n')
    await writeFile(join(artifactDir, 'lib', 'upgrade-contract.mjs'), 'export {}\n')

    const installation = await installCoordinator({
      repoRoot: worktree,
      artifactDir,
      coordinatorBaseDir: join(root, 'coordinator-home'),
    })

    expect(JSON.parse(await readFile(join(installation.installationHome, 'installation.json'), 'utf8'))).toMatchObject({ repoRoot: initiatingRoot })
    expect(installation.home.startsWith(worktree)).toBe(false)
  })

  it('holds one atomic coordinator lock per installation', async () => {
    const { installation } = await installFixture()
    const first = await acquireCoordinatorLock(installation.installationHome)

    await expect(acquireCoordinatorLock(installation.installationHome)).rejects.toThrow('already running')

    await first.release()
    const second = await acquireCoordinatorLock(installation.installationHome)
    expect(second).toMatchObject({ path: join(installation.installationHome, 'update.lock') })
    await second.release()
  })

  it('adopts the shell reservation that protects source resolution before the coordinator starts', async () => {
    const { installation } = await installFixture()
    const lockPath = join(installation.installationHome, 'update.lock')
    await mkdir(lockPath)
    await writeFile(join(lockPath, 'owner.json'), JSON.stringify({ pid: 123 }))

    const lock = await acquireCoordinatorLock(installation.installationHome, { adoptExisting: true })

    await lock.release()
    expect(existsSync(lockPath)).toBe(false)
  })

  it.each(['4.0.25', '4.0.26', '4.0.27'])('plans the %s bootstrap from durable deployed state instead of a manually pulled checkout version', async (deployedVersion) => {
    const { root, installation } = await installFixture()
    const repoRoot = join(root, 'checkout')
    await writeFile(join(repoRoot, 'package.json'), JSON.stringify({ version: '4.0.28', persistentMemoryReleaseLine: 'fixture-line' }))
    await writeFile(join(repoRoot, 'release-upgrade.json'), JSON.stringify({
      schemaVersion: 1,
      release: '4.0.28',
      minimumSupportedSource: '4.0.25',
      compatibleMajorLine: 4,
      directFrom: '>=4.0.25 <4.0.29',
      bridges: [],
      requiredStops: [],
      coordinator: { minimumVersion: 1, bootstrap: true },
    }))
    await writeFile(join(repoRoot, '.local', 'update-state', 'last-successful-update.json'), JSON.stringify({
      id: 'previous-release', releaseLine: 'fixture-line', source: 'update-script', version: deployedVersion, finishedAt: '2026-07-14T00:00:00.000Z',
    }))

    const plan = await planCoordinatorBootstrap({
      repoRoot,
      releaseLine: 'fixture-line',
      coordinatorHome: installation.installationHome,
      contractPath: join(repoRoot, 'release-upgrade.json'),
      packagePath: join(repoRoot, 'package.json'),
      deployedStatePath: join(repoRoot, '.local', 'update-state', 'last-successful-update.json'),
      upgradeContractModuleUrl: new URL('../../../layers/update-ops/release-versioning/upgrade-contract.ts', import.meta.url).href,
    })

    expect(plan).toMatchObject({ sourceVersion: deployedVersion, targetVersion: '4.0.28', path: ['4.0.28'] })
    expect(JSON.parse(await readFile(join(installation.installationHome, 'state', 'active-plan.json'), 'utf8'))).toMatchObject({
      sourceVersion: deployedVersion, targetVersion: '4.0.28', path: ['4.0.28'],
    })
  })

  it('permits a same-version trusted branch update after target resolution', async () => {
    const { root, installation } = await installFixture()
    const repoRoot = join(root, 'checkout')
    await writeFile(join(repoRoot, 'package.json'), JSON.stringify({ version: '4.0.28', persistentMemoryReleaseLine: 'fixture-line' }))
    await writeFile(join(repoRoot, 'release-upgrade.json'), JSON.stringify({
      schemaVersion: 1,
      release: '4.0.28',
      minimumSupportedSource: '4.0.25',
      compatibleMajorLine: 4,
      directFrom: '>=4.0.25 <4.0.29',
      bridges: [],
      requiredStops: [],
      coordinator: { minimumVersion: 1, bootstrap: true },
    }))
    await writeFile(join(repoRoot, '.local', 'update-state', 'last-successful-update.json'), JSON.stringify({ version: '4.0.28', releaseLine: 'fixture-line' }))

    await expect(planCoordinatorBootstrap({
      repoRoot,
      releaseLine: 'fixture-line',
      coordinatorHome: installation.installationHome,
      contractPath: join(repoRoot, 'release-upgrade.json'),
      packagePath: join(repoRoot, 'package.json'),
      deployedStatePath: join(repoRoot, '.local', 'update-state', 'last-successful-update.json'),
      upgradeContractModuleUrl: new URL('../../../layers/update-ops/release-versioning/upgrade-contract.ts', import.meta.url).href,
    })).resolves.toMatchObject({ sourceVersion: '4.0.28', targetVersion: '4.0.28', path: [] })
  })

  it('uses matching live dashboard release metadata when a fresh installation has no durable marker', async () => {
    const root = await tempRoot()
    const fetchMock = vi.fn(async () => new Response('<!-- persistent-memory-release-line: public-v1 -->\n## 1.0.0\n', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(resolveDeployedVersion({
      statePath: join(root, 'missing-marker.json'),
      releaseLine,
      liveReleaseHistoryUrl: 'http://dashboard.example.test/release-history.md',
    })).resolves.toBe('1.0.0')
    expect(fetchMock).toHaveBeenCalledWith(
      'http://dashboard.example.test/release-history.md',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it.each([undefined, 'old-line'])('ignores a %s old deployed marker and resolves the current public dashboard without rewriting state', async (oldLine) => {
    const root = await tempRoot()
    const statePath = join(root, 'last-successful-update.json')
    const oldState = JSON.stringify({ version: '4.0.37', releaseLine: oldLine })
    await writeFile(statePath, oldState)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<!-- persistent-memory-release-line: public-v1 -->\n## 1.0.0\n')))
    await expect(resolveDeployedVersion({ statePath, releaseLine, liveReleaseHistoryUrl: 'http://dashboard.example.test/history' })).resolves.toBe('1.0.0')
    await expect(readFile(statePath, 'utf8')).resolves.toBe(oldState)
  })

  it.each(['## 4.0.37\n', '<!-- persistent-memory-release-line: old-line -->\n## 1.0.0\n'])('rejects deployed history outside the selected release line: %s', async (history) => {
    const root = await tempRoot()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(history)))
    await expect(resolveDeployedVersion({ statePath: join(root, 'missing.json'), releaseLine, liveReleaseHistoryUrl: 'http://dashboard.example.test/history' })).rejects.toThrow('Cannot determine the deployed release')
  })

  it('rejects an unmarked target before writing either a contract plan or legacy bridge plan', async () => {
    const { root, installation } = await installFixture()
    const repoRoot = join(root, 'checkout')
    const packagePath = join(repoRoot, 'package.json')
    const deployedStatePath = join(repoRoot, 'deployed.json')
    const contractPath = join(repoRoot, 'upgrade.json')
    await writeFile(packagePath, JSON.stringify({ version: '1.0.0' }))
    await writeFile(deployedStatePath, JSON.stringify({ version: '1.0.0', releaseLine }))
    await writeFile(contractPath, await readFile(new URL('../../../release/upgrade.json', import.meta.url)))
    const options = { repoRoot, coordinatorHome: installation.installationHome, releaseLine, packagePath, deployedStatePath, contractPath, liveReleaseHistoryUrl: 'http://dashboard.example.test/history', upgradeContractModuleUrl: contractModuleUrl }
    await expect(planCoordinatorBootstrap(options)).rejects.toThrow('target package does not belong')
    await expect(planLegacyBridge(options)).rejects.toThrow('target package does not belong')
    expect(existsSync(join(installation.installationHome, 'state', 'active-plan.json'))).toBe(false)
  })

  it('selects public contracts and exact worktrees while skipping unmarked, foreign-line, and reused historical versions', async () => {
    const repoRoot = await tempRoot()
    const git = (...args: string[]) => execFileSync('git', ['-c', `safe.directory=${repoRoot.replace(/\\/gu, '/')}`, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', ...args], { cwd: repoRoot, encoding: 'utf8', windowsHide: true }).trim()
    git('init', '--quiet')
    await mkdir(join(repoRoot, 'release'))
    await mkdir(join(repoRoot, 'layers', 'update-ops', 'update-flow'), { recursive: true })
    await writeFile(join(repoRoot, 'layers', 'update-ops', 'update-flow', 'public-source.json'), JSON.stringify({ releaseLine }))
    await expect(coordinatorReleaseLineFor(repoRoot)).resolves.toBe(releaseLine)
    await writeFile(join(repoRoot, 'package.json'), JSON.stringify({ version: '1.0.0', persistentMemoryReleaseLine: releaseLine }))
    await writeFile(join(repoRoot, 'release', 'upgrade.json'), await readFile(new URL('../../../release/upgrade.json', import.meta.url)))
    git('add', '.')
    git('commit', '--quiet', '-m', 'Public initial release')
    const publicCommit = git('rev-parse', 'HEAD')
    for (const pkg of [{ version: '4.0.37' }, { version: '1.0.0' }, { version: '1.0.0', persistentMemoryReleaseLine: 'old-line' }]) {
      await writeFile(join(repoRoot, 'package.json'), JSON.stringify(pkg))
      await writeFile(join(repoRoot, 'release', 'upgrade.json'), '{"invalidHistoricalContract":true}')
      git('add', '.')
      git('commit', '--quiet', '-m', 'Historical fixture outside public release line')
    }
    git('update-ref', 'refs/remotes/origin/master', 'HEAD')
    const contracts = await loadTrustedUpgradeContracts(repoRoot, 'master', releaseLine, contractModuleUrl)
    expect([...contracts.keys()]).toEqual(['1.0.0'])
    await expect(coordinatorReleaseWorktree(repoRoot, join(repoRoot, 'coordinator'), 'master', '4.0.37', releaseLine)).rejects.toThrow('unavailable from trusted origin/master')
    const worktree = await coordinatorReleaseWorktree(repoRoot, join(repoRoot, 'coordinator'), 'master', '1.0.0', releaseLine)
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8', windowsHide: true }).trim()).toBe(publicCommit)
    expect(JSON.parse(await readFile(join(worktree, 'package.json'), 'utf8'))).toMatchObject({ persistentMemoryReleaseLine: releaseLine })
  })

  it('does not reuse a completed plan from an old release line with the same version numbers', async () => {
    const { installation } = await installFixture()
    const calls: string[] = []
    const plan = { protocolVersion: 1 as const, sourceVersion: '1.0.0', targetVersion: '1.0.0', path: ['1.0.0'], targetRevision: 'same-revision', plannedAt: '2026-09-06T00:00:00.000Z' }
    await executeCoordinatorPlan({ coordinatorHome: installation.installationHome, plan, snapshot: async () => {}, runHop: async () => {} })
    await expect(executeCoordinatorPlan({ coordinatorHome: installation.installationHome, plan: { ...plan, releaseLine }, snapshot: async () => { calls.push('snapshot') }, runHop: async () => { calls.push('hop') } })).resolves.toMatchObject({ releaseLine, status: 'complete' })
    expect(calls).toEqual(['snapshot', 'hop'])
  })

  it('does not resume or overwrite an unfinished plan from an old release line', async () => {
    const { installation } = await installFixture()
    const plan = { protocolVersion: 1 as const, sourceVersion: '1.0.0', targetVersion: '1.0.1', path: ['1.0.1'], targetRevision: 'old-revision', plannedAt: '2026-09-06T00:00:00.000Z' }
    await expect(executeCoordinatorPlan({ coordinatorHome: installation.installationHome, plan, snapshot: async () => {}, runHop: async () => { throw new Error('fixture failure') } })).rejects.toThrow('fixture failure')
    const statePath = join(installation.installationHome, 'state', 'hop-progress.json')
    const originalState = await readFile(statePath, 'utf8')
    const work = vi.fn(async () => {})
    await expect(executeCoordinatorPlan({ coordinatorHome: installation.installationHome, plan: { ...plan, releaseLine, targetRevision: 'public-revision' }, snapshot: work, runHop: work })).rejects.toThrow('different update plan')
    expect(work).not.toHaveBeenCalled()
    await expect(readFile(statePath, 'utf8')).resolves.toBe(originalState)
  })
})
