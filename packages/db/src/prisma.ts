/**
 * @pm/db — Prisma clients (Phase 3, extracted to @pm/db in Phase 6).
 *
 * TWO clients, one job each (the connection-role split is the RLS spine):
 *
 *   • prisma       — databaseUrl → pm_app (NOSUPERUSER / NOBYPASSRLS).
 *                    The RLS-SUBJECT. ALL data-plane work goes through this,
 *                    ALWAYS inside runInTenant() (see tenant-context.ts) so
 *                    the per-request GUCs (app.team_id / app.granted_team_ids)
 *                    are set on the same connection as the queries.
 *
 *   • ownerPrisma  — databaseMigrateUrl → pmuser (table OWNER, bypasses
 *                    FORCE'd RLS). The CONTROL plane ONLY: app_user / team /
 *                    team_grant. rls.sql deliberately grants pm_app NO access to
 *                    those tables, so token verify + readableTeams MUST use this
 *                    client. NEVER touch data tables with ownerPrisma — that
 *                    would silently defeat RLS isolation.
 *
 * The audit-guarded data client (guardedPrisma) is exported for handlers that
 * want a belt-and-suspenders throw if a data-model op escapes runInTenant. It
 * CANNOT set the GUCs itself — a Prisma 7 query extension has no tx handle and
 * runs on a pooled connection, so any set_config there lands on the wrong
 * connection (confirmed gotcha). The real GUC-setting lives in runInTenant.
 *
 * CONFIG INJECTION (Phase 6): @pm/db imports NO app config module. Each app
 * (api, worker) calls initDb({ databaseUrl, databaseMigrateUrl }) ONCE at boot
 * from its own validated config. The module-level `prisma`/`ownerPrisma`/
 * `guardedPrisma` are live-binding `let`s assigned by initDb — ESM live bindings
 * make the assignment visible to all importers after init runs. runInTenant
 * reads `prisma` at CALL time (inside its async body), so the binding resolves
 * after init. Touching any of the three before initDb() throws a clear error.
 */
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '../../../generated/prisma/client.ts'
import type { DbConfig } from './config.ts'
import { tenantStore } from './tenant-context.ts'

/** The audit-guarded client type (prisma.$extends return). */
type GuardedPrisma = ReturnType<PrismaClient['$extends']>

// Live-binding singletons. Assigned by initDb(); `undefined` until then.
let _prisma: PrismaClient | undefined
let _ownerPrisma: PrismaClient | undefined
let _guarded: GuardedPrisma | undefined

// Public exports — reassigned by initDb(). ESM live bindings surface the new
// values to importers. Reading them before initDb() runs throws (the getters
// would be undefined → a confusing "$transaction of undefined"); we guard in
// makeDbClients + leave these as the post-init handles handlers actually use.
export let prisma: PrismaClient
export let ownerPrisma: PrismaClient
export let guardedPrisma: GuardedPrisma

/**
 * The 10 RLS-bound data tables. A query on any of these outside runInTenant()
 * would run with NO GUCs set → pm_current_team_id() = NULL → zero rows
 * (fail-closed). The audit guard turns that silent emptiness into a loud throw.
 */
const DATA_MODELS = new Set([
  'Source',
  'Document',
  'Chunk',
  'Entity',
  'Claim',
  'Relationship',
  'Investigation',
  'InvestigationLink',
  'IngestJob',
  'Memory',
])

/**
 * guardedPrisma — same physical client as `prisma`, wrapped in a $extends query
 * audit. It does NOT set GUCs (it cannot — see file header); it only throws when
 * a DATA-model op runs while the ALS context reports we are NOT inside
 * runInTenant. This catches "forgot to wrap" bugs at the call site instead of as
 * a confusing empty result set.
 */
// The $allOperations callback shape. Prisma's own inference for this hook does
// not flow cleanly through the @ts-nocheck'd generated client, so we annotate
// the destructured params explicitly (otherwise they are implicit-any under
// strict). `query` runs the original op against its already-chosen connection.
interface AllOperationsArgs {
  model?: string
  operation: string
  args: unknown
  query: (args: unknown) => Promise<unknown>
}

/**
 * Wrap a data client in the $extends audit guard. Same physical client as
 * `prisma`; it does NOT set GUCs (it cannot — see file header), it only throws
 * when a DATA-model op runs while the ALS context reports we are NOT inside
 * runInTenant. This catches "forgot to wrap" bugs at the call site instead of as
 * a confusing empty result set.
 */
function makeGuarded(client: PrismaClient): GuardedPrisma {
  return client.$extends({
    query: {
      $allModels: {
        $allOperations({ model, operation, args, query }: AllOperationsArgs) {
          const ctx = tenantStore.getStore()
          if (DATA_MODELS.has(model ?? '') && !ctx?.insideTenantTx) {
            throw new Error(
              `RLS guard: ${model}.${operation} ran outside runInTenant() — the ` +
                'RLS GUCs are unset, so this would fail closed (zero rows). Wrap ' +
                'the data-plane work in runInTenant((tx) => ...).',
            )
          }
          return query(args)
        },
      },
    },
  })
}

/**
 * Build the two clients (+ the audit-guarded data client) from injected config.
 * Idempotent: a second call returns the already-built singletons. Registers the
 * beforeExit pool teardown exactly once.
 */
export function makeDbClients(cfg: DbConfig): {
  prisma: PrismaClient
  ownerPrisma: PrismaClient
  guardedPrisma: GuardedPrisma
} {
  if (_prisma && _ownerPrisma && _guarded) {
    return { prisma: _prisma, ownerPrisma: _ownerPrisma, guardedPrisma: _guarded }
  }
  // Data plane: pm_app (RLS-subject).
  _prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: cfg.databaseUrl }) })
  // Control plane: pmuser (owner — bypasses RLS by design).
  _ownerPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: cfg.databaseMigrateUrl }) })
  _guarded = makeGuarded(_prisma)

  // Graceful shutdown — release both pools.
  process.once('beforeExit', () => {
    void Promise.allSettled([_prisma!.$disconnect(), _ownerPrisma!.$disconnect()])
  })

  return { prisma: _prisma, ownerPrisma: _ownerPrisma, guardedPrisma: _guarded }
}

/**
 * Initialize @pm/db ONCE at app boot. Assigns the live-binding exports so every
 * importer of `prisma`/`ownerPrisma`/`guardedPrisma` (and runInTenant, which
 * reads `prisma` at call time) sees the constructed clients. Synchronous, called
 * at module top-level boot — both api and worker call it before serving/consuming.
 */
export function initDb(cfg: DbConfig): void {
  const c = makeDbClients(cfg)
  prisma = c.prisma
  ownerPrisma = c.ownerPrisma
  guardedPrisma = c.guardedPrisma
}
