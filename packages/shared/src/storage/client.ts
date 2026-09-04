/**
 * @pm/shared/storage — MinIO S3 client factory.
 *
 * THE load-bearing gotcha: the SDK's `endPoint` is a HOSTNAME ONLY (no scheme,
 * no port). The .env carries a full URL (MINIO_ENDPOINT=http://host:9000), so
 * the factory must `new URL()`-parse it into the SDK's separate endPoint / port
 * / useSSL fields. Passing the raw URL as endPoint silently builds wrong request
 * hosts.
 *
 * Prisma-free: storage deals in streams + string keys; callers own Postgres.
 */
import { Client as MinioClient } from 'minio'

export interface MinioConfig {
  endPoint: string
  port: number
  useSSL: boolean
  accessKey: string
  secretKey: string
  region: string
}

/**
 * Resolve a MinIO client config from env. MINIO_ENDPOINT is a full URL; we parse
 * it into hostname + port + scheme. accessKey/secretKey come from the MinIO root
 * creds (the compose stack uses MINIO_ROOT_USER / MINIO_ROOT_PASSWORD).
 */
export function resolveMinioConfig(env: NodeJS.ProcessEnv = process.env): MinioConfig {
  const raw = env.MINIO_ENDPOINT
  if (!raw) throw new Error('MINIO_ENDPOINT must be set (e.g. http://persistent-memory-minio:9000).')
  const u = new URL(raw) // ← MUST parse; the SDK rejects a full URL as endPoint
  const accessKey = env.MINIO_ROOT_USER
  const secretKey = env.MINIO_ROOT_PASSWORD
  if (!accessKey || !secretKey) {
    throw new Error('MINIO_ROOT_USER and MINIO_ROOT_PASSWORD must be set for the MinIO client.')
  }
  return {
    endPoint: u.hostname, // host ONLY — no scheme, no port
    port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80),
    useSSL: u.protocol === 'https:',
    accessKey,
    secretKey,
    region: env.MINIO_REGION ?? 'us-east-1',
  }
}

export function makeMinioClient(cfg: MinioConfig): MinioClient {
  return new MinioClient({ ...cfg })
}

export { MinioClient }
