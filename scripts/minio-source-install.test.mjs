import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const app = join(root, 'apps/minio')
const lock = JSON.parse(readFileSync(join(app, 'source.json'), 'utf8'))
const hash = (value) => createHash('sha256').update(value).digest('hex')

function canonicalInventory(rows) {
  return rows.map(({ id, name, image, mounts, running }) => ({ id, name, image,
    mounts: [...mounts].sort((a, b) => a.Destination.localeCompare(b.Destination)), running,
  })).sort((a, b) => a.id.localeCompare(b.id))
}

test('service preservation ignores mount enumeration order while detecting identity and mount changes', () => {
  const before = [{ id: 'original-id', name: '/original', image: 'original-image', running: true, mounts: [
    { Type: 'volume', Name: 'original-data', Source: '/volumes/data', Destination: '/data', RW: true },
    { Type: 'bind', Source: '/host/config', Destination: '/config', RW: false },
  ] }]
  const reordered = structuredClone(before)
  reordered[0].mounts.reverse()
  assert.deepEqual(canonicalInventory(before), canonicalInventory(reordered))
  for (const mutate of [
    (row) => { row.id = 'replacement-id' },
    (row) => { row.image = 'replacement-image' },
    (row) => { row.running = false },
    (row) => { row.mounts[0].Name = 'foreign-data' },
    (row) => { row.mounts[0].Source = '/foreign/data' },
    (row) => { row.mounts[0].Destination = '/other' },
    (row) => { row.mounts[0].RW = false },
  ]) {
    const changed = structuredClone(before)
    mutate(changed[0])
    assert.equal(isDeepStrictEqual(canonicalInventory(before), canonicalInventory(changed)), false)
  }
})

test('MinIO uses an immutable official source archive and the supplied digest-pinned local Go toolchain', () => {
  const dockerfile = readFileSync(join(app, 'Dockerfile'), 'utf8')
  assert.match(lock.commit, /^[a-f0-9]{40}$/)
  assert.equal(lock.archive.url, `https://codeload.github.com/minio/minio/tar.gz/${lock.commit}`)
  assert.match(lock.archive.sha256, /^[a-f0-9]{64}$/)
  assert.ok(dockerfile.includes(`ADD --checksum=sha256:${lock.archive.sha256} ${lock.archive.url}`))
  assert.ok(dockerfile.includes(`FROM ${lock.goImage}`))
  assert.ok(dockerfile.includes('GOTOOLCHAIN=local'))
  assert.ok(dockerfile.includes('-p 1 -mod=readonly'))
  assert.ok(dockerfile.includes('GOMAXPROCS=1 GOMEMLIMIT=768MiB GOGC=50'))
  assert.ok(dockerfile.includes('type=cache,id=pm-minio-go12610-lowmem-v1,target=/root/.cache/go-build'))
  assert.ok(!dockerfile.includes('type=tmpfs'))
  assert.ok(dockerfile.includes('source=upstream/go.mod,target=/build/source/go.mod,readonly'))
  assert.ok(dockerfile.includes('source=upstream/go.sum,target=/build/source/go.sum,readonly'))
  assert.equal(hash(readFileSync(join(app, 'upstream/go.mod'))), lock.goModSha256)
  assert.equal(hash(readFileSync(join(app, 'upstream/go.sum'))), lock.goSumSha256)
  assert.match(readFileSync(join(app, '.gitattributes'), 'utf8'), /eol=lf/)
})

test('MinIO preserves the server/data/console contract with static HTTP health and exact source/license attribution', () => {
  const dockerfile = readFileSync(join(app, 'Dockerfile'), 'utf8')
  const health = readFileSync(join(app, 'health/main.go'), 'utf8')
  assert.match(dockerfile, /FROM scratch/)
  assert.match(dockerfile, /ENTRYPOINT \["\/usr\/bin\/minio"\]/)
  assert.match(dockerfile, /CMD \["server", "\/data", "--console-address", ":9001"\]/)
  assert.match(dockerfile, /VOLUME \["\/data"\]/)
  assert.match(dockerfile, /HEALTHCHECK[^\n]+\["\/usr\/bin\/pm-minio-health"\]/)
  assert.ok(!dockerfile.includes('mc ready'))
  assert.ok(health.includes('/minio/health/live'))
  assert.ok(health.includes('/minio/health/ready'))
  assert.ok(health.includes('response.StatusCode != http.StatusOK'))
  assert.ok(dockerfile.includes('COPY --from=build /build/minio-source.tar.gz /usr/share/minio/source.tar.gz'))
  assert.ok(dockerfile.includes(`org.opencontainers.image.revision="${lock.commit}"`))
  assert.match(readFileSync(join(app, 'upstream/LICENSE'), 'utf8'), /GNU AFFERO GENERAL PUBLIC LICENSE/)
  assert.match(readFileSync(join(app, 'upstream/CREDITS'), 'utf8'), /Copyright/)
  assert.match(readFileSync(join(app, 'health/LICENSE'), 'utf8'), /MIT License/)
})

function docker(args, binary = false) {
  return new Promise((done, fail) => execFile('docker', args, { cwd: root, encoding: binary ? 'buffer' : 'utf8', windowsHide: true, timeout: 120_000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
    if (error) fail(new Error(`Docker fixture ${args[0]} failed (${error.code ?? 'unknown'}).`))
    else done(binary ? stdout : stdout.trim())
  }))
}
const inspectFormat = '{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Image}},"labels":{{json .Config.Labels}},"mounts":{{json .Mounts}},"running":{{json .State.Running}},"exitCode":{{json .State.ExitCode}}}'
async function freePort() {
  return new Promise((done, fail) => {
    const listener = createServer((socket) => socket.destroy())
    listener.once('error', fail)
    listener.listen(0, '127.0.0.1', () => { const port = listener.address().port; listener.close(() => done(port)) })
  })
}
async function inventory(excluded = new Set()) {
  const ids = (await docker(['ps', '-q'])).split(/\s+/).filter((id) => id && ![...excluded].some((owned) => owned.startsWith(id)))
  if (!ids.length) return []
  const rows = (await docker(['inspect', '--format', inspectFormat, ...ids])).split(/\r?\n/).map((line) => JSON.parse(line))
  return canonicalInventory(rows)
}
async function objectSnapshot(client, bucket, objects) {
  const result = []
  for (const [key, expected] of objects) {
    const stream = await client.getObject(bucket, key)
    const pieces = []
    for await (const piece of stream) pieces.push(Buffer.from(piece))
    const bytes = Buffer.concat(pieces)
    assert.deepEqual(bytes, expected)
    const stat = await client.statObject(bucket, key)
    result.push({ key, bytes: bytes.length, sha256: hash(bytes), etag: stat.etag, modifiedAt: stat.lastModified.toISOString(), metadata: stat.metaData })
  }
  const listed = []
  for await (const item of client.listObjectsV2(bucket, '', true)) listed.push(item.name)
  assert.deepEqual(listed.sort(), objects.map(([key]) => key).sort())
  return result
}

const enabled = process.env.PM_MINIO_ALLOW_DOCKER_TEST === '1'
test('fresh synthetic S3 roundtrip and clean-stopped legacy-data compatibility in owned disposable volumes', { skip: !enabled, timeout: 300_000 }, async () => {
  const sourceImage = process.env.PM_MINIO_TEST_IMAGE
  const oldImage = process.env.PM_MINIO_LEGACY_IMAGE
  assert.ok(sourceImage?.startsWith('persistent-memory-minio-source-test-'))
  assert.match(oldImage ?? '', /^sha256:[a-f0-9]{64}$/)
  const source = JSON.parse(await docker(['image', 'inspect', '--format', '{"id":{{json .Id}},"labels":{{json .Config.Labels}}}', sourceImage]))
  assert.equal(source.labels['org.opencontainers.image.revision'], lock.commit)
  assert.equal(await docker(['info', '--format', '{{.OSType}}']), 'linux')
  const { Client } = await import('minio') // The application's already-installed locked S3 client; no dependency install.
  const nonce = randomBytes(6).toString('hex')
  const owner = `community-minio-source-${nonce}`
  const prefix = `pm-minio-source-${nonce}`
  const directory = join(root, '.local/documents/community-knowledge/minio-source', nonce)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const accessKey = `pmf-${nonce}`
  const secretKey = randomBytes(16).toString('hex')
  const envPath = join(directory, 'synthetic.env')
  writeFileSync(envPath, `MINIO_ROOT_USER=${accessKey}\nMINIO_ROOT_PASSWORD=${secretKey}\n`, { mode: 0o600 })
  const envFile = join(root, '.env.persistent-memory')
  const envBefore = existsSync(envFile) ? hash(readFileSync(envFile)) : null
  const before = await inventory()
  const containers = []
  const receipt = { capturedAt: new Date().toISOString(), source: lock, sourceImageId: source.id, legacyImageId: oldImage, owner, before, volumes: [], phases: [], passed: false }
  const receiptPath = join(directory, 'receipt.json')
  const objects = [
    ['probe/plain.txt', Buffer.from('A bounded synthetic Community object storage fixture.\n')],
    ['probe/bytes.bin', Buffer.from(Array.from({ length: 8192 }, (_, index) => index % 251))],
    ['probe/empty', Buffer.alloc(0)],
  ]
  const bucket = `pm-fixture-${nonce}`
  async function volume(role) {
    const name = `${prefix}-${role}`
    let exists = false
    try { await docker(['volume', 'inspect', name]); exists = true } catch { /* A missing exact generated name is expected. */ }
    assert.equal(exists, false)
    await docker(['volume', 'create', '--label', `pm.task=${owner}`, name])
    assert.equal(JSON.parse(await docker(['volume', 'inspect', '--format', '{{json .Labels}}', name]))['pm.task'], owner)
    receipt.volumes.push(name)
    return name
  }
  async function guard(item) {
    const inspected = JSON.parse(await docker(['inspect', '--format', inspectFormat, item.id]))
    assert.equal(inspected.id, item.id)
    assert.equal(inspected.name, `/${item.name}`)
    assert.equal(inspected.labels['pm.task'], owner)
    assert.equal(inspected.mounts.length, 1)
    assert.ok(inspected.mounts.every((mount) => mount.Type === 'volume' && mount.Name === item.volume && mount.Destination === '/data'))
    assert.ok(!before.some((original) => original.id === item.id || original.mounts.some((mount) => mount.Name === item.volume)))
    return inspected
  }
  async function stop(item) {
    const original = await guard(item)
    if (original.running) await docker(['stop', '--time', '30', item.id])
    const stopped = await guard(item)
    assert.equal(stopped.running, false)
    assert.equal(stopped.exitCode, 0)
    return stopped
  }
  async function start(image, role, dataVolume) {
    const port = await freePort()
    const name = `${prefix}-${role}`
    const id = await docker(['run', '-d', '--name', name, '--label', `pm.task=${owner}`, '--memory', '512m', '--cpus', '1', '--pids-limit', '256',
      '--publish', `127.0.0.1:${port}:9000`, '--mount', `type=volume,source=${dataVolume},target=/data`, '--env-file', envPath,
      image, 'server', '/data', '--console-address', ':9001'])
    const item = { id, name, volume: dataVolume, port }
    containers.push(item)
    await guard(item)
    const deadline = Date.now() + 60_000
    let ready = false
    while (Date.now() < deadline) {
      ready = await fetch(`http://127.0.0.1:${port}/minio/health/ready`, { signal: AbortSignal.timeout(1_000) }).then((response) => response.status === 200).catch(() => false)
      if (ready) break
      await delay(300)
    }
    assert.ok(ready, 'Owned fixture did not reach S3 readiness.')
    const transport = { request(...args) {
      const request = httpRequest(...args)
      request.setTimeout(5_000, () => request.destroy(new Error('Synthetic S3 fixture request timed out.')))
      return request
    } }
    const client = new Client({ endPoint: '127.0.0.1', port, useSSL: false, accessKey, secretKey, region: 'us-east-1', transport })
    return { item, client }
  }
  async function write(client) {
    await client.makeBucket(bucket, 'us-east-1')
    for (const [key, bytes] of objects) await client.putObject(bucket, key, bytes, bytes.length, { 'Content-Type': 'application/octet-stream', 'x-amz-meta-purpose': 'synthetic-community-acceptance' })
  }
  try {
    const fresh = await start(sourceImage, 'fresh', await volume('fresh'))
    await write(fresh.client)
    const freshObjects = await objectSnapshot(fresh.client, bucket, objects)
    await docker(['exec', fresh.item.id, '/usr/bin/pm-minio-health'])
    receipt.phases.push({ phase: 'fresh-source-roundtrip', containerId: fresh.item.id, objects: freshObjects, httpHealth: true })
    await stop(fresh.item)

    const legacy = await start(oldImage, 'legacy', await volume('legacy'))
    await write(legacy.client)
    const legacyObjects = await objectSnapshot(legacy.client, bucket, objects)
    const legacyVersion = await docker(['exec', legacy.item.id, '/usr/bin/minio', '--version'])
    await stop(legacy.item)
    const archive = await docker(['cp', `${legacy.item.id}:/data/.`, '-'], true)
    const archivePath = join(directory, 'legacy-clean-stopped-data.tar')
    writeFileSync(archivePath, archive, { mode: 0o600 })
    receipt.phases.push({ phase: 'legacy-source-before', containerId: legacy.item.id, version: legacyVersion, objects: legacyObjects,
      cleanStoppedBackup: { path: archivePath, bytes: archive.length, sha256: hash(archive) } })

    const upgraded = await start(sourceImage, 'upgraded', legacy.item.volume)
    const after = await objectSnapshot(upgraded.client, bucket, objects)
    assert.deepEqual(after, legacyObjects)
    await docker(['exec', upgraded.item.id, '/usr/bin/pm-minio-health'])
    await upgraded.client.putObject(bucket, 'probe/new-after-upgrade.txt', Buffer.from('New synthetic write after old-data recovery.'))
    await objectSnapshot(upgraded.client, bucket, [...objects, ['probe/new-after-upgrade.txt', Buffer.from('New synthetic write after old-data recovery.')]])
    receipt.phases.push({ phase: 'legacy-source-after', containerId: upgraded.item.id, objects: after, httpHealth: true, newWrite: true })
    await stop(upgraded.item)
    receipt.passed = true
  } finally {
    receipt.stopped = []
    for (const item of containers) {
      try { const stopped = await stop(item); receipt.stopped.push({ id: item.id, exitCode: stopped.exitCode }) }
      catch { receipt.stopped.push({ id: item.id, stopVerified: false }); receipt.passed = false }
    }
    receipt.after = await inventory(new Set(containers.map((item) => item.id)))
    receipt.productionServicesUnchanged = isDeepStrictEqual(receipt.after, before)
    receipt.productionEnvUnchanged = (existsSync(envFile) ? hash(readFileSync(envFile)) : null) === envBefore
    receipt.passed &&= receipt.productionServicesUnchanged && receipt.productionEnvUnchanged
    writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 })
  }
  assert.equal(receipt.passed, true, 'MinIO fixture or preservation verification failed; inspect the private receipt.')
})
