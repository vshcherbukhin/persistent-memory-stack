/** Architecture guards for the v2 projection fence replacing inline legacy upserts. */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { KnowledgeUpdate, KnowledgeWrite } from '@pm/shared'
import { parseKnowledge } from '../src/services/knowledge.ts'
const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const canonical = source('../src/services/knowledge.ts')
const routes = source('../src/routes/knowledge.ts')
const archive = source('../src/routes/knowledge-archive.ts')
const merge = source('../src/services/merge.ts')
const worker = source('../../../apps/worker/src/steps/embed-backfill.ts')

describe('canonical v2 edits and vector freshness', () => {
  it('uses one strict write parser and the same revision-aware update for all API/dashboard aliases', () => {
    expect(routes).toContain("for (const prefix of ['', '/dashboard', '/admin'])")
    expect(routes).toContain('updateKnowledge(req.params.id, req.body)')
    expect(canonical).toContain('parseKnowledge(KnowledgeUpdate, raw)')
    expect(canonical).toContain('parseKnowledge(KnowledgeWrite, raw)')
  })
  it('rejects an old content-only edit before touching storage', () => {
    expect(() => parseKnowledge(KnowledgeUpdate, { content: 'Old content-only edits cannot silently bypass the new write contract.' })).toThrow('Community memory contract v2')
  })
  it('rejects a shape-only new write before touching storage', () => {
    expect(() => parseKnowledge(KnowledgeWrite, { content: 'An old shape payload cannot supply missing certainty or evidence.', project: 'alpha', metadata: { category: 'fix' } })).toThrow('Community memory contract v2')
  })
  it('increments the accepted revision and invalidates both derived projections on an update', () => {
    expect(canonical).toContain('revision: { increment: 1 }')
    expect(canonical).toContain("embeddingStatus: 'pending', graphStatus: 'pending'")
    expect(canonical).toContain('revision: input.expectedRevision, deletedAt: null')
    expect(canonical).toContain("throw new KnowledgeError('revision_conflict'")
  })
  it('serves semantic candidates only for the current searchable revision', () => {
    expect(merge).toContain("row.embeddingStatus === 'embedded'")
    expect(merge).toContain('hit.revision === row.revision')
    expect(merge).toContain("row.revision === 1 && row.knowledge === null")
  })
  it('fences worker completion against a changed/deleted record after embedding', () => {
    expect(worker).toContain("ownershipState: 'personal', deletedAt: null")
    expect(worker).toContain('revision: rows.find(row => row.id === id)?.revision')
    expect(worker).toContain("deletedAt: null, embeddingStatus: 'pending'")
  })
})

describe('historical archive conversion is not an update bypass', () => {
  it('requires an explicit versioned archive and ownership confirmation', () => {
    expect(archive).toContain("schema:z.enum(['pm.memory-export/1','pm.memory-export/2'])")
    expect(archive).toContain('ownerConfirmation:z.literal(true)')
  })
  it('rejects existing-ID overwrite and keeps both row history and accepted revision', () => {
    expect(archive).toContain("'archive_revision_conflict'")
    expect(archive).toContain('revision:record.revision??1')
    expect(archive).toContain('record.revisionHistory??[]')
    expect(archive).toContain('tx.memoryRevision.create')
  })
  it('does not infer ownership from exported project or foreign author identifiers', () => {
    expect(archive).toContain('record.createdById===ctx.userId')
    expect(archive).toContain('record.teamId===ctx.teamId')
    expect(archive).toContain('tx.memoryImportQuarantine.create')
    expect(archive).toContain('payload:json(record)')
    expect(archive).toContain('metadata:record.metadata==null?Prisma.DbNull:json(record.metadata)')
  })
  it('returns bounded row-level errors instead of exposing failed raw memory content', () => {
    expect(archive).toContain('if(details.length<100)')
    expect(archive).toContain("stage:'validation'")
    expect(archive).toContain('no partial row was accepted')
  })
})
