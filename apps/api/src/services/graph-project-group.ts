import { deriveProjectGraphGroup, type GraphMemorySurface } from '@pm/graph'
import { config } from '../config.ts'

export function currentMemorySurface(): GraphMemorySurface {
  return 'personal'
}

export function graphProjectGroup(teamId: string, project: string): string {
  if (project === 'general' && currentMemorySurface() !== 'personal') {
    throw new Error('Project "general" is Personal Memories only and cannot be used on the Shared Memories surface.')
  }
  return deriveProjectGraphGroup({
    // Existing installations have TOKEN_PEPPER already. The literal fallback is
    // only for the no-secret local developer fixture and is never sent to users.
    // A separate derived namespace preserves old graphs without admitting mixed
    // historical/foreign episodes into personal recall. Rebuild is explicit.
    secret: `personal-knowledge-v2:${config.GRAPH_GROUP_SECRET || config.TOKEN_PEPPER || 'local-development-graph-group-secret'}`,
    teamId,
    project,
    surface: currentMemorySurface(),
  })
}
