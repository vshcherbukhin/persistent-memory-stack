import 'dotenv/config'
import { initDb, prisma, ownerPrisma } from '@pm/db'
import { config } from './config.ts'
import { inspectCommunityGraphCompatibility } from './steps/community-graph-compatibility.ts'

initDb({ databaseUrl: config.DATABASE_URL, databaseMigrateUrl: config.DATABASE_MIGRATE_URL })
try {
  const result = await inspectCommunityGraphCompatibility()
  console.log(JSON.stringify({completed:result.metrics.personalMemories,total:result.metrics.personalMemories,state:result.state}))
} finally {
  await Promise.allSettled([prisma.$disconnect(),ownerPrisma.$disconnect()])
}
