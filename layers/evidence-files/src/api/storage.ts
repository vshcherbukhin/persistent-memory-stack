/**
 * persistent-memory-api — MinIO storage service (Phase 6).
 *
 * Builds the MinIO client singleton at boot. resolveMinioConfig parses the
 * endpoint URL into host/port/SSL and reads MINIO_ROOT_USER/PASSWORD from env —
 * the same MINIO_* vars the api's Zod config already validates at boot, so by the
 * time this module loads they are present. The bucket is ensured once at boot
 * (see server.ts). Mirrors services/embedding.ts: this module only holds the
 * instance; the stream-based blob ops live in @pm/shared (Prisma-free).
 */
import { makeMinioClient, resolveMinioConfig, type MinioClient } from '@pm/shared'

export const minio: MinioClient = makeMinioClient(resolveMinioConfig())
