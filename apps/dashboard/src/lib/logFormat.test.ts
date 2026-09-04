import { describe, expect, it } from 'vitest'
import { filterMcpServiceLogs, filterMcpSessionLogs, formatLogTimestamp, parseLogEntries } from './logFormat'

describe('log formatting', () => {
  it('formats Docker timestamped Pino JSON logs as operator-readable lines', () => {
    const [entry] = parseLogEntries(
      '2026-07-07T16:25:39.656586178Z {"level":30,"time":1783441539656,"req":{"method":"GET","url":"/dashboard/services/api/logs?tail=40"},"res":{"statusCode":200},"responseTime":0.9488750100135803,"msg":"request completed"}',
    )

    expect(entry?.level).toBe('info')
    expect(entry?.message).toContain('request completed')
    expect(entry?.message).toContain('GET /dashboard/services/api/logs?tail=40')
    expect(entry?.message).toContain('status 200')
    expect(formatLogTimestamp(entry?.timestamp ?? null, 'server')).toBe('2026-07-07 16:25:39.656')
  })

  it('keeps MCP client request metadata from top-level structured logs', () => {
    const [entry] = parseLogEntries(
      '2026-07-07T17:45:38.140Z {"t":"2026-07-07T17:45:38.140Z","level":"info","msg":"mcp request","mcpSessionId":"stream-abc","mcpRpcMethod":"tools/call","mcpToolName":"recall_context","method":"POST","path":"/mcp","status":200,"durationMs":12}',
    )

    expect(entry?.level).toBe('info')
    expect(entry?.message).toBe('mcp request | tools/call recall_context | POST /mcp | status 200 | 12ms')
    expect(formatLogTimestamp(entry?.timestamp ?? null, 'server')).toBe('2026-07-07 17:45:38.140')
  })

  it('splits MCP service internals from per-session communication logs', () => {
    const raw = [
      '2026-07-07T17:45:30.000Z {"t":"2026-07-07T17:45:30.000Z","level":"info","msg":"persistent-memory-mcp listening over streamable http","port":8091}',
      '2026-07-07T17:45:31.000Z {"t":"2026-07-07T17:45:31.000Z","level":"info","msg":"api","method":"POST","path":"/mcp-sessions/stream-abc/heartbeat","status":200}',
      '2026-07-07T17:45:32.000Z {"t":"2026-07-07T17:45:32.000Z","level":"info","msg":"mcp request","mcpSessionId":"stream-abc","mcpRpcMethod":"tools/call","mcpToolName":"recall_context","method":"POST","path":"/mcp","status":200}',
      '2026-07-07T17:45:33.000Z {"t":"2026-07-07T17:45:33.000Z","level":"info","msg":"api","mcpSessionId":"stream-abc","method":"POST","path":"/memories/search","status":200}',
      '2026-07-07T17:45:34.000Z {"t":"2026-07-07T17:45:34.000Z","level":"info","msg":"api","mcpSessionId":"stream-other","method":"POST","path":"/graph/search","status":200}',
    ].join('\n')

    const serviceLogs = filterMcpServiceLogs(raw)
    expect(serviceLogs).toContain('persistent-memory-mcp listening')
    expect(serviceLogs).not.toContain('/mcp-sessions/stream-abc/heartbeat')
    expect(serviceLogs).not.toContain('recall_context')
    expect(serviceLogs).not.toContain('/memories/search')

    const sessionLogs = filterMcpSessionLogs(raw, 'stream-abc')
    expect(sessionLogs).toContain('recall_context')
    expect(sessionLogs).toContain('/memories/search')
    expect(sessionLogs).not.toContain('persistent-memory-mcp listening')
    expect(sessionLogs).not.toContain('stream-other')
  })

  it('colors raw error and warn prefixes without keeping duplicate level text in the message', () => {
    const entries = parseLogEntries('ERROR: failed to connect\nWARN: retrying', {
      fallbackTimestamp: '2026-07-07T16:25:39.123Z',
    })

    expect(entries.map((entry) => entry.level)).toEqual(['error', 'warn'])
    expect(entries.map((entry) => entry.message)).toEqual(['failed to connect', 'retrying'])
  })

  it('renders JavaScript errors with bracketed runtime codes as one error entry', () => {
    const entries = parseLogEntries(
      [
        '2026-07-13T20:15:22.213Z SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]: TypeScript parameter property is not supported in strip-only mode',
        '2026-07-13T20:15:22.213Z     at parseTypeScript (node:internal/modules/typescript:63:40)',
        '2026-07-13T20:15:22.213Z     at ModuleLoader.loadAndTranslate (node:internal/modules/esm/loader:617:12)',
      ].join('\n'),
    )

    expect(entries).toHaveLength(1)
    expect(entries[0]?.level).toBe('error')
    expect(entries[0]?.message).toContain('ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX')
    expect(entries[0]?.message).toContain('ModuleLoader.loadAndTranslate')
  })

  it('tails formatted entries after timestamps have been parsed', () => {
    const entries = parseLogEntries('one\ntwo\nthree\nfour\nfive', {
      fallbackTimestamp: '2026-07-07T16:25:39.123Z',
      maxLines: 2,
    })

    expect(entries.map((entry) => entry.message)).toEqual(['four', 'five'])
  })

  it('keeps timestamped JavaScript error objects together as one log entry', () => {
    const entries = parseLogEntries(
      [
        '2026-07-07T17:16:16.475Z × TypeError: fetch failed',
        '2026-07-07T17:16:16.475Z     at async p (.next/server/chunks/973.js:1:2934)',
        '2026-07-07T17:16:16.475Z {',
        "2026-07-07T17:16:16.475Z   digest: '1781737072',",
        '2026-07-07T17:16:16.475Z   [cause]: Error: connect ECONNREFUSED 172.18.0.12:8090 {',
        '2026-07-07T17:16:16.475Z     errno: -111,',
        "2026-07-07T17:16:16.475Z     code: 'ECONNREFUSED'",
        '2026-07-07T17:16:16.475Z   }',
        '2026-07-07T17:16:16.475Z }',
      ].join('\n'),
    )

    expect(entries).toHaveLength(1)
    expect(entries[0]?.level).toBe('error')
    expect(entries[0]?.message).toContain('TypeError: fetch failed')
    expect(entries[0]?.message).toContain("digest: '1781737072'")
    expect(entries[0]?.message).toContain("code: 'ECONNREFUSED'")
  })

  it('parses timestamped pretty JSON as one structured log entry', () => {
    const entries = parseLogEntries(
      [
        '2026-07-07T17:16:16.475Z {',
        '2026-07-07T17:16:16.475Z   "level": 40,',
        '2026-07-07T17:16:16.475Z   "time": "2026-07-07T17:16:16.475Z",',
        '2026-07-07T17:16:16.475Z   "msg": "slow request",',
        '2026-07-07T17:16:16.475Z   "res": { "statusCode": 503 }',
        '2026-07-07T17:16:16.475Z }',
      ].join('\n'),
    )

    expect(entries).toHaveLength(1)
    expect(entries[0]?.level).toBe('warn')
    expect(entries[0]?.message).toContain('slow request')
    expect(entries[0]?.message).toContain('status 503')
  })
})
