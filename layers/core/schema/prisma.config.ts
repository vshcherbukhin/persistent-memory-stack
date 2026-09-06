/**
 * persistent-memory — Prisma 7 CLI/Migrate configuration.
 *
 * Prisma 7 removed `datasource.url` from the schema. The connection URL for the
 * CLI (generate / migrate / db) lives here. Migrations and the seed run as the
 * OWNER (pmuser) — prefer DATABASE_MIGRATE_URL, falling back to DATABASE_URL for
 * local one-shot use. The RLS-subject runtime role (pm_app) connects via the
 * PrismaPg adapter in the app, never through this CLI config.
 *
 * The `seed` here mirrors package.json's `prisma.seed` so both `prisma db seed`
 * and `npm run seed` use the same entrypoint.
 */
import 'dotenv/config'
import { defineConfig } from 'prisma/config'

// Migrations + seed run as the OWNER (pmuser): prefer DATABASE_MIGRATE_URL, fall
// back to DATABASE_URL for local one-shot use. Read from process.env directly —
// Prisma 7's env() throws on an unresolved var, which breaks the fallback.
const migrateUrl = process.env.DATABASE_MIGRATE_URL ?? process.env.DATABASE_URL

export default defineConfig({
  schema: 'schema.prisma',
  migrations: {
    path: 'migrations',
    seed: 'npm run seed',
  },
  ...(migrateUrl ? { datasource: { url: migrateUrl } } : {}),
})
