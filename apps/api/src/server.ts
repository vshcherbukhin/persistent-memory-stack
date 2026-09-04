/**
 * persistent-memory-api — entrypoint (Phase 3).
 *
 * Boots the Fastify app and listens on 0.0.0.0:API_PORT. Binding to 0.0.0.0 is
 * required inside the container so the published host port (8090) is reachable.
 */
import { ensureCollection } from '@pm/shared'
import { initDb } from '@pm/db'
import { buildApp } from './app.ts'
import { config } from './config.ts'
import { qdrant, activePin } from './services/embedding.ts'
import { ensureLocalIdentity } from './auth/local-mode.ts'

// Initialize @pm/db BEFORE anything touches the clients (runInTenant reads
// `prisma` at call time, so this must run before the first request). Synchronous,
// at module top-level boot — well before app.listen() serves traffic.
initDb({
  databaseUrl: config.DATABASE_URL,
  databaseMigrateUrl: config.DATABASE_MIGRATE_URL,
})

const app = buildApp()

async function main(): Promise<void> {
  // P13: in local mode, AUTH IS DISABLED — ensure the lone local team + super-user
  // exists and is recorded in local_identity BEFORE listening, and
  // log a LOUD warning. Gated by the boot-time DEPLOYMENT_MODE pin.
  if (config.DEPLOYMENT_MODE === 'local') {
    // Best-effort, like ensureCollection below: on a FRESH install the api can start BEFORE
    // migrations are applied (compose-up runs before prisma-migrate), so team/app_user may not
    // exist yet. A throw here would crash the api → fail its healthcheck → block `docker compose up`
    // (dependents gate on api health). The lone local super-user is (re)created once the schema
    // exists + the api is force-recreated (the installer's restart-app step does exactly that).
    try {
      await ensureLocalIdentity()
    } catch (err) {
      app.log.warn(
        { err },
        'ensureLocalIdentity skipped at boot (DB not migrated yet?) — the local super-user is created on the post-migrate restart',
      )
    }
    app.log.warn(
      '⚠️  DEPLOYMENT_MODE=local — authentication is DISABLED (every request is a single ' +
        'local super-user). This is for a single-user local stack ONLY. NEVER run local mode on a ' +
        'shared or networked deployment.',
    )
  }

  // P5: ensure the Qdrant collection + tenant/project payload indexes exist
  // (idempotent). Best-effort at boot — a transient Qdrant unavailability must
  // not crash the api (health/auth don't depend on Qdrant); the data plane
  // (P6/P7) will surface a clear error if it's still down at write time.
  try {
    await ensureCollection(qdrant, activePin)
    app.log.info(
      { collection: 'memory_vectors', activeVector: activePin.vectorName },
      'qdrant collection ensured',
    )
  } catch (err) {
    app.log.warn({ err }, 'qdrant ensureCollection failed at boot — will retry on first data-plane op')
  }

  try {
    await app.listen({ host: '0.0.0.0', port: config.API_PORT })
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}

// Graceful shutdown on container stop.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void app.close().then(() => process.exit(0))
  })
}

void main()
