import { createHmac } from 'node:crypto'

export type GraphMemorySurface = 'personal' | 'shared'

/**
 * Stable but opaque Graphiti partition key. A Graphiti group is a physical graph
 * namespace, never an authorization token; callers must still derive the allowed
 * team/project set server-side before they pass a key to Graphiti.
 */
export function deriveProjectGraphGroup(input: {
  secret: string
  teamId: string
  project: string
  surface: GraphMemorySurface
}): string {
  const project = input.project.trim()
  if (!project) throw new Error('Graph project must not be empty.')
  const digest = createHmac('sha256', input.secret)
    .update(`persistent-memory/graph-v2\u0000${input.surface}\u0000${input.teamId}\u0000${project}`)
    .digest('base64url')
  return `pmg2_${digest}`
}
