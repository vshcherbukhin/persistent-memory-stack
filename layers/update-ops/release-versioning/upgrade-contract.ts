export interface ReleaseUpgradeBridge {
  from: string
  to: string
  requires: string
  reason: string
}

export interface ReleaseUpgradeStop {
  when: string
  release: string
  reason: string
}

export interface ReleaseUpgradeContract {
  schemaVersion: 1
  release: string
  minimumSupportedSource: string
  compatibleMajorLine: number
  directFrom: string
  bridges: ReleaseUpgradeBridge[]
  requiredStops: ReleaseUpgradeStop[]
  coordinator: {
    minimumVersion: number
    bootstrap: boolean
  }
}

export interface UpgradeContractValidationOptions {
  packageVersion: string
  availableReleases: ReadonlySet<string>
}

interface Version {
  major: number
  minor: number
  patch: number
}

function parseVersion(value: string): Version {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(value)
  if (!match) throw new Error(`Invalid semantic version: ${value}`)
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

export function compareUpgradeVersions(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  for (const key of ['major', 'minor', 'patch'] as const) {
    const diff = left[key] - right[key]
    if (diff !== 0) return diff
  }
  return 0
}

export function satisfiesUpgradeRange(version: string, range: string): boolean {
  const comparisons = range.trim().split(/\s+/u).filter(Boolean)
  if (!comparisons.length) return false
  return comparisons.every((comparison) => {
    const match = /^(>=|>|<=|<|=)?(\d+\.\d+\.\d+)$/u.exec(comparison)
    if (!match) return false
    const operator = match[1] ?? '='
    const result = compareUpgradeVersions(version, match[2]!)
    return operator === '>=' ? result >= 0
      : operator === '>' ? result > 0
        : operator === '<=' ? result <= 0
          : operator === '<' ? result < 0
            : result === 0
  })
}

function nextPatchVersion(version: string): string {
  const parsed = parseVersion(version)
  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`
}

function rangePermitsVersionNewerThan(range: string, target: string): boolean {
  const candidates = new Set<string>([nextPatchVersion(target)])
  for (const comparison of range.trim().split(/\s+/u)) {
    const match = /^(>=|>|<=|<|=)?(\d+\.\d+\.\d+)$/u.exec(comparison)
    if (!match) continue
    candidates.add(match[2]!)
    candidates.add(nextPatchVersion(match[2]!))
  }
  return [...candidates].some((candidate) => (
    compareUpgradeVersions(candidate, target) > 0
    && satisfiesUpgradeRange(candidate, range)
  ))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function rejectUnexpectedFields(value: Record<string, unknown>, name: string, allowed: readonly string[]): void {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key))
  if (unexpected) throw new Error(`${name} contains unsupported field ${unexpected}.`)
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string.`)
  return value
}

function requireRange(value: unknown, name: string): string {
  const range = requireString(value, name)
  for (const comparison of range.trim().split(/\s+/u)) {
    if (!/^(>=|>|<=|<|=)?\d+\.\d+\.\d+$/u.test(comparison)) {
      throw new Error(`${name} contains an unsupported semantic-version range.`)
    }
  }
  return range
}

function requireVersion(value: unknown, name: string): string {
  const version = requireString(value, name)
  parseVersion(version)
  return version
}

export function validateUpgradeContract(
  value: unknown,
  options: UpgradeContractValidationOptions,
): ReleaseUpgradeContract {
  if (!isRecord(value)) throw new Error('Release upgrade contract must be an object.')
  rejectUnexpectedFields(value, 'Release upgrade contract', [
    'schemaVersion',
    'release',
    'minimumSupportedSource',
    'compatibleMajorLine',
    'directFrom',
    'bridges',
    'requiredStops',
    'coordinator',
  ])
  if (value.schemaVersion !== 1) throw new Error('Release upgrade contract must use schemaVersion 1.')

  const release = requireVersion(value.release, 'release')
  const minimumSupportedSource = requireVersion(value.minimumSupportedSource, 'minimumSupportedSource')
  const directFrom = requireRange(value.directFrom, 'directFrom')
  if (compareUpgradeVersions(minimumSupportedSource, release) > 0) {
    throw new Error(`minimumSupportedSource ${minimumSupportedSource} cannot be later than release ${release}.`)
  }
  if (rangePermitsVersionNewerThan(directFrom, release)) {
    throw new Error(`directFrom ${directFrom} permits versions newer than target release ${release}.`)
  }
  if (release !== options.packageVersion) {
    throw new Error(`Release ${release} does not match package version ${options.packageVersion}.`)
  }
  if (!options.availableReleases.has(release)) throw new Error(`Release ${release} is unavailable from the trusted branch.`)
  if (typeof value.compatibleMajorLine !== 'number' || !Number.isInteger(value.compatibleMajorLine)) {
    throw new Error('compatibleMajorLine must be an integer.')
  }
  if (parseVersion(release).major !== value.compatibleMajorLine) {
    throw new Error(`compatibleMajorLine ${value.compatibleMajorLine} does not match release ${release}.`)
  }
  if (!Array.isArray(value.bridges) || !Array.isArray(value.requiredStops)) {
    throw new Error('bridges and requiredStops must be arrays.')
  }
  const coordinator = value.coordinator
  if (!isRecord(coordinator) || typeof coordinator.minimumVersion !== 'number' || !Number.isInteger(coordinator.minimumVersion) || coordinator.minimumVersion < 1 || typeof coordinator.bootstrap !== 'boolean') {
    throw new Error('coordinator must declare minimumVersion and bootstrap.')
  }
  rejectUnexpectedFields(coordinator, 'coordinator', ['minimumVersion', 'bootstrap'])

  const bridges = value.bridges.map((raw, index): ReleaseUpgradeBridge => {
    if (!isRecord(raw)) throw new Error(`bridges[${index}] must be an object.`)
    rejectUnexpectedFields(raw, `bridges[${index}]`, ['from', 'to', 'requires', 'reason'])
    const to = requireVersion(raw.to, `bridges[${index}].to`)
    if (to !== release) throw new Error(`Bridge ${index} must target release ${release}.`)
    if (!options.availableReleases.has(to)) throw new Error(`Bridge target ${to} is unavailable from the trusted branch.`)
    return {
      from: requireRange(raw.from, `bridges[${index}].from`),
      to,
      requires: requireRange(raw.requires, `bridges[${index}].requires`),
      reason: requireString(raw.reason, `bridges[${index}].reason`),
    }
  })

  const seenStops = new Set<string>()
  let previousStop: string | null = null
  const requiredStops = value.requiredStops.map((raw, index): ReleaseUpgradeStop => {
    if (!isRecord(raw)) throw new Error(`requiredStops[${index}] must be an object.`)
    rejectUnexpectedFields(raw, `requiredStops[${index}]`, ['when', 'release', 'reason'])
    const stopRelease = requireVersion(raw.release, `requiredStops[${index}].release`)
    if (compareUpgradeVersions(stopRelease, release) >= 0) {
      throw new Error(`Required stop ${stopRelease} must be earlier than target release ${release}.`)
    }
    if (!options.availableReleases.has(stopRelease)) throw new Error(`Required stop ${stopRelease} is unavailable from the trusted branch.`)
    if (seenStops.has(stopRelease)) throw new Error(`Required stop ${stopRelease} is duplicated.`)
    if (previousStop && compareUpgradeVersions(stopRelease, previousStop) <= 0) {
      throw new Error(`Required stop ${stopRelease} is not strictly later than ${previousStop}.`)
    }
    seenStops.add(stopRelease)
    previousStop = stopRelease
    return {
      when: requireRange(raw.when, `requiredStops[${index}].when`),
      release: stopRelease,
      reason: requireString(raw.reason, `requiredStops[${index}].reason`),
    }
  })

  return {
    schemaVersion: 1,
    release,
    minimumSupportedSource,
    compatibleMajorLine: value.compatibleMajorLine,
    directFrom,
    bridges,
    requiredStops,
    coordinator: {
      minimumVersion: coordinator.minimumVersion,
      bootstrap: coordinator.bootstrap,
    },
  }
}

export function planUpgradePath(
  sourceVersion: string,
  target: ReleaseUpgradeContract,
  contracts: ReadonlyMap<string, ReleaseUpgradeContract>,
): string[] {
  if (!contracts.has(target.release)) throw new Error(`Target contract is unavailable: ${target.release}`)
  if (compareUpgradeVersions(sourceVersion, target.release) > 0) {
    throw new Error(`Source ${sourceVersion} is newer than target release ${target.release}; downgrade paths are unsupported.`)
  }
  if (compareUpgradeVersions(sourceVersion, target.minimumSupportedSource) < 0) {
    throw new Error(`Source ${sourceVersion} is older than the supported minimum ${target.minimumSupportedSource}.`)
  }
  let current = sourceVersion
  const path: string[] = []

  for (const stop of target.requiredStops) {
    if (!satisfiesUpgradeRange(current, stop.when)) continue
    const stopContract = contracts.get(stop.release)
    if (!stopContract) throw new Error(`Required stop contract is unavailable: ${stop.release}`)
    if (compareUpgradeVersions(stop.release, current) <= 0) {
      throw new Error(`Required stop ${stop.release} does not advance from ${current}.`)
    }
    if (!satisfiesUpgradeRange(current, stopContract.directFrom)) {
      throw new Error(`Source ${current} cannot update directly to required stop ${stop.release}.`)
    }
    path.push(stop.release)
    current = stop.release
  }

  if (current === target.release) return path
  if (!satisfiesUpgradeRange(current, target.directFrom)) {
    throw new Error(`Source ${current} cannot update directly to ${target.release}.`)
  }
  const sourceMajor = parseVersion(current).major
  const targetMajor = parseVersion(target.release).major
  if (sourceMajor !== targetMajor) {
    const bridge = target.bridges.find((candidate) => (
      candidate.to === target.release
      && satisfiesUpgradeRange(current, candidate.from)
      && satisfiesUpgradeRange(current, candidate.requires)
    ))
    if (!bridge) throw new Error(`A declared bridge is required from ${current} to ${target.release}.`)
  }
  return [...path, target.release]
}
