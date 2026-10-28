import type { FastifyInstance, FastifyRequest } from 'fastify'
import { embeddingMode, activePin, embedder } from './embedding.ts'
import { EmbeddingsNotReadyError, ollamaReadiness } from './ollama-readiness.ts'

export type MemoryOperation = 'read' | 'write' | 'update'
export type MemoryActivityState = 'idle' | 'active' | 'success' | 'error' | 'starting'
type Activity = { active: number; state: MemoryActivityState; lastCompletedAt: string | null }
type Identity = { userId: string; teamId: string | null }
const kinds = ['read', 'write', 'update'] as const

/** Route templates only: never store query text, IDs, memory content or credentials. */
export function memoryOperation(method: string, route: string): MemoryOperation | null {
  const path = route.replace(/^\/(dashboard|admin)(?=\/)/, '')
  if (!/^\/(memories|memory-graph|graph|documents|ingest)(\/|$)/.test(path)) return null
  if (path === '/memories/pending-embeddings' || path.endsWith('/embedding')) return null // internal projection work
  if (method === 'GET' || (method === 'POST' && /\/(search|search-by-entities|bulk-delete-preview|export)$/.test(path))) return 'read'
  if (method === 'POST' && path === '/memories/graph/rebuild') return 'update'
  if (method === 'PATCH' || method === 'PUT' || method === 'DELETE') return 'update'
  return method === 'POST' ? 'write' : null
}

export function createMemoryActivity(now = Date.now) {
  const owners = new Map<string, { updated: number; values: Record<MemoryOperation, Activity> }>()
  const key = (owner: Identity) => JSON.stringify([owner.teamId, owner.userId])
  function entry(owner: Identity) {
    const ownerKey = key(owner)
    let value = owners.get(ownerKey)
    if (!value) {
      for (const [id, item] of owners) if (now() - item.updated > 30 * 60_000 && kinds.every(kind => item.values[kind].active === 0)) owners.delete(id)
      // Bound diagnostic memory independently of the corpus size.
      if (owners.size >= 256) owners.delete(owners.keys().next().value!)
      value = { updated: now(), values: Object.fromEntries(kinds.map(kind => [kind, { active: 0, state: 'idle', lastCompletedAt: null }])) as Record<MemoryOperation, Activity> }
      owners.set(ownerKey, value)
    }
    return value
  }
  return {
    begin(owner: Identity, kind: MemoryOperation) {
      const ownerEntry = entry(owner)
      const item = ownerEntry.values[kind]
      ownerEntry.updated = now()
      item.active++
      let finished = false
      return (outcome: 'success' | 'error' | 'starting') => {
        if (finished) return
        finished = true
        item.active = Math.max(0, item.active - 1)
        item.state = outcome
        item.lastCompletedAt = new Date(now()).toISOString()
        ownerEntry.updated = now()
      }
    },
    snapshot(owner: Identity): Record<MemoryOperation, Activity> {
      const values = entry(owner).values
      return Object.fromEntries(kinds.map(kind => {
        const item = values[kind]
        const recent = item.lastCompletedAt && now() - Date.parse(item.lastCompletedAt) < 8_000
        return [kind, { ...item, state: item.active > 0 ? 'active' : recent ? item.state : 'idle' }]
      })) as Record<MemoryOperation, Activity>
    },
  }
}

export const memoryActivity = createMemoryActivity()

export async function assertMemoryEmbeddingsReady(): Promise<void> {
  // Remote providers and client bridges retain their existing behavior.
  if (embeddingMode !== 'server' || embedder?.provider !== 'ollama') return
  const readiness = await ollamaReadiness.inspect({ model: activePin.modelId, dim: activePin.dim })
  if (readiness.state !== 'ready') throw new EmbeddingsNotReadyError(readiness)
}

/** After authentication; fail before parsing/uploads, validation, provider calls or writes. */
export function registerMemoryRuntime(app: FastifyInstance, ensureReady = assertMemoryEmbeddingsReady, activity = memoryActivity) {
  const requests = new WeakMap<FastifyRequest, { finish: ReturnType<typeof activity.begin>; starting: boolean }>()
  app.addHook('onRequest', async (req, reply) => {
    const kind = memoryOperation(req.method, req.routeOptions.url ?? '')
    if (!kind || !req.identity) return
    const request = { finish: activity.begin(req.identity, kind), starting: false }
    requests.set(req, request)
    // A completed request body can be followed by a caller disconnect while the
    // handler is running. That response close is neither onRequestAbort nor
    // Fastify onResponse. Finish is idempotent across all lifecycle events.
    reply.raw.once('close', () => { if (!reply.raw.writableFinished) request.finish('error') })
    reply.raw.once('error', () => request.finish('error'))
    try { await ensureReady() } catch (error) {
      request.starting = error instanceof EmbeddingsNotReadyError && error.readiness.state === 'starting'
      throw error
    }
  })
  app.addHook('onResponse', async (req, reply) => requests.get(req)?.finish(requests.get(req)?.starting ? 'starting' : reply.statusCode < 400 ? 'success' : 'error'))
  app.addHook('onRequestAbort', async req => requests.get(req)?.finish('error'))
}
