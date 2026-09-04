/**
 * docker-control — the security gate + bounded router + parsers.
 *
 * The gate (authOk) and the verb-bounded router (route) are the whole security
 * surface of this sidecar, so they are exhaustively unit-tested. The socket I/O
 * (makeDockerOps) is exercised via a FAKE ops object — no real daemon needed.
 */
import { describe, it, expect } from 'vitest'
import { authOk, route } from '../src/server.ts'
import { memoryContainerFilters, parseHealth, parseContainers, demuxDockerLog } from '../src/parse.ts'
import { matchesServiceRef, type DockerOps } from '../src/docker.ts'

const fakeOps = (over: Partial<DockerOps> = {}): DockerOps => ({
  listServices: async () => [{
    service: 'api',
    name: 'persistent-memory-api',
    id: 'a',
    state: 'running',
    status: 'Up',
    health: null,
    controllable: true,
    mcpSession: false,
  }],
  serviceLogs: async () => 'log line\n',
  actOnService: async () => ({ ok: true }),
  terminateMcpService: async () => ({ ok: true }),
  ...over,
})

describe('authOk — the shared-secret gate', () => {
  it('fails CLOSED when no token is configured (never an open proxy)', () => {
    expect(authOk('Bearer anything', '')).toBe(false)
    expect(authOk(undefined, '')).toBe(false)
  })
  it('accepts only the exact Bearer token', () => {
    expect(authOk('Bearer s3cret', 's3cret')).toBe(true)
  })
  it('rejects a wrong, missing, or malformed header', () => {
    expect(authOk('Bearer wrong', 's3cret')).toBe(false)
    expect(authOk(undefined, 's3cret')).toBe(false)
    expect(authOk('s3cret', 's3cret')).toBe(false) // missing "Bearer "
    expect(authOk('Bearer ', 's3cret')).toBe(false)
  })
})

describe('route — verb-bounded dispatch', () => {
  const sp = (q = ''): URLSearchParams => new URLSearchParams(q)

  it('GET /services → lists project services', async () => {
    const r = await route('GET', '/services', sp(), fakeOps())
    expect(r.status).toBe(200)
    expect((r.body as any).services[0].service).toBe('api')
  })

  it('GET /services/:s/logs honors a clamped tail', async () => {
    let got: [string, number] | null = null
    const r = await route('GET', '/services/api/logs', sp('tail=50'), fakeOps({ serviceLogs: async (s, t) => { got = [s, t]; return 'x' } }))
    expect(r.status).toBe(200)
    expect(got).toEqual(['api', 50])
  })

  it('POST /services/:s/:action passes only allow-listed actions', async () => {
    let called: [string, string] | null = null
    const ops = fakeOps({ actOnService: async (s, a) => { called = [s, a]; return { ok: true } } })
    for (const a of ['start', 'stop', 'restart']) {
      const r = await route('POST', `/services/api/${a}`, sp(), ops)
      expect(r.status).toBe(200)
    }
    expect(called).toEqual(['api', 'restart'])
  })

  it('POST /services/:s/terminate is the separate MCP-session termination path', async () => {
    let called: string | null = null
    const ops = fakeOps({
      terminateMcpService: async (s: string) => { called = s; return { ok: true } },
    })

    const r = await route('POST', '/services/abcdef123456/terminate', sp(), ops)

    expect(r.status).toBe(200)
    expect(called).toBe('abcdef123456')
  })

  it('REJECTS an action outside the allow-list with 400 (never reaches the socket)', async () => {
    let touched = false
    const ops = fakeOps({ actOnService: async () => { touched = true; return { ok: true } } })
    const r = await route('POST', '/services/api/exec', sp(), ops)
    expect(r.status).toBe(400)
    expect(touched).toBe(false)
  })

  it('404s unknown paths and 405s wrong methods', async () => {
    expect((await route('GET', '/', sp(), fakeOps())).status).toBe(404)
    expect((await route('DELETE', '/services/api/start', sp(), fakeOps())).status).toBe(405)
    expect((await route('GET', '/services/api/start', sp(), fakeOps())).status).toBe(405) // action is POST-only
  })

  it('maps malformed %-encoding in the service segment to a clean 400 (not a 500 leak)', async () => {
    let touched = false
    const ops = fakeOps({ serviceLogs: async () => { touched = true; return 'x' } })
    const r = await route('GET', '/services/%ZZ/logs', sp(), ops)
    expect(r.status).toBe(400)
    expect(touched).toBe(false)
  })
})

describe('parsers (moved verbatim from the api)', () => {
  it('filters to all persistent-memory project containers, including MCP clients', () => {
    const filters = JSON.parse(decodeURIComponent(memoryContainerFilters('persistent-memory')))
    expect(filters.label).toEqual(['com.docker.compose.project=persistent-memory'])
  })

  it('parseHealth reads the Status string', () => {
    expect(parseHealth('Up 2 minutes (healthy)')).toBe('healthy')
    expect(parseHealth('Up (unhealthy)')).toBe('unhealthy')
    expect(parseHealth('Up 3 minutes')).toBeNull()
  })
  it('parseContainers maps + sorts, tolerates junk', () => {
    const rows = parseContainers([
      {
        Id: 'b',
        Names: ['/persistent-memory-codex-mcp-123'],
        State: 'running',
        Status: 'Up',
        Labels: {
          'com.docker.compose.service': 'codex-mcp',
          'persistent-memory.role': 'mcp-client',
        },
      },
      {
        Id: 'a',
        Names: ['/api'],
        State: 'running',
        Status: 'Up',
        Labels: {
          'com.docker.compose.service': 'api',
          'com.docker.compose.config-hash': 'abc',
          'com.docker.compose.oneoff': 'False',
        },
      },
    ])
    expect(rows.map((r) => r.service)).toEqual(['api', 'codex-mcp'])
    expect(rows.find((r) => r.service === 'api')?.controllable).toBe(true)
    expect(rows.find((r) => r.service === 'codex-mcp')?.controllable).toBe(false)
    expect(rows.find((r) => r.service === 'codex-mcp')?.mcpSession).toBe(true)
    expect(parseContainers('nope')).toEqual([])
  })
  it('matches a specific project container by service, name, full id, or short id', () => {
    const row = {
      service: 'codex-mcp',
      name: 'persistent-memory-codex-mcp-123',
      id: 'abcdef1234567890',
      state: 'running',
      status: 'Up',
      health: null,
      controllable: false,
      mcpSession: true,
    } as const

    expect(matchesServiceRef(row, 'codex-mcp')).toBe(true)
    expect(matchesServiceRef(row, 'persistent-memory-codex-mcp-123')).toBe(true)
    expect(matchesServiceRef(row, 'abcdef1234567890')).toBe(true)
    expect(matchesServiceRef(row, 'abcdef123456')).toBe(true)
    expect(matchesServiceRef(row, 'codex-mcp', true)).toBe(false)
  })
  it('demuxDockerLog de-frames multiplexed streams + passes TTY verbatim', () => {
    const frame = (type: number, text: string): Buffer => {
      const p = Buffer.from(text, 'utf8'); const h = Buffer.alloc(8); h[0] = type; h.writeUInt32BE(p.length, 4); return Buffer.concat([h, p])
    }
    expect(demuxDockerLog(Buffer.concat([frame(1, 'a\n'), frame(2, 'b\n')]))).toBe('a\nb\n')
    expect(demuxDockerLog(Buffer.from('tty\n'))).toBe('tty\n')
  })
})
