import { afterEach, describe, expect, it, vi } from 'vitest'
import { getJSON, streamNDJSON } from '../web/src/api.ts'

afterEach(() => vi.unstubAllGlobals())

describe('installer stream responses', () => {
  it('explains how to recover when the local prerequisite server is offline', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    await expect(getJSON('/api/prereqs')).rejects.toThrow('If it has stopped, restart it, then choose Check again')
  })

  it('rejects a stream cut off before completion instead of reporting success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"type":"stdout","chunk":"Downloading"}\n')))
    await expect(streamNDJSON('/api/prereqs/install', {}, vi.fn())).rejects.toThrow('before completion was confirmed')
  })

  it('accepts a final completion event without a trailing newline', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"type":"done","ok":true}')))
    const onEvent = vi.fn()
    await streamNDJSON('/api/prereqs/install', {}, onEvent)
    expect(onEvent).toHaveBeenCalledWith({ type: 'done', ok: true })
  })

  it('rejects failed completion even when no separate error event arrived', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"type":"done","ok":false}\n')))
    await expect(streamNDJSON('/api/ollama/pull', {}, vi.fn())).rejects.toThrow('reported a failure')
  })

  it('reports a dropped connection while reading progress', async () => {
    const body = new ReadableStream({ start(controller) { controller.error(new TypeError('terminated')) } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body)))
    await expect(streamNDJSON('/api/prereqs/install', {}, vi.fn())).rejects.toThrow('installer connection was lost')
  })

  it('surfaces a concurrent install rejection even without an NDJSON newline', async () => {
    const message = 'A prerequisite installation is already running. Wait for it to finish.'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: message }), { status: 409 })))
    const onEvent = vi.fn()
    await expect(streamNDJSON('/api/prereqs/install', { component: 'ollama' }, onEvent)).rejects.toThrow(message)
    expect(onEvent).not.toHaveBeenCalled()
  })

  it('reports the status when a failure response is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Service unavailable', { status: 503 })))
    await expect(streamNDJSON('/api/prereqs/install', {}, vi.fn())).rejects.toThrow('/api/prereqs/install → 503')
  })

  it('continues to deliver successful streamed progress and completion events', async () => {
    const events = [{ type: 'step-start', id: 'install-ollama' }, { type: 'done', ok: true }]
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(events.map(event => JSON.stringify(event)).join('\n') + '\n')))
    const onEvent = vi.fn()
    await streamNDJSON('/api/prereqs/install', { component: 'ollama' }, onEvent)
    expect(onEvent.mock.calls.map(([event]) => event)).toEqual(events)
  })
})
