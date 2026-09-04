/** @pm/shared/storage — public surface of the MinIO blob layer. */
export {
  makeMinioClient,
  resolveMinioConfig,
  MinioClient,
} from './client.ts'
export type { MinioConfig } from './client.ts'
export { originalKey, artifactKey, sourcePrefix } from './keys.ts'
export {
  PM_BUCKET,
  ensureBucket,
  putStream,
  getStream,
  getBuffer,
  getBufferCapped,
  FileTooLargeError,
  statObject,
  presignedGetUrl,
  removeObject,
  removePrefix,
} from './store.ts'
