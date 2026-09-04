import type { Job, MemoryGraphRebuildJobData, MemoryGraphRebuildJobResult } from '@pm/shared'
import type { WorkerDeps } from './deps.ts'
import { memoryGraphRebuild } from './steps/memory-graph-rebuild.ts'

export function makeMemoryGraphRebuildProcessor(deps: WorkerDeps) {
  return async (job: Job<MemoryGraphRebuildJobData, MemoryGraphRebuildJobResult>): Promise<MemoryGraphRebuildJobResult> => {
    return memoryGraphRebuild(deps, job.data)
  }
}
