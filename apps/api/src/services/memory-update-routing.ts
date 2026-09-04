export interface MemoryUpdateState {
  content: string
  project: string
  sessionId: string | null
  category: string
  entities: string[]
}

export interface MemoryUpdateRequest {
  content?: string
  project?: string
  sessionId?: string | null
  category?: string
  entities?: string[]
}

export interface MemoryUpdateRoute {
  contentChanged: boolean
  projectChanged: boolean
  sessionChanged: boolean
  metadataChanged: boolean
  validationRequired: boolean
  hasChanges: boolean
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

/**
 * Classify only durable field changes. Merely supplying a field is not a change:
 * exact content, the current project/session, and identical category/entities
 * stay on the zero-model-call path.
 */
export function classifyMemoryUpdate(
  existing: MemoryUpdateState,
  request: MemoryUpdateRequest,
): MemoryUpdateRoute {
  const contentChanged = request.content !== undefined && request.content !== existing.content
  const projectChanged = request.project !== undefined && request.project !== existing.project
  const sessionChanged = request.sessionId !== undefined && request.sessionId !== existing.sessionId
  const categoryChanged = request.category !== undefined && request.category !== existing.category
  const entitiesChanged = request.entities !== undefined && !sameStrings(request.entities, existing.entities)
  const metadataChanged = categoryChanged || entitiesChanged
  return {
    contentChanged,
    projectChanged,
    sessionChanged,
    metadataChanged,
    validationRequired: contentChanged || metadataChanged,
    hasChanges: contentChanged || projectChanged || sessionChanged || metadataChanged,
  }
}
