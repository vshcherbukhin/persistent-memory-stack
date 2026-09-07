import { evaluateResources, type ResourceSnapshot } from '../shared/resource-policy.js'

/** Shared by action routes and the terminal installer; UI acknowledgements can
 * never waive a measured minimum. Re-evaluate a fresh snapshot at execution. */
export function resourceGate(snapshot: ResourceSnapshot, selection: { provider: string; model: string }, acknowledged = false): string | null {
  const assessment = evaluateResources(snapshot, selection)
  if (!assessment.allowed) return `Installation requirements are not met. ${assessment.blockers.map(issue => issue.message).join(' ')} Free resources and run the environment check again.`
  if (assessment.warnings.length && !acknowledged) return `Review and acknowledge the resource warnings before continuing. ${assessment.warnings.map(issue => issue.message).join(' ')}`
  return null
}
