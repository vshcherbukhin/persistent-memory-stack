/**
 * getBufferCapped (Phase 12, #8) — a bounded MinIO read: returns the buffer when the
 * object fits the cap, throws FileTooLargeError + aborts the stream when it doesn't
 * (so an over-cap blob can't OOM the worker). Mocks the client's getObject stream.
 */
import { describe, it, expect, vi } from 'vitest'
import { Readable } from 'node:stream'
import { getBufferCapped, FileTooLargeError } from '../src/storage/store.ts'
import type { MinioClient } from '../src/storage/client.ts'

function clientFor(chunks: Buffer[]): { client: MinioClient; destroyed: () => boolean } {
  const stream = Readable.from(chunks)
  let destroyed = false
  const origDestroy = stream.destroy.bind(stream)
  stream.destroy = ((...a: unknown[]) => {
    destroyed = true
    return origDestroy(...(a as []))
  }) as typeof stream.destroy
  const client = { getObject: vi.fn(async () => stream) } as unknown as MinioClient
  return { client, destroyed: () => destroyed }
}

describe('getBufferCapped', () => {
  it('returns the full buffer when under the cap', async () => {
    const { client } = clientFor([Buffer.from('hello '), Buffer.from('world')])
    const buf = await getBufferCapped(client, 'k', 1024)
    expect(buf.toString()).toBe('hello world')
  })

  it('throws FileTooLargeError + destroys the stream once the cap is exceeded', async () => {
    const { client, destroyed } = clientFor([Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8)])
    await expect(getBufferCapped(client, 'k', 10)).rejects.toBeInstanceOf(FileTooLargeError)
    expect(destroyed(), 'stream aborted (not fully read)').toBe(true)
  })

  it('the error carries the cap', async () => {
    const { client } = clientFor([Buffer.alloc(50)])
    await expect(getBufferCapped(client, 'k', 10)).rejects.toMatchObject({ maxBytes: 10 })
  })
})
