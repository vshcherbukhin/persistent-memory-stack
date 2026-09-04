import 'dotenv/config'
import { initDb } from '@pm/db'
import { GraphitiClient } from '@pm/graph'
import { config } from './config.ts'
import { GRAPH_V2_MIGRATION_VERSION, runGraphV2Migration } from './steps/graph-v2-migration.ts'

const snapshotId = process.argv.find((value) => value.startsWith('--snapshot-id='))?.slice('--snapshot-id='.length)
if (!snapshotId) throw new Error('graph-v2 migration requires --snapshot-id=<updater-snapshot-id>.')

initDb({ databaseUrl: config.DATABASE_URL, databaseMigrateUrl: config.DATABASE_MIGRATE_URL })
const result = await runGraphV2Migration({
  graphiti: new GraphitiClient(config.GRAPHITI_URL, config.GRAPHITI_TIMEOUT_MS),
  groupSecret: config.GRAPH_GROUP_SECRET || config.TOKEN_PEPPER || 'local-development-graph-group-secret',
  surface: config.MEMORY_SURFACE ?? (config.DEPLOYMENT_MODE === 'local' ? 'personal' : 'shared'),
  snapshotId,
})
console.log(`[${GRAPH_V2_MIGRATION_VERSION}] ${result.state}: ${JSON.stringify(result.metrics)}`)
