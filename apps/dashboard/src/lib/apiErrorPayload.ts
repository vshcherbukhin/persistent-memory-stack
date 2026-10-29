type ValidationIssue = { instancePath?: string; path?: (string | number)[]; message?: string }

/** Fastify schema failures carry `issues`, while domain failures carry `message`/`reason`. */
export function readApiErrorPayload(body: { error?: string; message?: string; reason?: string; details?: unknown; issues?: ValidationIssue[] }, status: number) {
  const details = body.details && typeof body.details === 'object' ? body.details as { issues?: ValidationIssue[]; kind?: string; value?: string; choices?: string[]; currentRevision?: number } : undefined
  const issues = body.issues ?? details?.issues
  const validation = Array.isArray(issues)
    ? issues.slice(0, 25).map((issue) => `${issue.instancePath || issue.path?.join('.') || 'request'}: ${issue.message || 'Invalid value'}`).join('; ')
    : undefined
  const classification = details?.kind && details?.value ? `${details.kind}: ${details.value}.${details.choices?.length ? ` Available: ${details.choices.slice(0, 5).join(', ')}.` : ''}` : undefined
  const revision = details?.currentRevision ? `Current revision: ${details.currentRevision}.` : undefined
  return {
    code: body.error ?? 'api_error',
    message: [body.message ?? body.reason, validation, classification, revision].filter(Boolean).join(' ') || `HTTP ${status}`,
    details: typeof body.details === 'string' ? body.details : undefined,
  }
}
