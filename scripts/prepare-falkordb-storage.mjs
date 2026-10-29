#!/usr/bin/env node
/** Preserve the legacy container-layer FalkorDB directory before its first /data recreate. */
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, closeSync, openSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LEGACY_DIR = '/var/lib/falkordb/data'
const SCHEMA = 'pm.falkordb-storage/1'
const ID = /^[a-f0-9]{64}$/
const IMAGE = /^sha256:[a-f0-9]{64}$/
const NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/
const MAX_SCRATCH_BYTES = 512 * 1024 * 1024
const fileManifestScript = "find . -type f -print0 | xargs -0 -r sha256sum; printf '\\n__PM_FILE_METADATA__\\n'; find . \\( -type f -o -type d \\) -print0 | xargs -0 -r stat -c '%f %u %g %n'"

export class StoragePreparationError extends Error {
  constructor(code, message, receiptPath) {
    super(message); this.name = 'StoragePreparationError'; this.code = code
    if (receiptPath) this.receiptPath = receiptPath
  }
}
const refuse = (code, message) => { throw new StoragePreparationError(code, message) }

export function storageConfiguration(text, envPath) {
  const values = {}
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(PM_CONTAINER_PREFIX|PM_VOLUME_PREFIX|COMPOSE_PROJECT_NAME)\s*=\s*(.*?)\s*$/)
    if (!match) continue
    if (Object.hasOwn(values, match[1])) refuse('invalid_environment', 'Duplicate storage namespace setting.')
    values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2')
  }
  const prefix = values.PM_CONTAINER_PREFIX || 'persistent-memory'
  const volumePrefix = values.PM_VOLUME_PREFIX || 'persistent_memory'
  const project = values.COMPOSE_PROJECT_NAME || 'persistent-memory'
  if (![prefix, volumePrefix, project].every(value => NAME.test(value))) refuse('invalid_environment', 'Invalid storage namespace setting.')
  return { prefix, volumePrefix, project, containerName: `${prefix}-falkordb`, volumeName: `${volumePrefix}_falkordb_data`,
    envPath: resolve(envPath), backupRoot: resolve(dirname(envPath), '.local/update-backups/falkordb-storage') }
}

/** Exact identity and Compose ownership are required even for a read-only check. */
export function validateStorageContainer(container, config, expectedId) {
  if (!ID.test(container?.Id ?? '') || (expectedId && container.Id !== expectedId)
    || container.Name !== `/${config.containerName}`
    || container.Config?.Labels?.['com.docker.compose.service'] !== 'falkordb'
    || container.Config?.Labels?.['com.docker.compose.project'] !== config.project) {
    refuse('container_ownership_conflict', 'The container does not match this installation and Compose service.')
  }
  const mounts = container.Mounts?.filter(mount => mount.Destination === '/data') ?? []
  if (mounts.length !== 1 || mounts[0].Type !== 'volume' || mounts[0].Name !== config.volumeName || mounts[0].RW !== true) {
    refuse('storage_mount_conflict', 'FalkorDB /data must be the exact writable named volume for this installation.')
  }
  if (!IMAGE.test(container.Image ?? '')) refuse('container_ownership_conflict', 'The original image identity is unavailable.')
  return container
}

/** Never relay command output: Redis config or Docker diagnostics can contain credentials. */
export function runStorageDocker(args, { stdoutPath } = {}) {
  let fd
  try {
    if (stdoutPath) fd = openSync(stdoutPath, 'wx', 0o600)
    const result = spawnSync('docker', args, { encoding: stdoutPath ? undefined : 'utf8',
      stdio: ['ignore', fd ?? 'pipe', 'pipe'], windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
    return { status: result.status, stdout: result.stdout?.toString() ?? '', stderr: result.stderr?.toString() ?? '', error: Boolean(result.error) }
  } finally { if (fd !== undefined) closeSync(fd) }
}

const systemIO = { ...fs, async hashFile(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
} }

function successful(result, code) {
  if (result.error || result.status !== 0) refuse(code, 'The storage operation failed; original data and recovery artifacts were retained.')
  return result.stdout
}
function inspectContainer(docker, selector) {
  const result = docker(['inspect', '--type', 'container', selector])
  if (result.status !== 0 && /no such (?:object|container)/i.test(result.stderr)) return null
  const output = successful(result, 'container_inspection_failed')
  try { const value = JSON.parse(output); if (value.length === 1) return value[0] } catch { /* typed below */ }
  refuse('container_inspection_failed', 'Container identity could not be verified.')
}
function helperArguments(image, mounts, writeTarget = false, extraArgs = []) {
  return ['run', '--rm', '--pull=never', '--network=none', '--read-only', '--cap-drop=ALL',
    '--cap-add=DAC_OVERRIDE', ...(writeTarget ? ['--cap-add=CHOWN', '--cap-add=FOWNER'] : []),
    '--security-opt=no-new-privileges:true', ...mounts.flatMap(mount => ['--mount', mount]), ...extraArgs, image, 'sh', '-eu', '-c']
}
const emptyScript = 'test -z "$(find /target -mindepth 1 -maxdepth 1 -print -quit)" || exit 42'
function artifactProbeScript(root) {
  return `test "$(find ${root} -mindepth 1 -maxdepth 1 -print)" = "${root}/data" && test -L ${root}/data || exit 42; readlink ${root}/data; stat -c '%f %u %g' ${root}/data`
}
function parseImageArtifact(result) {
  if (result.error || result.status !== 0) refuse('target_not_empty', 'The target contains data other than a verified pristine-image symlink; nothing was overwritten.')
  const match = result.stdout.trim().match(/^\/var\/lib\/falkordb\/data\n([a-f0-9]{1,8}) (\d+) (\d+)$/)
  if (!match) refuse('target_not_empty', 'The target symlink does not match the recognized pristine-image artifact.')
  return { path: 'data', target: LEGACY_DIR, mode: match[1], uid: match[2], gid: match[3] }
}
function targetStorageState(docker, image, config, originalImage) {
  const result = docker([...helperArguments(image, [`type=volume,source=${config.volumeName},target=/target,readonly`]), emptyScript])
  if (result.status !== 42) { successful(result, 'target_inspection_failed'); return null }
  const target = parseImageArtifact(docker([...helperArguments(image, [`type=volume,source=${config.volumeName},target=/target,readonly`]), artifactProbeScript('/target')]))
  // The exact original image is inspected without runtime env or user mounts.
  // Its own disposable image-volume initialization proves copy-up provenance.
  const pristine = parseImageArtifact(docker(['run', '--rm', '--pull=never', '--network=none', '--read-only', '--cap-drop=ALL',
    '--entrypoint=sh', originalImage, '-eu', '-c', artifactProbeScript('/data')]))
  if (JSON.stringify(target) !== JSON.stringify(pristine)) refuse('target_not_empty', 'The target artifact differs from the exact original pristine image.')
  return { ...target, imageId: originalImage }
}
function artifactIntegrityScript(artifact) {
  return `test -L /target/data && test "$(readlink /target/data)" = "${LEGACY_DIR}" && test "$(stat -c '%f %u %g' /target/data)" = "${artifact.mode} ${artifact.uid} ${artifact.gid}" || exit 42`
}
function archiveEntries(text) {
  const entries = text.split(/\r?\n/).filter(Boolean)
  if (!entries.length || entries.some(path => path.includes('\\') || path.startsWith('/')
    || path.replace(/^\.\//, '').split('/').some(part => part === '..'))) {
    refuse('backup_archive_invalid', 'The preserved archive has an unsafe or empty file inventory.')
  }
  return entries
}
function copiedFiles(text, entries) {
  const expectedFiles = entries.map(entry => entry.replace(/^\.\//, '')).filter(path => path && path !== '.' && !path.endsWith('/'))
  const files = text.split(/\r?\n/).filter(Boolean).map(line => {
    const match = line.match(/^([a-f0-9]{64})  (\.\/[^\r\n]+)$/)
    if (!match || !entries.some(entry => entry.replace(/^\.\//, '') === match[2].slice(2))) {
      refuse('copy_verification_failed', 'Copied file hashes do not match the preserved archive inventory.')
    }
    return { path: match[2].slice(2), sha256: match[1] }
  })
  if (new Set(files.map(file => file.path)).size !== files.length || files.length !== expectedFiles.length) {
    refuse('copy_verification_failed', 'The copied file inventory is incomplete or contains duplicate paths.')
  }
  return files
}

function fileManifest(text, entries) {
  const parts = text.split('\n__PM_FILE_METADATA__\n')
  if (parts.length !== 2) refuse('copy_verification_failed', 'The file integrity manifest is incomplete.')
  const files = copiedFiles(parts[0], entries)
  const paths = new Set(entries.map(entry => entry.replace(/^\.\//, '').replace(/\/+$/, '') || '.'))
  const metadata = parts[1].split(/\r?\n/).filter(Boolean).map(line => {
    const match = line.match(/^([a-f0-9]{1,8}) (\d+) (\d+) (\.|\.\/[^\r\n]+)$/)
    const path = match?.[4].replace(/^\.\//, '')
    if (!match || !paths.has(path)) refuse('copy_verification_failed', 'The file mode and ownership manifest is invalid.')
    return { path, mode: match[1], uid: match[2], gid: match[3] }
  })
  if (metadata.length !== paths.size || new Set(metadata.map(row => row.path)).size !== metadata.length) {
    refuse('copy_verification_failed', 'The file mode and ownership manifest is incomplete.')
  }
  return { files, metadata }
}

function equalManifests(source, target) {
  for (const field of ['files', 'metadata']) {
    const expected = new Map(source[field].map(row => [row.path, JSON.stringify(row)]))
    if (expected.size !== target[field].length || target[field].some(row => expected.get(row.path) !== JSON.stringify(row))) {
      refuse('copy_verification_failed', 'Copied bytes, modes or ownership differ from the preserved archive; recovery data was retained.')
    }
  }
}

async function resumeOriginal(receipt, config, docker) {
  const original = inspectContainer(docker, receipt.containerId)
  if (!original) return { status: 'noop', reason: 'original_absent', containerId: receipt.containerId }
  // A replacement (or renamed old container) must never be started by recovery.
  if (original.Id !== receipt.containerId || original.Name !== `/${config.containerName}`) {
    return { status: 'noop', reason: 'original_replaced', containerId: receipt.containerId }
  }
  validateStorageContainer(original, config, receipt.containerId)
  if (original.Image !== receipt.imageId) refuse('recovery_identity_conflict', 'The original image identity no longer matches the recovery receipt.')
  if (original.State?.Running) return { status: 'noop', reason: 'original_running', containerId: original.Id }
  successful(docker(['start', original.Id]), 'original_restart_failed')
  const restarted = inspectContainer(docker, original.Id)
  if (!restarted?.State?.Running) refuse('original_restart_failed', 'The exact original container did not restart; recovery artifacts were retained.')
  validateStorageContainer(restarted, config, original.Id)
  return { status: 'resumed', containerId: original.Id }
}

/** Dependencies are injectable so safety decisions are tested without touching Docker or real data. */
export async function prepareFalkorStorage({ envPath = join(repoRoot, '.env.persistent-memory'), prepare = false, resumePath, requireReady = false,
  docker = runStorageDocker, io = systemIO, now = () => new Date(), nonce = () => randomBytes(6).toString('hex'),
  sleep = ms => new Promise(done => setTimeout(done, ms)), stopPolls = 60 } = {}) {
  if ((prepare && resumePath) || (requireReady && (prepare || resumePath))) refuse('invalid_arguments', 'Choose check-only readiness, preparation or recovery.')
  let envText
  try { envText = await io.readFile(envPath, 'utf8') } catch { refuse('environment_unavailable', 'The installation environment file could not be read.') }
  const config = storageConfiguration(envText, resolve(envPath))
  if (resumePath) {
    const path = resolve(resumePath), inside = relative(config.backupRoot, path)
    if (!inside || inside.startsWith('..') || isAbsolute(inside)) refuse('recovery_receipt_invalid', 'Recovery requires this installation’s storage receipt.')
    let receipt
    try { receipt = JSON.parse(await io.readFile(path, 'utf8')) } catch { refuse('recovery_receipt_invalid', 'The recovery receipt could not be read.') }
    if (receipt.schema !== SCHEMA || !ID.test(receipt.containerId ?? '') || !IMAGE.test(receipt.imageId ?? '')
      || receipt.envPath !== config.envPath || receipt.containerName !== config.containerName
      || receipt.volumeName !== config.volumeName || receipt.project !== config.project
      || receipt.sourceDir !== LEGACY_DIR || receipt.originalWasRunning !== true) {
      refuse('recovery_receipt_invalid', 'The recovery receipt does not match this installation.')
    }
    return { ...await resumeOriginal(receipt, config, docker), receiptPath: path }
  }

  const original = inspectContainer(docker, config.containerName)
  if (!original) return { status: 'noop', reason: 'container_absent' }
  validateStorageContainer(original, config)
  if (!original.State?.Running) refuse('original_not_running', 'Start or inspect the original container before deciding its Redis data directory.')
  const configOutput = successful(docker(['exec', original.Id, 'sh', '-eu', '-c',
    'test -n "${FALKORDB_PASSWORD:-}"; REDISCLI_AUTH="$FALKORDB_PASSWORD" redis-cli --raw CONFIG GET dir']), 'redis_directory_unavailable')
  const values = configOutput.trim().split(/\r?\n/)
  if (values.length !== 2 || values[0] !== 'dir') refuse('redis_directory_unavailable', 'Redis did not report an unambiguous data directory.')
  const sourceDir = values[1].replace(/\/+$/, '')
  if (sourceDir === '/data') return { status: 'noop', reason: 'already_mounted', containerId: original.Id }
  if (sourceDir !== LEGACY_DIR) refuse('unrecognized_data_directory', 'The active Redis directory is not a recognized legacy directory; no changes were made.')
  if ((original.Mounts ?? []).some(mount => sourceDir === mount.Destination || sourceDir.startsWith(`${mount.Destination.replace(/\/$/, '')}/`))) {
    refuse('legacy_source_mount_conflict', 'The legacy source is mounted separately; automatic container-layer migration is unsafe.')
  }
  if (!prepare) {
    if (requireReady) refuse('legacy_graph_update_required', 'Legacy graph storage requires the supported updater. Run npm run update-persistent-memory before starting or reinstalling services.')
    return { status: 'migration_required', containerId: original.Id, sourceDir, volumeName: config.volumeName }
  }

  const volumeOutput = successful(docker(['volume', 'inspect', config.volumeName]), 'storage_volume_unavailable')
  let volume
  try { volume = JSON.parse(volumeOutput)[0] } catch { /* typed below */ }
  if (volume?.Name !== config.volumeName || volume.Driver !== 'local'
    || (volume.Labels?.['com.docker.compose.project'] && volume.Labels['com.docker.compose.project'] !== config.project)) {
    refuse('storage_volume_conflict', 'The existing target volume does not match the installation.')
  }
  let image
  try { image = JSON.parse(successful(docker(['image', 'inspect', 'alpine:3.20']), 'copy_helper_unavailable'))[0]?.Id } catch(error) {
    if (error instanceof StoragePreparationError) throw error
  }
  if (!IMAGE.test(image ?? '')) refuse('copy_helper_unavailable', 'The existing Alpine copy-helper image could not be verified.')
  const preservedImageArtifact = targetStorageState(docker, image, config, original.Image)

  await io.mkdir(config.backupRoot, { recursive: true, mode: 0o700 })
  const realRoot = await io.realpath(dirname(config.envPath)), realBackup = await io.realpath(config.backupRoot)
  if (!realBackup.startsWith(realRoot + sep)) refuse('backup_path_unsafe', 'The durable backup directory resolves outside this installation.')
  const runDir = join(config.backupRoot, `${now().toISOString().replace(/[^0-9TZ]/g, '')}-${nonce()}`)
  await io.mkdir(runDir, { mode: 0o700 })
  const receiptPath = join(runDir, 'receipt.json'), archivePath = join(runDir, 'data.tar'), eventsPath = join(runDir, 'events.jsonl')
  // Mount syntax cannot safely represent commas or line breaks in host paths.
  if (/[\r\n,]/.test(archivePath)) refuse('backup_path_unsafe', 'The backup path cannot be safely mounted by Docker.')
  const receipt = { schema: SCHEMA, createdAt: now().toISOString(), envPath: config.envPath, project: config.project,
    containerName: config.containerName, containerId: original.Id, imageId: original.Image, sourceDir,
    volumeName: config.volumeName, mountDestination: '/data', originalWasRunning: true, archivePath, helperImageId: image, preservedImageArtifact }
  await io.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  const event = async status => io.appendFile(eventsPath, `${JSON.stringify({ at: now().toISOString(), status })}\n`, { mode: 0o600 })
  let stopRequested = false
  try {
    await event('stop_requested'); stopRequested = true
    // SIGTERM only: never fall back to SIGKILL if Redis takes too long to flush.
    successful(docker(['kill', '--signal=SIGTERM', original.Id]), 'original_stop_failed')
    let stopped
    for (let attempt = 0; attempt < stopPolls; attempt += 1) {
      stopped = inspectContainer(docker, original.Id)
      if (!stopped) refuse('original_disappeared', 'The original container disappeared before its backup.')
      validateStorageContainer(stopped, config, original.Id)
      if (!stopped.State?.Running) break
      await sleep(1000)
    }
    if (stopped?.State?.Running) refuse('original_stop_timeout', 'Redis did not stop cleanly; no copy was attempted.')
    if (stopped.State?.ExitCode !== 0) refuse('original_unclean_stop', 'Redis did not exit cleanly; no copy was attempted.')
    await event('original_stopped')
    successful(docker(['cp', `${original.Id}:${sourceDir}/.`, '-'], { stdoutPath: archivePath }), 'backup_copy_failed')
    await io.chmod(archivePath, 0o600)
    const archiveHash = await io.hashFile(archivePath), archiveBytes = (await io.stat(archivePath)).size
    const backupMount = `type=bind,source=${archivePath.replaceAll('\\', '/')},target=/backup/data.tar,readonly`
    const entries = archiveEntries(successful(docker([...helperArguments(image, [backupMount]), 'tar -tf /backup/data.tar']), 'backup_inventory_failed'))
    if (entries.some(entry => /^data(?:\/|$)/.test(entry.replace(/^\.\//, '')))) {
      refuse('backup_artifact_conflict', 'The archive would overwrite the reserved pristine-image data symlink; original and target data were retained.')
    }
    // The archive is uncompressed. Keep scratch bounded rather than consuming
    // unbounded RAM for an unexpectedly large graph; original data stays intact.
    const scratchBytes = Math.max(16 * 1024 * 1024, archiveBytes + 16 * 1024 * 1024)
    if (scratchBytes > MAX_SCRATCH_BYTES) refuse('backup_requires_manual_copy', 'The graph exceeds the bounded verification scratch space; preserve the backup and use a reviewed manual migration.')
    const sourceOutput = successful(docker([...helperArguments(image, [backupMount], true, ['--tmpfs', `/scratch:rw,size=${scratchBytes},mode=0700`]),
      `tar -xpf /backup/data.tar -C /scratch; cd /scratch; ${fileManifestScript}`]), 'backup_integrity_failed')
    const sourceManifest = fileManifest(sourceOutput, entries)
    await io.writeFile(join(runDir, 'backup-manifest.json'), `${JSON.stringify({ archiveSha256: archiveHash, archiveBytes, entries, ...sourceManifest }, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    await event('backup_verified')
    // Recheck identity/volume and emptiness after stopping, immediately before extraction.
    const unchanged = validateStorageContainer(inspectContainer(docker, original.Id), config, original.Id)
    if (unchanged.State?.Running) refuse('original_restarted', 'The original container restarted before extraction; no target copy was attempted.')
    const currentArtifact = targetStorageState(docker, image, config, original.Image)
    if (JSON.stringify(currentArtifact) !== JSON.stringify(preservedImageArtifact)) refuse('target_not_empty', 'The target artifact changed before extraction.')
    const targetGuard = preservedImageArtifact
      ? `test "$(find /target -mindepth 1 -maxdepth 1 -print)" = "/target/data" || exit 42; ${artifactIntegrityScript(preservedImageArtifact)}`
      : emptyScript
    const copied = docker([...helperArguments(image, [backupMount, `type=volume,source=${config.volumeName},target=/target`], true),
      `${targetGuard}; tar -xpf /backup/data.tar -C /target; ${preservedImageArtifact ? `${artifactIntegrityScript(preservedImageArtifact)}; ` : ''}cd /target; ${fileManifestScript}`])
    if (copied.status === 42) refuse('target_not_empty', 'The target volume changed before copy; existing data was preserved.')
    const targetManifest = fileManifest(successful(copied, 'volume_copy_failed'), entries)
    equalManifests(sourceManifest, targetManifest)
    if (await io.hashFile(archivePath) !== archiveHash) refuse('backup_changed', 'The preserved archive changed during copy; recovery artifacts were retained.')
    await io.writeFile(join(runDir, 'copy-manifest.json'), `${JSON.stringify({ archiveSha256: archiveHash, ...targetManifest, preservedImageArtifact }, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    await event('prepared_original_stopped')
    return { status: 'prepared', containerId: original.Id, receiptPath, volumeName: config.volumeName, originalStopped: true }
  } catch (error) {
    let recovery
    if (stopRequested) {
      try { recovery = await resumeOriginal(receipt, config, docker) } catch { recovery = { status: 'manual_recovery_required' } }
    }
    try { await event(`failed_${recovery?.status ?? 'before_stop'}`) } catch { /* original receipt remains immutable */ }
    const safeError = error instanceof StoragePreparationError ? error : new StoragePreparationError('storage_preparation_failed', 'Storage preparation failed; original data and recovery artifacts were retained.')
    safeError.receiptPath = receiptPath; safeError.recovery = recovery?.status ?? 'not_needed'
    throw safeError
  }
}

export function parseStorageArguments(args) {
  const options = {}
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--prepare') { if (options.prepare) refuse('invalid_arguments', 'Repeated preparation option.'); options.prepare = true }
    else if (args[i] === '--require-ready') { if (options.requireReady) refuse('invalid_arguments', 'Repeated readiness option.'); options.requireReady = true }
    else if (args[i] === '--env-file' || args[i] === '--resume') {
      const key = args[i] === '--env-file' ? 'envPath' : 'resumePath'
      if (options[key] || !args[i + 1] || args[i + 1].startsWith('--')) refuse('invalid_arguments', 'A unique path is required for this option.')
      options[key] = args[++i]
    } else refuse('invalid_arguments', 'Unknown storage preparation option.')
  }
  return options
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await prepareFalkorStorage(parseStorageArguments(process.argv.slice(2))))) }
  catch (error) {
    const known = error instanceof StoragePreparationError
    console.error(JSON.stringify({ status: 'error', code: known ? error.code : 'storage_preparation_failed',
      message: known ? error.message : 'Storage preparation failed without changing or deleting recovery data.',
      ...(error.receiptPath ? { receiptPath: error.receiptPath } : {}), ...(error.recovery ? { recovery: error.recovery } : {}) }))
    process.exitCode = 1
  }
}
