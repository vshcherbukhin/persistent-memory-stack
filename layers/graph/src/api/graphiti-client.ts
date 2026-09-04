/**
 * persistent-memory-api — typed Graphiti HTTP client (Phase 7).
 *
 * The ONLY place that talks to GRAPHITI_URL on the read path. Graphiti does ZERO
 * auth and TRUSTS the group_ids it's handed, so the API is the sole choke-point:
 * every method here is called by a /graph/* route that derives group_ids from
 * req.identity.readableTeamIds — never from the request body/query.
 *
 * Wire conventions (verified against apps/graphiti-service/main.py + models.py):
 *   • POST /search        — group_ids is a JSON array in the body.
 *   • GET  /timeline      — group_ids is a REPEATED query key (FastAPI list[str]).
 *   • GET  /contradictions— same repeated-key convention.
 * Non-2xx → GraphitiError(status, detail) → the app.ts handler maps it to a
 * 502 graph_backend_error. AbortSignal.timeout bounds every call.
 *
 * GraphitiFactEdge mirrors models.py FactEdge, dropping expired_at/fact_embedding
 * (system-time + the large float array — noise on the API boundary).
 */
/** Mirrors graphiti-service models.py FactEdge (drops expired_at/fact_embedding). */
export interface GraphitiFactEdge {
  uuid: string
  name: string | null
  fact: string | null
  source_node_uuid: string | null
  target_node_uuid: string | null
  source_name: string | null
  target_name: string | null
  group_id: string | null
  created_at: string | null
  valid_at: string | null
  invalid_at: string | null
}

export interface GraphitiTimelineEntry extends GraphitiFactEdge {
  status: 'valid' | 'invalid'
}

export interface GraphitiContradiction {
  superseded: GraphitiFactEdge
  superseded_by: GraphitiFactEdge | null
}

export interface GraphitiSearchResponse {
  facts: GraphitiFactEdge[]
}
export interface GraphitiTimelineResponse {
  entity_uuid: string | null
  entries: GraphitiTimelineEntry[]
  next_after_at: string | null
  next_after_uuid: string | null
}
export interface GraphitiContradictionsResponse {
  contradictions: GraphitiContradiction[]
}

/** Non-2xx from Graphiti → mapped to 502 graph_backend_error in app.ts. */
export class GraphitiError extends Error {
  override readonly name = 'GraphitiError'
  readonly code = 'graph_backend_error' as const
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`graphiti ${status}: ${detail}`)
  }
}

export interface SearchArgs {
  query: string
  groupIds: string[] // = readableTeamIds (server-derived)
  limit?: number
  centerNodeUuid?: string
  validOnly?: boolean
}

export interface TimelineArgs {
  groupIds: string[]
  entityUuid?: string
  includeInvalid?: boolean
  limit?: number
  afterAt?: string
  afterUuid?: string
}

export interface ContradictionsArgs {
  groupIds: string[]
  entityUuid?: string
  limit?: number
}

export interface PostEpisodeArgs {
  groupId: string // = team_id (single-team write; writes never cross teams)
  name: string
  episodeBody: string
  referenceTime: Date
  idempotencyKey?: string
  telemetry?: GraphTelemetryContext
}

export interface GraphTelemetryContext {
  operationId: string
  subjectKind: 'memory' | 'document'
  subjectId: string
  teamId: string
  project: string
  graphGroupId: string
  stage: string
}

export interface EpisodeImpact {
  episode_uuid: string
  exists: boolean
  primary_fact_count: number
  supporting_fact_count: number
  primary_facts: Array<{ edge_uuid: string | null; fact: string | null; source_name: string | null; target_name: string | null }>
}

export interface PurgeGroupResult {
  episodes: number
  facts: number
}

export class GraphitiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
  ) {}

  /**
   * POST /episodes — best-effort agent-memory episode (group_id = teamId).
   * Single-team write; the CALLER wraps this in try/catch so a 502 never fails
   * the memory write. Mirrors the worker's postEpisode step.
   *
   * Do not send `uuid` here: graphiti-core 0.29.2 treats uuid as an existing
   * episode lookup, not as a create/upsert id, and returns "node ... not found"
   * for a new memory.
   */
  async postEpisode(p: PostEpisodeArgs): Promise<string> {
    const body = await this.postJson<{ episode_uuid: string }>('/episodes', {
      group_id: p.groupId,
      name: p.name,
      episode_body: p.episodeBody,
      source: 'text',
      reference_time: p.referenceTime.toISOString(),
      ...(p.idempotencyKey ? { idempotency_key: p.idempotencyKey } : {}),
    }, p.telemetry ? { 'x-pm-graph-telemetry': JSON.stringify(p.telemetry) } : undefined)
    return body.episode_uuid
  }

  /** Remove one persisted Graphiti episode through provenance-aware removal. */
  async removeEpisode(p: { groupId: string; episodeId: string }): Promise<number> {
    const body = await this.delJson<{ deleted: number }>('/episodes', {
      group_id: p.groupId,
      episode_uuid: p.episodeId,
    })
    return body.deleted
  }

  /** Read the current Graphiti provenance impact for bounded same-group episodes. */
  async episodeImpact(p: { groupId: string; episodeIds: string[] }): Promise<EpisodeImpact[]> {
    const body = await this.postJson<{ impacts: EpisodeImpact[] }>('/episodes/impact', {
      group_id: p.groupId,
      episode_uuids: p.episodeIds,
    })
    return body.impacts
  }

  /** Installer-only cleanup of a validated, unread legacy partition. */
  async purgeGroup(p: { groupId: string }): Promise<PurgeGroupResult> {
    return this.delJson<PurgeGroupResult>('/groups', { group_id: p.groupId })
  }

  /**
   * Temporary compatibility for pre-v2 writers without episode provenance.
   * New Graph v2 lifecycle code must call removeEpisode instead.
   */
  async deleteEpisode(p: { groupId: string; name: string }): Promise<number> {
    const body = await this.delJson<{ deleted: number }>('/episodes', {
      group_id: p.groupId,
      name: p.name,
    })
    return body.deleted
  }

  /** POST /search — group_ids in the JSON body (native multi-group fan-out). */
  async search(args: SearchArgs): Promise<GraphitiSearchResponse> {
    return this.postJson<GraphitiSearchResponse>('/search', {
      query: args.query,
      group_ids: args.groupIds,
      limit: args.limit ?? 10,
      center_node_uuid: args.centerNodeUuid ?? null,
      valid_only: args.validOnly ?? false,
    })
  }

  /** GET /timeline — group_ids as repeated query keys (FastAPI list[str]). */
  async timeline(args: TimelineArgs): Promise<GraphitiTimelineResponse> {
    const qs = new URLSearchParams()
    for (const g of args.groupIds) qs.append('group_ids', g)
    if (args.entityUuid) qs.set('entity_uuid', args.entityUuid)
    if (args.includeInvalid !== undefined) {
      qs.set('include_invalid', String(args.includeInvalid))
    }
    if (args.limit !== undefined) qs.set('limit', String(args.limit))
    if (args.afterAt) qs.set('after_at', args.afterAt)
    if (args.afterUuid) qs.set('after_uuid', args.afterUuid)
    return this.getJson<GraphitiTimelineResponse>(`/timeline?${qs.toString()}`)
  }

  /** GET /contradictions — same repeated-key convention. */
  async contradictions(args: ContradictionsArgs): Promise<GraphitiContradictionsResponse> {
    const qs = new URLSearchParams()
    for (const g of args.groupIds) qs.append('group_ids', g)
    if (args.entityUuid) qs.set('entity_uuid', args.entityUuid)
    if (args.limit !== undefined) qs.set('limit', String(args.limit))
    return this.getJson<GraphitiContradictionsResponse>(`/contradictions?${qs.toString()}`)
  }

  private async postJson<T>(path: string, body: unknown, extraHeaders?: Record<string, string>): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...extraHeaders },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    if (!res.ok) throw new GraphitiError(res.status, await res.text())
    return (await res.json()) as T
  }

  private async getJson<T>(path: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    if (!res.ok) throw new GraphitiError(res.status, await res.text())
    return (await res.json()) as T
  }

  private async delJson<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    })
    if (!res.ok) throw new GraphitiError(res.status, await res.text())
    return (await res.json()) as T
  }
}
