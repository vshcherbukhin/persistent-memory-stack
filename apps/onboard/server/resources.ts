/** Read-only host resource probes. Never starts Docker, pulls an image/model,
 * changes settings, or treats a Docker Linux path as a host filesystem path. */
import { execFile } from 'node:child_process'
import { statfs, stat, readFile } from 'node:fs/promises'
import { totalmem, freemem, cpus, arch, platform, homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import { hostCommand, nativeWindowsPath } from './host.js'
import type { DiskResources, ResourceSnapshot } from '../shared/resource-policy.js'

export interface ResourceCommandResult { code: number | null; stdout: string; timedOut?: boolean }
export interface FilesystemStats { bsize: bigint; blocks: bigint; bavail: bigint }
export interface ResourceProbeIO {
  statfs: (path: string) => Promise<FilesystemStats>
  device: (path: string) => Promise<string>
  readText: (path: string) => Promise<string>
  capture: (command: string, args: string[], timeoutMs: number) => Promise<ResourceCommandResult>
}
export interface ReadResourcesOptions {
  installPath: string
  ollamaModelsPath?: string
  /** Explicit override is useful for managed Docker Desktop installations. */
  dockerDataPath?: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  home?: string
  host?: ResourceSnapshot['host']
  now?: () => Date
  timeoutMs?: number
  io?: Partial<ResourceProbeIO>
}
const boundedNumber = (value: unknown, positive = false): number | null => {
  const number = typeof value === 'number' ? value : NaN
  return Number.isSafeInteger(number) && (positive ? number > 0 : number >= 0) ? number : null
}
const boundedBytes = (value: bigint): number | null => value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null
const errorCode = (error: unknown): string => error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
// win32.isAbsolute also accepts current-drive roots such as \models. Those
// could measure a different disk than an Ollama process using another drive.
const fullyQualifiedPath = (path: string, hostPlatform: NodeJS.Platform): boolean => hostPlatform === 'win32'
  ? /^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/]|$))/i.test(path)
  : posix.isAbsolute(path)
async function bounded<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([work, new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('Resource probe timed out'), { code: 'ETIMEDOUT' })), timeoutMs)
    })])
  } finally { if (timer) clearTimeout(timer) }
}

/** Win32_PhysicalMemory.Capacity is an SMBIOS module capacity in bytes. Send
 * only capacities, never serial numbers or other machine inventory fields.
 * Decimal strings retain uint64 precision until the bounded sum is checked. */
const WINDOWS_MEMORY_COMMAND = "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; ConvertTo-Json -Compress -InputObject @(Get-CimInstance -ClassName Win32_PhysicalMemory -Property Capacity -OperationTimeoutSec 3 | ForEach-Object { [string]$_.Capacity })"
export function parseWindowsPhysicalMemoryBytes(result: ResourceCommandResult): number | null {
  if (result.code !== 0) return null
  try {
    const modules: unknown = JSON.parse(result.stdout)
    if (!Array.isArray(modules) || modules.length === 0 || modules.length > 1024) return null
    let total = 0n
    for (const capacity of modules) {
      if (typeof capacity !== 'string' || !/^[1-9]\d{0,19}$/.test(capacity)) return null
      total += BigInt(capacity)
    }
    return boundedBytes(total)
  } catch { return null }
}

/** vm_stat's printed "Pages free" excludes speculative pages, unlike Mach's
 * free_count (and Node's os.freemem). Its inactive queue is separate from both.
 * Sources: apple-oss-distributions/system_cmds, vm_stat/vm_stat.c:snapshot;
 * apple-oss-distributions/xnu, osfmk/vm/vm_resident.c:vm_page_enqueue_inactive.
 * Purgeable pages are an overlapping object property, not another page queue
 * (xnu/osfmk/vm/vm_object.c:vm_object_purgable_control), so do not add them.
 * This is an estimate: inactive pages may need compression or disk writeback;
 * they are not a promise of immediately free RAM or a memory-pressure reading. */
export function parseMacosAvailableMemoryBytes(result: ResourceCommandResult, totalMemoryBytes: number | null): number | null {
  const total = boundedNumber(totalMemoryBytes, true)
  if (result.code !== 0 || result.timedOut || total === null || result.stdout.length > 128 * 1024) return null
  const lines = result.stdout.trim().split(/\r?\n/)
  const header = /^Mach Virtual Memory Statistics: \(page size of (4096|16384) bytes\)$/.exec(lines[0]?.trim() ?? '')
  if (!header?.[1]) return null
  const pageSize = BigInt(header[1])
  const totalBytes = BigInt(total)
  let available = 0n
  for (const label of ['Pages free', 'Pages speculative', 'Pages inactive']) {
    const entries = lines.filter(line => line.trimStart().startsWith(`${label}:`))
    const entry = entries[0]
    if (entries.length !== 1 || entry === undefined) return null
    const value = new RegExp(`^${label}:\\s+([0-9]{1,20})\\.?\\s*$`).exec(entry.trim())
    if (!value?.[1]) return null
    const bytes = BigInt(value[1]) * pageSize
    if (bytes > totalBytes) return null
    available += bytes
  }
  // Do not clamp an impossible sum into an apparently idle, fully available
  // machine. Fall back conservatively and let the user recheck a bad snapshot.
  return available <= totalBytes ? Number(available) : null
}

export async function readHostResources(
  hostPlatform: NodeJS.Platform, capture: ResourceProbeIO['capture'], timeoutMs: number,
  base: ResourceSnapshot['host'] = { platform: hostPlatform, arch: arch(), cpuCount: boundedNumber(cpus().length, true), totalMemoryBytes: boundedNumber(totalmem(), true), freeMemoryBytes: boundedNumber(freemem()) },
): Promise<ResourceSnapshot['host']> {
  if (hostPlatform === 'darwin') {
    try {
      const available = parseMacosAvailableMemoryBytes(await bounded(
        capture('/usr/bin/vm_stat', [], timeoutMs), timeoutMs + 100,
      ), base.totalMemoryBytes)
      if (available !== null) return { ...base, availableMemoryBytes: available, availableMemorySource: 'macos-vm-stat' }
    } catch { /* Keep the conservative OS-free fallback below. */ }
    const free = boundedNumber(base.freeMemoryBytes)
    const total = boundedNumber(base.totalMemoryBytes, true)
    return {
      ...base,
      availableMemoryBytes: free === null || (total !== null && free > total) ? null : free,
      availableMemorySource: 'os-free',
      availableMemoryReason: 'macOS available RAM could not be estimated. The check conservatively uses OS-reported free RAM without assuming cached memory can be reclaimed. Close memory-heavy applications and recheck resources.',
    }
  }
  if (hostPlatform !== 'win32') return base
  let installed: number | null = null
  try {
    installed = parseWindowsPhysicalMemoryBytes(await bounded(
      capture('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_MEMORY_COMMAND], timeoutMs), timeoutMs + 100,
    ))
  } catch { /* Keep the measured usable-memory fallback below. */ }
  const usable = base.totalMemoryBytes
  // An incomplete/inconsistent module inventory must not replace a larger known
  // usable capacity. Free memory remains the independent current OS measurement.
  if (installed !== null && installed >= (usable ?? 0) && installed >= (base.freeMemoryBytes ?? 0)) {
    return { ...base, totalMemoryBytes: installed, usableMemoryBytes: usable, memorySource: 'installed-physical' }
  }
  return {
    ...base, usableMemoryBytes: usable, memorySource: 'os-usable',
    memoryReason: 'Installed Windows RAM could not be confirmed. Host RAM uses the lower OS-usable measurement without rounding up. Check Windows memory reporting and recheck resources if this falls below your installed capacity.',
  }
}

export async function readFilesystemResources(path: string, io: Pick<ResourceProbeIO, 'statfs' | 'device'>, hostPlatform: NodeJS.Platform, timeoutMs = 5000): Promise<DiskResources> {
  const paths = hostPlatform === 'win32' ? win32 : posix
  const native = hostPlatform === 'win32' ? nativeWindowsPath(path) : path
  const unknown = (reason: string): DiskResources => ({ path: native, resolvedPath: null, filesystemId: null, totalBytes: null, freeBytes: null, status: 'unknown', reason })
  if (!fullyQualifiedPath(native, hostPlatform)) return unknown('The filesystem path must be fully qualified, including a drive or network share on Windows. Set an accessible installation/model directory and recheck.')
  try {
    return await bounded((async () => {
      let current = paths.normalize(native)
      for (let attempt = 0; attempt < 64; attempt++) {
        try {
          const [space, device] = await Promise.all([io.statfs(current), io.device(current)])
          const totalBytes = boundedBytes(space.blocks * space.bsize)
          const freeBytes = boundedBytes(space.bavail * space.bsize)
          if (space.bsize <= 0n || !totalBytes || freeBytes === null || freeBytes > totalBytes || !device) return unknown('The filesystem returned unusable capacity information. Check this disk and recheck resources.')
          return { path: native, resolvedPath: current, filesystemId: device, totalBytes, freeBytes, status: 'ok' as const }
        } catch (error) {
          // A fresh install/model directory may not exist. Measure its parent;
          // access failures never fall back to a potentially different disk.
          if (!['ENOENT', 'ENOTDIR'].includes(errorCode(error))) throw error
          const parent = paths.dirname(current)
          if (parent === current) break
          current = parent
        }
      }
      return unknown('No accessible parent filesystem was found for this path. Choose an existing disk and recheck.')
    })(), timeoutMs)
  } catch (error) {
    return unknown(errorCode(error) === 'ETIMEDOUT'
      ? 'The filesystem probe timed out. Check that this disk is connected and recheck.'
      : 'The filesystem could not be read. Check permissions and disk connectivity, then recheck.')
  }
}

/** Docker devicemapper can expose this field; most Desktop drivers do not.
 * No system-df usage/reclaimable figure is misrepresented as available capacity. */
export function parseDockerStorageBytes(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const match = /^\s*(\d+(?:\.\d+)?)\s*(B|kB|MB|GB|TB|KiB|MiB|GiB|TiB)\s*$/i.exec(value)
  if (!match) return null
  const units: Record<string, number> = { b: 1, kb: 1000, mb: 1000 ** 2, gb: 1000 ** 3, tb: 1000 ** 4, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 }
  return boundedNumber(Math.floor(Number(match[1]) * units[match[2]!.toLowerCase()]!))
}
export function parseDockerResources(result: ResourceCommandResult): ResourceSnapshot['docker'] {
  const failed = (reason: string): ResourceSnapshot['docker'] => ({ status: 'unavailable', totalMemoryBytes: null, cpuCount: null, arch: null, storageFreeBytes: null, reason })
  if (result.code !== 0) return failed(result.timedOut ? 'Docker did not respond in time. Check Docker Desktop and recheck resources.' : 'Docker resource information is unavailable. Start Docker Desktop, select Linux containers, then recheck.')
  let data: Record<string, unknown>
  try {
    const value: unknown = JSON.parse(result.stdout)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return failed('Docker returned unreadable resource information. Recheck Docker Desktop.')
    data = value as Record<string, unknown>
  } catch { return failed('Docker returned unreadable resource information. Recheck Docker Desktop.') }
  if (data.OSType !== 'linux') return { ...failed('This stack needs Docker Linux containers. Switch Docker Desktop to its Linux engine and recheck.'), status: 'unsupported' }
  const storage = Array.isArray(data.DriverStatus) ? data.DriverStatus.find(row => Array.isArray(row) && row[0] === 'Data Space Available') : undefined
  const storageFreeBytes = parseDockerStorageBytes(storage?.[1])
  return {
    status: 'ok', totalMemoryBytes: boundedNumber(data.MemTotal, true), cpuCount: boundedNumber(data.NCPU, true),
    arch: typeof data.Architecture === 'string' ? data.Architecture : null, storageFreeBytes,
    ...(storageFreeBytes === null ? { storageReason: 'Docker does not report available storage inside its Linux VM. Check Docker Desktop disk usage and free space; host filesystem free space is a separate limit.' } : {}),
  }
}

/** Only known local absolute disk-location fields are used. Everything else in
 * Desktop settings (including credentials/proxies) is discarded and never returned. */
export function dockerDataPathFromSettings(text: string, hostPlatform: NodeJS.Platform, home: string): string | null {
  let data: Record<string, unknown>
  try {
    const value: unknown = JSON.parse(text.replace(/^\uFEFF/, ''))
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    data = value as Record<string, unknown>
  } catch { return null }
  const paths = hostPlatform === 'win32' ? win32 : posix
  for (const key of ['dataFolder', 'diskImageLocation', 'diskImagePath', 'wslDataRoot']) {
    const entry = Object.entries(data).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1]
    const raw = typeof entry === 'string' ? entry : entry && typeof entry === 'object' && 'value' in entry && typeof entry.value === 'string' ? entry.value : ''
    if (!raw.trim()) continue
    const expanded = /^~[\\/]/.test(raw) ? paths.join(home, raw.slice(2)) : raw
    const native = hostPlatform === 'win32' ? nativeWindowsPath(expanded) : expanded
    if (fullyQualifiedPath(native, hostPlatform)) return paths.normalize(native)
  }
  return null
}

export function dockerEndpointLocation(endpoint: unknown): 'local' | 'remote' | 'unknown' {
  if (typeof endpoint !== 'string' || !endpoint) return 'unknown'
  if (/^(?:unix:\/\/\/|npipe:\/\/)/i.test(endpoint)) return 'local'
  if (/^ssh:\/\//i.test(endpoint)) return 'remote'
  if (/^(?:tcp|https?):\/\//i.test(endpoint)) {
    try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(endpoint).hostname) ? 'local' : 'remote' }
    catch { return 'unknown' }
  }
  return 'unknown'
}

export async function readResources(options: ReadResourcesOptions): Promise<ResourceSnapshot> {
  const hostPlatform = options.platform ?? platform()
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const paths = hostPlatform === 'win32' ? win32 : posix
  const timeoutMs = Math.max(100, Math.min(options.timeoutMs ?? 5000, 10_000))
  const io: ResourceProbeIO = {
    statfs: path => statfs(path, { bigint: true }),
    device: async path => (await stat(path, { bigint: true })).dev.toString(),
    readText: async path => {
      const info = await stat(path)
      if (!info.isFile() || info.size > 1024 ** 2) throw new Error('Settings file is not a bounded regular file')
      return readFile(path, 'utf8')
    },
    capture: (command, args, timeout) => new Promise(resolve => {
      let resolved: ReturnType<typeof hostCommand>
      try { resolved = hostCommand(command, args, { platform: hostPlatform, env }) }
      catch { resolve({ code: null, stdout: '' }); return }
      execFile(resolved.command, resolved.args, { env: resolved.env, encoding: 'utf8', timeout, maxBuffer: 128 * 1024, windowsHide: true }, (error, stdout) => {
        resolve({ code: error ? (typeof error.code === 'number' ? error.code : null) : 0, stdout: error ? '' : stdout, timedOut: !!error?.killed })
      })
    }),
    ...options.io,
  }
  const modelPath = options.ollamaModelsPath?.trim() || env.OLLAMA_MODELS?.trim() || paths.join(home, '.ollama', 'models')
  const desktopSettings = hostPlatform === 'darwin'
    ? paths.join(home, 'Library', 'Group Containers', 'group.com.docker')
    : hostPlatform === 'win32' ? paths.join(env.APPDATA ?? paths.join(home, 'AppData', 'Roaming'), 'Docker')
      : paths.join(home, '.docker', 'desktop')
  const readDockerHostDisk = async (): Promise<DiskResources | null> => {
    let path = options.dockerDataPath ?? null
    if (!path) {
      // Current and legacy settings filenames; no recursive scans or modifications.
      const texts = await Promise.all(['settings-store.json', 'settings.json'].map(async name => {
        try { return await bounded(io.readText(paths.join(desktopSettings, name)), timeoutMs) } catch { return null }
      }))
      // A current settings file supersedes the legacy one even if it does not
      // expose its disk path. Do not accidentally report an obsolete location.
      const current = texts.find(text => text !== null)
      path = current ? dockerDataPathFromSettings(current, hostPlatform, home) : null
    }
    return path ? readFilesystemResources(path, io, hostPlatform, timeoutMs) : null
  }
  const readDockerContext = async (): Promise<'local' | 'remote' | 'unknown'> => {
    // DOCKER_CONTEXT explicitly overrides DOCKER_HOST in the Docker CLI.
    if (env.DOCKER_HOST && !env.DOCKER_CONTEXT) return dockerEndpointLocation(env.DOCKER_HOST)
    try {
      const result = await bounded(io.capture('docker', ['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}'], timeoutMs), timeoutMs + 100)
      return result.code === 0 ? dockerEndpointLocation(JSON.parse(result.stdout)) : 'unknown'
    } catch { return 'unknown' }
  }
  const [installDisk, ollamaDisk, desktopDisk, dockerResult, context, host] = await Promise.all([
    readFilesystemResources(options.installPath, io, hostPlatform, timeoutMs),
    readFilesystemResources(modelPath, io, hostPlatform, timeoutMs),
    readDockerHostDisk(),
    bounded(io.capture('docker', ['info', '--format', '{{json .}}'], timeoutMs), timeoutMs + 100).catch(() => ({ code: null, stdout: '', timedOut: true })),
    readDockerContext(),
    readHostResources(hostPlatform, io.capture, timeoutMs, options.host),
  ])
  const docker = { ...parseDockerResources(dockerResult), context }
  if (context === 'remote') {
    docker.status = 'unavailable'
    docker.reason = 'Docker is using a remote endpoint. Select the local Docker Desktop context and recheck before installing this host stack.'
  }
  return {
    capturedAt: (options.now ?? (() => new Date()))().toISOString(),
    host,
    installDisk, ollamaDisk, dockerHostDisk: context === 'local' ? desktopDisk : null, docker,
  }
}
