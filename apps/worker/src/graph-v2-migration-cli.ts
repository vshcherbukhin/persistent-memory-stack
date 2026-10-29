import 'dotenv/config'
import { initDb, prisma, ownerPrisma } from '@pm/db'
import { config } from './config.ts'
import { inspectCommunityGraphCompatibility } from './steps/community-graph-compatibility.ts'

const snapshotId = process.argv.find((value) => value.startsWith('--snapshot-id='))?.slice('--snapshot-id='.length)
if (!snapshotId) throw new Error('graph-v2 migration requires --snapshot-id=<updater-snapshot-id>.')

initDb({ databaseUrl: config.DATABASE_URL, databaseMigrateUrl: config.DATABASE_MIGRATE_URL })
// Retain the updater entrypoint, but retire the old corpus replay/purge engine.
// New classified writes use the ordinary bounded, revision-fenced projections.
try {
  const result = await inspectCommunityGraphCompatibility()
  console.log(`[community-graph-preservation] ${result.state}: ${JSON.stringify(result.metrics)}`)
} finally {
  await Promise.allSettled([prisma.$disconnect(),ownerPrisma.$disconnect()])
}
