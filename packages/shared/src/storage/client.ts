/**
 * @pm/shared/storage — local MinIO adapter using the maintained S3 SDK.
 *
 * Keep the existing hostname/port/useSSL configuration contract. The adapter
 * reconstructs the explicit local endpoint for the S3 SDK; it never discovers
 * AWS credentials or selects an AWS storage endpoint.
 *
 * Prisma-free: storage deals in streams + string keys; callers own Postgres.
 */
import { Readable } from 'node:stream'
import {
  S3Client, HeadBucketCommand, CreateBucketCommand, GetObjectCommand,
  HeadObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, ListObjectsV2Command,
  type BucketLocationConstraint,
} from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

export interface MinioConfig {
  endPoint: string
  port: number
  useSSL: boolean
  accessKey: string
  secretKey: string
  region: string
}

/** Preserve the existing storage surface, local endpoint and explicit credentials. */
export class MinioClient {
  private readonly s3: S3Client

  constructor(cfg: MinioConfig) {
    this.s3 = new S3Client({
      endpoint: `${cfg.useSSL ? 'https' : 'http'}://${cfg.endPoint}:${cfg.port}`,
      region: cfg.region,
      credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
      forcePathStyle: true,
      // Optional AWS checksum trailers are not supported by every retained MinIO.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    })
  }

  async bucketExists(bucket: string): Promise<boolean> {
    try { await this.s3.send(new HeadBucketCommand({ Bucket: bucket })); return true }
    catch (error) {
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return false
      throw error
    }
  }

  async makeBucket(bucket: string, region: string): Promise<void> {
    await this.s3.send(new CreateBucketCommand({ Bucket: bucket,
      ...(region === 'us-east-1' ? {} : { CreateBucketConfiguration: { LocationConstraint: region as BucketLocationConstraint } }),
    }))
  }

  async putObject(bucket: string, key: string, body: Readable | Buffer, size?: number, metadata?: Record<string, string>): Promise<{ etag: string; versionId: string | null }> {
    const result = await new Upload({
      client: this.s3,
      params: { Bucket: bucket, Key: key, Body: body, ...(size === undefined ? {} : { ContentLength: size }),
        ...(metadata?.['Content-Type'] ? { ContentType: metadata['Content-Type'] } : {}),
        Metadata: Object.fromEntries(Object.entries(metadata ?? {}).filter(([name]) => name.toLowerCase() !== 'content-type')),
      },
      partSize: 64 * 1024 * 1024,
      queueSize: 1,
      leavePartsOnError: false,
    }).done()
    if (!result.ETag) throw new Error('Storage upload returned no object identifier.')
    return { etag: result.ETag.replace(/^"|"$/g, ''), versionId: result.VersionId ?? null }
  }

  async getObject(bucket: string, key: string): Promise<Readable> {
    const result = await this.s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
    if (!(result.Body instanceof Readable)) throw new Error('Storage returned no readable object body.')
    return result.Body
  }

  async statObject(bucket: string, key: string) {
    const result = await this.s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
    return { size: result.ContentLength ?? 0, etag: (result.ETag ?? '').replace(/^"|"$/g, ''),
      lastModified: result.LastModified, versionId: result.VersionId ?? null,
      metaData: { ...result.Metadata, ...(result.ContentType ? { 'content-type': result.ContentType } : {}) },
    }
  }

  presignedGetObject(bucket: string, key: string, expirySeconds = 3600): Promise<string> {
    if (!Number.isInteger(expirySeconds) || expirySeconds < 1 || expirySeconds > 604800) throw new Error('Download expiry must be between 1 second and 7 days.')
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: expirySeconds })
  }

  async removeObject(bucket: string, key: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
  }

  async removeObjects(bucket: string, keys: string[]): Promise<void> {
    for (let offset = 0; offset < keys.length; offset += 1000) {
      const result = await this.s3.send(new DeleteObjectsCommand({ Bucket: bucket,
        Delete: { Objects: keys.slice(offset, offset + 1000).map(Key => ({ Key })), Quiet: true },
      }))
      if (result.Errors?.length) throw new Error('Storage did not delete every requested object.')
    }
  }

  listObjectsV2(bucket: string, prefix = '', recursive = false): Readable {
    const s3 = this.s3
    return Readable.from((async function* () {
      let token: string | undefined
      do {
        const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix,
          ...(recursive ? {} : { Delimiter: '/' }), ...(token ? { ContinuationToken: token } : {}),
        }))
        for (const object of page.Contents ?? []) if (object.Key) yield { name: object.Key, size: object.Size, etag: object.ETag?.replace(/^"|"$/g, ''), lastModified: object.LastModified }
        for (const directory of page.CommonPrefixes ?? []) if (directory.Prefix) yield { prefix: directory.Prefix }
        if (!page.IsTruncated) break
        if (!page.NextContinuationToken || page.NextContinuationToken === token) throw new Error('Storage listing returned an invalid continuation token.')
        token = page.NextContinuationToken
      } while (true)
    })())
  }

  destroy(): void { this.s3.destroy() }
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
