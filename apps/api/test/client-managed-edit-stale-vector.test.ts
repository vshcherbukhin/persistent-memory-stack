/**
 * Stale-embedding sync on memory EDIT / IMPORT (#3b + the Phase-3 review gaps).
 *
 * Whenever a content change ends with embeddingStatus='pending' — client-managed
 * embeddings (no server embedder) OR a server-managed embed/upsert FAILURE — leaving the old Qdrant point
 * in place would let search serve a STALE vector for the new content. So every
 * such path MUST: (1) force embeddingStatus='pending', and (2) DELETE the existing
 * qdrantPointId from the memory_vectors collection. The P6 consumer re-embeds the
 * pending row later, recreating the SAME deterministic point id (#4) from the
 * rowId — so the round-trip is orphan-free.
 *
 * Covered paths:
 *   • data-plane PATCH /memories/:id   — client-managed + server-managed embed/upsert failure
 *   • admin    PATCH /dashboard/memories/:id — client-managed + server-managed embed failure
 *   • admin    POST  /dashboard/memories/import — client-managed/embed-fail re-import
 *
 * The handlers are deep inside route closures (full Fastify + Qdrant + RLS + the
 * Shape gate to exercise live), so this is a source-drift guard in the same spirit
 * as project-default.test.ts: it pins the stale-point branches in BOTH route files
 * so a regression that drops a delete or a pending-mark is caught.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const dataPlane = readFileSync(
  fileURLToPath(new URL('../src/routes/memories.ts', import.meta.url)),
  'utf8',
)
const adminPlane = readFileSync(
  fileURLToPath(new URL('../src/routes/dashboard/memories.ts', import.meta.url)),
  'utf8',
)

describe('data-plane PATCH /memories/:id — client-managed edit drops the stale point', () => {
  it('detects client-managed embeddings (content changed + no embedder) via dropStaleVectorClientManaged', () => {
    expect(dataPlane).toContain('const dropStaleVectorClientManaged = contentChanged && !embedder')
  })

  it('forces embeddingStatus=pending on a client-managed content edit', () => {
    expect(dataPlane).toContain("...(dropStaleVectorClientManaged ? { embeddingStatus: 'pending' as const } : {})")
  })

  it('deletes the existing qdrantPointId from memory_vectors on a client-managed / pending edit', () => {
    expect(dataPlane).toContain('(dropStaleVectorClientManaged || dropStaleVectorServerManagedFail) && existing.qdrantPointId')
    expect(dataPlane).toContain(".delete('memory_vectors', { points: [existing.qdrantPointId] })")
  })

  it('flags dropStaleVectorServerManagedFail when server-managed embed yields no vector or upsert throws', () => {
    // set in the no-vector else-branch AND in the upsert catch.
    expect(dataPlane).toContain('dropStaleVectorServerManagedFail = true')
  })

  it('carries qdrantPointId in MEM_SELECT so the purge can find the point', () => {
    expect(dataPlane).toMatch(/MEM_SELECT[\s\S]*qdrantPointId: true/)
  })
})

describe('admin PATCH /dashboard/memories/:id — client-managed / pending edit drops the stale point', () => {
  it('sets dropStalePoint when no embedder is buildable on a content change (client-managed embeddings)', () => {
    expect(adminPlane).toContain('dropStalePoint = true // client-managed embeddings (no embedder) → stale')
  })

  it('sets dropStalePoint on a server-managed embed failure (no vector OR threw)', () => {
    expect(adminPlane).toContain('if (!vector) dropStalePoint = true')
    expect(adminPlane).toContain('dropStalePoint = true // embed threw → stale')
  })

  it('deletes the existing qdrantPointId on a pending edit (else-branch of the re-upsert)', () => {
    expect(adminPlane).toContain('else if (dropStalePoint && existing.qdrantPointId)')
    expect(adminPlane).toContain(".delete('memory_vectors', { points: [existing.qdrantPointId] })")
  })
})

describe('admin POST /dashboard/memories/import — client-managed/embed-fail re-import drops the stale point', () => {
  it('captures the prior qdrantPointId only when there is no fresh vector', () => {
    expect(adminPlane).toContain('let stalePointId: string | null = null')
    expect(adminPlane).toContain('if (!vector) {')
    expect(adminPlane).toMatch(/findUnique\(\{\s*where: \{ id: rec\.id \},\s*select: \{ qdrantPointId: true \}/)
  })

  it('deletes the captured stale point in the no-vector branch of the import upsert', () => {
    expect(adminPlane).toContain('else if (stalePointId)')
    expect(adminPlane).toContain(".delete('memory_vectors', { points: [stalePointId] })")
  })
})

describe('admin POST /dashboard/memories/import — fresh-install restore remaps stale ids', () => {
  it('resolves the target team instead of blindly trusting the exported team id', () => {
    expect(adminPlane).toContain('resolveImportTeamId')
    expect(adminPlane).toContain('teamExists')
    expect(adminPlane).toContain('const targetTeam = await resolveImportTeamId')
  })

  it('remaps stale exported createdById values before creating rows', () => {
    expect(adminPlane).toContain('resolveImportCreatedById')
    expect(adminPlane).toContain('const importCreatedById = await resolveImportCreatedById')
    expect(adminPlane).toContain('createdById: importCreatedById')
    expect(adminPlane).not.toContain('createdById: rec.createdById ?? id.userId')
  })

  it('returns bounded row-level import error details for the dashboard card', () => {
    expect(adminPlane).toContain('MAX_IMPORT_ERROR_DETAILS')
    expect(adminPlane).toContain('const ImportErrorDetail = z.object')
    expect(adminPlane).toContain('details: z.array(ImportErrorDetail)')
    expect(adminPlane).toContain('recordError(rowIndex, rec.id')
  })
})
