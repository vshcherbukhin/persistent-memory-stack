#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import { access, chmod, copyFile, link, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, posix, resolve, win32 } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
export function deployedStatePathFor(repoRoot, handoffStateDir) {
    const stateDir = handoffStateDir ? resolve(handoffStateDir) : join(resolve(repoRoot), '.local', 'update-state');
    return join(stateDir, 'last-successful-update.json');
}
export function canonicalInstallationRoot(repoRoot, platform = process.platform) {
    const resolved = (platform === 'win32' ? win32 : posix).resolve(repoRoot);
    const releaseWorktreeSegment = '/.local/release-worktrees/';
    const comparable = platform === 'win32' ? resolved.replace(/\\/gu, '/').toLowerCase() : resolved;
    const index = comparable.indexOf(releaseWorktreeSegment);
    return index >= 0 ? resolved.slice(0, index) : resolved;
}
function installationIdFor(repoRoot) {
    const root = canonicalInstallationRoot(repoRoot);
    return createHash('sha256').update(process.platform === 'win32' ? root.toLowerCase() : root).digest('hex').slice(0, 24);
}
async function writeJsonAtomic(path, value) {
    const directory = dirname(path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
}
async function copyPrivateIfMissing(source, destination) {
    const temporary = `${destination}.${randomUUID()}.tmp`;
    await copyFile(source, temporary, constants.COPYFILE_FICLONE);
    await chmod(temporary, 0o600);
    try {
        await link(temporary, destination);
    }
    catch (error) {
        const code = error instanceof Error && 'code' in error ? error.code : undefined;
        if (code !== 'EEXIST')
            throw error;
    }
    finally {
        await rm(temporary, { force: true });
    }
}
async function requireReadable(path) {
    await access(path, constants.R_OK);
}
async function artifactIdFor(paths) {
    const hash = createHash('sha256');
    for (const bytes of await Promise.all(paths.map(path => readFile(path))))
        hash.update(bytes).update('\0');
    return hash.digest('hex').slice(0, 24);
}
export async function installCoordinator(options) {
    const repoRoot = canonicalInstallationRoot(options.repoRoot);
    const installationId = installationIdFor(repoRoot);
    const installationHome = join(resolve(options.coordinatorBaseDir), installationId);
    const artifact = join(resolve(options.artifactDir), 'coordinator.mjs');
    const contractLibrary = join(resolve(options.artifactDir), 'lib', 'upgrade-contract.mjs');
    const releaseLibrary = join(resolve(options.artifactDir), 'lib', 'github-releases.mjs');
    const publicSource = join(resolve(options.artifactDir), 'lib', 'public-source.json');
    const artifacts = [artifact, contractLibrary, releaseLibrary, publicSource];
    await Promise.all(artifacts.map(requireReadable));
    const artifactId = await artifactIdFor(artifacts);
    const home = join(installationHome, 'bundles', artifactId);
    await mkdir(join(home, 'lib'), { recursive: true, mode: 0o700 });
    await mkdir(join(installationHome, 'state'), { recursive: true, mode: 0o700 });
    await chmod(installationHome, 0o700);
    await chmod(join(installationHome, 'bundles'), 0o700);
    await chmod(home, 0o700);
    await chmod(join(home, 'lib'), 0o700);
    await chmod(join(installationHome, 'state'), 0o700);
    await copyPrivateIfMissing(artifact, join(home, 'coordinator.mjs'));
    await copyPrivateIfMissing(contractLibrary, join(home, 'lib', 'upgrade-contract.mjs'));
    await copyPrivateIfMissing(releaseLibrary, join(home, 'lib', 'github-releases.mjs'));
    await copyPrivateIfMissing(publicSource, join(home, 'lib', 'public-source.json'));
    await writeJsonAtomic(join(installationHome, 'installation.json'), {
        protocolVersion: 1,
        installationId,
        repoRoot,
        installedAt: new Date().toISOString(),
    });
    return { installationId, home, installationHome };
}
export async function acquireCoordinatorLock(home, options = {}) {
    const path = join(home, 'update.lock');
    if (options.adoptExisting) {
        await access(path, constants.R_OK);
        return {
            path,
            async release() {
                await rm(path, { recursive: true, force: true });
            },
        };
    }
    try {
        await mkdir(path, { mode: 0o700 });
    }
    catch (error) {
        const code = error instanceof Error && 'code' in error ? error.code : undefined;
        if (code === 'EEXIST')
            throw new Error(`Persistent Memory update is already running (${path}).`);
        throw error;
    }
    await writeJsonAtomic(join(path, 'owner.json'), { pid: process.pid, startedAt: new Date().toISOString() });
    return {
        path,
        async release() {
            await rm(path, { recursive: true, force: true });
        },
    };
}
async function readJson(path) {
    return JSON.parse(await readFile(path, 'utf8'));
}
function versionFromDurableState(value) {
    if (!value || typeof value !== 'object')
        return undefined;
    const version = value.version;
    return typeof version === 'string' && /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(version) ? version : undefined;
}
function hasReleaseLine(value, releaseLine, key = 'releaseLine') {
    return !!releaseLine && !!value && typeof value === 'object'
        && value[key] === releaseLine;
}
export async function coordinatorReleaseLineFor(repoRoot) {
    const source = await readJson(join(repoRoot, 'layers', 'update-ops', 'update-flow', 'public-source.json'));
    if (typeof source.releaseLine !== 'string' || !/^[a-z][a-z0-9-]*$/u.test(source.releaseLine)) {
        throw new Error('The initiating checkout is missing its trusted public release line.');
    }
    return source.releaseLine;
}
export async function resolveDeployedVersion(options) {
    try {
        const state = await readJson(options.statePath);
        const stateVersion = hasReleaseLine(state, options.releaseLine) ? versionFromDurableState(state) : undefined;
        if (stateVersion)
            return stateVersion;
    }
    catch {
        // A fresh install may not have a durable marker yet; use its live dashboard next.
    }
    if (!options.liveReleaseHistoryUrl) {
        throw new Error(`Cannot determine the deployed release: no valid durable state at ${options.statePath}.`);
    }
    try {
        const response = await fetch(options.liveReleaseHistoryUrl, { signal: AbortSignal.timeout(2_000) });
        const history = await response.text();
        const version = /^##\s+([0-9]+\.[0-9]+\.[0-9]+)\b/mu.exec(history)?.[1];
        if (response.ok && version && history.includes(`<!-- persistent-memory-release-line: ${options.releaseLine} -->`))
            return version;
    }
    catch {
        // The final error below explains the recovery action without treating checkout HEAD as deployed state.
    }
    throw new Error(`Cannot determine the deployed release from durable state or ${options.liveReleaseHistoryUrl}.`);
}
async function loadUpgradeContract(moduleUrl) {
    const url = moduleUrl ?? new URL('./lib/upgrade-contract.mjs', import.meta.url).href;
    return await import(url);
}
export async function planCoordinatorBootstrap(options) {
    const [rawContract, packageJson, sourceVersion, upgrade] = await Promise.all([
        readJson(options.contractPath),
        readJson(options.packagePath),
        resolveDeployedVersion({
            statePath: options.deployedStatePath,
            releaseLine: options.releaseLine,
            liveReleaseHistoryUrl: options.liveReleaseHistoryUrl,
        }),
        loadUpgradeContract(options.upgradeContractModuleUrl),
    ]);
    if (!hasReleaseLine(packageJson, options.releaseLine, 'persistentMemoryReleaseLine')) {
        throw new Error('Coordinator target package does not belong to the current public release line.');
    }
    const packageVersion = versionFromDurableState(packageJson);
    if (!packageVersion)
        throw new Error(`Coordinator target package is missing a valid version: ${options.packagePath}`);
    const availableReleases = new Set(options.contracts?.keys() ?? [packageVersion]);
    const contract = upgrade.validateUpgradeContract(rawContract, { packageVersion, availableReleases });
    const contracts = new Map(options.contracts ?? []);
    contracts.set(contract.release, contract);
    const path = upgrade.planUpgradePath(sourceVersion, contract, contracts);
    const plan = {
        protocolVersion: 1,
        releaseLine: options.releaseLine,
        sourceVersion,
        targetVersion: contract.release,
        path,
        plannedAt: new Date().toISOString(),
    };
    await writeJsonAtomic(join(options.coordinatorHome, 'state', 'active-plan.json'), plan);
    return plan;
}
async function runCommand(command, args, cwd) {
    return await new Promise((resolveRun) => {
        const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
        child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
        child.once('error', (error) => resolveRun({ code: 1, stdout, stderr: error.message }));
        child.once('close', (code) => resolveRun({ code: code ?? 1, stdout, stderr }));
    });
}
async function gitOutput(repoRoot, args) {
    const result = await runCommand('git', args, repoRoot);
    if (result.code !== 0)
        throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`.trim());
    return result.stdout.trim();
}
async function versionAtCommit(repoRoot, commit, releaseLine) {
    try {
        const raw = await gitOutput(repoRoot, ['show', `${commit}:package.json`]);
        const packageJson = JSON.parse(raw);
        return hasReleaseLine(packageJson, releaseLine, 'persistentMemoryReleaseLine') ? versionFromDurableState(packageJson) : undefined;
    }
    catch {
        return undefined;
    }
}
/** Loads only contracts reachable from the trusted selected branch. */
export async function loadTrustedUpgradeContracts(repoRoot, branch, releaseLine, moduleUrl) {
    const upgrade = await loadUpgradeContract(moduleUrl);
    const commits = (await gitOutput(repoRoot, ['rev-list', `origin/${branch}`])).split(/\r?\n/u).filter(Boolean);
    const rawContracts = new Map();
    for (const commit of commits) {
        const version = await versionAtCommit(repoRoot, commit, releaseLine);
        if (!version || rawContracts.has(version))
            continue;
        try {
            rawContracts.set(version, JSON.parse(await gitOutput(repoRoot, ['show', `${commit}:release/upgrade.json`])));
        }
        catch {
            // Releases before upgrade contracts are intentionally unavailable to the planner.
        }
    }
    const available = new Set(rawContracts.keys());
    const contracts = new Map();
    for (const [version, raw] of rawContracts) {
        contracts.set(version, upgrade.validateUpgradeContract(raw, { packageVersion: version, availableReleases: available }));
    }
    return contracts;
}
function validatePublishedPin(release) {
    if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(release.version)
        || release.tag !== `v${release.version}` || !/^[0-9a-f]{40}$/u.test(release.commit)) {
        throw new Error('Invalid published release selection. Resolve a published GitHub release before updating.');
    }
}
async function resolvePublishedRelease(options) {
    const releaseModule = await import(new URL('./lib/github-releases.mjs', import.meta.url).href);
    return await releaseModule.fetchPublishedRelease(options);
}
export async function publishedTargetForCoordinator(repoRoot, releaseLine, env, resolveRelease = resolvePublishedRelease) {
    const pin = {
        tag: env.PM_COORDINATOR_RELEASE_TAG ?? '',
        version: env.PM_COORDINATOR_RELEASE_VERSION ?? '',
        commit: env.PM_COORDINATOR_RELEASE_COMMIT ?? '',
    };
    // The v1.1.0 shell installs this new bundle after resolving its checkout but
    // cannot export fields introduced in v1.1.1. Resolve that exact version anew
    // from published Releases; main still verifies the tag and checkout SHA.
    if (env.PM_COORDINATOR_SOURCE_MODE === undefined && !pin.tag && !pin.version && !pin.commit) {
        if (env.PM_COORDINATOR_TARGET_RESOLVED !== '1') {
            throw new Error('Legacy coordinator handoff has no resolved update target. Run the supported host updater.');
        }
        const pkg = await readJson(join(repoRoot, 'package.json'));
        const version = versionFromDurableState(pkg);
        if (!version || !hasReleaseLine(pkg, releaseLine, 'persistentMemoryReleaseLine')) {
            throw new Error('Legacy coordinator target package does not belong to the current public release line.');
        }
        const published = await resolveRelease({ version });
        validatePublishedPin(published);
        if (published.version !== version)
            throw new Error('Published release differs from the legacy coordinator target version.');
        return published;
    }
    validatePublishedPin(pin);
    return pin;
}
export async function fetchPublishedReleaseCommit(repoRoot, release, releaseLine) {
    validatePublishedPin(release);
    let fetched;
    try {
        await gitOutput(repoRoot, ['fetch', '--quiet', '--no-recurse-submodules', '--no-tags', 'origin', `refs/tags/${release.tag}`]);
        fetched = await gitOutput(repoRoot, ['rev-parse', '--verify', 'FETCH_HEAD^{commit}']);
    }
    catch {
        // Git tracing, proxies, and credential helpers can include secrets in diagnostics.
        throw new Error('Published release Git fetch failed. Check repository access and connectivity, then retry.');
    }
    if (fetched !== release.commit)
        throw new Error(`Published tag ${release.tag} changed while fetching. Refusing to update.`);
    if (await versionAtCommit(repoRoot, fetched, releaseLine) !== release.version) {
        throw new Error(`Published tag ${release.tag} does not match its package version and public release line.`);
    }
    return fetched;
}
/** Release-mode contracts come only from published, pinned tags, never branch history. */
export async function loadPublishedUpgradeContracts(repoRoot, releaseLine, target, options = {}) {
    const upgrade = await loadUpgradeContract(options.moduleUrl);
    const resolveRelease = options.resolveRelease ?? resolvePublishedRelease;
    const releases = new Map();
    const rawContracts = new Map();
    const queued = new Set([target.version]);
    const pending = [target.version];
    const signal = AbortSignal.timeout(120_000);
    while (pending.length) {
        if (signal.aborted)
            throw new Error('Published release planning timed out. Retry when GitHub is reachable.');
        const version = pending.shift();
        if (releases.size >= 25)
            throw new Error('Published release dependency limit exceeded.');
        const release = version === target.version ? target : await resolveRelease({ version, signal });
        if (release.version !== version)
            throw new Error(`Published release resolver returned the wrong version for ${version}.`);
        await fetchPublishedReleaseCommit(repoRoot, release, releaseLine);
        const raw = JSON.parse(await gitOutput(repoRoot, ['show', `${release.commit}:release/upgrade.json`]));
        if (!raw || typeof raw !== 'object' || !Array.isArray(raw.requiredStops)) {
            throw new Error(`Published release ${version} has an invalid upgrade contract.`);
        }
        releases.set(version, release);
        rawContracts.set(version, raw);
        for (const stop of raw.requiredStops) {
            if (!stop || typeof stop.release !== 'string' || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(stop.release)) {
                throw new Error(`Published release ${version} has an invalid required stop.`);
            }
            if (!queued.has(stop.release)) {
                queued.add(stop.release);
                pending.push(stop.release);
            }
        }
    }
    const availableReleases = new Set(releases.keys());
    const contracts = new Map();
    for (const [version, raw] of rawContracts) {
        contracts.set(version, upgrade.validateUpgradeContract(raw, { packageVersion: version, availableReleases }));
    }
    return { contracts, releases };
}
async function assertPinnedWorktree(root, commit) {
    if (await gitOutput(root, ['rev-parse', 'HEAD']) !== commit)
        throw new Error(`Release worktree ${root} points to a different commit.`);
    if (await gitOutput(root, ['status', '--porcelain', '--untracked-files=no']))
        throw new Error(`Release worktree ${root} has tracked changes. Refusing to execute modified release code.`);
}
export async function coordinatorPublishedReleaseWorktree(repoRoot, coordinatorHome, release) {
    validatePublishedPin(release);
    const worktree = join(coordinatorHome, 'worktrees', `persistent-memory-${release.version}-${release.commit.slice(0, 12)}`);
    if (!existsSync(worktree)) {
        await mkdir(dirname(worktree), { recursive: true, mode: 0o700 });
        await gitOutput(repoRoot, ['worktree', 'add', '--detach', worktree, release.commit]);
    }
    await assertPinnedWorktree(worktree, release.commit);
    return worktree;
}
export async function coordinatorReleaseWorktree(repoRoot, coordinatorHome, branch, release, releaseLine) {
    const commits = (await gitOutput(repoRoot, ['rev-list', `origin/${branch}`])).split(/\r?\n/u).filter(Boolean);
    let commit;
    for (const candidate of commits) {
        if (await versionAtCommit(repoRoot, candidate, releaseLine) === release) {
            commit = candidate;
            break;
        }
    }
    if (!commit)
        throw new Error(`Release ${release} is unavailable from trusted origin/${branch}.`);
    const worktree = join(coordinatorHome, 'worktrees', `persistent-memory-${release}-${commit.slice(0, 12)}`);
    try {
        const existing = await gitOutput(worktree, ['rev-parse', 'HEAD']);
        if (existing !== commit)
            throw new Error(`Coordinator worktree ${worktree} points to a different commit.`);
        return worktree;
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes('not a git repository') && !message.includes('ENOENT'))
            throw error;
    }
    await mkdir(dirname(worktree), { recursive: true, mode: 0o700 });
    const result = await runCommand('git', ['worktree', 'add', '--detach', worktree, commit], repoRoot);
    if (result.code !== 0)
        throw new Error(`Could not create coordinator worktree for ${release}: ${result.stderr || result.stdout}`.trim());
    return worktree;
}
function progressPathFor(coordinatorHome) {
    return join(coordinatorHome, 'state', 'hop-progress.json');
}
function validPublishedPlanPins(input) {
    if (input.releaseCommits === undefined)
        return true;
    const pins = input.releaseCommits;
    return pins !== null && typeof pins === 'object' && !Array.isArray(pins)
        && Object.entries(pins).every(([version, commit]) => /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(version) && typeof commit === 'string' && /^[0-9a-f]{40}$/u.test(commit))
        && input.path.every(version => typeof pins[version] === 'string')
        && pins[input.targetVersion] === input.targetRevision;
}
function isExecutionState(value) {
    const input = value;
    if (!input)
        return false;
    return input.protocolVersion === 1
        && typeof input.sourceVersion === 'string'
        && typeof input.targetVersion === 'string'
        && Array.isArray(input.path)
        && ['running', 'complete', 'failed'].includes(String(input.status))
        && Array.isArray(input.completedHops)
        && typeof input.updatedAt === 'string'
        && (input.snapshotStatus === undefined || input.snapshotStatus === 'running' || input.snapshotStatus === 'complete')
        && validPublishedPlanPins(input);
}
function newExecutionState(plan) {
    return {
        protocolVersion: 1,
        releaseLine: plan.releaseLine,
        sourceVersion: plan.sourceVersion,
        targetVersion: plan.targetVersion,
        path: [...plan.path],
        targetRevision: plan.targetRevision,
        releaseCommits: plan.releaseCommits,
        status: 'running',
        completedHops: [],
        updatedAt: new Date().toISOString(),
    };
}
function matchesPlan(state, plan) {
    return state.releaseLine === plan.releaseLine
        && state.sourceVersion === plan.sourceVersion
        && state.targetVersion === plan.targetVersion
        && state.path.join('\u0000') === plan.path.join('\u0000')
        && state.targetRevision === plan.targetRevision
        && JSON.stringify(state.releaseCommits ?? null) === JSON.stringify(plan.releaseCommits ?? null);
}
function matchesReleasePath(state, plan) {
    return state.releaseLine === plan.releaseLine
        && state.sourceVersion === plan.sourceVersion
        && state.targetVersion === plan.targetVersion
        && state.path.join('\u0000') === plan.path.join('\u0000');
}
function canRetryFailedRevision(state, plan) {
    return state.status === 'failed'
        && !state.releaseCommits && !plan.releaseCommits
        && state.completedHops.length === 0
        && matchesReleasePath(state, plan)
        && state.targetRevision !== plan.targetRevision;
}
export async function clearHandoffForNoopRun(options) {
    let handoff;
    try {
        handoff = await readJson(options.handoffPath);
    }
    catch (error) {
        if (isMissingFile(error))
            return false;
        throw error;
    }
    const input = handoff;
    if (!input || input.id !== options.runId)
        return false;
    await writeJsonAtomic(options.handoffPath, {
        id: options.runId,
        ...(typeof input.releaseLine === 'string' ? { releaseLine: input.releaseLine } : {}),
        source: typeof input.source === 'string' ? input.source : 'update-coordinator',
        phase: 'idle',
        updatedAt: new Date().toISOString(),
    });
    return true;
}
export async function publishCoordinatorFailureForRun(options) {
    let handoff;
    try {
        handoff = await readJson(options.handoffPath);
    }
    catch (error) {
        if (isMissingFile(error))
            return false;
        throw error;
    }
    const input = handoff;
    if (!input || input.id !== options.runId || input.phase === 'failed')
        return false;
    const updatedAt = new Date().toISOString();
    const state = {
        id: options.runId,
        ...(typeof input.releaseLine === 'string' ? { releaseLine: input.releaseLine } : {}),
        source: typeof input.source === 'string' ? input.source : 'update-coordinator',
        phase: 'failed',
        message: 'Update coordinator stopped before the lifecycle could start. Review the error below, then use the terminal for full details.',
        startedAt: typeof input.startedAt === 'string' ? input.startedAt : updatedAt,
        updatedAt,
        error: 'Update coordinator stopped before the lifecycle could start.',
    };
    for (const field of ['targetVersion', 'releaseNotesVersion']) {
        if (typeof input[field] === 'string')
            state[field] = input[field];
    }
    await writeJsonAtomic(options.handoffPath, state);
    return true;
}
function validateRecoveryState(state, plan, path) {
    const completed = state.completedHops;
    const isOrderedPrefix = completed.length <= plan.path.length
        && completed.every((release, index) => release === plan.path[index]);
    if (!isOrderedPrefix)
        throw new Error(`Coordinator recovery state is invalid: ${path}. Completed hops must be an ordered prefix of the planned path.`);
    if ((state.snapshotAt && state.snapshotStatus === 'running') || (!state.snapshotAt && state.snapshotStatus === 'complete')) {
        throw new Error(`Coordinator recovery state is invalid: ${path}. Snapshot status and checkpoint disagree.`);
    }
    if (completed.length > 0 && !state.snapshotAt) {
        throw new Error(`Coordinator recovery state is invalid: ${path}. Verified hops require a completed snapshot checkpoint.`);
    }
    const nextHop = plan.path[completed.length];
    if (state.status === 'complete') {
        if (completed.length !== plan.path.length || state.currentHop || state.failedHop) {
            throw new Error(`Coordinator recovery state is invalid: ${path}. A complete plan must verify every hop exactly once.`);
        }
        return;
    }
    if (state.status === 'failed') {
        if (!nextHop || state.currentHop !== nextHop || state.failedHop !== nextHop) {
            throw new Error(`Coordinator recovery state is invalid: ${path}. A failed plan must identify the first unfinished hop.`);
        }
        return;
    }
    if (state.currentHop !== undefined && state.currentHop !== nextHop) {
        throw new Error(`Coordinator recovery state is invalid: ${path}. A running plan must point at the first unfinished hop.`);
    }
}
function isMissingFile(error) {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
/**
 * Executes a persisted release path exactly once. A completed snapshot and each
 * completed hop are durable checkpoints, so a restart resumes at the first
 * unfinished hop and never silently rolls database data back.
 */
export async function executeCoordinatorPlan(options) {
    if (!validPublishedPlanPins(options.plan))
        throw new Error('Coordinator published release plan has invalid or missing commit pins.');
    const path = progressPathFor(options.coordinatorHome);
    let state;
    try {
        const existing = await readJson(path);
        if (!isExecutionState(existing))
            throw new Error(`Coordinator recovery state is invalid: ${path}. Restore it from a known backup before retrying.`);
        for (const [version, commit] of Object.entries(existing.releaseCommits ?? {})) {
            const selected = options.plan.releaseCommits?.[version];
            if (selected && selected !== commit)
                throw new Error(`Published release ${version} changed since the saved update plan. Refusing to replace its pinned commit.`);
        }
        if (!matchesPlan(existing, options.plan)) {
            if (canRetryFailedRevision(existing, options.plan)) {
                validateRecoveryState(existing, {
                    protocolVersion: 1,
                    sourceVersion: existing.sourceVersion,
                    targetVersion: existing.targetVersion,
                    path: existing.path,
                    targetRevision: existing.targetRevision,
                    plannedAt: existing.updatedAt,
                }, path);
                state = {
                    ...existing,
                    targetRevision: options.plan.targetRevision,
                    status: 'running',
                    currentHop: undefined,
                    failedHop: undefined,
                    error: undefined,
                    updatedAt: new Date().toISOString(),
                };
            }
            else {
                if (existing.status !== 'complete') {
                    throw new Error('Coordinator recovery state belongs to a different update plan. Review recovery state before starting another update.');
                }
                validateRecoveryState(existing, {
                    protocolVersion: 1,
                    sourceVersion: existing.sourceVersion,
                    targetVersion: existing.targetVersion,
                    path: existing.path,
                    targetRevision: existing.targetRevision,
                    plannedAt: existing.updatedAt,
                }, path);
                state = newExecutionState(options.plan);
            }
        }
        else {
            validateRecoveryState(existing, options.plan, path);
            state = existing;
        }
    }
    catch (error) {
        if (!isMissingFile(error))
            throw error;
        state = newExecutionState(options.plan);
    }
    if (state.status === 'complete') {
        await options.onNoop?.(state);
        return state;
    }
    if (!state.snapshotAt) {
        if (state.snapshotStatus === 'running') {
            throw new Error(`Coordinator snapshot outcome is unknown after an interrupted run. Inspect the snapshot and recovery state before retrying: ${path}`);
        }
        state.snapshotStatus = 'running';
        state.status = 'running';
        state.updatedAt = new Date().toISOString();
        await writeJsonAtomic(path, state);
        await options.snapshot();
        state.snapshotAt = new Date().toISOString();
        state.snapshotStatus = 'complete';
        state.status = 'running';
        state.updatedAt = state.snapshotAt;
        await writeJsonAtomic(path, state);
    }
    const completed = new Set(state.completedHops);
    for (const release of options.plan.path) {
        if (completed.has(release))
            continue;
        state.status = 'running';
        state.currentHop = release;
        state.failedHop = undefined;
        state.error = undefined;
        state.updatedAt = new Date().toISOString();
        await writeJsonAtomic(path, state);
        try {
            await options.runHop(release);
        }
        catch (error) {
            state.status = 'failed';
            state.failedHop = release;
            state.error = error instanceof Error ? error.message : String(error);
            state.updatedAt = new Date().toISOString();
            await writeJsonAtomic(path, state);
            throw error;
        }
        state.completedHops.push(release);
        completed.add(release);
        state.currentHop = undefined;
        state.updatedAt = new Date().toISOString();
        await writeJsonAtomic(path, state);
    }
    state.status = 'complete';
    state.currentHop = undefined;
    state.failedHop = undefined;
    state.completedAt = new Date().toISOString();
    state.updatedAt = state.completedAt;
    await writeJsonAtomic(path, state);
    return state;
}
function readFlag(flags, name) {
    const index = flags.indexOf(name);
    return index >= 0 ? flags[index + 1] : undefined;
}
function parseCli(argv) {
    const separator = argv.indexOf('--');
    const flags = separator >= 0 ? argv.slice(0, separator) : argv;
    const args = separator >= 0 ? argv.slice(separator + 1) : [];
    const repoRoot = readFlag(flags, '--repo-root');
    const legacyScript = readFlag(flags, '--legacy-script');
    if (!repoRoot || !legacyScript)
        throw new Error('Coordinator requires --repo-root and --legacy-script.');
    return { repoRoot: resolve(repoRoot), legacyScript: resolve(legacyScript), args };
}
async function installFromCli(argv) {
    const repoRoot = readFlag(argv, '--root');
    if (!repoRoot)
        throw new Error('Coordinator installation requires --root.');
    const coordinatorBaseDir = readFlag(argv, '--base-dir') ?? join(homedir(), '.persistent-memory', 'instances');
    const installation = await installCoordinator({
        repoRoot,
        artifactDir: dirname(fileURLToPath(import.meta.url)),
        coordinatorBaseDir,
    });
    if (argv.includes('--print-home'))
        process.stdout.write(`${installation.home}\n`);
    else
        process.stdout.write(`INFO: [update-coordinator] installed ${installation.home}\n`);
}
export function legacyUpdateInvocation(legacyScript, args, env, platform = process.platform, pathExists = existsSync) {
    if (platform !== 'win32')
        return { command: 'bash', args: [legacyScript, ...args], env };
    // The native launcher validates Git for Windows and exports its exact Bash.
    // Never fall back to System32/bash.exe: that starts a different WSL host.
    const bash = env.PM_GIT_BASH;
    const gitRoot = bash ? win32.resolve(win32.dirname(bash), /[\\/]usr[\\/]bin[\\/]bash\.exe$/iu.test(bash) ? '../..' : '..') : '';
    if (!bash || !win32.isAbsolute(bash) || win32.basename(bash).toLowerCase() !== 'bash.exe'
        || !pathExists(bash) || !pathExists(win32.join(gitRoot, 'usr', 'bin', 'cygpath.exe'))) {
        throw new Error('Windows updates require Git for Windows Bash. Run npm run update-persistent-memory from PowerShell so the launcher selects it.');
    }
    return {
        command: bash,
        args: ['--noprofile', '--norc', legacyScript.replace(/\\/gu, '/'), ...args],
        env: { ...env, MSYS_NO_PATHCONV: '1', MSYS2_ARG_CONV_EXCL: '*' },
    };
}
async function runLegacyUpdate(legacyScript, args, env) {
    const invocation = legacyUpdateInvocation(legacyScript, args, env);
    return await runProcess(invocation.command, invocation.args, env.PM_COORDINATOR_SOURCE_ROOT ?? process.cwd(), invocation.env);
}
async function runProcess(command, args, cwd, env) {
    return await new Promise((resolveRun, rejectRun) => {
        const child = spawn(command, args, { cwd, stdio: 'inherit', env, windowsHide: true });
        child.once('error', rejectRun);
        child.once('close', (code) => resolveRun(code ?? 1));
    });
}
export async function planLegacyBridge(options) {
    const [sourceVersion, packageJson] = await Promise.all([
        resolveDeployedVersion({ statePath: options.deployedStatePath, releaseLine: options.releaseLine, liveReleaseHistoryUrl: options.liveReleaseHistoryUrl }),
        readJson(options.packagePath),
    ]);
    if (!hasReleaseLine(packageJson, options.releaseLine, 'persistentMemoryReleaseLine')) {
        throw new Error('Coordinator target package does not belong to the current public release line.');
    }
    const targetVersion = versionFromDurableState(packageJson);
    if (!targetVersion)
        throw new Error(`Coordinator target package is missing a valid version: ${options.packagePath}`);
    const plan = {
        protocolVersion: 1,
        releaseLine: options.releaseLine,
        sourceVersion,
        targetVersion,
        path: [targetVersion],
        plannedAt: new Date().toISOString(),
    };
    await writeJsonAtomic(join(options.coordinatorHome, 'state', 'active-plan.json'), plan);
    return plan;
}
export function handoffStateDirFor(hopRoot, coordinatorHome, legacyBridge) {
    // 4.0.27's gateway predates the coordinator mount. Its Compose file can only
    // read the target worktree's legacy handoff directory, so bridge events use
    // that compatible location until the gateway returns to a modern release.
    return legacyBridge ? join(hopRoot, '.local', 'update-state') : join(coordinatorHome, 'state');
}
async function main() {
    if (process.argv.slice(2).includes('--install')) {
        await installFromCli(process.argv.slice(2));
        return;
    }
    const cli = parseCli(process.argv.slice(2));
    const coordinatorBundleHome = dirname(fileURLToPath(import.meta.url));
    const coordinatorHome = resolve(coordinatorBundleHome, '..', '..');
    const statePath = deployedStatePathFor(cli.repoRoot, process.env.PM_HANDOFF_STATE_DIR);
    const lock = await acquireCoordinatorLock(coordinatorHome, { adoptExisting: process.env.PM_COORDINATOR_LOCK_HELD === '1' });
    try {
        const sourceRoot = resolve(process.env.PM_COORDINATOR_SOURCE_ROOT ?? cli.repoRoot);
        const releaseLine = await coordinatorReleaseLineFor(sourceRoot);
        const publishedMode = process.env.PM_COORDINATOR_SOURCE_MODE !== 'branch';
        const branch = publishedMode ? '' : process.env.PM_COORDINATOR_BRANCH ?? await gitOutput(sourceRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
        const publishedTarget = publishedMode
            ? await publishedTargetForCoordinator(cli.repoRoot, releaseLine, process.env)
            : { tag: '', version: '', commit: '' };
        let publishedReleases = new Map();
        if (publishedMode) {
            await fetchPublishedReleaseCommit(sourceRoot, publishedTarget, releaseLine);
            await assertPinnedWorktree(cli.repoRoot, publishedTarget.commit);
            publishedReleases.set(publishedTarget.version, publishedTarget);
        }
        const packagePath = join(cli.repoRoot, 'package.json');
        const contractPath = join(cli.repoRoot, 'release', 'upgrade.json');
        const liveReleaseHistoryUrl = process.env.PM_DEPLOYED_RELEASE_HISTORY_URL ?? `${process.env.PM_DASHBOARD_URL ?? 'http://127.0.0.1:3200'}/release-history.md`;
        let plan;
        let legacyBridge = false;
        try {
            await access(contractPath, constants.R_OK);
            let contracts;
            if (publishedMode) {
                const published = await loadPublishedUpgradeContracts(sourceRoot, releaseLine, publishedTarget);
                contracts = published.contracts;
                publishedReleases = published.releases;
            }
            else {
                contracts = await loadTrustedUpgradeContracts(sourceRoot, branch, releaseLine);
            }
            plan = await planCoordinatorBootstrap({
                repoRoot: cli.repoRoot,
                releaseLine,
                coordinatorHome,
                contractPath,
                packagePath,
                deployedStatePath: statePath,
                liveReleaseHistoryUrl,
                contracts,
            });
        }
        catch (error) {
            if (!isMissingFile(error))
                throw error;
            // The requested exact legacy release predates upgrade metadata. Keep its
            // established one-hop lifecycle available while still snapshotting and
            // recording recovery state in the installer-managed coordinator.
            legacyBridge = true;
            plan = await planLegacyBridge({ coordinatorHome, releaseLine, deployedStatePath: statePath, liveReleaseHistoryUrl, packagePath });
        }
        const targetRevision = await gitOutput(cli.repoRoot, ['rev-parse', 'HEAD']).catch(() => undefined);
        if (targetRevision)
            plan = { ...plan, targetRevision };
        if (publishedMode) {
            if (plan.targetVersion !== publishedTarget.version || targetRevision !== publishedTarget.commit) {
                throw new Error('Coordinator target differs from the immutable published release selection.');
            }
            plan = { ...plan, releaseCommits: Object.fromEntries([...publishedReleases].sort(([a], [b]) => a.localeCompare(b)).map(([version, release]) => [version, release.commit])) };
        }
        await writeJsonAtomic(join(coordinatorHome, 'state', 'active-plan.json'), plan);
        const executionPlan = {
            ...plan,
            // A trusted dev branch can rebuild the same semantic release. It still
            // needs one lifecycle execution, even though it is not a semver hop.
            path: plan.path.length ? plan.path : [plan.targetVersion],
        };
        const state = await executeCoordinatorPlan({
            coordinatorHome,
            plan: executionPlan,
            snapshot: async () => {
                const exitCode = await runProcess('node', [join(sourceRoot, 'scripts', 'pre-update-snapshot.mjs'), '--required', '--source=update-coordinator'], sourceRoot, process.env);
                if (exitCode !== 0)
                    throw new Error(`Pre-update snapshot failed with exit code ${exitCode}.`);
            },
            runHop: async (release) => {
                const finalHop = release === plan.targetVersion;
                const publishedHop = publishedReleases.get(release);
                if (publishedMode && !publishedHop)
                    throw new Error(`Release hop ${release} has no published commit pin.`);
                const hopRoot = finalHop
                    ? cli.repoRoot
                    : publishedHop
                        ? await coordinatorPublishedReleaseWorktree(sourceRoot, coordinatorHome, publishedHop)
                        : await coordinatorReleaseWorktree(sourceRoot, coordinatorHome, branch, release, releaseLine);
                if (publishedHop)
                    await assertPinnedWorktree(hopRoot, publishedHop.commit);
                const handoffStateDir = handoffStateDirFor(hopRoot, coordinatorHome, legacyBridge);
                const exitCode = await runLegacyUpdate(cli.legacyScript, cli.args, {
                    ...process.env,
                    PM_COORDINATOR_ACTIVE: '1',
                    PM_COORDINATOR_HOME: coordinatorHome,
                    PM_COORDINATOR_INSTALL_ROOT: sourceRoot,
                    PM_COORDINATOR_STATE_DIR: join(coordinatorHome, 'state'),
                    PM_COORDINATOR_DEPLOYED_STATE_DIR: dirname(statePath),
                    PM_HANDOFF_STATE_DIR: handoffStateDir,
                    // Legacy targets understand only the original handoff source/schema,
                    // but Compose still mounts the coordinator-owned state directory.
                    PM_HANDOFF_SOURCE: legacyBridge ? 'update-script' : 'update-coordinator',
                    PM_HANDOFF_PROTOCOL_VERSION: legacyBridge ? '' : '1',
                    PM_COORDINATOR_RESOLVED_ROOT: hopRoot,
                    PM_COORDINATOR_SOURCE_ROOT: sourceRoot,
                    PM_COORDINATOR_ENV_RUNTIME: join(sourceRoot, '.env.persistent-memory'),
                    PM_COORDINATOR_VERSIONED_WORKTREE: finalHop ? process.env.PM_COORDINATOR_VERSIONED_WORKTREE ?? '0' : '1',
                    PM_COORDINATOR_FINAL_HOP: finalHop ? '1' : '0',
                    PM_COORDINATOR_SOURCE_MODE: publishedMode ? 'published' : 'branch',
                    PM_COORDINATOR_RELEASE_TAG: publishedTarget.tag,
                    PM_COORDINATOR_RELEASE_VERSION: publishedTarget.version,
                    PM_COORDINATOR_RELEASE_COMMIT: publishedTarget.commit,
                    PM_COORDINATOR_HOP_COMMIT: publishedHop?.commit ?? '',
                    PM_SKIP_SETUP_SNAPSHOT: '1',
                });
                if (exitCode !== 0)
                    throw new Error(`Release hop ${release} failed with exit code ${exitCode}.`);
            },
            onNoop: async () => {
                const handoffStateDir = process.env.PM_HANDOFF_STATE_DIR;
                const handoffRunId = process.env.PM_HANDOFF_ID;
                const cleared = handoffStateDir && handoffRunId
                    ? await clearHandoffForNoopRun({ handoffPath: join(resolve(handoffStateDir), 'dashboard-handoff.json'), runId: handoffRunId })
                    : false;
                process.stdout.write(cleared
                    ? '[OK]   No deployment was needed; returning the dashboard.\n'
                    : '[OK]   No lifecycle work was needed for the resolved release.\n');
            },
        });
        await writeJsonAtomic(join(coordinatorHome, 'state', 'completed-plan.json'), { ...state, plannedPath: plan.path });
    }
    catch (error) {
        const handoffStateDir = process.env.PM_HANDOFF_STATE_DIR;
        const handoffRunId = process.env.PM_HANDOFF_ID;
        if (handoffStateDir && handoffRunId) {
            const coordinatorHandoffPath = join(coordinatorHome, 'state', 'dashboard-handoff.json');
            const coordinatorHandoff = await readJson(coordinatorHandoffPath).catch(() => undefined);
            const childAlreadyPublishedFailure = coordinatorHandoff?.id === handoffRunId && coordinatorHandoff.phase === 'failed';
            if (!childAlreadyPublishedFailure) {
                await publishCoordinatorFailureForRun({
                    handoffPath: join(resolve(handoffStateDir), 'dashboard-handoff.json'),
                    runId: handoffRunId,
                }).catch(() => undefined);
            }
        }
        throw error;
    }
    finally {
        await lock.release();
    }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    void main().catch((error) => {
        console.error(`ERROR: [update-coordinator] ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
    });
}
//# sourceMappingURL=index.js.map