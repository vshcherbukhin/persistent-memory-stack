import { afterEach, describe, expect, it, vi } from 'vitest'
import { dlpGate, makeDlpClient } from '../../../layers/security-dlp/src/index.ts'

const clean = () => Response.json({ pii: [], secrets: [], block: false })
const client = () => makeDlpClient({ baseUrl: 'http://scanner.invalid', timeoutMs: 4000, retryDelayMs: 0 })
afterEach(() => vi.unstubAllGlobals())

describe('DLP HTTP failure recovery', () => {
  it('retries a transient timeout before accepting a successful scan', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new DOMException('private detail', 'TimeoutError')).mockResolvedValueOnce(clean())
    vi.stubGlobal('fetch', fetch)
    expect(await dlpGate(client(), 'memory')).toMatchObject({ blocked: false, failClosed: false })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('bounds persistent timeout retries and reports the deadline without echoing content', async () => {
    const fetch = vi.fn().mockRejectedValue(new DOMException('private submitted content', 'TimeoutError'))
    vi.stubGlobal('fetch', fetch)
    const result = await dlpGate(client(), 'private submitted content')
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({ blocked: true, failClosed: true, failure: { kind: 'timeout' } })
    expect(result.failure?.message).toContain('4000 ms per attempt after 2 attempts')
    expect(JSON.stringify(result)).not.toContain('private submitted content')
  })

  it('retries retryable HTTP failures but never repeats a successful PII decision', async () => {
    const pii = { pii: [{ entity_type: 'EMAIL_ADDRESS', start: 0, end: 5, score: 1 }], secrets: [], block: true }
    const fetch = vi.fn().mockResolvedValueOnce(new Response('private body', { status: 503 })).mockResolvedValueOnce(Response.json(pii))
    vi.stubGlobal('fetch', fetch)
    const result = await dlpGate(client(), 'memory')
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({ blocked: true, failClosed: false })
    expect(result.findings[0].findingType).toBe('EMAIL_ADDRESS')
  })

  it('does not retry successful secret detection', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ pii: [], secrets: [{ rule_id: 'test-secret', description: 'Secret' }], block: true }))
    vi.stubGlobal('fetch', fetch)
    expect(await dlpGate(client(), 'memory')).toMatchObject({ blocked: true, failClosed: false })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('reports a non-retryable HTTP status without disclosing the response body', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('private body', { status: 403 }))
    vi.stubGlobal('fetch', fetch)
    const result = await dlpGate(client(), 'memory')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(result.failure?.message).toBe('The DLP scanner returned HTTP 403.')
    expect(JSON.stringify(result)).not.toContain('private body')
  })

  it('retains a controlled network code but discards arbitrary exception text', async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError('private host or content', { cause: { code: 'ECONNREFUSED' } }))
    vi.stubGlobal('fetch', fetch)
    const result = await dlpGate(client(), 'memory')
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(result.failure?.message).toContain('ECONNREFUSED')
    expect(JSON.stringify(result)).not.toContain('private host or content')
  })

  it.each([
    { pii: [], secrets: [] },
    { pii: [], secrets: [], block: true },
    { pii: [{ entity_type: 'EMAIL_ADDRESS' }], secrets: [], block: true },
  ])('fails closed on malformed or inconsistent scan responses without retrying', async payload => {
    const fetch = vi.fn().mockResolvedValue(Response.json(payload))
    vi.stubGlobal('fetch', fetch)
    expect(await dlpGate(client(), 'memory')).toMatchObject({ blocked: true, failClosed: true, failure: { kind: 'invalid_response' } })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('covers timeouts while reading a response body', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => { throw new DOMException('private content', 'TimeoutError') } })
    vi.stubGlobal('fetch', fetch)
    expect(await dlpGate(client(), 'memory')).toMatchObject({ blocked: true, failClosed: true, failure: { kind: 'timeout' } })
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
