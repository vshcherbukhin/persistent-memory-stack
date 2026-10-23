type ValidationIssue = { instancePath?: string; message?: string }

/** Fastify schema failures carry `issues`, while domain failures carry `message`/`reason`. */
export function readApiErrorPayload(body: { error?: string; message?: string; reason?: string; details?: unknown; issues?: ValidationIssue[] }, status: number) {
  const validation = Array.isArray(body.issues)
    ? body.issues.slice(0, 25).map((issue) => `${issue.instancePath || 'request'}: ${issue.message || 'Invalid value'}`).join('; ')
    : undefined
  return {
    code: body.error ?? 'api_error',
    message: body.message ?? body.reason ?? validation ?? `HTTP ${status}`,
    details: typeof body.details === 'string' ? body.details : undefined,
  }
}
