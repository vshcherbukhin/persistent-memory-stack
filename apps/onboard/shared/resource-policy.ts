/** Conservative product installation budgets, including safety headroom.
 * These are planning estimates, not model-vendor minimums or performance guarantees.
 * Keep this module free of Node APIs so the host and wizard use one policy. */
export const GiB = 1024 ** 3
export type ResourceProvider = 'ollama' | 'openai' | 'voyage'
export interface DiskResources {
  path: string
  resolvedPath: string | null
  filesystemId: string | null
  totalBytes: number | null
  freeBytes: number | null
  status: 'ok' | 'unknown'
  reason?: string
}
export interface ResourceSnapshot {
  capturedAt: string
  host: {
    platform: string
    arch: string
    cpuCount: number | null
    totalMemoryBytes: number | null
    freeMemoryBytes: number | null
    /** Windows reports installed modules separately from OS-usable memory. */
    usableMemoryBytes?: number | null
    memorySource?: 'installed-physical' | 'os-usable'
    memoryReason?: string
  }
  installDisk: DiskResources
  ollamaDisk: DiskResources
  /** The physical filesystem holding Docker Desktop's disk image, when known.
   * Its free space is distinct from free storage inside the Docker Linux VM. */
  dockerHostDisk: DiskResources | null
  docker: {
    status: 'ok' | 'unavailable' | 'unsupported'
    context?: 'local' | 'remote' | 'unknown'
    totalMemoryBytes: number | null
    cpuCount: number | null
    arch: string | null
    storageFreeBytes: number | null
    storageReason?: string
    reason?: string
  }
}
export interface ResourceQuantities {
  hostMemoryGiB: number
  freeHostMemoryGiB: number
  dockerMemoryGiB: number
  installDiskGiB: number
  modelDiskGiB: number
  dockerDiskGiB: number
  cpuCount: number
}
export interface ResourceBudget {
  minimum: ResourceQuantities
  recommended: ResourceQuantities
  basis: string
}
export interface ResourceModel {
  provider: ResourceProvider
  model: string
  dim: number
  label: string
  location: 'local' | 'remote'
  budget: ResourceBudget
}
const quantities = (ram: number, free: number, modelDisk: number, recommended = false): ResourceQuantities => ({
  hostMemoryGiB: ram, freeHostMemoryGiB: free, modelDiskGiB: modelDisk,
  dockerMemoryGiB: recommended ? 6 : 4,
  installDiskGiB: recommended ? 60 : 35,
  dockerDiskGiB: recommended ? 40 : 25,
  cpuCount: recommended ? 4 : 2,
})
const budget = (ram: number, free: number, disk: number, recRam: number, recFree: number, recDisk: number): ResourceBudget => ({
  minimum: quantities(ram, free, disk), recommended: quantities(recRam, recFree, recDisk, true),
  basis: 'Conservative Persistent Memory installation estimates with headroom for the OS, Docker, builds and model storage; not supplier-certified model minimums.',
})
export const RESOURCE_MODELS: readonly ResourceModel[] = [
  { provider: 'ollama', model: 'nomic-embed-text', dim: 768, label: 'Nomic Embed Text', location: 'local', budget: budget(12, 3, 2, 16, 5, 4) },
  { provider: 'ollama', model: 'qwen3-embedding:0.6b', dim: 1024, label: 'Qwen3 Embedding 0.6B', location: 'local', budget: budget(16, 4, 4, 24, 6, 6) },
  { provider: 'ollama', model: 'qwen3-embedding:4b', dim: 2560, label: 'Qwen3 Embedding 4B', location: 'local', budget: budget(24, 6, 8, 32, 10, 12) },
  { provider: 'ollama', model: 'qwen3-embedding:8b', dim: 4096, label: 'Qwen3 Embedding 8B', location: 'local', budget: budget(48, 12, 16, 64, 16, 24) },
  { provider: 'openai', model: 'text-embedding-3-small', dim: 1536, label: 'OpenAI Text Embedding 3 Small', location: 'remote', budget: budget(8, 2, 0, 16, 4, 0) },
  { provider: 'openai', model: 'text-embedding-3-large', dim: 3072, label: 'OpenAI Text Embedding 3 Large', location: 'remote', budget: budget(8, 2, 0, 16, 4, 0) },
  { provider: 'voyage', model: 'voyage-4', dim: 1024, label: 'Voyage 4 (balanced)', location: 'remote', budget: budget(8, 2, 0, 16, 4, 0) },
  { provider: 'voyage', model: 'voyage-4-large', dim: 1024, label: 'Voyage 4 Large (quality)', location: 'remote', budget: budget(8, 2, 0, 16, 4, 0) },
  { provider: 'voyage', model: 'voyage-4-lite', dim: 1024, label: 'Voyage 4 Lite (efficient)', location: 'remote', budget: budget(8, 2, 0, 16, 4, 0) },
  { provider: 'voyage', model: 'voyage-3-large', dim: 1024, label: 'Voyage 3 Large (legacy)', location: 'remote', budget: budget(8, 2, 0, 16, 4, 0) },
]
export interface ResourceIssue { code: string; message: string }
export interface ResourceAssessment {
  model: ResourceModel | null
  budget: ResourceBudget | null
  allowed: boolean
  requiresAcknowledgement: boolean
  meetsRecommended: boolean
  blockers: ResourceIssue[]
  warnings: ResourceIssue[]
}
const known = (value: number | null): value is number => value !== null && Number.isFinite(value) && value >= 0
const gibText = (bytes: number): string => `${(bytes / GiB).toFixed(1)} GiB`

export function evaluateResources(snapshot: ResourceSnapshot, selection: { provider: string; model: string }): ResourceAssessment {
  const model = RESOURCE_MODELS.find(item => item.provider === selection.provider && item.model === selection.model) ?? null
  const result: ResourceAssessment = { model, budget: model?.budget ?? null, allowed: false, requiresAcknowledgement: false, meetsRecommended: true, blockers: [], warnings: [] }
  const block = (code: string, message: string): void => { result.blockers.push({ code, message }); result.meetsRecommended = false }
  const warn = (code: string, message: string): void => { result.warnings.push({ code, message }); result.meetsRecommended = false }
  // Unknown Docker storage does not disqualify a model whose measured capacity
  // meets recommended headroom. It remains a separate explicit acknowledgement.
  const unknown = (code: string, message: string): void => { result.warnings.push({ code, message }); result.requiresAcknowledgement = true }
  if (!model) { block('unsupported_model', 'Choose a supported embedding provider and model before installing.'); return result }
  const min = model.budget.minimum
  const rec = model.budget.recommended
  const memory = (name: string, value: number | null, minimum: number, recommended: number, action: string): void => {
    const code = name.toLowerCase().replaceAll(' ', '_')
    if (!known(value)) { block(`${code}_unknown`, `${name} could not be measured. ${action} Recheck resources before installing.`); return }
    if (value < minimum * GiB) block(`${code}_minimum`, `${name} is ${gibText(value)}; this choice needs at least ${minimum} GiB of product-budget headroom. ${action}`)
    else if (value < recommended * GiB) warn(`${code}_recommended`, `${name} is ${gibText(value)}; ${recommended} GiB is recommended. ${action}`)
  }
  memory('Host RAM', snapshot.host.totalMemoryBytes, min.hostMemoryGiB, rec.hostMemoryGiB, model.location === 'local' ? 'Choose a smaller local model or a remote embedding API.' : 'Use a host with more memory.')
  if (snapshot.host.memoryReason) unknown('host_memory_fallback', snapshot.host.memoryReason)
  memory('Free host RAM', snapshot.host.freeMemoryBytes, min.freeHostMemoryGiB, rec.freeHostMemoryGiB, 'Close memory-heavy applications and recheck; this is currently free RAM, not a promise of reclaimable cache.')
  if (!['x64', 'arm64'].includes(snapshot.host.arch)) block('host_architecture', 'This installer supports x64 and arm64 hosts. Confirm a supported native Node installation.')
  if (!known(snapshot.host.cpuCount)) block('host_cpu_unknown', 'CPU count could not be measured. Recheck host resources.')
  else if (snapshot.host.cpuCount < min.cpuCount) block('host_cpu_minimum', `At least ${min.cpuCount} logical CPUs are required by the product budget.`)
  else if (snapshot.host.cpuCount < rec.cpuCount) warn('host_cpu_recommended', `${rec.cpuCount} or more logical CPUs are recommended.`)
  if (snapshot.docker.status !== 'ok') block('docker_unavailable', snapshot.docker.reason ?? 'Start Docker Desktop with Linux containers, then recheck resources.')
  else {
    memory('Docker RAM', snapshot.docker.totalMemoryBytes, min.dockerMemoryGiB, rec.dockerMemoryGiB, 'Check Docker Desktop memory allocation; host RAM and Docker VM memory are different budgets.')
    if (!known(snapshot.docker.cpuCount)) block('docker_cpu_unknown', 'Docker CPU availability could not be measured. Recheck Docker resources.')
    else if (snapshot.docker.cpuCount < min.cpuCount) block('docker_cpu_minimum', `Allocate at least ${min.cpuCount} logical CPUs to Docker.`)
    else if (snapshot.docker.cpuCount < rec.cpuCount) warn('docker_cpu_recommended', `Allocate ${rec.cpuCount} or more logical CPUs to Docker for recommended headroom.`)
  }

  // Group physical filesystem reservations. If repo/model/Docker data share a
  // disk, they compete for the same bytes and must be budgeted together.
  const reservations: Array<{ label: string; disk: DiskResources; minimum: number; recommended: number }> = [
    { label: 'Installation filesystem', disk: snapshot.installDisk, minimum: min.installDiskGiB, recommended: rec.installDiskGiB },
  ]
  if (model.location === 'local') reservations.push({ label: 'Ollama model filesystem', disk: snapshot.ollamaDisk, minimum: min.modelDiskGiB, recommended: rec.modelDiskGiB })
  // Installation reserve already includes Docker image/build space on the same
  // physical disk. On a separate Docker-data disk, reserve that space there too.
  if (snapshot.dockerHostDisk && snapshot.dockerHostDisk.filesystemId !== snapshot.installDisk.filesystemId) {
    reservations.push({ label: 'Docker data filesystem', disk: snapshot.dockerHostDisk, minimum: min.dockerDiskGiB, recommended: rec.dockerDiskGiB })
  }
  const groups = new Map<string, { labels: string[]; free: number; minimum: number; recommended: number }>()
  for (const item of reservations) {
    if (item.disk.status !== 'ok' || !known(item.disk.freeBytes) || !item.disk.filesystemId) {
      block('filesystem_unknown', `${item.label} could not be measured. ${item.disk.reason ?? 'Check that its path is accessible and recheck resources.'}`)
      continue
    }
    const current = groups.get(item.disk.filesystemId)
    if (current) {
      current.labels.push(item.label); current.free = Math.min(current.free, item.disk.freeBytes)
      current.minimum += item.minimum; current.recommended += item.recommended
    } else groups.set(item.disk.filesystemId, { labels: [item.label], free: item.disk.freeBytes, minimum: item.minimum, recommended: item.recommended })
  }
  for (const group of groups.values()) {
    const label = group.labels.join(' + ')
    if (group.free < group.minimum * GiB) block('disk_minimum', `${label}: ${gibText(group.free)} free; at least ${group.minimum} GiB is budgeted${group.labels.length > 1 ? ' together on this shared filesystem' : ''}. Free space or choose another disk before installing.`)
    else if (group.free < group.recommended * GiB) warn('disk_recommended', `${label}: ${gibText(group.free)} free; ${group.recommended} GiB is recommended for installation headroom.`)
  }
  if (!snapshot.dockerHostDisk && ['darwin', 'win32'].includes(snapshot.host.platform)) unknown('docker_host_disk_unknown', 'The physical disk holding Docker Desktop data could not be confirmed. Check its disk-image location and available host space in Docker Desktop before continuing.')
  if (snapshot.docker.context === 'unknown') unknown('docker_context_unknown', 'The Docker endpoint could not be confirmed as local. Select the local Docker Desktop context and recheck; local filesystem measurements do not describe a remote daemon.')
  if (snapshot.docker.status === 'ok') {
    if (!known(snapshot.docker.storageFreeBytes)) unknown('docker_storage_unknown', snapshot.docker.storageReason ?? `Docker does not expose free space inside its Linux storage here. Confirm at least ${min.dockerDiskGiB} GiB available in Docker Desktop before continuing; host free disk is a different measure.`)
    else if (snapshot.docker.storageFreeBytes < min.dockerDiskGiB * GiB) block('docker_disk_minimum', `Docker Linux storage has ${gibText(snapshot.docker.storageFreeBytes)} free; at least ${min.dockerDiskGiB} GiB is budgeted. Free or expand Docker storage, then recheck.`)
    else if (snapshot.docker.storageFreeBytes < rec.dockerDiskGiB * GiB) warn('docker_disk_recommended', `Docker Linux storage has ${gibText(snapshot.docker.storageFreeBytes)} free; ${rec.dockerDiskGiB} GiB is recommended.`)
  }
  result.allowed = result.blockers.length === 0
  return result
}

export function recommendResources(snapshot: ResourceSnapshot): {
  provider: ResourceProvider; model: string; dim: number; reason: string; allowed: boolean;
  requiresAcknowledgement: boolean; localEnabled: boolean; options: ResourceAssessment[];
} {
  const options = RESOURCE_MODELS.map(model => evaluateResources(snapshot, model))
  const localOptions = options.filter(option => option.model?.location === 'local')
  const recommendedLocal = [...localOptions].reverse().find(option => option.allowed && option.meetsRecommended)
  const selected = recommendedLocal ?? options.find(option => option.model?.model === 'text-embedding-3-small')!
  const model = selected.model!
  return {
    provider: model.provider, model: model.model, dim: model.dim,
    reason: recommendedLocal
      ? 'This is the largest local model meeting recommended headroom for the measured capacities. Review and acknowledge any unmeasured Docker storage separately.'
      : 'A remote embedding API avoids local model memory pressure. No local model currently meets all recommended headroom; review any blocked or unknown resources before installation.',
    allowed: selected.allowed, requiresAcknowledgement: selected.requiresAcknowledgement,
    localEnabled: localOptions.some(option => option.allowed), options,
  }
}
