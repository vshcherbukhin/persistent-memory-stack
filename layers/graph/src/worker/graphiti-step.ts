/**
 * Step 6 — POST /episodes to the Graphiti microservice (best-effort).
 *
 * group_id = teamId (single-team write; writes never cross teams). The CALLER
 * wraps this in its own try/catch — a 502 here logs but never fails
 * the job (per the task: best-effort).
 *
 * Do not send `uuid` for creates. graphiti-core 0.29.2 treats uuid as an
 * existing episode lookup, not as a create/upsert id.
 */
export interface WorkerGraphitiPostEpisodeArgs {
  groupId: string
  name: string
  episodeBody: string
  referenceTime: Date
  idempotencyKey?: string
  telemetry?: { operationId: string; subjectKind: 'memory' | 'document'; subjectId: string; teamId: string; project: string; graphGroupId: string; stage: string }
}

export async function postEpisode(
  graphitiUrl: string,
  timeoutMs: number,
  p: WorkerGraphitiPostEpisodeArgs,
): Promise<string> {
  const res = await fetch(`${graphitiUrl}/episodes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(p.telemetry ? { 'x-pm-graph-telemetry': JSON.stringify(p.telemetry) } : {}) },
    body: JSON.stringify({
      group_id: p.groupId, // = team_id (required, single-team)
      name: p.name,
      episode_body: p.episodeBody,
      source: 'text',
      reference_time: p.referenceTime.toISOString(),
      ...(p.idempotencyKey ? { idempotency_key: p.idempotencyKey } : {}),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`graphiti ${res.status}: ${await res.text()}`)
  const body = (await res.json()) as { episode_uuid: string }
  return body.episode_uuid
}

export async function deleteEpisode(
  graphitiUrl: string,
  timeoutMs: number,
  p: { groupId: string; name: string },
): Promise<number> {
  const res = await fetch(`${graphitiUrl}/episodes`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      group_id: p.groupId,
      name: p.name,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`graphiti ${res.status}: ${await res.text()}`)
  const body = (await res.json()) as { deleted: number }
  return body.deleted
}
