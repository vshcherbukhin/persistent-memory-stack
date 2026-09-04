import { describe, expect, it } from 'vitest'
import {
  idleSessionIds,
  loadConfig,
  missingMcpSessionResponse,
} from '../../../layers/mcp-runtime/src/index.ts'

describe('mcp-runtime layer', () => {
  it('exposes runtime config and session helpers from the layer path', () => {
    const cfg = loadConfig({
      API_URL: 'http://localhost:8090',
      PM_PERSONAL_API_URL: '',
      PM_SHARED_USER_TOKEN: '',
    } as NodeJS.ProcessEnv)

    expect(cfg.API_URL).toBe('http://localhost:8090')
    expect(cfg.PM_MCP_TRANSPORT).toBe('http')
    expect(cfg.PM_PERSONAL_API_URL).toBeUndefined()

    expect(missingMcpSessionResponse(true)).toMatchObject({
      status: 404,
      body: { error: { message: 'Session not found' } },
    })

    expect(idleSessionIds(new Map([
      ['fresh', { lastRequestAt: 9_500 }],
      ['idle', { lastRequestAt: 1_000 }],
    ]), 5, 10_000)).toEqual(['idle'])
  })
})
