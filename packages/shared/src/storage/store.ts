/**
 * @pm/shared/storage — thin operations wrapper over the MinIO client.
 *
 * Streams in, streams out, string keys. Both the api (write originals on
 * POST /ingest) and the worker (read originals + write extracted artifacts) use
 * this — exactly like the embedder/Qdrant client. Stays Prisma-free.
 */
import type { Readable } from 'node:stream'
import type { MinioClient } from './client.ts'

/** The single evidence bucket. team/project/sourceId prefixing lives in keys.ts. */
export const PM_BUCKET = 'pm-evidence'

/** Idempotent bucket create. Call once at api + worker boot. */
export async function ensureBucket(
  c: MinioClient,
  bucket: string = PM_BUCKET,
  region = 'us-east-1',
): Promise<void> {
  if (!(await c.bucketExists(bucket))) await c.makeBucket(bucket, region)
}

/**
 * Stream an object IN. size is OMITTED on purpose: a multipart upload stream has
 * no known length, so the SDK does unknown-length multipart (64 MiB parts). NEVER
 * collect to a Buffer first (defeats streaming + risks OOM on large PDFs).
 */
export function putStream(
  c: MinioClient,
  key: string,
  stream: Readable | Buffer,
  mimeType?: string,
  bucket: string = PM_BUCKET,
): Promise<{ etag: string; versionId: string | null }> {
  return c.putObject(
    bucket,
    key,
    stream,
    undefined, // size omitted → SDK uses unknown-length multipart
    mimeType ? { 'Content-Type': mimeType } : undefined,
  )
}

/** Fetch an object as a Readable (worker step 1: fetch the original blob). */
export function getStream(
  c: MinioClient,
  key: string,
  bucket: string = PM_BUCKET,
): Promise<Readable> {
  return c.getObject(bucket, key)
}

/** Fetch an object fully into a Buffer (extraction libs need the whole buffer). */
export async function getBuffer(
  c: MinioClient,
  key: string,
  bucket: string = PM_BUCKET,
): Promise<Buffer> {
  const stream = await c.getObject(bucket, key)
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer))
  }
  return Buffer.concat(chunks)
}

/** Thrown by getBufferCapped when an object exceeds the read ceiling. */
export class FileTooLargeError extends Error {
  override readonly name = 'FileTooLargeError'
  constructor(
    readonly maxBytes: number,
    readonly key: string,
  ) {
    super(`object exceeds the ${maxBytes}-byte read cap`)
  }
}

/**
 * Stream an object into a Buffer with a HARD byte ceiling (Phase 12, #8). Aborts
 * (destroys the stream) + throws FileTooLargeError the moment the accumulated size
 * exceeds maxBytes — WITHOUT reading the rest — so a blob larger than the cap can
 * never OOM the worker (e.g. one uploaded out-of-band past the api's upload limit).
 *
 * The PDF/DOCX extractors need the whole buffer (they are not streamable), so the
 * bounded READ — not streaming extraction — is what bounds peak memory; the worker
 * mem_limit (docker-compose) + WORKER_CONCURRENCY then bound the aggregate.
 */
export async function getBufferCapped(
  c: MinioClient,
  key: string,
  maxBytes: number,
  bucket: string = PM_BUCKET,
): Promise<Buffer> {
  const stream = await c.getObject(bucket, key)
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of stream) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer)
    total += buf.length
    if (total > maxBytes) {
      stream.destroy()
      throw new FileTooLargeError(maxBytes, key)
    }
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}

/** Object metadata: { size, etag, lastModified, metaData }. */
export function statObject(c: MinioClient, key: string, bucket: string = PM_BUCKET) {
  return c.statObject(bucket, key)
}

/**
 * Short-lived presigned download URL (retrieval P7 mints these per result).
 * MinIO/S3 cap is 7 days (604800 s); default 1 h. Never embed permanent links.
 */
export function presignedGetUrl(
  c: MinioClient,
  key: string,
  expirySeconds = 3600,
  bucket: string = PM_BUCKET,
): Promise<string> {
  return c.presignedGetObject(bucket, key, expirySeconds)
}

/** Remove an object (cleanup on a partial/truncated upload). */
export function removeObject(c: MinioClient, key: string, bucket: string = PM_BUCKET): Promise<void> {
  return c.removeObject(bucket, key)
}

/**
 * Remove EVERY object under a key prefix — the original blob AND the extracted
 * artifacts, which all share the `team/<teamId>/<project>/<sourceId>/` prefix
 * (keys.ts). Used by the P11 document DELETE (artifacts aren't tracked in Postgres,
 * so a prefix sweep is the only way to reclaim them). Lists recursively then batch-
 * removes; returns the count removed. Caller wraps it fail-soft (a storage hiccup
 * must not block the Postgres delete).
 */
export async function removePrefix(
  c: MinioClient,
  prefix: string,
  bucket: string = PM_BUCKET,
): Promise<number> {
  const keys: string[] = []
  const stream = c.listObjectsV2(bucket, prefix, true)
  await new Promise<void>((resolve, reject) => {
    stream.on('data', (obj) => {
      if (obj.name) keys.push(obj.name)
    })
    stream.on('end', () => resolve())
    stream.on('error', reject)
  })
  if (keys.length > 0) await c.removeObjects(bucket, keys)
  return keys.length
}
