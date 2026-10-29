import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import { Readable } from 'node:stream'
import { MinioClient, resolveMinioConfig } from '../src/storage/client.ts'

const clients: MinioClient[] = []
const servers: Server[] = []
async function fixture(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No test listener')
  const config = resolveMinioConfig({ MINIO_ENDPOINT:`http://127.0.0.1:${address.port}`, MINIO_ROOT_USER:'synthetic-storage-user', MINIO_ROOT_PASSWORD:'synthetic-storage-password' })
  const client = new MinioClient(config)
  clients.push(client)
  return { client, endpoint:`http://127.0.0.1:${address.port}` }
}
afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy()
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))))
})

describe('local S3 adapter', () => {
  it('keeps the configured endpoint, explicit credentials, encoded keys and metadata', async () => {
    const seen: { method?:string; path?:string; type?:string; metadata?:string; authorization?:string; body:string }[] = []
    const { client, endpoint } = await fixture((request, response) => {
      void (async () => {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        seen.push({ method:request.method, path:request.url, type:request.headers['content-type'], metadata:request.headers['x-amz-meta-source'] as string, authorization:request.headers.authorization, body:Buffer.concat(chunks).toString() })
        response.setHeader('ETag', '"synthetic-etag"')
        response.setHeader('x-amz-version-id', 'synthetic-version')
        response.end()
      })()
    })
    const result = await client.putObject('pm-evidence', 'folder/space + é.txt', Readable.from(['hello ', 'world']), undefined, { 'Content-Type':'text/plain', source:'synthetic' })
    expect(result).toEqual({ etag:'synthetic-etag', versionId:'synthetic-version' })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ method:'PUT', path:'/pm-evidence/folder/space%20%2B%20%C3%A9.txt?x-id=PutObject', type:'text/plain', metadata:'synthetic', body:'hello world' })
    expect(seen[0]!.authorization).toContain('Credential=synthetic-storage-user/')
    const url = new URL(await client.presignedGetObject('pm-evidence', 'folder/space + é.txt', 300))
    expect(url.origin).toBe(endpoint)
    expect(url.pathname).toBe('/pm-evidence/folder/space%20%2B%20%C3%A9.txt')
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300')
    expect(url.searchParams.get('X-Amz-Credential')).toMatch(/^synthetic-storage-user\//)
    for (const expiry of [0, 604801, 2.5]) expect(() => client.presignedGetObject('pm-evidence', 'key', expiry)).toThrow(/expiry/)
  })

  it('streams downloads and preserves object metadata', async () => {
    const { client } = await fixture((request, response) => {
      response.setHeader('ETag', '"object-etag"')
      response.setHeader('Last-Modified', 'Thu, 29 Oct 2026 00:00:00 GMT')
      response.setHeader('Content-Length', '5')
      response.setHeader('Content-Type', 'text/plain')
      response.setHeader('x-amz-meta-source', 'retained')
      response.end(request.method === 'HEAD' ? undefined : 'hello')
    })
    const body = await client.getObject('pm-evidence', 'key')
    const chunks: Buffer[] = []
    for await (const chunk of body) chunks.push(Buffer.from(chunk))
    expect(Buffer.concat(chunks).toString()).toBe('hello')
    expect(await client.statObject('pm-evidence', 'key')).toMatchObject({ size:5, etag:'object-etag', lastModified:new Date('2026-10-29T00:00:00Z'), metaData:{ source:'retained', 'content-type':'text/plain' } })
  })

  it('treats only missing buckets as absent, never permission failures', async () => {
    const { client } = await fixture((request, response) => { response.statusCode = request.url?.startsWith('/missing') ? 404 : 403; response.end() })
    expect(await client.bucketExists('missing')).toBe(false)
    await expect(client.bucketExists('denied')).rejects.toMatchObject({ $metadata:{ httpStatusCode:403 } })
  })

  it('follows listing pages, preserves gaps in object names and rejects broken pagination', async () => {
    const queries: URLSearchParams[] = []
    const { client } = await fixture((request, response) => {
      const query = new URL(request.url!, 'http://synthetic.invalid').searchParams
      queries.push(query)
      response.setHeader('Content-Type', 'application/xml')
      const second = query.has('continuation-token')
      response.end(`<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>${!second}</IsTruncated>${second ? '' : '<NextContinuationToken>next-page</NextContinuationToken>'}<Contents><Key>${second ? 'prefix/second' : 'prefix/first'}</Key><Size>1</Size></Contents></ListBucketResult>`)
    })
    const names = []
    for await (const object of client.listObjectsV2('pm-evidence', 'prefix/', true)) names.push(object.name)
    expect(names).toEqual(['prefix/first','prefix/second'])
    expect(queries[0]!.get('prefix')).toBe('prefix/')
    expect(queries[0]!.has('delimiter')).toBe(false)
    expect(queries[1]!.get('continuation-token')).toBe('next-page')
    const broken = await fixture((_request, response) => { response.setHeader('Content-Type','application/xml'); response.end('<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>') })
    await expect((async () => { for await (const _ of broken.client.listObjectsV2('pm-evidence')) { /* drain */ } })()).rejects.toThrow(/continuation token/)
  })

  it('batches deletes to the S3 limit and reports per-object failures', async () => {
    const counts: number[] = []
    let fail = false
    const { client } = await fixture((request, response) => {
      void (async () => {
        let body = ''
        for await (const chunk of request) body += chunk.toString()
        counts.push((body.match(/<Object>/g) ?? []).length)
        response.setHeader('Content-Type', 'application/xml')
        response.end(fail ? '<DeleteResult><Error><Key>synthetic</Key><Code>AccessDenied</Code></Error></DeleteResult>' : '<DeleteResult/>')
      })()
    })
    await client.removeObjects('pm-evidence', Array.from({length:1001}, (_,i)=>`key-${i}`))
    expect(counts).toEqual([1000,1])
    fail = true
    await expect(client.removeObjects('pm-evidence', ['denied'])).rejects.toThrow(/did not delete every/)
  })
})
