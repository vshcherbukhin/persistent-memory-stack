import 'dotenv/config'
import { initDb } from '@pm/db'
import { config } from './config.ts'
import { inspectGraphV2Progress } from './steps/graph-v2-migration.ts'

initDb({ databaseUrl: config.DATABASE_URL, databaseMigrateUrl: config.DATABASE_MIGRATE_URL })
const progress = await inspectGraphV2Progress({
  groupSecret: config.GRAPH_GROUP_SECRET || config.TOKEN_PEPPER || 'local-development-graph-group-secret',
  surface: 'personal',
  snapshotId: 'updater-progress-probe',
  // This read-only CLI never touches Graphiti. Keep its dependency intentionally
  // unavailable so an accidental future call fails loudly at the type boundary.
  graphiti: {} as never,
})
console.log(JSON.stringify(progress))
