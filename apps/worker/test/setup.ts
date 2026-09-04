/**
 * Vitest setup — minimal placeholder env so apps/worker/src/config.ts (Zod-validated at
 * import) does not throw when a unit test imports a config-dependent module (e.g. the
 * pipeline now transitively imports notify.ts → config.ts). Never connected to; unit
 * tests inject stubs / test pure functions. Integration tests use the real env.
 */
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test'
process.env.DATABASE_MIGRATE_URL ??= 'postgresql://test:test@localhost:5432/test'
process.env.REDIS_URL ??= 'redis://localhost:6379'
process.env.MINIO_ENDPOINT ??= 'http://localhost:9000'
process.env.MINIO_ROOT_USER ??= 'test'
process.env.MINIO_ROOT_PASSWORD ??= 'test'
