import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
}

const schema = source('../../../layers/core/schema/schema.prisma')
const migration = source('../../../layers/core/schema/migrations/0030_memory_record_updated_at/migration.sql')
const dataRoute = source('../src/routes/memories.ts')
const dashboardRoute = source('../src/routes/dashboard/memories.ts')
const mergeService = source('../src/services/merge.ts')

describe('user-visible memory timestamps', () => {
  it('adds, backfills, constrains, and indexes record_updated_at', () => {
    expect(schema).toContain('recordUpdatedAt DateTime @default(now()) @map("record_updated_at")')
    expect(schema).toContain('@@index([teamId, project, recordUpdatedAt])')
    expect(migration).toContain('ADD COLUMN "record_updated_at" TIMESTAMP(3)')
    expect(migration).toContain('SET "record_updated_at" = "updated_at"')
    expect(migration).toContain('ALTER COLUMN "record_updated_at" SET NOT NULL')
    expect(migration).toContain('memory_team_id_project_record_updated_at_idx')
  })

  it('returns the record timestamp across data, dashboard, and merged list DTOs', () => {
    for (const contract of [dataRoute, dashboardRoute, mergeService]) {
      expect(contract).toContain('recordUpdatedAt')
      expect(contract).toContain('recordUpdatedAt.toISOString()')
    }
  })

  it('advances the record timestamp only in explicit user edit routes', () => {
    expect(dataRoute).toMatch(/classifyMemoryUpdate[\s\S]*recordUpdatedAt: new Date\(\)/)
    expect(dashboardRoute).toMatch(/classifyMemoryUpdate[\s\S]*recordUpdatedAt: new Date\(\)/)
    expect(mergeService).not.toContain('recordUpdatedAt: new Date()')
  })
})
