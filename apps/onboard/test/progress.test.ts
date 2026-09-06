import { describe, expect, it } from 'vitest'
import { createPrereqOutputParser, type PrereqOutputEvent } from '../server/progress.ts'

const PREFIX = 'PM_OLLAMA_PROGRESS '
const progress = (value: object) => PREFIX + JSON.stringify(value)

function capture() {
  const events: PrereqOutputEvent[] = []
  const parser = createPrereqOutputParser('install-ollama', (event) => events.push(event))
  const stdout = () => events.filter((event) => event.type === 'stdout').map((event) => event.chunk).join('')
  return { events, parser, stdout }
}

describe('prerequisite progress output', () => {
  it('decodes prefixed progress split at every byte boundary and keeps ordinary output', () => {
    const { events, parser, stdout } = capture()
    const input = Buffer.from(`Downloading the installer.\r\n${progress({ stage: 'download', downloadedBytes: 1048576, totalBytes: 2097152 })}\r\nVerifying signature.\n${progress({ stage: 'verify' })}\n`)
    for (const byte of input) parser.write(Buffer.from([byte]))
    parser.end()
    expect(events.filter((event) => event.type === 'progress')).toEqual([
      { type: 'progress', id: 'install-ollama', stage: 'download', downloadedBytes: 1048576, totalBytes: 2097152 },
      { type: 'progress', id: 'install-ollama', stage: 'verify' },
    ])
    expect(stdout()).toBe('Downloading the installer.\r\nVerifying signature.\n')
  })

  it('keeps an unknown download size indeterminate and accepts each subsequent stage', () => {
    const { events, parser } = capture()
    parser.write(Buffer.from([
      progress({ stage: 'download', downloadedBytes: 0 }),
      ...['verify', 'install', 'start', 'ready'].map((stage) => progress({ stage })),
    ].join('\n')))
    parser.end()
    expect(events).toEqual([
      { type: 'progress', id: 'install-ollama', stage: 'download', downloadedBytes: 0 },
      ...['verify', 'install', 'start', 'ready'].map((stage) => ({ type: 'progress', id: 'install-ollama', stage })),
    ])
  })

  it('retains malformed, impossible, and unknown progress records as diagnostic output', () => {
    const { events, parser, stdout } = capture()
    const input = [
      PREFIX + 'broken json', PREFIX + 'null', PREFIX + '[]',
      progress({ stage: 'done' }), progress({ stage: 'download', downloadedBytes: -1 }),
      progress({ stage: 'download', totalBytes: 0 }), progress({ stage: 'download', downloadedBytes: 11, totalBytes: 10 }),
      progress({ stage: 'download', downloadedBytes: '20' }), progress({ stage: 'download', downloadedBytes: 1.5 }),
      progress({ stage: 'download', totalBytes: Number.MAX_SAFE_INTEGER + 1 }),
      progress({ stage: 'install', totalBytes: 100 }),
    ].join('\r\n')
    parser.write(Buffer.from(input))
    parser.end()
    expect(events.every((event) => event.type === 'stdout')).toBe(true)
    expect(stdout()).toBe(input)
  })

  it('whitelists fields so a child cannot spoof the event type or step id', () => {
    const { events, parser } = capture()
    parser.write(Buffer.from(progress({ stage: 'ready', type: 'done', id: 'other', ok: true }) + '\n'))
    expect(events).toEqual([{ type: 'progress', id: 'install-ollama', stage: 'ready' }])
  })

  it('preserves UTF-8 across chunks and streams carriage-return output without waiting for EOF', () => {
    const { parser, stdout } = capture()
    const input = Buffer.from('Download café ✓\r')
    for (const byte of input) parser.write(Buffer.from([byte]))
    expect(stdout()).toBe('Download café ✓\r')
    parser.end()
    expect(stdout()).toBe('Download café ✓\r')
  })

  it('does not recognize a prefix in the middle of an ordinary output line', () => {
    const { events, parser, stdout } = capture()
    parser.write(Buffer.from('ordinary '))
    parser.write(Buffer.from(progress({ stage: 'ready' }) + '\n'))
    expect(events.every((event) => event.type === 'stdout')).toBe(true)
    expect(stdout()).toBe('ordinary ' + progress({ stage: 'ready' }) + '\n')
  })

  it('flushes an oversized pending record and resumes parsing at the next newline', () => {
    const { events, parser, stdout } = capture()
    const oversized = PREFIX + 'x'.repeat(17 * 1024)
    parser.write(Buffer.from(oversized))
    expect(stdout()).toBe(oversized)
    parser.write(Buffer.from('\n' + progress({ stage: 'start' }) + '\n'))
    expect(events.at(-1)).toEqual({ type: 'progress', id: 'install-ollama', stage: 'start' })
  })

  it('flushes truncated final output exactly once and ignores writes after close', () => {
    const { parser, stdout } = capture()
    parser.write(Buffer.from(PREFIX + '{"stage":'))
    parser.end()
    parser.end()
    parser.write(Buffer.from('late output'))
    expect(stdout()).toBe(PREFIX + '{"stage":')
  })

  it('keeps separate stdout and stderr partial records independent', () => {
    const events: PrereqOutputEvent[] = []
    const out = createPrereqOutputParser('step', (event) => events.push(event))
    const err = createPrereqOutputParser('step', (event) => events.push(event))
    out.write(Buffer.from(PREFIX + '{"stage":'))
    err.write(Buffer.from('diagnostic\n'))
    out.write(Buffer.from('"install"}\n'))
    out.end()
    err.end()
    expect(events).toEqual([
      { type: 'stdout', id: 'step', chunk: 'diagnostic\n' },
      { type: 'progress', id: 'step', stage: 'install' },
    ])
  })
})
