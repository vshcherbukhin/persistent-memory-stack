import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { IdleLifecycle } from '../server/idle-lifecycle.ts'
import { createNdjsonStream } from '../server/ndjson.ts'

const IDLE_TIMEOUT = 30 * 60 * 1000

function lifecycle() {
  let now = 0
  const idle = new IdleLifecycle(IDLE_TIMEOUT, () => now)
  return { idle, advance: (milliseconds: number) => { now += milliseconds } }
}

class Response extends EventEmitter {
  destroyed = false
  writableEnded = false
  writeHead = vi.fn((_status: number, _headers: Record<string, string>) => this)
  write = vi.fn((_chunk: string) => true)
  end = vi.fn(() => { this.writableEnded = true })
}

function response() {
  const raw = new Response()
  const reply = { raw, hijack: vi.fn() }
  return { raw, reply, stream: createNdjsonStream(reply) }
}

describe('installer idle lifecycle', () => {
  it('expires an abandoned wizard after the idle timeout', () => {
    const { idle, advance } = lifecycle()
    advance(IDLE_TIMEOUT)
    expect(idle.shouldExit()).toBe(false)
    advance(1)
    expect(idle.shouldExit()).toBe(true)
  })

  it('an incoming request starts a fresh idle window', () => {
    const { idle, advance } = lifecycle()
    advance(IDLE_TIMEOUT - 1)
    idle.touch()
    advance(IDLE_TIMEOUT - 1)
    expect(idle.shouldExit()).toBe(false)
    advance(2)
    expect(idle.shouldExit()).toBe(true)
  })

  it('keeps a download alive for hours without requests and resets idle time when it finishes', () => {
    const { idle, advance } = lifecycle()
    const release = idle.beginWork()
    advance(2 * 60 * 60 * 1000)
    expect(idle.shouldExit()).toBe(false)
    release()
    expect(idle.shouldExit()).toBe(false)
    advance(IDLE_TIMEOUT)
    expect(idle.shouldExit()).toBe(false)
    advance(1)
    expect(idle.shouldExit()).toBe(true)
  })

  it('waits for every operation and makes repeated release harmless', () => {
    const { idle, advance } = lifecycle()
    const releaseInstall = idle.beginWork()
    const releaseModel = idle.beginWork()
    releaseInstall()
    releaseInstall()
    advance(IDLE_TIMEOUT + 1)
    expect(idle.shouldExit()).toBe(false)
    releaseModel()
    advance(IDLE_TIMEOUT + 1)
    expect(idle.shouldExit()).toBe(true)
  })

  it('a browser disconnect stops output while the operation keeps its lease', () => {
    const { idle, advance } = lifecycle()
    const release = idle.beginWork()
    const { raw, stream } = response()
    stream.emit({ type: 'stdout', chunk: 'Downloading.\n' })
    raw.emit('close')
    advance(2 * 60 * 60 * 1000)
    stream.emit({ type: 'stdout', chunk: 'Still downloading.\n' })
    expect(raw.write).toHaveBeenCalledTimes(1)
    expect(idle.shouldExit()).toBe(false)
    try {
      throw new Error('download failed')
    } catch {
      stream.emit({ type: 'done', ok: false })
    } finally {
      release()
      stream.end()
    }
    expect(idle.shouldExit()).toBe(false)
    advance(IDLE_TIMEOUT + 1)
    expect(idle.shouldExit()).toBe(true)
  })
})

describe('installer NDJSON transport', () => {
  it('streams complete events and ends the response once', () => {
    const { raw, reply, stream } = response()
    stream.emit({ type: 'done', ok: true })
    stream.end()
    stream.end()
    stream.emit({ type: 'stdout', chunk: 'late output' })
    expect(reply.hijack).toHaveBeenCalledOnce()
    expect(raw.writeHead).toHaveBeenCalledWith(200, {
      'content-type': 'application/x-ndjson', 'cache-control': 'no-store',
    })
    expect(raw.write.mock.calls).toEqual([['{"type":"done","ok":true}\n']])
    expect(raw.end).toHaveBeenCalledOnce()
  })

  it('absorbs asynchronous socket errors, including errors after a disconnect', () => {
    const { raw, stream } = response()
    expect(() => raw.emit('error', new Error('connection reset'))).not.toThrow()
    stream.emit({ type: 'stdout', chunk: 'late output' })
    raw.emit('close')
    expect(() => raw.emit('error', new Error('late connection reset'))).not.toThrow()
    stream.end()
    expect(raw.write).not.toHaveBeenCalled()
    expect(raw.end).not.toHaveBeenCalled()
  })

  it('ignores synchronous writes that race with a socket closing', () => {
    const { raw, stream } = response()
    raw.write.mockImplementation(() => { throw new Error('socket closed') })
    expect(() => stream.emit({ type: 'stdout', chunk: 'output' })).not.toThrow()
    stream.emit({ type: 'done', ok: true })
    stream.end()
    expect(raw.write).toHaveBeenCalledOnce()
    expect(raw.end).not.toHaveBeenCalled()
  })

  it('does not write headers or output to an already destroyed response', () => {
    const raw = new Response()
    raw.destroyed = true
    const stream = createNdjsonStream({ raw, hijack: vi.fn() })
    stream.emit({ type: 'done', ok: true })
    stream.end()
    expect(raw.writeHead).not.toHaveBeenCalled()
    expect(raw.write).not.toHaveBeenCalled()
    expect(raw.end).not.toHaveBeenCalled()
  })

  it('does not write or end again when another owner has ended the response', () => {
    const { raw, stream } = response()
    raw.writableEnded = true
    stream.emit({ type: 'done', ok: true })
    stream.end()
    expect(raw.write).not.toHaveBeenCalled()
    expect(raw.end).not.toHaveBeenCalled()
  })

  it('handles header and end failures without throwing into process callbacks', () => {
    const raw = new Response()
    raw.writeHead.mockImplementation(() => { throw new Error('headers unavailable') })
    const stream = createNdjsonStream({ raw, hijack: vi.fn() })
    stream.emit({ type: 'done', ok: true })
    expect(raw.write).not.toHaveBeenCalled()
    const other = response()
    other.raw.end.mockImplementation(() => { throw new Error('socket closed') })
    expect(() => other.stream.end()).not.toThrow()
  })
})
