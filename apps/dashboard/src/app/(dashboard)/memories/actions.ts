'use server'

import { api, ApiError, normalizeMemorySurface } from '@/lib/api'
import { requireSession, requireControlPlane, isSuperuser } from '@/lib/session'
import { canAccessControlPlane } from '@/lib/authz'
import type { MemoryUpdateActionResult } from '@/lib/memoryUpdateResult'
import type { Memory, MemoryExportEnvelope, MemoryGraphRebuildResult, MemoryImportResult, PendingEmbeddings, MemorySurface, GraphDeletePreview, BulkGraphDeletePreview, MemoryGraphActivityResult, MemoryGraphFacets, MemoryGraphFilters, MemoryGraphSnapshot } from '@/lib/types'

export interface MemoryListResult {
  rows: Memory[]
  total: number
  nextCursor: string | null
  badges: string[]
}

export async function getMemoryGraphSnapshotAction(
  filters: MemoryGraphFilters,
  cursor: string | undefined,
  surfaceInput?: MemorySurface,
): Promise<MemoryGraphSnapshot> {
  const surface = normalizeMemorySurface(surfaceInput)
  await requireSession()
  // Use the API's bounded maxima so a full overview does not require one
  // server-action round trip per 100 memories or 250 facts.
  return api.getMemoryGraphSnapshot({ ...filters, cursor, memoryLimit: 200, factLimit: 500 }, surface)
}

export async function getMemoryGraphFacetsAction(
  search: string | undefined,
  facet: 'projects' | 'tags' | 'badges' | undefined,
  surfaceInput?: MemorySurface,
): Promise<MemoryGraphFacets> {
  const surface = normalizeMemorySurface(surfaceInput)
  await requireSession()
  return api.getMemoryGraphFacets({ search, facet, recent: search ? 30 : 12 }, surface)
}

export async function getMemoryGraphActivityAction(
  filters: MemoryGraphFilters,
  cursor: string | undefined,
  surfaceInput?: MemorySurface,
): Promise<MemoryGraphActivityResult> {
  const surface = normalizeMemorySurface(surfaceInput)
  await requireSession()
  return api.getMemoryGraphActivity({ ...filters, cursor }, surface)
}

/**
 * Memory server actions — ROLE-AWARE. An admin/superuser uses the elevated
 * dashboard plane (/dashboard/memories/*, cross-team per role); a plain member uses
 * the data plane (/memories/*, own-created edit/delete, universal read). The api
 * is the authoritative gate; choosing the endpoint by role here just routes to
 * the right surface (a member calling /dashboard/* would 403).
 */
async function role(surfaceInput?: MemorySurface): Promise<{ admin: boolean }> {
  const surface = normalizeMemorySurface(surfaceInput)
  const localWho = await requireSession()
  const who = surface === 'shared' ? await api.memoryWhoami(surface) : localWho
  return { admin: canAccessControlPlane(who.adminLevel) }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function stripTeamFieldsFromMemoryRows(memories: unknown[]): unknown[] {
  return memories.map((memory) => {
    if (!isRecord(memory)) return memory
    const { teamId: _teamId, ...rest } = memory
    return rest
  })
}

function stripTeamFieldsFromPersonalExport(envelope: MemoryExportEnvelope): MemoryExportEnvelope {
  const exportOptions = envelope.exportOptions
    ? (({ teamId: _teamId, teamName: _teamName, ...rest }) => rest)(envelope.exportOptions)
    : undefined
  const filters = envelope.filters
    ? (({ teamId: _teamId, ...rest }) => rest)(envelope.filters)
    : undefined
  return {
    ...envelope,
    ...(exportOptions ? { exportOptions } : {}),
    ...(filters ? { filters } : {}),
    memories: stripTeamFieldsFromMemoryRows(envelope.memories),
  }
}

export async function listMemoriesAction(filters: {
  teamId?: string
  project?: string
  category?: string
  cursor?: string
  limit?: number
  scoreMin?: number
  scoreMax?: number
}, surfaceInput?: MemorySurface): Promise<MemoryListResult> {
  const surface = normalizeMemorySurface(surfaceInput)
  const { admin } = await role(surface)
  if (admin) {
    const res = await api.listMemories({ ...filters, limit: filters.limit ?? 50 }, surface)
    return { rows: res.results, total: res.total, nextCursor: res.nextCursor, badges: res.badges }
  }
  const res = await api.dpListMemories({
    project: filters.project,
    category: filters.category,
    cursor: filters.cursor,
    limit: filters.limit ?? 50,
    scoreMin: filters.scoreMin,
    scoreMax: filters.scoreMax,
  }, surface)
  return { rows: res.results, total: res.total, nextCursor: res.nextCursor, badges: res.badges }
}

export async function searchMemoriesAction(
  query: string,
  teamId?: string,
  project?: string,
  category?: string,
  scoreMin?: number,
  scoreMax?: number,
  surfaceInput?: MemorySurface,
): Promise<MemoryListResult> {
  const surface = normalizeMemorySurface(surfaceInput)
  const { admin } = await role(surface)
  if (admin) {
    const res = await api.searchMemories({ query, teamId, project, category, scoreMin, scoreMax, limit: 50 }, surface)
    return { rows: res.results, total: res.total, nextCursor: null, badges: [] }
  }
  const res = await api.dpSearchMemories({ query, project, category, scoreMin, scoreMax, limit: 50 }, surface)
  return { rows: res.results, total: res.results.length, nextCursor: null, badges: [] }
}

export async function updateMemoryAction(input: {
  id: string
  content?: string
  project?: string
  category?: string
  surface?: MemorySurface
}): Promise<MemoryUpdateActionResult> {
  const surface = normalizeMemorySurface(input.surface)
  const { admin } = await role(surface)
  try {
    if (admin) await api.updateMemory(input.id, { content: input.content, project: input.project, category: input.category }, surface)
    else await api.dpUpdateMemory(input.id, { content: input.content, project: input.project }, surface)
    return { ok: true }
  } catch (err) {
    // Expected API validation/conflict errors are data, not render failures. A
    // thrown Server Action error is intentionally masked by production Next.js.
    if (err instanceof ApiError) return { ok: false, error: err.message }
    throw err
  }
}

export async function previewMemoryDeleteAction(id: string, surfaceInput?: MemorySurface): Promise<GraphDeletePreview> {
  const surface = normalizeMemorySurface(surfaceInput)
  const { admin } = await role(surface)
  if (!admin) throw new Error('A dashboard graph-impact preview requires admin.')
  return api.previewMemoryDelete(id, surface)
}

export async function deleteMemoryAction(id: string, opts: { previewToken?: string } = {}, surfaceInput?: MemorySurface): Promise<void> {
  const surface = normalizeMemorySurface(surfaceInput)
  const { admin } = await role(surface)
  try {
    if (admin) {
      if (!opts.previewToken) throw new Error('Review the live graph impact before confirming deletion.')
      await api.deleteMemory(id, { previewToken: opts.previewToken }, surface)
    }
    else await api.dpDeleteMemory(id, surface)
  } catch (err) {
    if (err instanceof ApiError) throw new Error(err.message)
    throw err
  }
}

/** Bulk delete starts with a live, scope-bound graph impact preview for the caller's current team. */
export async function previewBulkDeleteAction(project?: string, surfaceInput?: MemorySurface): Promise<BulkGraphDeletePreview> {
  const surface = normalizeMemorySurface(surfaceInput)
  try {
    return await api.dpPreviewBulkDeleteMemories(project, surface)
  } catch (err) {
    if (err instanceof ApiError) throw new Error(err.message)
    throw err
  }
}

/** Consume a single-use bulk-delete preview. The API rechecks every selected row and graph episode. */
export async function bulkDeleteAction(input: { previewToken: string; surface?: MemorySurface }): Promise<number> {
  const surface = normalizeMemorySurface(input.surface)
  try {
    return (await api.dpConfirmBulkDeleteMemories(input.previewToken, surface)).deleted
  } catch (err) {
    if (err instanceof ApiError) throw new Error(err.message)
    throw err
  }
}

/** Pending-embedding counts (admin+). The embed-backfill consumer drains these. */
export async function pendingEmbeddingsAction(surfaceInput?: MemorySurface): Promise<PendingEmbeddings | null> {
  const surface = normalizeMemorySurface(surfaceInput)
  const { admin } = await role(surface)
  if (!admin) return null
  try {
    return await api.pendingEmbeddings(surface)
  } catch (err) {
    if (err instanceof ApiError) return null
    throw err
  }
}

/** Force-run the embed-backfill now (superuser) — reuses the P5 worker control plane. */
export async function runBackfillAction(): Promise<{ ok: boolean; error?: string }> {
  const who = await requireControlPlane()
  if (!isSuperuser(who)) return { ok: false, error: 'Only a superuser may run the backfill.' }
  try {
    await api.workerAction('embed-backfill', 'run-now')
    return { ok: true }
  } catch (err) {
    if (err instanceof ApiError) return { ok: false, error: err.message }
    throw err
  }
}

/** One-time Memory → Graphiti rebuild (admin+). The worker consumes the queued job. */
export async function rebuildMemoryGraphAction(input: {
  teamId?: string
  project?: string
  createdById?: string
  surface?: MemorySurface
}): Promise<MemoryGraphRebuildResult> {
  const surface = normalizeMemorySurface(input.surface)
  const { admin } = await role(surface)
  if (!admin) throw new Error('Graph rebuild requires admin.')
  try {
    const { surface: _surface, ...filters } = input
    return await api.rebuildMemoryGraph(surface === 'personal' ? { project: filters.project, createdById: filters.createdById } : filters, surface)
  } catch (err) {
    if (err instanceof ApiError) throw new Error(err.message)
    throw err
  }
}

/** Export (admin+ only). Returns the JSON envelope; the browser handles save/encryption. */
export async function exportMemoriesAction(input: { teamId?: string; project?: string; surface?: MemorySurface }): Promise<MemoryExportEnvelope> {
  const surface = normalizeMemorySurface(input.surface)
  const { admin } = await role(surface)
  if (!admin) throw new Error('Export requires admin.')
  try {
    const { surface: _surface, ...filters } = input
    const envelope = await api.exportMemories(surface === 'personal' ? { project: filters.project } : filters, surface)
    return surface === 'personal' ? stripTeamFieldsFromPersonalExport(envelope) : envelope
  } catch (err) {
    if (err instanceof ApiError) throw new Error(err.message)
    throw err
  }
}

/** Import (admin+ only). Accepts the export envelope's `memories` array. */
export async function importMemoriesAction(memories: unknown[], teamId?: string, project?: string, surfaceInput?: MemorySurface): Promise<MemoryImportResult> {
  const surface = normalizeMemorySurface(surfaceInput)
  const { admin } = await role(surface)
  if (!admin) throw new Error('Import requires admin.')
  try {
    const rows = surface === 'personal' ? stripTeamFieldsFromMemoryRows(memories) : memories
    return await api.importMemories(rows, surface === 'personal' ? undefined : teamId, project, surface)
  } catch (err) {
    if (err instanceof ApiError) throw new Error(err.message)
    throw err
  }
}
