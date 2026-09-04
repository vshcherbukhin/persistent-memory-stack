/**
 * @pm/db — the narrow connection-string contract.
 *
 * @pm/db deliberately does NOT import any app config module: the api validates a
 * rich Zod env (apps/api/src/config.ts), the worker validates its own
 * (apps/worker/src/config.ts), and they have different env surfaces. Both inject ONLY the two DB
 * URLs here via initDb(), so @pm/db stays app-agnostic and reusable.
 *
 * The connection-role split is the RLS spine (carried from P2/P3):
 *   • databaseUrl         → pm_app  (NOSUPERUSER / NOBYPASSRLS, RLS-subject; data plane)
 *   • databaseMigrateUrl  → pmuser  (table OWNER, bypasses FORCE'd RLS; control plane only)
 */
export interface DbConfig {
  /** pm_app — RLS-subject data-plane connection (DATABASE_URL). */
  databaseUrl: string
  /** pmuser — owner / control-plane connection (DATABASE_MIGRATE_URL). */
  databaseMigrateUrl: string
}
