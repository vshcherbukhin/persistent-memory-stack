/**
 * @pm/shared/storage — object-key scheme.
 *
 * Team-first (mirrors the Qdrant team_id payload boundary): the team segment
 * leads so a future bucket-policy / prefix-scope per team is trivial. The key is
 * always derived from the SERVER-STAMPED teamId (from identity at the api), never
 * from client input — same discipline as the Qdrant payload stamp.
 *
 *   originals:  team/<teamId>/<project>/<sourceId>/original/<safeFilename>
 *   artifacts:  team/<teamId>/<project>/<sourceId>/extracted/<safeName>
 */

/** Collapse path-traversal + weird bytes to a safe single segment. */
const seg = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, '_')

export function originalKey(p: {
  teamId: string
  project: string
  sourceId: string
  filename: string
}): string {
  return `team/${p.teamId}/${seg(p.project)}/${p.sourceId}/original/${seg(p.filename)}`
}

export function artifactKey(p: {
  teamId: string
  project: string
  sourceId: string
  name: string
}): string {
  return `team/${p.teamId}/${seg(p.project)}/${p.sourceId}/extracted/${seg(p.name)}`
}

/**
 * The shared prefix for ALL of a source's objects (original + every artifact).
 * The P11 document DELETE sweeps this prefix to reclaim untracked artifacts.
 */
export function sourcePrefix(p: { teamId: string; project: string; sourceId: string }): string {
  return `team/${p.teamId}/${seg(p.project)}/${p.sourceId}/`
}
