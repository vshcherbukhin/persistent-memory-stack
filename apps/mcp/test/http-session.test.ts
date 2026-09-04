import { describe, expect, it } from 'vitest'
import { missingMcpSessionResponse } from '../src/http-session.ts'

describe('Streamable HTTP session errors', () => {
  it('returns session-not-found for an unknown stale session id', () => {
    expect(missingMcpSessionResponse(true)).toEqual({
      status: 404,
      body: {
        jsonrpc: '2.0',
        error: {
          code: -32001,
          message: 'Session not found',
        },
        id: null,
      },
    })
  })

  it('returns bad-request when a non-initialize request has no session id', () => {
    expect(missingMcpSessionResponse(false)).toEqual({
      status: 400,
      body: {
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Bad Request: Session ID required',
        },
        id: null,
      },
    })
  })
})
