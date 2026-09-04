import { describe, expect, it } from 'vitest'
import { deriveProjectGraphGroup } from '@pm/graph'
import {
  GRAPH_V2_MIGRATION_VERSION,
  isGraphV2Complete,
  legacyGraphGroupsForRows,
  nextGraphMigrationState,
  shouldRetryGraphMigrationRebuild,
  validateGraphMigration,
  type GraphMigrationValidation,
} from '../src/steps/graph-v2-migration.ts'

describe('Graph V2 installer migration', () => {
  it('advances only through the durable rebuild, validation, cleanup lifecycle', () => {
    expect(GRAPH_V2_MIGRATION_VERSION).toMatch(/^graph-v2-project-partitions-/)
    expect(nextGraphMigrationState('snapshot_confirmed', true)).toBe('v2_rebuild_running')
    expect(nextGraphMigrationState('v2_rebuild_running', true)).toBe('v2_rebuild_validating')
    expect(nextGraphMigrationState('v2_rebuild_validating', true)).toBe('legacy_cleanup_running')
    expect(nextGraphMigrationState('legacy_cleanup_running', true)).toBe('complete')
  })

  it('blocks legacy cleanup until every live row has v2 provenance and deletion probes are clean', () => {
    const invalid: GraphMigrationValidation = {
      memories: { total: 3, v2Complete: 2 },
      missingProvenance: 1,
      pendingRemovals: 0,
      deletedEpisodesStillPresent: 0,
      legacyGroups: 2,
    }
    expect(validateGraphMigration(invalid)).toEqual({
      ok: false,
      reasons: ['1 live memory row(s) have no v2 provenance.', '1 provenance record(s) are missing.'],
    })

    expect(validateGraphMigration({ ...invalid, memories: { total: 3, v2Complete: 3 }, missingProvenance: 0 })).toEqual({ ok: true, reasons: [] })
  })

  it('rescans when a concurrent live row or its provenance arrives after the first rebuild pass', () => {
    expect(shouldRetryGraphMigrationRebuild({
      memories: { total: 3, v2Complete: 2 },
      missingProvenance: 0,
      pendingRemovals: 0,
      deletedEpisodesStillPresent: 0,
      legacyGroups: 1,
    })).toBe(true)
    expect(shouldRetryGraphMigrationRebuild({
      memories: { total: 3, v2Complete: 3 },
      missingProvenance: 1,
      pendingRemovals: 0,
      deletedEpisodesStillPresent: 0,
      legacyGroups: 1,
    })).toBe(true)
    expect(shouldRetryGraphMigrationRebuild({
      memories: { total: 3, v2Complete: 3 },
      missingProvenance: 0,
      pendingRemovals: 1,
      deletedEpisodesStillPresent: 0,
      legacyGroups: 1,
    })).toBe(false)
  })

  it('retains the team-wide legacy group across a restart after a row was already stamped v2', () => {
    expect(legacyGraphGroupsForRows([
      { teamId: 'team-a', graphGroupId: 'pmg2_project_partition' },
      { teamId: 'team-b', graphGroupId: 'team-b' },
    ])).toEqual(['team-a', 'team-b'])
  })

  it('counts progress only when the persisted pointer matches the derived V2 partition', () => {
    const deps = { groupSecret: 'test-secret', surface: 'personal' as const, snapshotId: 'snapshot', graphiti: {} as never }
    expect(isGraphV2Complete({
      teamId: 'team-a', project: 'alpha', graphStatus: 'ok', graphGroupId: 'team-a', graphEpisodeId: 'episode-v1',
    }, deps)).toBe(false)
    const v2Group = deriveProjectGraphGroup({ secret: deps.groupSecret, teamId: 'team-a', project: 'alpha', surface: deps.surface })
    expect(isGraphV2Complete({
      teamId: 'team-a', project: 'alpha', graphStatus: 'ok', graphGroupId: v2Group, graphEpisodeId: 'episode-v2',
    }, deps)).toBe(true)
  })
})
