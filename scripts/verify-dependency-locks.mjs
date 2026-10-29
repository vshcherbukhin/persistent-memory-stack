import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const fields = ['dependencies', 'devDependencies', 'optionalDependencies']

export function pythonInputIssues(inputs, lock) {
  const requirement = /^([a-zA-Z0-9_.-]+)(?:\[[^\]]+\])?(==[^\s;\\]+| @ https:\/\/[^\s\\]+)/
  const normalized = name => name.toLowerCase().replace(/[-_.]+/g, '-')
  const pinned = new Map(lock.split(/\r?\n/).map(line => requirement.exec(line)).filter(Boolean).map(match => [normalized(match[1]), match[2]]))
  return inputs.split(/\r?\n/).filter(line => line.trim() && !line.trim().startsWith('#')).flatMap(line => {
    const parsed = requirement.exec(line)
    return parsed && pinned.get(normalized(parsed[1])) === parsed[2] ? [] : [`Direct requirement and lock disagree: ${line}`]
  })
}

export function npmLockIssues(manifests, lock) {
  const issues = []
  const localNames = new Set(manifests.map(({ manifest }) => manifest.name))
  if (lock.lockfileVersion !== 3 || !lock.packages) return ['A committed npm v3 lockfile is required.']
  for (const { path, manifest } of manifests) {
    const snapshot = lock.packages[path]
    if (!snapshot) { issues.push(`${path || '.'}: missing lock snapshot`); continue }
    for (const field of fields) {
      const deps = manifest[field] ?? {}
      const locked = snapshot[field] ?? {}
      if (Object.keys(deps).length !== Object.keys(locked).length || Object.entries(deps).some(([name, version]) => locked[name] !== version)) issues.push(`${path || '.'}: ${field} and lock disagree`)
      for (const [name, version] of Object.entries(deps)) {
        if (!localNames.has(name) && !/^\d+\.\d+\.\d+$/.test(version)) issues.push(`${path || '.'}: ${name} must use an exact stable version`)
      }
    }
  }
  for (const [path, pkg] of Object.entries(lock.packages)) {
    if (!path.includes('node_modules/') || pkg.link || pkg.inBundle) continue
    if (!pkg.resolved?.startsWith('https://registry.npmjs.org/') || !/^sha(256|384|512)-[A-Za-z0-9+/=]+$/.test(pkg.integrity ?? '')) issues.push(`${path}: missing registry URL or integrity`)
  }
  return issues
}

export function assertDependencyLocks(directory = root) {
  const manifest = readJson(join(directory, 'package.json'))
  const rootManifests = ['', ...manifest.workspaces].map(path => ({ path, manifest: readJson(join(directory, path, 'package.json')) }))
  const groups = [{ dir: '', manifests: rootManifests }, ...['apps/dashboard', 'apps/onboard', 'apps/documentation'].map(dir => ({ dir, manifests: [{ path: '', manifest: readJson(join(directory, dir, 'package.json')) }] }))]
  const issues = groups.flatMap(({ dir, manifests }) => npmLockIssues(manifests, readJson(join(directory, dir, 'package-lock.json'))).map(issue => `${dir || 'root'}: ${issue}`))
  for (const dir of ['apps/graphiti-service', 'apps/dlp-service', 'documentation']) {
    issues.push(...pythonInputIssues(readFileSync(join(directory, dir, 'requirements.txt'), 'utf8'), readFileSync(join(directory, dir, 'requirements.lock'), 'utf8')).map(issue => `${dir}: ${issue}`))
    for (const name of ['requirements.lock', 'build-requirements.lock']) {
      const locked = readFileSync(join(directory, dir, name), 'utf8')
      const entries = locked.split(/\r?\n(?=[a-zA-Z0-9])/).filter(line => line.trim() && !line.trim().startsWith('#'))
      if (!entries.length || entries.some(entry => !/^[a-zA-Z0-9_.-]+(?:==\d[^\s]*| @ https:\/\/)/.test(entry) || !/--hash=sha256:[0-9a-f]{64}/.test(entry))) issues.push(`${dir}/${name}: exact packages with SHA256 hashes are required`)
    }
  }
  if (issues.length) throw new Error(`Dependency lock verification failed:\n${issues.join('\n')}`)
  return { npmTrees: groups.length, pythonLocks: 6 }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log('Verified dependency locks:', assertDependencyLocks()) } catch (error) { console.error(error.message); process.exitCode = 1 }
}
