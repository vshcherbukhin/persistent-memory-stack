import { afterEach, describe, expect, it, vi } from 'vitest'
import { getJSON, streamNDJSON } from '../web/src/api.ts'

afterEach(() => vi.unstubAllGlobals())

function stubFetch(mock: typeof fetch) {
  vi.stubGlobal('fetch', vi.fn((url: RequestInfo | URL, init?: RequestInit) => String(url) === '/api/session'
    ? Promise.resolve(new Response(JSON.stringify({ nonce: 'A'.repeat(32) }))) : mock(url, init)))
}

describe('installer stream responses', () => {
  it('loads a fresh process nonce before each explicit mutation and forwards it only as the guard header', async () => {
    const action = vi.fn().mockResolvedValue(new Response('{"type":"done","ok":true}\n'))
    stubFetch(action)
    await streamNDJSON('/api/prereqs/install', { component: 'docker' }, vi.fn())
    expect(action).toHaveBeenCalledOnce()
    expect(new Headers(action.mock.calls[0][1]?.headers).get('x-pm-onboard-nonce')).toBe('A'.repeat(32))
    expect(String(action.mock.calls[0][1]?.body)).not.toContain('nonce')
  })
  it('does not attempt a mutation when the session bootstrap is unavailable or malformed', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{}'))
    vi.stubGlobal('fetch', fetcher)
    await expect(streamNDJSON('/api/install', {}, vi.fn())).rejects.toThrow('installer connection was lost')
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0][0]).toBe('/api/session')
  })
  it('explains how to recover when the local prerequisite server is offline', async () => {
    stubFetch( vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    await expect(getJSON('/api/prereqs')).rejects.toThrow('If it has stopped, restart it, then choose Check again')
  })

  it('rejects a stream cut off before completion instead of reporting success', async () => {
    stubFetch( vi.fn().mockResolvedValue(new Response('{"type":"stdout","chunk":"Downloading"}\n')))
    await expect(streamNDJSON('/api/prereqs/install', {}, vi.fn())).rejects.toThrow('before completion was confirmed')
  })

  it('accepts a final completion event without a trailing newline', async () => {
    stubFetch( vi.fn().mockResolvedValue(new Response('{"type":"done","ok":true}')))
    const onEvent = vi.fn()
    await streamNDJSON('/api/prereqs/install', {}, onEvent)
    expect(onEvent).toHaveBeenCalledWith({ type: 'done', ok: true })
  })

  it('rejects failed completion even when no separate error event arrived', async () => {
    stubFetch( vi.fn().mockResolvedValue(new Response('{"type":"done","ok":false}\n')))
    await expect(streamNDJSON('/api/ollama/pull', {}, vi.fn())).rejects.toThrow('reported a failure')
  })

  it('reports a dropped connection while reading progress', async () => {
    const body = new ReadableStream({ start(controller) { controller.error(new TypeError('terminated')) } })
    stubFetch( vi.fn().mockResolvedValue(new Response(body)))
    await expect(streamNDJSON('/api/prereqs/install', {}, vi.fn())).rejects.toThrow('installer connection was lost')
  })

  it('surfaces a concurrent install rejection even without an NDJSON newline', async () => {
    const message = 'A prerequisite installation is already running. Wait for it to finish.'
    stubFetch( vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: message }), { status: 409 })))
    const onEvent = vi.fn()
    await expect(streamNDJSON('/api/prereqs/install', { component: 'ollama' }, onEvent)).rejects.toThrow(message)
    expect(onEvent).not.toHaveBeenCalled()
  })

  it('reports the status when a failure response is not JSON', async () => {
    stubFetch( vi.fn().mockResolvedValue(new Response('Service unavailable', { status: 503 })))
    await expect(streamNDJSON('/api/prereqs/install', {}, vi.fn())).rejects.toThrow('/api/prereqs/install → 503')
  })

  it('continues to deliver successful streamed progress and completion events', async () => {
    const events = [{ type: 'step-start', id: 'install-ollama' }, { type: 'done', ok: true }]
    stubFetch( vi.fn().mockResolvedValue(new Response(events.map(event => JSON.stringify(event)).join('\n') + '\n')))
    const onEvent = vi.fn()
    await streamNDJSON('/api/prereqs/install', { component: 'ollama' }, onEvent)
    expect(onEvent.mock.calls.map(([event]) => event)).toEqual(events)
  })
})
