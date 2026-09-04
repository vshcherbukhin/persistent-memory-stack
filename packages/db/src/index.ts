/**
 * @pm/db — public surface of the persistent-memory data layer.
 *
 * This barrel is the encapsulation boundary: api AND worker import the two
 * clients, the runInTenant() RLS wrapper, the tenant context, AND the generated
 * Prisma enums/model types FROM HERE — never reaching into generated/prisma
 * directly. (verbatimModuleSyntax is on, so type re-exports use `export type`
 * and the `Prisma` value uses a plain `export`.)
 */
export {
  prisma,
  ownerPrisma,
  guardedPrisma,
  makeDbClients,
  initDb,
} from './prisma.ts'
export type { DbConfig } from './config.ts'
export {
  tenantStore,
  getCtx,
  runInTenant,
} from './tenant-context.ts'
export type { TenantCtx, Tx, TenantRunOpts } from './tenant-context.ts'
export {
  recordUsage,
  recordUsageFireAndForget,
  currentHourBucket,
} from './usage.ts'
export type { UsageEvent } from './usage.ts'

// Re-export the generated enums + model types callers need, so api/worker import
// them from '@pm/db' and NEVER reach into generated/prisma.
export type {
  AdminLevel,
  EmbeddingStatus,
  EmbeddingMode,
  IngestStatus,
  GraphStatus,
  SourceKind,
  MemoryShape,
  AppUser,
  Team,
  TeamGrant,
  SystemSettings,
  ModelUsageRollup,
  ScheduledJob,
  Source,
  Document,
  Chunk,
  IngestJob,
  Memory,
} from '../../../generated/prisma/client.ts'
export { Prisma } from '../../../generated/prisma/client.ts'
