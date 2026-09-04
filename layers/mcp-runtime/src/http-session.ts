export interface JsonRpcErrorPayload {
  jsonrpc: '2.0'
  error: {
    code: number
    message: string
  }
  id: null
}

export interface HttpJsonRpcError {
  status: number
  body: JsonRpcErrorPayload
}

export function missingMcpSessionResponse(hasSessionId: boolean): HttpJsonRpcError {
  if (hasSessionId) {
    return {
      status: 404,
      body: {
        jsonrpc: '2.0',
        error: {
          code: -32001,
          message: 'Session not found',
        },
        id: null,
      },
    }
  }

  return {
    status: 400,
    body: {
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Bad Request: Session ID required',
      },
      id: null,
    },
  }
}
