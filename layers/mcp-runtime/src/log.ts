/**
 * STDERR-ONLY structured logger + secret redaction.
 *
 * THE #1 STDIO-MCP KILLER: stdout carries the JSON-RPC frames. A single stray
 * `console.log` (or any write to stdout) corrupts the protocol and the client
 * disconnects. EVERY diagnostic in this package goes through here, which writes
 * to process.stderr ONLY. There is no console.log anywhere in src/ (CI greps).
 *
 * Two things are secrets and must NEVER reach a log line:
 *   • PM_USER_TOKEN (wire format <tokenId>.<secret>) — redactToken() masks any
 *     such substring before it can be logged.
 *   • A presigned MinIO URL (get_document.originalUrl) embeds the MinIO root-cred
 *     signature — callers must never pass it to the logger; we don't log bodies.
 */

/** Mask any `<tokenId>.<secret>` token-shaped substring in a string. */
export function redactToken(s: string): string {
  // A token is two long base62-ish segments joined by a dot. Mask the secret half.
  return s.replace(
    /\b([A-Za-z0-9_-]{6,})\.([A-Za-z0-9_-]{6,})\b/g,
    (_m, id: string) => `${id}.***`,
  )
}

type Fields = Record<string, unknown>

function emit(level: 'info' | 'warn' | 'error', msg: string, fields?: Fields): void {
  const line: Fields = { t: new Date().toISOString(), level, msg }
  if (fields) {
    for (const [k, v] of Object.entries(fields)) {
      line[k] = v instanceof Error ? { name: v.name, message: redactToken(v.message) } : v
    }
  }
  // STDERR ONLY. console.error writes to stderr in Node.
  process.stderr.write(redactToken(JSON.stringify(line)) + '\n')
}

export const log = {
  info: (msg: string, fields?: Fields) => emit('info', msg, fields),
  warn: (msg: string, fields?: Fields) => emit('warn', msg, fields),
  error: (msg: string, fields?: Fields) => emit('error', msg, fields),
}
