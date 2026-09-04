/**
 * Vitest setup — minimal placeholder env so api/src/config.ts (Zod-validated at
 * import time) does not throw when a unit test imports a config-dependent module.
 *
 * These values are NEVER connected to: the unit tests inject stubs (e.g.
 * __setExtractionLLM / __setDlpClient) or test pure functions. Integration tests run
 * against the live stack with the real env (test/integration/*), not these.
 *
 * `??=` so a real env (if the runner exports one) always wins.
 */
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test'
process.env.DATABASE_MIGRATE_URL ??= 'postgresql://test:test@localhost:5432/test'
process.env.REDIS_URL ??= 'redis://localhost:6379'
process.env.QDRANT_URL ??= 'http://localhost:6333'
process.env.MINIO_ENDPOINT ??= 'http://localhost:9000'
process.env.MINIO_ROOT_USER ??= 'test'
process.env.MINIO_ROOT_PASSWORD ??= 'test'
