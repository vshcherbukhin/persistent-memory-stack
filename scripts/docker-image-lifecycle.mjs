import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const OWNER = 'io.persistent-memory.install.owner'
const ATTEMPT = 'io.persistent-memory.install.attempt'
const KIND = 'io.persistent-memory.install.kind'
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/
const CONTAINER_ID = /^[a-f0-9]{64}$/
const STORAGE_FAILURE = /no space left|ENOSPC|input\/output error|I\/O error|bbolt|read-only file system|disk quota/i
const CORRUPT_BUILD = /unexpected EOF|checksum|corrupt|missing blob|failed to (?:extract|register layer)|invalid tar|content digest.*not found/i
const NODE_ENTRIES = {
  api: 'dist/server.js', worker: 'dist/index.js', mcp: 'apps/mcp/dist/index.js',
  dashboard: 'server.js', documentation: 'src/server.mjs', 'dashboard-gateway': 'dist/index.js',
  'docker-control': 'dist/index.js', 'update-runner': 'dist/apps/update-runner/src/index.js',
}
const STORAGE_SERVICES = new Set(['postgres', 'redis', 'minio', 'qdrant', 'falkordb', 'neo4j'])
// Parse the real compiled import graph without evaluating application code. This catches
// missing packaged relative modules (including update-runner artifacts) as well as bad bytes.
// The VM parser is available in Node 22.12+ behind its existing flag; it never links/evaluates.
const NODE_SMOKE = `const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const seen=new Set();function check(file){file=fs.realpathSync(file);if(seen.has(file))return;seen.add(file);if(seen.size>10000)throw Error('Import graph exceeds validation limit');const text=fs.readFileSync(file,'utf8');if(file.endsWith('.json')){JSON.parse(text);return;}const parsed=new vm.SourceTextModule(text,{identifier:file});for(const spec of parsed.dependencySpecifiers){if(spec.startsWith('.'))check(path.resolve(path.dirname(file),spec));}}
check(path.resolve(process.argv[1]));console.log('Compiled module graph checked:',seen.size);`

export function smokeCommand(service) {
  if (NODE_ENTRIES[service]) return ['node', '--experimental-vm-modules', '--no-warnings', '-e', NODE_SMOKE, NODE_ENTRIES[service]]
  if (service === 'graphiti' || service === 'dlp') return ['python', '-c', "import ast,pathlib,fastapi,uvicorn; files=list(pathlib.Path('/app').glob('*.py')); assert files; [ast.parse(p.read_bytes(),filename=str(p)) for p in files]"]
  const commands = {
    postgres: ['postgres', '--version'], redis: ['redis-server', '--version'],
    falkordb: ['redis-server', '--version'], qdrant: ['/qdrant/qdrant', '--version'],
    minio: ['/usr/bin/minio', '--version'], neo4j: ['java', '-version'],
  }
  if (!commands[service]) throw new Error(`No isolated image smoke check is defined for service ${service}.`)
  return commands[service]
}

export function dockerCommand(args, { cwd, env, timeout = 120_000, stream = false } = {}) {
  return new Promise(resolveResult => {
    const child = spawn('docker', args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', timedOut = false
    const collect = (key, chunk) => {
      const text = chunk.toString()
      if (key === 'stdout') stdout = (stdout + text).slice(-16 * 1024 * 1024)
      else stderr = (stderr + text).slice(-256 * 1024)
      if (stream) (key === 'stdout' ? process.stdout : process.stderr).write(text)
    }
    child.stdout.on('data', chunk => collect('stdout', chunk))
    child.stderr.on('data', chunk => collect('stderr', chunk))
    const timer = setTimeout(() => { timedOut = true; child.kill() }, timeout)
    child.once('error', error => { clearTimeout(timer); resolveResult({ code: 1, stdout, stderr: error.message, timedOut }) })
    child.once('close', code => { clearTimeout(timer); resolveResult({ code: code ?? 1, stdout, stderr, timedOut }) })
  })
}

export function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    renameSync(temporary, path)
  } finally { if (existsSync(temporary)) unlinkSync(temporary) }
}

function readJson(path) { return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) }
function savedValue(root, key) {
  const file = join(root, '.env.persistent-memory')
  if (!existsSync(file)) return ''
  const value = new RegExp(`^${key}=([^\\r\\n]*)`, 'm').exec(readFileSync(file, 'utf8'))?.[1]?.trim() ?? ''
  return value.replace(/^(['"])(.*)\1$/, '$2')
}
function failure(service, result) {
  if (STORAGE_FAILURE.test(`${result.stdout}\n${result.stderr}`)) return new Error(`Docker storage failed while checking ${service}. Free host/Docker disk space and diagnose Docker storage before retrying. Image recovery does not repair Docker's data disk or databases.`)
  return new Error(`Image validation/recovery failed for ${service}${result.timedOut ? ' (timed out)' : ''}. No further automatic retry. Review the build/runtime failure and Docker disk space; user data volumes were preserved.`)
}

/** Every Docker operation is injectable; tests never access the host Docker daemon. */
export async function imageLifecycle(options) {
  const root = realpathSync(options.root)
  if (options.mode === 'verify') return runImageLifecycle({ ...options, root })
  const directory = join(root, '.local/install-artifacts')
  mkdirSync(directory, { recursive: true })
  const lock = join(directory, 'lifecycle.lock.json')
  const token = randomUUID()
  if (existsSync(lock)) {
    const previous = readJson(lock)
    let alive = true
    if (previous.root === root && Number.isSafeInteger(previous.pid) && previous.pid > 0 && typeof previous.token === 'string') {
      try { process.kill(previous.pid, 0) } catch (error) { if (error.code === 'ESRCH') alive = false }
    }
    if (alive) throw new Error('Another installer image operation is active, or its ownership cannot be proved. Resources were preserved.')
    if (readJson(lock).token !== previous.token) throw new Error('Installer ownership changed; retry after the other operation finishes.')
    unlinkSync(lock)
  }
  writeFileSync(lock, JSON.stringify({ root, pid: process.pid, token }), { flag: 'wx', mode: 0o600 })
  try { return await runImageLifecycle({ ...options, root }) }
  finally { if (existsSync(lock) && readJson(lock).token === token) unlinkSync(lock) }
}

async function runImageLifecycle({ root, mode, env = process.env, run = dockerCommand, emit = console.log, allProfiles = false, pause = ms => new Promise(resolvePause => setTimeout(resolvePause, ms)) }) {
  root = realpathSync(root)
  if (!['up', 'up-storage', 'start-apps', 'prepare', 'verify', 'cleanup', 'uninstall-images'].includes(mode)) throw new Error('Unsupported image lifecycle mode.')
  if (!existsSync(join(root, '.env.persistent-memory'))) throw new Error('The existing .env.persistent-memory is required; image checks never generate it.')
  const profiles = new Set((env.COMPOSE_PROFILES ?? '').split(',').map(value => value.trim()).filter(Boolean))
  if (savedValue(root, 'PM_MCP_RUNTIME') === 'stream') profiles.add('mcp-stream')
  if (savedValue(root, 'GRAPH_BACKEND') === 'neo4j') profiles.add('neo4j')
  if (allProfiles) { profiles.add('mcp-stream'); profiles.add('neo4j') }
  const base = ['compose', '-f', join(root, 'deploy/compose/docker-compose.yml'), '--env-file', join(root, '.env.persistent-memory'), ...[...profiles].flatMap(profile => ['--profile', profile])]
  const execute = (args, options = {}) => run(args, { cwd: root, env: { ...env, COMPOSE_PARALLEL_LIMIT: '1', MSYS_NO_PATHCONV: '1', MSYS2_ARG_CONV_EXCL: '*' }, ...options })
  const configResult = await execute([...base, 'config', '--format', 'json'])
  if (configResult.code !== 0) throw new Error('Cannot resolve the required Compose images from the existing environment. No resource cleanup was attempted.')
  const config = JSON.parse(configResult.stdout)
  if (!config.name || !config.services) throw new Error('Compose returned an invalid project configuration.')
  const services = Object.entries(config.services).filter(([, value]) => !value.profiles?.length || value.profiles.some(profile => profiles.has(profile)))
  const owner = createHash('sha256').update(`${root}\n${config.name}`).digest('hex')
  const directory = join(root, '.local/install-artifacts')
  const ledgerPath = join(directory, 'ledger.json')
  const empty = { version: 1, owner, project: config.name, images: [], containers: [], volumes: [], attempts: [] }
  const ledger = existsSync(ledgerPath) ? readJson(ledgerPath) : empty
  if (ledger.version !== 1 || ledger.owner !== owner || ledger.project !== config.name || !['images', 'containers', 'volumes', 'attempts'].every(key => Array.isArray(ledger[key]))) throw new Error('Installer resource ledger is invalid or belongs to another checkout; resources preserved.')
  const save = () => atomicJson(ledgerPath, ledger)
  const inspectImage = async reference => {
    const result = await execute(['image', 'inspect', reference])
    if (result.code !== 0) {
      if (/no such image|not found/i.test(result.stderr)) return null
      const error = failure('image metadata', result)
      error.imageCorrupt = CORRUPT_BUILD.test(result.stdout + result.stderr) && !STORAGE_FAILURE.test(result.stdout + result.stderr)
      throw error
    }
    const image = JSON.parse(result.stdout)[0]
    if (!IMAGE_ID.test(image?.Id ?? '') || image.Os !== 'linux') throw new Error('Required image metadata is invalid or is not a Linux image.')
    return image
  }
  const ownedImage = (image, service) => {
    const labels = image?.Config?.Labels ?? {}
    // A modern checkout-specific owner is authoritative, even when another
    // checkout deliberately uses the same Compose project/service names.
    if (Object.hasOwn(labels, OWNER)) return labels[OWNER] === owner
    return labels['com.docker.compose.project'] === config.name && labels['com.docker.compose.service'] === service
  }
  const recordImage = (image, service, reference) => {
    if (!image || !ownedImage(image, service)) return
    if (!ledger.images.some(item => item.id === image.Id && item.reference === reference)) ledger.images.push({ id: image.Id, service, reference })
    save()
  }
  const allContainers = async () => {
    const listed = await execute(['ps', '-aq', '--no-trunc'])
    if (listed.code !== 0) throw failure('container ownership', listed)
    const ids = listed.stdout.trim().split(/\s+/).filter(Boolean)
    if (!ids.length) return []
    if (ids.some(id => !CONTAINER_ID.test(id))) throw new Error('Cannot prove container references; cleanup refused.')
    const inspected = await execute(['container', 'inspect', ...ids])
    if (inspected.code !== 0) throw failure('container references', inspected)
    return JSON.parse(inspected.stdout)
  }
  const cleanup = async (removeCurrent = false) => {
    // Recover only our own interrupted smoke checks. They never attach user data.
    for (const item of [...ledger.containers]) {
      if (!CONTAINER_ID.test(item.id) || item.kind !== 'smoke') continue
      const result = await execute(['container', 'inspect', item.id])
      if (result.code !== 0) continue
      const container = JSON.parse(result.stdout)[0]
      if (container?.Config?.Labels?.[OWNER] !== owner || container.Config.Labels[ATTEMPT] !== item.attempt || container.Config.Labels[KIND] !== 'smoke' || container.HostConfig?.NetworkMode !== 'none' || (container.Mounts ?? []).some(mount => mount.Type === 'bind' || mount.Type === 'volume')) continue
      if ((await execute(['container', 'rm', '--force', item.id])).code === 0) ledger.containers = ledger.containers.filter(candidate => candidate !== item)
    }
    const currentIds = new Set()
    if (!removeCurrent) for (const [, service] of services) {
      const image = await inspectImage(service.image)
      if (image) currentIds.add(image.Id)
    }
    // All containers, including stopped containers and other Compose projects, protect their images/volumes.
    const containers = await allContainers()
    const referencedImages = new Set(containers.map(container => container.Image))
    const referencedVolumes = new Set(containers.flatMap(container => (container.Mounts ?? []).filter(mount => mount.Type === 'volume').map(mount => mount.Name)))
    const persistentVolumes = new Set(Object.values(config.volumes ?? {}).map(volume => volume.name).filter(Boolean))
    for (const item of [...ledger.images]) {
      if (!IMAGE_ID.test(item.id) || referencedImages.has(item.id) || currentIds.has(item.id)) continue
      const image = await inspectImage(item.id)
      if (!image) { ledger.images = ledger.images.filter(candidate => candidate !== item); continue }
      if (!ownedImage(image, item.service)) continue
      const allowedReferences = new Set(ledger.images.filter(candidate => candidate.id === item.id).map(candidate => candidate.reference))
      if ((image.RepoTags ?? []).some(tag => tag !== '<none>:<none>' && !allowedReferences.has(tag))) continue
      // Never force removal: Docker independently refuses referenced images/races.
      const removed = await execute(['image', 'rm', item.id])
      if (removed.code === 0) { ledger.images = ledger.images.filter(candidate => candidate.id !== item.id); emit(`Removed unused installer-owned image for ${item.service}.`) }
    }
    for (const item of [...ledger.volumes]) {
      if (item.kind !== 'temporary' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(item.name) || persistentVolumes.has(item.name) || referencedVolumes.has(item.name)) continue
      const result = await execute(['volume', 'inspect', item.name])
      if (result.code !== 0) continue
      const volume = JSON.parse(result.stdout)[0]
      if (volume?.Labels?.[OWNER] !== owner || volume?.Labels?.[KIND] !== 'temporary') continue
      if ((await execute(['volume', 'rm', item.name])).code === 0) ledger.volumes = ledger.volumes.filter(candidate => candidate !== item)
    }
    save()
  }
  if (mode === 'cleanup' || mode === 'uninstall-images') {
    // Adopt only exact, Compose-labeled build images, never similarly named user images.
    for (const [name, service] of services.filter(([, service]) => service.build)) recordImage(await inspectImage(service.image), name, service.image)
    await cleanup(mode === 'uninstall-images')
    return { ok: true }
  }
  if (mode === 'start-apps') {
    const prepared = [...ledger.attempts].reverse().find(item => item.status === 'complete' && item.phase === 'storage-ready')
    for (const [name, service] of services) {
      const current = await inspectImage(service.image)
      if (!current || !prepared?.validatedImages?.some(item => item.service === name && item.id === current.Id)) throw new Error(`Image ${name} has not passed this installation's storage preparation checks. Rerun installation before starting applications.`)
    }
    const started = await execute([...base, 'up', '-d', '--no-build', ...services.map(([name]) => name)], { timeout: 10 * 60_000, stream: true })
    if (started.code !== 0) throw failure('application startup', started)
    prepared.phase = 'started'
    await cleanup()
    emit('Application services restarted after database initialization with the selected embedding configuration.')
    return { ok: true }
  }
  if (mode === 'verify') {
    const containers = await allContainers()
    const observed = []
    for (const [name, service] of services) {
      const image = await inspectImage(service.image)
      if (!image) throw new Error(`Required image is missing for ${name}; rerun installation image preparation.`)
      const running = containers.find(container => container.Image === image.Id && container.State?.Running && container.Config?.Labels?.['com.docker.compose.project'] === config.name && container.Config?.Labels?.['com.docker.compose.service'] === name)
      if (!running || running.State?.Restarting || (running.State?.Health && running.State.Health.Status !== 'healthy')) throw new Error(`Service ${name} is not running the validated current image or is unhealthy/restarting. Inspect its logs before retrying; do not delete data volumes.`)
      observed.push({ name, id: running.Id, image: image.Id, restarts: Number(running.RestartCount ?? 0) })
    }
    await pause(2000)
    const second = await allContainers()
    for (const item of observed) {
      const current = second.find(container => container.Id === item.id)
      if (!current || current.Image !== item.image || !current.State?.Running || current.State?.Restarting || (current.State?.Health && current.State.Health.Status !== 'healthy') || Number(current.RestartCount ?? 0) > item.restarts) throw new Error(`Service ${item.name} restarted or became unavailable during image verification. Inspect its logs and Docker storage; user data volumes were preserved.`)
    }
    emit(`Validated metadata, running image identity and restart stability for ${services.length} required services.`)
    return { ok: true }
  }

  const attempt = randomUUID()
  const attemptDirectory = join(directory, attempt)
  const override = join(attemptDirectory, 'compose-images.json')
  const entry = { id: attempt, startedAt: new Date().toISOString(), status: 'running', phase: 'validating', validatedImages: [] }
  ledger.attempts.push(entry)
  save()
  const buildBase = [...base.slice(0, 3), '-f', override, ...base.slice(3)]
  const smoke = async (name, image) => {
    const command = smokeCommand(name)
    const containerName = `pm-image-check-${attempt}-${name}`
    const mounts = new Set(['/tmp', ...Object.keys(image.Config?.Volumes ?? {})])
    if ([...mounts].some(path => !path.startsWith('/') || /[:,\r\n]/.test(path))) throw new Error('Image declares an unsafe smoke mount path.')
    const created = await execute(['create', '--name', containerName, '--label', `${OWNER}=${owner}`, '--label', `${ATTEMPT}=${attempt}`, '--label', `${KIND}=smoke`, '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '64', '--memory', '512m', '--no-healthcheck', ...[...mounts].flatMap(path => ['--tmpfs', `${path}:rw,nosuid,size=32m,mode=1777`]), '--entrypoint', command[0], image.Id, ...command.slice(1)])
    if (created.code !== 0) return created
    const id = created.stdout.trim()
    if (!CONTAINER_ID.test(id)) throw new Error('Docker returned an invalid smoke container ID; no broad cleanup attempted.')
    ledger.containers.push({ id, attempt, kind: 'smoke' })
    try { save(); return await execute(['start', '--attach', id], { timeout: 30_000 }) }
    finally {
      const inspected = await execute(['container', 'inspect', id])
      const container = inspected.code === 0 ? JSON.parse(inspected.stdout)[0] : null
      if (container?.Config?.Labels?.[OWNER] === owner && container.Config.Labels[ATTEMPT] === attempt && container.Config.Labels[KIND] === 'smoke' && container.HostConfig?.NetworkMode === 'none' && !(container.Mounts ?? []).some(mount => mount.Type === 'volume' || mount.Type === 'bind')) {
        // Only the exact no-network, no-data smoke container may be stopped after a timeout.
        if ((await execute(['container', 'rm', '--force', id])).code === 0) ledger.containers = ledger.containers.filter(item => item.id !== id)
      }
      save()
    }
  }
  try {
    atomicJson(override, { services: Object.fromEntries(services.filter(([, service]) => service.build).map(([name]) => [name, { build: { labels: { [OWNER]: owner, [ATTEMPT]: attempt } } }])) })
    for (const [name, service] of services) {
      smokeCommand(name) // refuse unknown entrypoints before starting any application code
      let previous, metadataCorrupt = false
      try { previous = await inspectImage(service.image) } catch (error) {
        if (!error.imageCorrupt) throw error
        metadataCorrupt = true
        emit(`Image metadata failed for ${name}; recovering this image once without deleting data.`)
      }
      recordImage(previous, name, service.image) // capture old immutable ID before a tag is replaced
      let repaired = metadataCorrupt
      if (service.build || !previous) {
        const result = await execute(service.build ? [...buildBase, 'build', ...(metadataCorrupt ? ['--no-cache', '--pull'] : []), name] : [...base, 'pull', name], { timeout: 60 * 60_000, stream: true })
        if (result.code !== 0) {
          if (repaired || STORAGE_FAILURE.test(result.stdout + result.stderr) || !service.build || !CORRUPT_BUILD.test(result.stdout + result.stderr)) throw failure(name, result)
          emit(`Cached build content failed for ${name}; retrying this image once without cache.`)
          const retry = await execute([...buildBase, 'build', '--no-cache', '--pull', name], { timeout: 60 * 60_000, stream: true })
          repaired = true
          if (retry.code !== 0) throw failure(name, retry)
        }
      }
      let image = await inspectImage(service.image)
      if (!image) throw new Error(`Build/pull completed without a usable image for ${name}.`)
      recordImage(image, name, service.image)
      let result = await smoke(name, image)
      if (result.code !== 0 && !repaired && !STORAGE_FAILURE.test(result.stdout + result.stderr)) {
        emit(`Image smoke failed for ${name}; rebuilding or pulling only this image once.`)
        const repair = await execute(service.build ? [...buildBase, 'build', '--no-cache', '--pull', name] : [...base, 'pull', name], { timeout: 60 * 60_000, stream: true })
        if (repair.code !== 0) throw failure(name, repair)
        image = await inspectImage(service.image)
        if (!image) throw new Error(`Image recovery did not produce ${name}.`)
        recordImage(image, name, service.image)
        result = await smoke(name, image)
      }
      if (result.code !== 0) throw failure(name, result)
      entry.validatedImages.push({ service: name, id: image.Id })
      save()
      emit(`Image runtime smoke passed: ${name}.`)
    }
    if (mode === 'up' || mode === 'up-storage') {
      if (mode === 'up-storage') {
        const applications = services.filter(([name]) => !STORAGE_SERVICES.has(name)).map(([name]) => name)
        if (applications.length) {
          const stopped = await execute([...base, 'stop', '--timeout', '30', ...applications], { timeout: 90_000, stream: true })
          if (stopped.code !== 0) throw failure('quiescing application writers before database initialization', stopped)
          emit('Application services are stopped for database initialization. They remain stopped if a later step fails; rerun installation after fixing the reported failure.')
        }
      }
      const selected = services.filter(([name]) => mode !== 'up-storage' || STORAGE_SERVICES.has(name)).map(([name]) => name)
      if (!selected.length) throw new Error('No storage services were found; installation cannot initialize the database safely.')
      const result = await execute([...base, 'up', '-d', '--no-build', ...selected], { timeout: 10 * 60_000, stream: true })
      if (result.code !== 0) throw failure('service startup', result)
    }
    entry.phase = mode === 'up-storage' ? 'storage-ready' : mode === 'up' ? 'started' : 'validated'
    entry.status = 'complete'
    await cleanup()
    return { ok: true, attempt }
  } catch (error) {
    entry.status = 'failed'
    // No speculative image/volume deletion on failure. Old known image IDs remain in the ledger for a safe later cleanup.
    throw error
  } finally {
    entry.finishedAt = new Date().toISOString()
    if (existsSync(override)) unlinkSync(override)
    // Exact empty attempt directories only; unexpected files are preserved.
    try { rmdirSync(attemptDirectory) } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY' && error.code !== 'EEXIST') throw error }
    ledger.attempts = [...ledger.attempts.filter(item => item.status === 'running'), ...ledger.attempts.filter(item => item.status !== 'running').slice(-20)]
    save()
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, ...options] = process.argv.slice(2)
  if (options.some(option => option !== '--all-profiles')) throw new Error('Unsupported image lifecycle argument.')
  imageLifecycle({ root: process.cwd(), mode, allProfiles: options.includes('--all-profiles') }).catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
