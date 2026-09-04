/**
 * removePrefix — list-then-batch-remove every object under a key prefix (the P11
 * document DELETE reclaims the original + untracked artifacts). Mocks the MinIO
 * client's listObjectsV2 stream + removeObjects.
 */
import { describe, it, expect, vi } from 'vitest'
import { Readable } from 'node:stream'
import { removePrefix } from '../src/storage/store.ts'
import type { MinioClient } from '../src/storage/client.ts'

function fakeClient(names: string[]): { client: MinioClient; removeObjects: ReturnType<typeof vi.fn> } {
  const removeObjects = vi.fn(async () => {})
  const client = {
    listObjectsV2: () => Readable.from(names.map((name) => ({ name })), { objectMode: true }),
    removeObjects,
  } as unknown as MinioClient
  return { client, removeObjects }
}

describe('removePrefix', () => {
  it('removes every listed key under the prefix and returns the count', async () => {
    const { client, removeObjects } = fakeClient([
      'team/t/p/s/original/a.pdf',
      'team/t/p/s/extracted/a.txt',
    ])
    const n = await removePrefix(client, 'team/t/p/s/')
    expect(n).toBe(2)
    expect(removeObjects).toHaveBeenCalledOnce()
    expect(removeObjects.mock.calls[0]![1]).toEqual([
      'team/t/p/s/original/a.pdf',
      'team/t/p/s/extracted/a.txt',
    ])
  })

  it('no objects under the prefix → 0, no removeObjects call', async () => {
    const { client, removeObjects } = fakeClient([])
    const n = await removePrefix(client, 'team/t/p/none/')
    expect(n).toBe(0)
    expect(removeObjects).not.toHaveBeenCalled()
  })
})
