import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, realpathSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { atomicJson, imageLifecycle, smokeCommand } from './docker-image-lifecycle.mjs'

const OWNER = 'io.persistent-memory.install.owner'
const ATTEMPT = 'io.persistent-memory.install.attempt'
const KIND = 'io.persistent-memory.install.kind'
const id = number => 'sha256:' + number.toString(16).padStart(64, '0')
const cid = number => number.toString(16).padStart(64, '0')
const success = stdout => ({ code: 0, stdout: typeof stdout === 'string' ? stdout : JSON.stringify(stdout), stderr: '' })
const failed = stderr => ({ code: 1, stdout: '', stderr })

function fixture(t, options = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pm images é 空 ')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, '.env.persistent-memory'), 'EMBED_PROVIDER=openai\nPRIVATE_FIXTURE=do-not-copy-this-fixture\n')
  const config = { name: 'memory-test', services: { 'update-runner': { image: 'fixture-updater:latest', build: { context: root }, environment: { SECRET: 'do-not-copy-this-fixture' } }, postgres: { image: 'fixture-postgres:17' } }, volumes: { postgres_data: { name: 'memory-test_postgres_data' } } }
  if (options.onlyApp) delete config.services.postgres
  const owner = createHash('sha256').update(`${root}\n${config.name}`).digest('hex')
  const images = new Map(), containers = new Map(), volumes = new Map(), calls = [], logs = []
  let imageSequence = 20, containerSequence = 100
  const image = (number, reference, service, labels = {}) => ({ Id: id(number), Os: 'linux', RepoTags: reference ? [reference] : [], Config: { Labels: { ...labels }, Volumes: service === 'postgres' ? { '/var/lib/postgresql/data': {} } : {} }, service })
  const old = image(1, 'fixture-updater:latest', 'update-runner', { 'com.docker.compose.project': config.name, 'com.docker.compose.service': 'update-runner' })
  const postgres = image(2, 'fixture-postgres:17', 'postgres')
  images.set(old.Id, old); images.set(postgres.Id, postgres)
  const findImage = reference => images.get(reference) ?? [...images.values()].find(item => item.RepoTags.includes(reference))
  const ledgerPath = join(root, '.local/install-artifacts/ledger.json')
  const readLedger = () => JSON.parse(readFileSync(ledgerPath, 'utf8'))
  const seedLedger = extra => atomicJson(ledgerPath, { version: 1, owner, project: config.name, images: [], containers: [], volumes: [], attempts: [], ...extra })
  const run = async (args, runOptions) => {
    calls.push({ args, options: runOptions })
    const custom = await options.intercept?.(args, { images, containers, volumes, readLedger, config, findImage })
    if (custom) return custom
    if (args[0] === 'compose') {
      assert.equal(args[args.indexOf('--env-file') + 1], join(root, '.env.persistent-memory'))
      assert.equal(runOptions.env.COMPOSE_PARALLEL_LIMIT, '1')
      if (args.includes('config')) return success(config)
      if (args.includes('build')) {
        const name = args.at(-1), reference = config.services[name].image
        const previous = findImage(reference)
        if (previous) {
          assert.ok(readLedger().images.some(item => item.id === previous.Id), 'old owned ID captured before tag replacement')
          previous.RepoTags = previous.RepoTags.filter(tag => tag !== reference)
        }
        const first = args.indexOf('-f'), second = args.indexOf('-f', first + 1)
        const labels = JSON.parse(readFileSync(args[second + 1], 'utf8')).services[name].build.labels
        const next = image(imageSequence++, reference, name, labels)
        images.set(next.Id, next)
        return success('built')
      }
      if (args.includes('pull')) return success('pulled')
      if (args.includes('stop')) {
        for (const container of containers.values()) {
          const name = container.Config?.Labels?.['com.docker.compose.service']
          if (args.includes(name)) container.State.Running = false
        }
        return success('stopped')
      }
      if (args.includes('up')) {
        assert.ok(args.includes('--no-build'))
        for (const [name, service] of Object.entries(config.services)) {
          if (!args.includes(name)) continue
          for (const [key, container] of containers) if (container.Config?.Labels?.['com.docker.compose.service'] === name) containers.delete(key)
          const next = { Id: cid(containerSequence++), Image: findImage(service.image).Id, Config: { Labels: { 'com.docker.compose.project': config.name, 'com.docker.compose.service': name } }, State: { Running: true, Restarting: false, Health: { Status: 'healthy' } }, Mounts: [] }
          containers.set(next.Id, next)
        }
        return success('started')
      }
    }
    if (args[0] === 'image' && args[1] === 'inspect') return findImage(args[2]) ? success([findImage(args[2])]) : failed('No such image')
    if (args[0] === 'image' && args[1] === 'rm') { assert.equal(args.length, 3); images.delete(args[2]); return success('removed') }
    if (args[0] === 'ps') return success([...containers.keys()].join('\n'))
    if (args[0] === 'container' && args[1] === 'inspect') return args.slice(2).every(key => containers.has(key)) ? success(args.slice(2).map(key => containers.get(key))) : failed('No such container')
    if (args[0] === 'container' && args[1] === 'rm') { containers.delete(args.at(-1)); return success('removed') }
    if (args[0] === 'create') {
      const labels = Object.fromEntries(args.flatMap((arg, index) => arg === '--label' ? [args[index + 1].split('=')] : []))
      const current = { Id: cid(containerSequence++), Image: args[args.indexOf('--entrypoint') + 2], Config: { Labels: labels }, HostConfig: { NetworkMode: 'none' }, Mounts: [{ Type: 'tmpfs', Destination: '/tmp' }] }
      containers.set(current.Id, current)
      return success(current.Id)
    }
    if (args[0] === 'start') return success('runtime smoke passed')
    if (args[0] === 'volume' && args[1] === 'inspect') return volumes.has(args[2]) ? success([volumes.get(args[2])]) : failed('No such volume')
    if (args[0] === 'volume' && args[1] === 'rm') { volumes.delete(args[2]); return success('removed') }
    throw new Error('Unexpected mock Docker operation: ' + JSON.stringify(args))
  }
  return { root, config, owner, images, containers, volumes, calls, logs, old, readLedger, seedLedger, run, invoke: mode => imageLifecycle({ root, mode, run, env: {}, pause: async () => {}, emit: line => logs.push(line) }) }
}

test('serial isolated image validation precedes no-build startup; old IDs and secrets are handled safely', async t => {
  const f = fixture(t)
  const before = readFileSync(join(f.root, '.env.persistent-memory'))
  await f.invoke('up')
  const creates = f.calls.filter(call => call.args[0] === 'create')
  assert.equal(creates.length, 2)
  for (const { args } of creates) {
    assert.equal(args[args.indexOf('--network') + 1], 'none')
    assert.ok(args.includes('--read-only')); assert.ok(args.includes('--no-healthcheck'))
    assert.equal(args.includes('--env-file'), false); assert.equal(args.includes('-e'), true /* Node parser flag is after the image, not Docker env */ && args.includes('node'))
    assert.equal(args.includes('--mount'), false); assert.equal(args.includes('--volume'), false)
    assert.match(args[args.indexOf('--entrypoint') + 2], /^sha256:/)
  }
  assert.ok(creates[1].args.some(arg => arg.startsWith('/var/lib/postgresql/data:rw,')))
  const upIndex = f.calls.findIndex(call => call.args.includes('up'))
  assert.ok(f.calls.filter(call => call.args[0] === 'start').every(call => f.calls.indexOf(call) < upIndex))
  assert.equal(f.readLedger().attempts[0].status, 'complete')
  assert.equal(f.readLedger().containers.length, 0)
  assert.deepEqual(readdirSync(join(f.root, '.local/install-artifacts')), ['ledger.json'])
  assert.equal(JSON.stringify(f.readLedger()).includes('do-not-copy-this-fixture'), false)
  assert.deepEqual(readFileSync(join(f.root, '.env.persistent-memory')), before)
  assert.equal(f.images.has(f.old.Id), false)
})

test('an inspectable but broken runtime rebuilds only the failed image once', async t => {
  let failures = 1
  const f = fixture(t, { intercept: args => args[0] === 'start' && failures-- > 0 ? failed('Cannot find module packaged-artifact.js') : null })
  await f.invoke('up')
  const builds = f.calls.filter(call => call.args.includes('build'))
  assert.equal(builds.length, 2)
  assert.ok(builds[1].args.includes('--no-cache')); assert.ok(builds[1].args.includes('--pull'))
  assert.ok(builds.every(call => call.args.at(-1) === 'update-runner'))
  assert.equal(f.calls.filter(call => call.args.includes('pull') && !call.args.includes('build')).length, 0)
})

test('persistent corruption fails after one retry without starting the stack or deleting data', async t => {
  const f = fixture(t, { intercept: args => args[0] === 'start' ? failed('unexpected EOF') : null })
  await assert.rejects(f.invoke('up'), /No further automatic retry/)
  assert.equal(f.calls.filter(call => call.args.includes('build')).length, 2)
  assert.equal(f.calls.some(call => call.args.includes('up')), false)
  assert.equal(f.calls.some(call => call.args[0] === 'volume' || (call.args[0] === 'image' && call.args[1] === 'rm')), false)
  assert.equal(f.readLedger().attempts[0].status, 'failed')
})

test('disk exhaustion stops without another build or recovery promise', async t => {
  const f = fixture(t, { intercept: args => args.includes('build') ? failed('no space left on device') : null })
  await assert.rejects(f.invoke('up'), /does not repair Docker's data disk or databases/)
  assert.equal(f.calls.filter(call => call.args.includes('build')).length, 1)
  assert.equal(f.calls.some(call => call.args[0] === 'create'), false)
})

test('known cached-layer corruption receives one no-cache retry', async t => {
  let first = true
  const f = fixture(t, { intercept: args => args.includes('build') && first ? (first = false, failed('failed to extract: checksum mismatch')) : null })
  await f.invoke('prepare')
  assert.equal(f.calls.filter(call => call.args.includes('build')).length, 2)
  assert.equal(f.calls.some(call => call.args.includes('up')), false)
})

test('malformed/corrupt image metadata triggers bounded replacement without image deletion', async t => {
  let first = true
  const f = fixture(t, { onlyApp: true, intercept: args => args[0] === 'image' && args[1] === 'inspect' && args[2] === 'fixture-updater:latest' && first ? (first = false, failed('unexpected EOF in image metadata')) : null })
  // The metadata could not supply a trustworthy old ID, so no claim of ownership is made.
  f.seedLedger({ images: [{ id: f.old.Id, service: 'update-runner', reference: 'fixture-updater:latest' }] })
  await f.invoke('prepare')
  const builds = f.calls.filter(call => call.args.includes('build'))
  assert.equal(builds.length, 1); assert.ok(builds[0].args.includes('--no-cache'))
})

test('cleanup preserves stopped foreign references, shared tags and unowned similarly named images', async t => {
  const f = fixture(t)
  const foreign = structuredClone(f.old); foreign.Id = id(3); foreign.RepoTags = []; f.images.set(foreign.Id, foreign)
  const alias = structuredClone(f.old); alias.Id = id(4); alias.RepoTags = ['someone-elses-image:keep']; f.images.set(alias.Id, alias)
  const unowned = structuredClone(f.old); unowned.Id = id(5); unowned.Config.Labels = {}; unowned.RepoTags = ['persistent-memory-custom:latest']; f.images.set(unowned.Id, unowned)
  f.containers.set(cid(900), { Id: cid(900), Image: foreign.Id, State: { Running: false }, Mounts: [] })
  f.seedLedger({ images: [foreign, alias, unowned].map(item => ({ id: item.Id, service: 'update-runner', reference: 'fixture-updater:latest' })) })
  await f.invoke('cleanup')
  for (const item of [foreign, alias, unowned]) assert.ok(f.images.has(item.Id))
  assert.equal(f.calls.some(call => call.args[0] === 'image' && call.args[1] === 'rm'), false)
})

test('only exact ledger-and-label temporary volumes are removed; persistent and referenced volumes survive', async t => {
  const f = fixture(t)
  const names = ['owned-temporary', 'memory-test_postgres_data', 'referenced-temporary', 'unproven-temporary']
  for (const name of names) f.volumes.set(name, { Name: name, Labels: name.startsWith('unproven') ? {} : { [OWNER]: f.owner, [KIND]: 'temporary' } })
  f.containers.set(cid(901), { Id: cid(901), Image: id(1000), Mounts: [{ Type: 'volume', Name: 'referenced-temporary' }] })
  f.seedLedger({ volumes: names.map(name => ({ name, kind: 'temporary' })) })
  await f.invoke('cleanup')
  assert.equal(f.volumes.has('owned-temporary'), false)
  for (const name of names.slice(1)) assert.ok(f.volumes.has(name))
})

test('interrupted smoke cleanup verifies all labels, no-network and no data mounts', async t => {
  const f = fixture(t)
  const clean = { Id: cid(902), Image: id(1000), Config: { Labels: { [OWNER]: f.owner, [ATTEMPT]: 'old-attempt', [KIND]: 'smoke' } }, HostConfig: { NetworkMode: 'none' }, Mounts: [] }
  const dirty = { ...structuredClone(clean), Id: cid(903), Mounts: [{ Type: 'bind', Source: 'user-data' }] }
  f.containers.set(clean.Id, clean); f.containers.set(dirty.Id, dirty)
  f.seedLedger({ containers: [clean, dirty].map(item => ({ id: item.Id, attempt: 'old-attempt', kind: 'smoke' })) })
  await f.invoke('cleanup')
  assert.equal(f.containers.has(clean.Id), false); assert.equal(f.containers.has(dirty.Id), true)
})

test('uninstall removes only unused proven project images without force', async t => {
  const f = fixture(t)
  await f.invoke('uninstall-images')
  assert.equal(f.images.has(f.old.Id), false)
  assert.ok(f.images.has(id(2)), 'third-party images are not owned')
  assert.deepEqual(f.calls.filter(call => call.args[0] === 'image' && call.args[1] === 'rm').map(call => call.args), [['image', 'rm', f.old.Id]])
})

test('another checkout owner overrides otherwise matching legacy Compose image labels', async t => {
  const f = fixture(t)
  f.old.Config.Labels[OWNER] = 'different-checkout'
  await f.invoke('uninstall-images')
  assert.ok(f.images.has(f.old.Id))
  assert.equal(f.readLedger().images.length, 0)
  assert.equal(f.calls.some(call => call.args[0] === 'image' && call.args[1] === 'rm'), false)
})

test('invalid ownership ledger refuses cleanup and leaves all resources intact', async t => {
  const f = fixture(t)
  f.seedLedger({ owner: 'another-checkout' })
  await assert.rejects(f.invoke('cleanup'), /belongs to another checkout/)
  assert.ok(f.images.has(f.old.Id))
  assert.equal(f.calls.length, 1)
})

test('verify is read-only and catches restart loops and wrong image identities', async t => {
  const f = fixture(t)
  await f.invoke('up')
  f.calls.length = 0
  const ledgerBefore = readFileSync(join(f.root, '.local/install-artifacts/ledger.json'))
  await f.invoke('verify')
  assert.ok(f.calls.every(call => call.args[0] === 'ps' || call.args.includes('inspect') || call.args.includes('config')))
  assert.deepEqual(readFileSync(join(f.root, '.local/install-artifacts/ledger.json')), ledgerBefore)
  const runtime = [...f.containers.values()][0]
  runtime.State.Restarting = true
  await assert.rejects(f.invoke('verify'), /unhealthy\/restarting/)
  runtime.State.Restarting = false; runtime.Image = id(999)
  await assert.rejects(f.invoke('verify'), /validated current image/)
})

test('another active image operation is rejected before any Docker commands', async t => {
  const f = fixture(t)
  mkdirSync(join(f.root, '.local/install-artifacts'), { recursive: true })
  writeFileSync(join(f.root, '.local/install-artifacts/lifecycle.lock.json'), JSON.stringify({ root: f.root, pid: process.pid, token: 'other-operation' }))
  await assert.rejects(f.invoke('up'), /Another installer image operation/)
  assert.equal(f.calls.length, 0)
})

test('verification rejects a restart count increase between healthy samples', async t => {
  const f = fixture(t)
  await f.invoke('up')
  await assert.rejects(imageLifecycle({ root: f.root, mode: 'verify', run: f.run, env: {}, emit: () => {}, pause: async () => { [...f.containers.values()][0].RestartCount = 1 } }), /restarted or became unavailable/)
})

test('finished attempt history is bounded and immutable image ownership is retained separately', async t => {
  const f = fixture(t)
  f.seedLedger({ attempts: Array.from({ length: 30 }, (_, index) => ({ id: String(index), status: 'complete' })) })
  await f.invoke('prepare')
  assert.equal(f.readLedger().attempts.length, 20)
  assert.ok(f.readLedger().images.length > 0)
})

test('Node smoke parses the compiled relative import graph without executing app writes', t => {
  const root = mkdtempSync(join(tmpdir(), 'pm module smoke '))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const entry = join(root, 'entry.js'), output = join(root, 'must-not-exist')
  writeFileSync(entry, `import './dependency.js'; import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(output)},'bad');`)
  writeFileSync(join(root, 'dependency.js'), 'export const okay = true;')
  const command = smokeCommand('update-runner'); command[command.length - 1] = entry
  let result = spawnSync(process.execPath, command.slice(1), { encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0, result.stderr); assert.equal(existsSync(output), false)
  rmSync(join(root, 'dependency.js'))
  result = spawnSync(process.execPath, command.slice(1), { encoding: 'utf8', windowsHide: true })
  assert.notEqual(result.status, 0); assert.match(result.stderr, /ENOENT/)
  assert.deepEqual(readdirSync(root), ['entry.js'])
})

test('storage preparation quiesces app writers before migrations and starts them only after initialization', async t => {
  const f = fixture(t)
  f.containers.set(cid(950), { Id: cid(950), Image: f.old.Id, Config: { Labels: { 'com.docker.compose.project': f.config.name, 'com.docker.compose.service': 'update-runner' } }, State: { Running: true }, Mounts: [] })
  await f.invoke('up-storage')
  assert.equal(f.containers.get(cid(950)).State.Running, false, 'old app process stays stopped across migrations/seed')
  const storageUp = f.calls.find(call => call.args.includes('up'))
  assert.deepEqual(storageUp.args.slice(storageUp.args.indexOf('--no-build') + 1), ['postgres'])
  const stopIndex = f.calls.findIndex(call => call.args.includes('stop'))
  assert.ok(f.calls.filter(call => call.args[0] === 'start').every(call => f.calls.indexOf(call) < stopIndex), 'all image smoke checks happen before writers stop')
  assert.ok(stopIndex < f.calls.indexOf(storageUp))
  assert.equal(f.readLedger().attempts.at(-1).phase, 'storage-ready')
  const buildCount = f.calls.filter(call => call.args.includes('build')).length
  await f.invoke('start-apps')
  assert.equal(f.calls.filter(call => call.args.includes('build')).length, buildCount)
  assert.ok([...f.containers.values()].some(container => container.Config.Labels['com.docker.compose.service'] === 'update-runner' && container.State.Running))
  assert.equal(f.readLedger().attempts.at(-1).phase, 'started')
})

test('app start refuses a missing preparation record or a changed image tag', async t => {
  const f = fixture(t)
  await assert.rejects(f.invoke('start-apps'), /has not passed/)
  assert.equal(f.calls.some(call => call.args.includes('up')), false)
  await f.invoke('up-storage')
  const current = [...f.images.values()].find(image => image.RepoTags.includes('fixture-updater:latest'))
  current.RepoTags = []
  f.images.set(id(999), { ...structuredClone(current), Id: id(999), RepoTags: ['fixture-updater:latest'] })
  f.calls.length = 0
  await assert.rejects(f.invoke('start-apps'), /has not passed/)
  assert.equal(f.calls.some(call => call.args.includes('up')), false)
})

test('a failed writer stop aborts before starting storage or allowing migrations', async t => {
  const f = fixture(t, { intercept: args => args.includes('stop') ? failed('daemon refused stop') : null })
  await assert.rejects(f.invoke('up-storage'), /quiescing application writers/)
  assert.equal(f.calls.some(call => call.args.includes('up')), false)
  assert.equal(f.readLedger().attempts.at(-1).status, 'failed')
})
