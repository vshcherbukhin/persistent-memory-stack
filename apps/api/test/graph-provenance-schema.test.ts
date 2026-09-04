import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const schema = readFileSync(resolve(import.meta.dirname, '../../../layers/core/schema/schema.prisma'), 'utf8')
const migration = readFileSync(
  resolve(import.meta.dirname, '../../../layers/core/schema/migrations/0025_graph_v2_provenance/migration.sql'),
  'utf8',
)
const graphVersionMigration = readFileSync(
  resolve(import.meta.dirname, '../../../layers/core/schema/migrations/0029_memory_graph_version/migration.sql'),
  'utf8',
)
const rls = readFileSync(resolve(import.meta.dirname, '../../../layers/core/schema/rls.sql'), 'utf8')

describe('graph provenance schema', () => {
  it('keeps the exact graph group and episode UUID on each graph-backed memory', () => {
    expect(schema).toMatch(/model Memory \{[\s\S]*graphGroupId\s+String\?\s+@map\("graph_group_id"\)[\s\S]*graphEpisodeId\s+String\?\s+@map\("graph_episode_id"\)/)
  })

  it('uses a graph-only optimistic version and backfills it safely for existing rows', () => {
    expect(schema).toMatch(/graphVersion\s+DateTime\s+@default\(now\(\)\)\s+@map\("graph_version"\)/)
    expect(graphVersionMigration).toContain('SET "graph_version" = "updated_at"')
    expect(graphVersionMigration).toContain('ALTER COLUMN "graph_version" SET NOT NULL')
  })

  it('has durable graph lifecycle and migration run records instead of best-effort-only deletion', () => {
    expect(schema).toContain('model GraphLifecycleOperation')
    expect(schema).toContain('model GraphEpisodeProvenance')
    expect(schema).toContain('model GraphDeletePreview')
    expect(schema).toContain('model GraphMigrationRun')
    expect(schema).toContain('enum GraphLifecycleOperationKind')
    expect(schema).toContain('enum GraphLifecycleStatus')
  })

  it('enforces that the general project is always Personal Memories', () => {
    expect(migration).toContain('CHECK ("project" <> \'general\' OR "surface" = \'personal\')')
  })

  it('keeps graph provenance and deletion previews in the RLS drift canary', () => {
    expect(rls).toContain('expects 15 rows')
    expect(rls).toContain("'graph_episode_provenance','graph_delete_preview'")
  })
})
