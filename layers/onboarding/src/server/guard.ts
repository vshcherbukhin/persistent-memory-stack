/**
 * DNS-rebinding guard for the loopback installer server.
 *
 * The server binds 127.0.0.1 only, but a malicious page in the user's browser
 * could DNS-rebind its own hostname to 127.0.0.1 and drive the privileged
 * install endpoints. Browsers still send the *attacker* origin's Host/Origin
 * headers, so we reject any request whose Host is not loopback:<PORT> and any
 * state-changing (POST) request carrying a foreign Origin.
 */
export function isLoopbackHost(host: string | undefined, port: number): boolean {
  if (!host) return false // a fetch from a page always sets Host; absence is suspicious
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`
}

export function isLoopbackOrigin(origin: string, port: number): boolean {
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`
}

/** Pure decision: returns a 403 reason string to reject, or null to allow. */
export function originGuardReason(
  method: string,
  host: string | undefined,
  origin: string | undefined,
  port: number,
): string | null {
  if (!isLoopbackHost(host, port)) return 'bad_host'
  // Only state-changing methods need the Origin check; GETs are read-only probes.
  // An absent Origin is allowed (non-browser clients, same-origin GET-style POST).
  if (method === 'POST' && origin && !isLoopbackOrigin(origin, port)) return 'bad_origin'
  return null
}
